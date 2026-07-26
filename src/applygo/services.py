from __future__ import annotations

import hashlib
import json
import re
import time
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx
from anthropic import Anthropic
from openai import OpenAI
from pypdf import PdfReader
from sqlalchemy import select
from sqlalchemy.orm import Session

from applygo.config import Settings, get_settings
from applygo.models import CandidateEvidence, CandidateProfile, FitAssessment, JobPosting, SourceDocument


def safe_filename(name: str) -> str:
    suffix = Path(name).suffix.lower()
    return f"{uuid4()}{suffix}"


def extract_text(path: Path, media_type: str) -> str:
    if media_type == "application/pdf" or path.suffix.lower() == ".pdf":
        reader = PdfReader(str(path))
        return "\n".join(page.extract_text() or "" for page in reader.pages).strip()
    return path.read_text(encoding="utf-8", errors="replace")


def store_document(session: Session, profile: CandidateProfile, name: str, media_type: str, data: bytes, settings: Settings | None = None) -> SourceDocument:
    settings = settings or get_settings()
    digest = hashlib.sha256(data).hexdigest()
    profile_dir = settings.storage_dir / profile.user_id / profile.id
    profile_dir.mkdir(parents=True, exist_ok=True)
    path = profile_dir / safe_filename(name)
    path.write_bytes(data)
    text = extract_text(path, media_type)
    document = SourceDocument(profile_id=profile.id, original_name=name, stored_path=str(path), media_type=media_type, sha256=digest, extracted_text=text)
    session.add(document)
    session.commit()
    session.refresh(document)
    return document


def create_evidence_from_text(session: Session, profile: CandidateProfile, text: str, source_document_id: str | None = None) -> list[CandidateEvidence]:
    claims: list[CandidateEvidence] = []
    for paragraph in re.split(r"\n\s*\n|(?<=[.!?])\s+(?=[A-Z])", text):
        cleaned = " ".join(paragraph.split())
        if len(cleaned) < 25:
            continue
        claim = CandidateEvidence(profile_id=profile.id, source_document_id=source_document_id, category="imported", claim=cleaned[:2000], verification_status="unreviewed", usable_in_applications=False)
        session.add(claim)
        claims.append(claim)
    session.commit()
    return claims


def normalize_job(description: str) -> dict[str, Any]:
    lowered = description.lower()
    skills = [skill for skill in ["python", "pytorch", "machine learning", "llm", "rag", "agents", "sql", "aws", "azure", "docker", "kubernetes", "automotive"] if skill in lowered]
    return {
        "skills": skills,
        "remote": "remote" in lowered,
        "hybrid": "hybrid" in lowered,
        "requires_work_authorization": any(term in lowered for term in ["work authorization", "authorized to work", "sponsorship"]),
    }


def deterministic_fit(profile: CandidateProfile, evidence: list[CandidateEvidence], job: JobPosting) -> dict[str, Any]:
    description = job.raw_description.lower()
    usable = [item for item in evidence if item.usable_in_applications and item.verification_status in {"verified", "user_confirmed"}]
    matched: list[dict[str, str]] = []
    for item in usable:
        words = {word for word in re.findall(r"[a-zA-Z][a-zA-Z0-9+#.-]{2,}", item.claim.lower()) if len(word) > 3}
        overlap = sorted(word for word in words if word in description)
        if overlap:
            matched.append({"evidence_id": item.id, "claim": item.claim, "overlap": ", ".join(overlap[:8])})
    score = min(100, 20 + len(matched) * 12 + len(job.normalized.get("skills", [])) * 3)
    return {
        "overall_score": score,
        "recommendation": "review" if score >= 45 else "low_priority",
        "hard_eligibility": {"status": "needs_review", "reasons": []},
        "strong_matches": matched[:8],
        "partial_matches": [],
        "evidence_gaps": ["Confirm all hard requirements and eligibility before applying"],
        "potential_disqualifiers": [],
        "questions_for_user": ["Does this role satisfy your location, compensation, and work-authorization constraints?"],
        "grounding_notice": "Only verified or user-confirmed evidence marked usable was considered.",
    }


class ModelGateway:
    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()

    def assess(self, profile: CandidateProfile, evidence: list[CandidateEvidence], job: JobPosting) -> tuple[dict[str, Any], dict[str, Any]]:
        baseline = deterministic_fit(profile, evidence, job)
        provider = self.settings.model_provider.lower()
        if provider == "mock":
            return baseline, {}
        payload = {
            "candidate_summary": profile.summary,
            "verified_evidence": [{"id": e.id, "claim": e.claim} for e in evidence if e.usable_in_applications and e.verification_status in {"verified", "user_confirmed"}],
            "job": {"title": job.title, "company": job.company, "description": job.raw_description},
            "required_output": baseline,
        }
        instruction = "Return JSON only. Evaluate fit using only verified_evidence. Never invent qualifications. Keep all required_output keys."
        if provider in {"openai", "ollama"}:
            base_url = None if provider == "openai" else __import__("os").environ.get("OLLAMA_BASE_URL", "http://localhost:11434/v1")
            api_key = __import__("os").environ.get("OPENAI_API_KEY" if provider == "openai" else "OLLAMA_API_KEY", "ollama")
            client = OpenAI(api_key=api_key, base_url=base_url)
            response = client.chat.completions.create(model=self.settings.model_name, response_format={"type": "json_object"}, messages=[{"role": "system", "content": instruction}, {"role": "user", "content": json.dumps(payload)}])
            return json.loads(response.choices[0].message.content or "{}"), {"total_tokens": response.usage.total_tokens if response.usage else None}
        if provider == "anthropic":
            client = Anthropic()
            response = client.messages.create(model=self.settings.model_name, max_tokens=2500, system=instruction, messages=[{"role": "user", "content": json.dumps(payload)}])
            text = "".join(block.text for block in response.content if hasattr(block, "text"))
            return json.loads(text), {"input_tokens": response.usage.input_tokens, "output_tokens": response.usage.output_tokens}
        raise ValueError(f"Unsupported model provider: {provider}")


def run_fit_assessment(session: Session, profile: CandidateProfile, job: JobPosting, settings: Settings | None = None) -> FitAssessment:
    settings = settings or get_settings()
    evidence = list(session.scalars(select(CandidateEvidence).where(CandidateEvidence.profile_id == profile.id)))
    started = time.perf_counter()
    result, usage = ModelGateway(settings).assess(profile, evidence, job)
    assessment = FitAssessment(job_id=job.id, profile_id=profile.id, provider=settings.model_provider, model=settings.model_name, result=result, evidence_ids=[match["evidence_id"] for match in result.get("strong_matches", []) if "evidence_id" in match], latency_ms=int((time.perf_counter() - started) * 1000), token_usage=usage)
    session.add(assessment)
    session.commit()
    session.refresh(assessment)
    return assessment
