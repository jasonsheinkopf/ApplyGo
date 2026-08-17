from __future__ import annotations

import hashlib
import re
import time
from datetime import UTC, datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from pypdf import PdfReader
from sqlalchemy import select
from sqlalchemy.orm import Session

from applygo.config import Settings, get_settings
from applygo.model_router import ModelRouter, ModelTask
from applygo.models import (
    CandidateEvidence,
    CandidateProfile,
    CoverLetterVersion,
    FitAssessment,
    ImproveQuestion,
    JobPosting,
    ResumeVersion,
    SourceDocument,
)
from applygo.prompt_management import get_text_prompt

PROMPT_VERSION = "fit-v2-routed"
REQUIREMENTS_PROMPT_VERSION = "requirements-v1-routed"
ALLOWED_UPLOAD_TYPES = {"application/pdf", "text/plain", "text/markdown"}

# Requirement categories ApplyGo can recognize deterministically without an LLM call.
# The LLM path (analyze_job_requirements) is free to surface additional categories;
# this vocabulary only powers the zero-cost baseline and the mock/offline fallback.
REQUIREMENT_VOCABULARY: dict[str, str] = {
    "python": "Python",
    "pytorch": "PyTorch",
    "machine learning": "Machine learning",
    "llm": "LLMs",
    "rag": "Retrieval-augmented generation",
    "agents": "Agentic systems",
    "sql": "SQL / relational databases",
    "aws": "AWS",
    "azure": "Azure",
    "docker": "Docker",
    "kubernetes": "Kubernetes",
    "automotive": "Automotive domain experience",
}
HARD_CONSTRAINT_MARKERS: dict[str, tuple[str, str]] = {
    "work_authorization": ("work authorization", "Must be authorized to work without sponsorship"),
    "degree": ("bachelor", "Requires a bachelor's degree or equivalent"),
    "clearance": ("security clearance", "Requires an active security clearance"),
}
STOP_STATUSES = {"unknown", "not_supported"}


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
    instruction = get_text_prompt(settings, "legacy/profile/summary")
    result = ModelRouter(settings).invoke(ModelTask.DOCUMENT_EXTRACTION, instruction, {"approved_evidence": claims, "preferences": preferences, "current_summary": profile.summary}, mock_output=default_summary)
    profile.summary = str(result.output.get("executive_summary", default_summary["executive_summary"]))
    profile.preferences = {**preferences, "generated_profile": result.output, "profile_provider": result.provider, "profile_model": result.model}
    session.commit()
    return result.output


def generate_resume_version(session: Session, profile: CandidateProfile, purpose: str, settings: Settings | None = None, job: JobPosting | None = None) -> ResumeVersion:
    settings = settings or get_settings()
    evidence = approved_evidence(session, profile.id)
    claims = [{"id": item.id, "claim": item.claim} for item in evidence]
    name = profile.user.display_name
    mock_markdown = f"# {name}\n\n## Professional Summary\n{profile.summary or 'Grounded candidate profile pending generation.'}\n\n## Selected Experience\n" + "\n".join(f"- {item.claim}" for item in evidence[:8])
    mock = {"title": f"{name} — {purpose or 'General'}", "purpose": purpose or "General-purpose résumé", "content_markdown": mock_markdown, "source_evidence_ids": [item.id for item in evidence]}
    instruction = get_text_prompt(settings, "legacy/resume/draft")
    payload: dict[str, Any] = {"candidate_name": name, "profile_summary": profile.summary, "preferences": profile.preferences, "approved_evidence": claims, "requested_purpose": purpose}
    if job is not None:
        # Reuses the same structured requirements/evidence mapping the Interested card
        # shows, so the résumé can emphasize the strongest truthful match to this job
        # instead of re-deriving job context from scratch.
        payload["requirements_analysis"] = analyze_job_requirements(session, profile, job, settings=settings)
        payload["job"] = {"title": job.title, "company": job.company}
    result = ModelRouter(settings).invoke(ModelTask.DOCUMENT_DRAFTING, instruction, payload, mock_output=mock)
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
        instruction = get_text_prompt(self.settings, "legacy/jobs/fit")
        result = self.router.invoke(ModelTask.FIT_ASSESSMENT, instruction, payload, mock_output=baseline)
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


# --- Interested jobs: requirement extraction, evidence matching, and the ---
# --- centralized Profile > Improve question loop.                        ---


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")


