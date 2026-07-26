from __future__ import annotations

import json
import os
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy import select
from sqlalchemy.orm import Session

from applygo.config import get_settings
from applygo.db import get_session, init_db
from applygo.models import CandidateEvidence, CandidateProfile, JobPosting, ResumeVersion, User
from applygo.services import create_evidence_from_text, generate_profile_summary, generate_resume_version, normalize_job, run_fit_assessment, store_document

BASE_DIR = Path(__file__).parent
app = FastAPI(title="ApplyGo", version="0.3.0")
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")


@app.on_event("startup")
def startup() -> None:
    init_db()


def require_profile(session: Session, profile_id: str) -> CandidateProfile:
    profile = session.get(CandidateProfile, profile_id)
    if profile is None:
        raise HTTPException(404, "Profile not found")
    return profile


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/", response_class=HTMLResponse)
def dashboard(request: Request, session: Session = Depends(get_session)) -> HTMLResponse:
    profiles = list(session.scalars(select(CandidateProfile).order_by(CandidateProfile.created_at.desc())))
    jobs = list(session.scalars(select(JobPosting).order_by(JobPosting.created_at.desc())))
    return templates.TemplateResponse(request, "index.html", {"profiles": profiles, "jobs": jobs})


@app.get("/setup", response_class=HTMLResponse)
def setup_page(request: Request) -> HTMLResponse:
    settings = get_settings()
    providers = {
        "openai": bool(settings.openai_api_key),
        "anthropic": bool(settings.anthropic_api_key),
        "ollama": bool(settings.ollama_base_url),
        "claude_code": os.system("command -v claude >/dev/null 2>&1") == 0,
        "claude_routine": bool(settings.claude_routine_url and settings.claude_routine_token),
    }
    return templates.TemplateResponse(request, "setup.html", {"settings": settings, "providers": providers})


@app.post("/setup/providers")
def save_provider_settings(
    provider: str = Form(...),
    model: str = Form(...),
    openai_api_key: str = Form(""),
    anthropic_api_key: str = Form(""),
    ollama_base_url: str = Form("http://localhost:11434/v1"),
    claude_routine_url: str = Form(""),
    claude_routine_token: str = Form(""),
) -> RedirectResponse:
    allowed = {"mock", "openai", "anthropic", "ollama", "openai_compatible", "claude_code", "claude_routine"}
    if provider not in allowed:
        raise HTTPException(400, "Unsupported provider")
    path = Path("data/private/provider.env")
    path.parent.mkdir(parents=True, exist_ok=True)
    values = {
        "APPLYGO_MODEL_PROVIDER": provider,
        "APPLYGO_MODEL_NAME": model.strip() or "default",
        "OPENAI_API_KEY": openai_api_key.strip(),
        "ANTHROPIC_API_KEY": anthropic_api_key.strip(),
        "OLLAMA_BASE_URL": ollama_base_url.strip(),
        "CLAUDE_ROUTINE_URL": claude_routine_url.strip(),
        "CLAUDE_ROUTINE_TOKEN": claude_routine_token.strip(),
    }
    path.write_text("\n".join(f"{key}={value}" for key, value in values.items() if value) + "\n", encoding="utf-8")
    path.chmod(0o600)
    get_settings.cache_clear()
    return RedirectResponse("/setup?saved=1", status_code=303)


@app.post("/profiles")
def create_profile(display_name: str = Form(...), label: str = Form("Primary profile"), summary: str = Form(""), session: Session = Depends(get_session)) -> RedirectResponse:
    user = User(display_name=display_name)
    session.add(user)
    session.flush()
    profile = CandidateProfile(user_id=user.id, label=label, summary=summary)
    session.add(profile)
    session.commit()
    return RedirectResponse(f"/profiles/{profile.id}", status_code=303)


@app.get("/profiles/{profile_id}", response_class=HTMLResponse)
def profile_page(profile_id: str, request: Request, session: Session = Depends(get_session)) -> HTMLResponse:
    profile = require_profile(session, profile_id)
    evidence = list(session.scalars(select(CandidateEvidence).where(CandidateEvidence.profile_id == profile.id).order_by(CandidateEvidence.created_at.desc())))
    resumes = list(session.scalars(select(ResumeVersion).where(ResumeVersion.profile_id == profile.id).order_by(ResumeVersion.created_at.desc())))
    return templates.TemplateResponse(request, "profile.html", {"profile": profile, "evidence": evidence, "resumes": resumes, "documents": profile.documents})


