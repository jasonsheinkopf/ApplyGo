from __future__ import annotations

import hashlib
import re
import time
from pathlib import Path
from typing import Any
from uuid import uuid4

from pypdf import PdfReader
from sqlalchemy import select
from sqlalchemy.orm import Session

from applygo.config import Settings, get_settings
from applygo.model_router import ModelRouter, ModelTask
from applygo.models import CandidateEvidence, CandidateProfile, FitAssessment, JobPosting, ResumeVersion, SourceDocument

PROMPT_VERSION = "fit-v2-routed"
ALLOWED_UPLOAD_TYPES = {"application/pdf", "text/plain", "text/markdown"}


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
    document = SourceDocument(profile_id=profile.id, original_name=name, stored_path=str(path), media_type=media_type, sha256=digest, extracted_text=extract_text(path, media_type))
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


def approved_evidence(session: Session, profile_id: str) -> list[CandidateEvidence]:
    return list(session.scalars(select(CandidateEvidence).where(CandidateEvidence.profile_id == profile_id, CandidateEvidence.usable_in_applications.is_(True), CandidateEvidence.verification_status.in_(["verified", "user_confirmed"]))))


def generate_profile_summary(session: Session, profile: CandidateProfile, settings: Settings | None = None) -> dict[str, Any]:
    settings = settings or get_settings()
    evidence = approved_evidence(session, profile.id)
    preferences = profile.preferences or {}
    claims = [{"id": item.id, "claim": item.claim} for item in evidence]
    default_summary = {
        "headline": profile.label,
        "executive_summary": " ".join(item.claim for item in evidence[:4])[:1800] or "Add and approve source evidence to generate a grounded professional profile.",
        "strengths": [item.claim for item in evidence[:5]],
        "target_roles": preferences.get("target_roles", ""),
        "requirements": preferences,
        "source_evidence_ids": [item.id for item in evidence],
    }
    instruction = "Return JSON only with headline, executive_summary, strengths, target_roles, requirements, and source_evidence_ids. Use only supplied approved evidence. Never invent experience."
    result = ModelRouter(settings).invoke(ModelTask.DOCUMENT_EXTRACTION, instruction, {"approved_evidence": claims, "preferences": preferences, "current_summary": profile.summary}, mock_output=default_summary)
    profile.summary = str(result.output.get("executive_summary", default_summary["executive_summary"]))
    profile.preferences = {**preferences, "generated_profile": result.output, "profile_provider": result.provider, "profile_model": result.model}
    session.commit()
    return result.output


def generate_resume_version(session: Session, profile: CandidateProfile, purpose: str, settings: Settings | None = None) -> ResumeVersion:
    settings = settings or get_settings()
    evidence = approved_evidence(session, profile.id)
    claims = [{"id": item.id, "claim": item.claim} for item in evidence]
    name = profile.user.display_name
    mock_markdown = f"# {name}\n\n## Professional Summary\n{profile.summary or 'Grounded candidate profile pending generation.'}\n\n## Selected Experience\n" + "\n".join(f"- {item.claim}" for item in evidence[:8])
    mock = {"title": f"{name} — {purpose or 'General'}", "purpose": purpose or "General-purpose résumé", "content_markdown": mock_markdown, "source_evidence_ids": [item.id for item in evidence]}
    instruction = "Return JSON only with title, purpose, content_markdown, and source_evidence_ids. Create a polished ATS-friendly resume using only approved evidence. Do not alter source documents or invent facts."
    result = ModelRouter(settings).invoke(ModelTask.DOCUMENT_DRAFTING, instruction, {"candidate_name": name, "profile_summary": profile.summary, "preferences": profile.preferences, "approved_evidence": claims, "requested_purpose": purpose}, mock_output=mock)
    resume = ResumeVersion(profile_id=profile.id, title=str(result.output.get("title", mock["title"])), purpose=str(result.output.get("purpose", mock["purpose"])), content_markdown=str(result.output.get("content_markdown", mock_markdown)), provider=result.provider, model=result.model, source_evidence_ids=list(result.output.get("source_evidence_ids", mock["source_evidence_ids"])))
    session.add(resume)
    session.commit()
    session.refresh(resume)
    return resume