def fingerprint(*parts: str) -> str:
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


def evidence_fingerprint(evidence: list[CandidateEvidence]) -> str:
    material = sorted(f"{item.id}:{item.verification_status}:{item.usable_in_applications}" for item in evidence)
    return fingerprint(*material)


def evidence_seeking_question(requirement_text: str) -> str:
    return (
        f"ApplyGo does not currently have clear evidence of {requirement_text} in your profile. "
        f"In any role, project, or coursework, have you worked with {requirement_text}? "
        "If so, briefly describe what you did and which tools you used."
    )


def deterministic_requirement_baseline(job: JobPosting) -> list[dict[str, Any]]:
    lowered = job.raw_description.lower()
    requirements: list[dict[str, Any]] = []
    for term, label in REQUIREMENT_VOCABULARY.items():
        if term not in lowered:
            continue
        nearby = lowered[max(0, lowered.index(term) - 60) : lowered.index(term) + 60]
        requirement_level = "required" if re.search(r"required|must have|minimum of", nearby) else "preferred"
        requirements.append(
            {
                "id": f"req_{slugify(term)}",
                "text": label,
                "category": slugify(term),
                "kind": "skill",
                "requirement_level": requirement_level,
                "hard_constraint": False,
                "evidence_question": evidence_seeking_question(label),
            }
        )
    for category, (marker, label) in HARD_CONSTRAINT_MARKERS.items():
        if marker in lowered:
            requirements.append(
                {
                    "id": f"req_{category}",
                    "text": label,
                    "category": category,
                    "kind": "constraint",
                    "requirement_level": "required",
                    "hard_constraint": True,
                    "evidence_question": f"This role requires: {label}. Does this apply to you?",
                }
            )
    return requirements


def match_requirement_deterministic(requirement: dict[str, Any], evidence: list[CandidateEvidence]) -> dict[str, Any]:
    tokens = [token for token in requirement["category"].split("_") if len(token) > 2]
    matched = [
        item.id
        for item in evidence
        if item.usable_in_applications and item.verification_status in {"verified", "user_confirmed"} and any(token in item.claim.lower() for token in tokens)
    ]
    if matched:
        return {"status": "supported", "evidence_ids": matched, "rationale": "Matched approved evidence containing this term."}
    if requirement.get("hard_constraint"):
        return {"status": "hard_constraint", "evidence_ids": [], "rationale": "Hard constraint with no confirming evidence yet."}
    # Absence of a keyword match is not proof of absence of the skill - default to
    # "unknown" so the gap surfaces as a targeted question instead of a false negative.
    return {"status": "unknown", "evidence_ids": [], "rationale": "No approved evidence mentions this yet."}


def deterministic_requirements_analysis(profile: CandidateProfile, evidence: list[CandidateEvidence], job: JobPosting) -> dict[str, Any]:
    requirements = deterministic_requirement_baseline(job)
    evidence_map = {req["id"]: match_requirement_deterministic(req, evidence) for req in requirements}
    return {"requirements": requirements, "evidence_map": evidence_map}


def analyze_job_requirements(session: Session, profile: CandidateProfile, job: JobPosting, settings: Settings | None = None, force: bool = False) -> dict[str, Any]:
    """Extract structured requirements for `job` and match them against the profile.

    Persisted on the job so it is not recomputed on every page render (see
    JobPosting.requirements_analysis). Only recomputed when the job description or
    the profile's approved evidence actually changed, or `force=True`.
    """
    settings = settings or get_settings()
    evidence = list(session.scalars(select(CandidateEvidence).where(CandidateEvidence.profile_id == profile.id)))
    profile_fp = evidence_fingerprint(evidence)
    job_fp = fingerprint(job.raw_description)
    if not force and job.requirements_analysis and job.analysis_profile_fingerprint == profile_fp and job.analysis_job_fingerprint == job_fp:
        return job.requirements_analysis

    baseline = deterministic_requirements_analysis(profile, evidence, job)
    approved = [{"id": item.id, "category": item.category, "claim": item.claim} for item in evidence if item.usable_in_applications and item.verification_status in {"verified", "user_confirmed"}]
    payload = {
        "job": {"title": job.title, "company": job.company, "description": job.raw_description},
        "candidate_summary": profile.summary,
        "approved_evidence": approved,
        "required_output_shape": baseline,
    }
    instruction = get_text_prompt(settings, "job/requirements-evidence")
    result = ModelRouter(settings).invoke(ModelTask.REQUIREMENT_ANALYSIS, instruction, payload, mock_output=baseline)
    analysis = {
        "requirements": result.output.get("requirements", baseline["requirements"]),
        "evidence_map": result.output.get("evidence_map", baseline["evidence_map"]),
        "provider": result.provider,
        "model": result.model,
        "prompt_version": REQUIREMENTS_PROMPT_VERSION,
        "generated_at": datetime.now(UTC).isoformat(),
    }
    job.requirements_analysis = analysis
    job.analysis_profile_fingerprint = profile_fp
    job.analysis_job_fingerprint = job_fp
    session.commit()
    return analysis