@app.post("/profiles/{profile_id}/preferences")
def update_preferences(
    profile_id: str,
    target_roles: str = Form(""),
    locations: str = Form(""),
    minimum_compensation: str = Form(""),
    work_style: str = Form(""),
    requirements: str = Form(""),
    session: Session = Depends(get_session),
) -> RedirectResponse:
    profile = require_profile(session, profile_id)
    profile.preferences = {**(profile.preferences or {}), "target_roles": target_roles, "locations": locations, "minimum_compensation": minimum_compensation, "work_style": work_style, "requirements": requirements}
    session.commit()
    return RedirectResponse(f"/profiles/{profile.id}#profile", status_code=303)


@app.post("/profiles/{profile_id}/generate-summary")
def regenerate_summary(profile_id: str, session: Session = Depends(get_session)) -> RedirectResponse:
    generate_profile_summary(session, require_profile(session, profile_id))
    return RedirectResponse(f"/profiles/{profile_id}#profile", status_code=303)


@app.post("/profiles/{profile_id}/documents")
async def upload_document(profile_id: str, file: UploadFile = File(...), session: Session = Depends(get_session)) -> RedirectResponse:
    profile = require_profile(session, profile_id)
    data = await file.read()
    if len(data) > 15 * 1024 * 1024:
        raise HTTPException(413, "File exceeds 15 MB")
    if file.content_type not in {"application/pdf", "text/plain", "text/markdown"}:
        raise HTTPException(415, "Only PDF, text, and Markdown are accepted")
    document = store_document(session, profile, file.filename or "upload", file.content_type or "application/octet-stream", data)
    create_evidence_from_text(session, profile, document.extracted_text, document.id)
    return RedirectResponse(f"/profiles/{profile.id}#sources", status_code=303)


@app.post("/profiles/{profile_id}/notes")
def add_notes(profile_id: str, notes: str = Form(...), session: Session = Depends(get_session)) -> RedirectResponse:
    profile = require_profile(session, profile_id)
    create_evidence_from_text(session, profile, notes)
    return RedirectResponse(f"/profiles/{profile.id}#evidence", status_code=303)


@app.post("/profiles/{profile_id}/resumes")
def create_resume(profile_id: str, purpose: str = Form("General-purpose résumé"), session: Session = Depends(get_session)) -> RedirectResponse:
    resume = generate_resume_version(session, require_profile(session, profile_id), purpose)
    return RedirectResponse(f"/profiles/{profile_id}#resume-{resume.id}", status_code=303)


@app.post("/resumes/{resume_id}/delete")
def delete_resume(resume_id: str, session: Session = Depends(get_session)) -> RedirectResponse:
    resume = session.get(ResumeVersion, resume_id)
    if resume is None:
        raise HTTPException(404, "Résumé version not found")
    profile_id = resume.profile_id
    session.delete(resume)
    session.commit()
    return RedirectResponse(f"/profiles/{profile_id}#resumes", status_code=303)


@app.post("/evidence/{evidence_id}/review")
def review_evidence(evidence_id: str, status: str = Form(...), usable: bool = Form(False), session: Session = Depends(get_session)) -> RedirectResponse:
    evidence = session.get(CandidateEvidence, evidence_id)
    if evidence is None:
        raise HTTPException(404, "Evidence not found")
    if status not in {"unreviewed", "verified", "user_confirmed", "rejected"}:
        raise HTTPException(400, "Invalid status")
    evidence.verification_status = status
    evidence.usable_in_applications = usable and status in {"verified", "user_confirmed"}
    session.commit()
    return RedirectResponse(f"/profiles/{evidence.profile_id}#evidence", status_code=303)


@app.post("/jobs")
def create_job(profile_id: str = Form(...), title: str = Form(...), company: str = Form(...), source_url: str = Form(""), description: str = Form(...), session: Session = Depends(get_session)) -> RedirectResponse:
    require_profile(session, profile_id)
    job = JobPosting(title=title, company=company, source_url=source_url, raw_description=description, normalized=normalize_job(description))
    session.add(job)
    session.commit()
    session.refresh(job)
    assessment = run_fit_assessment(session, require_profile(session, profile_id), job)
    return RedirectResponse(f"/jobs/{job.id}?assessment={assessment.id}", status_code=303)


@app.get("/jobs/{job_id}", response_class=HTMLResponse)
def job_page(job_id: str, request: Request, session: Session = Depends(get_session)) -> HTMLResponse:
    job = session.get(JobPosting, job_id)
    if job is None:
        raise HTTPException(404, "Job not found")
    assessments = sorted(job.assessments, key=lambda item: item.created_at, reverse=True)
    return templates.TemplateResponse(request, "job.html", {"job": job, "assessments": assessments})