def normalize_job(description: str) -> dict[str, Any]:
    lowered = description.lower()
    vocabulary = ["python", "pytorch", "machine learning", "llm", "rag", "agents", "sql", "aws", "azure", "docker", "kubernetes", "automotive"]
    return {"skills": [skill for skill in vocabulary if skill in lowered], "remote": "remote" in lowered, "hybrid": "hybrid" in lowered, "requires_work_authorization": any(term in lowered for term in ["work authorization", "authorized to work", "sponsorship"])}


def deterministic_fit(profile: CandidateProfile, evidence: list[CandidateEvidence], job: JobPosting) -> dict[str, Any]:
    del profile
    description = job.raw_description.lower()
    usable = [item for item in evidence if item.usable_in_applications and item.verification_status in {"verified", "user_confirmed"}]
    matched: list[dict[str, str]] = []
    for item in usable:
        words = {word for word in re.findall(r"[a-zA-Z][a-zA-Z0-9+#.-]{2,}", item.claim.lower()) if len(word) > 3}
        overlap = sorted(word for word in words if word in description)
        if overlap:
            matched.append({"evidence_id": item.id, "claim": item.claim, "overlap": ", ".join(overlap[:8])})
    score = min(100, 20 + len(matched) * 12 + len(job.normalized.get("skills", [])) * 3)
    return {"overall_score": score, "recommendation": "review" if score >= 45 else "low_priority", "hard_eligibility": {"status": "needs_review", "reasons": []}, "strong_matches": matched[:8], "partial_matches": [], "evidence_gaps": ["Confirm all hard requirements and eligibility before applying"], "potential_disqualifiers": [], "questions_for_user": ["Does this role satisfy your location, compensation, and work-authorization constraints?"], "grounding_notice": "Only verified or user-confirmed evidence marked usable was considered."}


class ModelGateway:
    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self.router = ModelRouter(self.settings)

    def assess(self, profile: CandidateProfile, evidence: list[CandidateEvidence], job: JobPosting) -> tuple[dict[str, Any], dict[str, Any], str, str]:
        baseline = deterministic_fit(profile, evidence, job)
        verified = [{"id": item.id, "claim": item.claim} for item in evidence if item.usable_in_applications and item.verification_status in {"verified", "user_confirmed"}]
        payload = {"candidate_summary": profile.summary, "verified_evidence": verified, "job": {"title": job.title, "company": job.company, "description": job.raw_description}, "required_output_shape": baseline}
        result = self.router.invoke(ModelTask.FIT_ASSESSMENT, "Return JSON only. Evaluate fit using only verified_evidence. Never invent qualifications. Preserve every required_output_shape key.", payload, mock_output=baseline)
        return result.output, {**result.usage, "execution_mode": result.execution_mode.value}, result.provider, result.model


def run_fit_assessment(session: Session, profile: CandidateProfile, job: JobPosting, settings: Settings | None = None) -> FitAssessment:
    settings = settings or get_settings()
    evidence = list(session.scalars(select(CandidateEvidence).where(CandidateEvidence.profile_id == profile.id)))
    started = time.perf_counter()
    result, usage, provider, model = ModelGateway(settings).assess(profile, evidence, job)
    assessment = FitAssessment(job_id=job.id, profile_id=profile.id, provider=provider, model=model, prompt_version=PROMPT_VERSION, result=result, evidence_ids=[match["evidence_id"] for match in result.get("strong_matches", []) if "evidence_id" in match], latency_ms=int((time.perf_counter() - started) * 1000), token_usage=usage)
    session.add(assessment)
    session.commit()
    session.refresh(assessment)
    return assessment