def job_gap_requirements(job: JobPosting) -> list[dict[str, Any]]:
    analysis = job.requirements_analysis or {}
    evidence_map = analysis.get("evidence_map", {})
    return [req for req in analysis.get("requirements", []) if evidence_map.get(req["id"], {}).get("status") in STOP_STATUSES and not req.get("hard_constraint")]


def job_improvement_count(job: JobPosting) -> int:
    return len(job_gap_requirements(job))


def build_rationale(jobs: list[JobPosting]) -> str:
    count = len(jobs)
    names = ", ".join(f"{job.company or job.title}" for job in jobs[:3])
    verb = "mentions" if count == 1 else "mention"
    plural = "role" if count == 1 else "roles"
    suffix = f" ({names}{'…' if count > 3 else ''})" if names else ""
    return f"{count} of your Interested {plural}{suffix} {verb} this, but your profile doesn't currently have clear evidence of it."


def sync_improve_questions_for_job(session: Session, profile: CandidateProfile, job: JobPosting, analysis: dict[str, Any]) -> None:
    open_by_category = {
        question.category: question
        for question in session.scalars(select(ImproveQuestion).where(ImproveQuestion.profile_id == profile.id, ImproveQuestion.status == "open"))
    }
    evidence_map = analysis.get("evidence_map", {})
    for requirement in analysis.get("requirements", []):
        status = evidence_map.get(requirement["id"], {}).get("status")
        category = requirement["category"]
        if status not in STOP_STATUSES or requirement.get("hard_constraint"):
            existing = open_by_category.get(category)
            if existing and job.id in (existing.related_job_ids or []):
                existing.related_job_ids = [jid for jid in existing.related_job_ids if jid != job.id]
            continue
        existing = open_by_category.get(category)
        if existing is None:
            existing = ImproveQuestion(
                profile_id=profile.id,
                category=category,
                requirement_text=requirement["text"],
                question_text=requirement.get("evidence_question") or evidence_seeking_question(requirement["text"]),
                requirement_level=requirement.get("requirement_level", "preferred"),
                hard_constraint=False,
                related_job_ids=[job.id],
            )
            session.add(existing)
            open_by_category[category] = existing
        elif job.id not in (existing.related_job_ids or []):
            existing.related_job_ids = [*existing.related_job_ids, job.id]
            if requirement.get("requirement_level") == "required":
                existing.requirement_level = "required"
        related_jobs = [j for j in (session.get(JobPosting, jid) for jid in existing.related_job_ids) if j is not None]
        existing.rationale = build_rationale(related_jobs)
    session.commit()


def sync_general_improve_questions(session: Session, profile: CandidateProfile) -> None:
    """Fallback questions for profiles with no Interested jobs yet (or very thin evidence)."""
    has_general = session.scalars(select(ImproveQuestion).where(ImproveQuestion.profile_id == profile.id, ImproveQuestion.category == "general_background")).first()
    evidence_count = session.scalar(select(CandidateEvidence).where(CandidateEvidence.profile_id == profile.id).limit(1))
    if has_general is None and evidence_count is None:
        session.add(
            ImproveQuestion(
                profile_id=profile.id,
                category="general_background",
                requirement_text="Work history and accomplishments",
                question_text="Tell ApplyGo about your background: your recent roles, key projects, and any measurable results (metrics, scale, impact). This becomes the foundation of your profile.",
                rationale="Your profile has no evidence yet, so ApplyGo can't ground résumés or job matches.",
                requirement_level="required",
                related_job_ids=[],
            )
        )
        session.commit()


def mark_job_interested(session: Session, profile: CandidateProfile, job: JobPosting, settings: Settings | None = None) -> dict[str, Any]:
    job.interested = True
    job.interested_at = datetime.now(UTC)
    job.profile_id = profile.id
    session.commit()
    analysis = analyze_job_requirements(session, profile, job, settings=settings)
    sync_improve_questions_for_job(session, profile, job, analysis)
    return analysis


def open_questions_for_profile(session: Session, profile_id: str) -> list[ImproveQuestion]:
    questions = list(session.scalars(select(ImproveQuestion).where(ImproveQuestion.profile_id == profile_id, ImproveQuestion.status == "open")))
    return sorted(questions, key=lambda question: question.priority, reverse=True)


def answer_improve_question(session: Session, profile: CandidateProfile, question: ImproveQuestion, answer_text: str) -> CandidateEvidence:
    evidence = CandidateEvidence(
        profile_id=profile.id,
        category=question.category,
        claim=answer_text.strip(),
        verification_status="user_confirmed",
        usable_in_applications=True,
        metadata_json={"source": "improve_question", "improve_question_id": question.id},
    )
    session.add(evidence)
    session.flush()
    question.status = "answered"
    question.answer_text = answer_text.strip()
    question.answered_at = datetime.now(UTC)
    question.resulting_evidence_id = evidence.id
    session.commit()
    reanalyze_jobs_after_answer(session, question, evidence)
    return evidence


def reanalyze_jobs_after_answer(session: Session, question: ImproveQuestion, evidence: CandidateEvidence) -> None:
    """Deterministically patch affected job analyses instead of re-running the LLM.

    Reserves the LLM call for the next time a job's description or evidence set
    materially changes; a single confirmed answer is enough to flip a requirement's
    status without re-deriving the rest of the analysis.
    """
    for job_id in question.related_job_ids or []:
        job = session.get(JobPosting, job_id)
        if job is None or not job.requirements_analysis:
            continue
        analysis = dict(job.requirements_analysis)
        evidence_map = dict(analysis.get("evidence_map", {}))
        changed = False
        for requirement in analysis.get("requirements", []):
            if requirement["category"] == question.category:
                evidence_map[requirement["id"]] = {"status": "supported", "evidence_ids": [evidence.id], "rationale": "Confirmed via Profile > Improve."}
                changed = True
        if changed:
            analysis["evidence_map"] = evidence_map
            job.requirements_analysis = analysis
    session.commit()


def generate_cover_letter_version(session: Session, profile: CandidateProfile, job: JobPosting, settings: Settings | None = None) -> CoverLetterVersion:
    settings = settings or get_settings()
    evidence = approved_evidence(session, profile.id)
    claims = [{"id": item.id, "claim": item.claim} for item in evidence]
    analysis = analyze_job_requirements(session, profile, job, settings=settings)
    name = profile.user.display_name
    supported = [req["text"] for req in analysis.get("requirements", []) if analysis.get("evidence_map", {}).get(req["id"], {}).get("status") == "supported"]
    mock_markdown = (
        f"# {name}\n\n{job.company} — {job.title}\n\n"
        f"Dear Hiring Team,\n\nI'm excited to apply for {job.title} at {job.company}. "
        + (f"My experience with {', '.join(supported[:4])} maps directly to what you're looking for. " if supported else "")
        + "\n\n"
        + "\n".join(f"- {item.claim}" for item in evidence[:5])
        + "\n\nSincerely,\n" + name
    )
    mock = {"content_markdown": mock_markdown, "source_evidence_ids": [item.id for item in evidence]}
    instruction = get_text_prompt(settings, "legacy/cover-letter/draft")
    result = ModelRouter(settings).invoke(
        ModelTask.DOCUMENT_DRAFTING,
        instruction,
        {"candidate_name": name, "profile_summary": profile.summary, "approved_evidence": claims, "job": {"title": job.title, "company": job.company, "description": job.raw_description}, "requirements_analysis": analysis},
        mock_output=mock,
    )
    cover_letter = CoverLetterVersion(
        profile_id=profile.id,
        job_id=job.id,
        content_markdown=str(result.output.get("content_markdown", mock_markdown)),
        provider=result.provider,
        model=result.model,
        source_evidence_ids=list(result.output.get("source_evidence_ids", mock["source_evidence_ids"])),
    )
    session.add(cover_letter)
    session.commit()
    session.refresh(cover_letter)
    return cover_letter
