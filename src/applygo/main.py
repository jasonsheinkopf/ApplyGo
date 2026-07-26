from __future__ import annotations

from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy import select
from sqlalchemy.orm import Session

from applygo.db import get_session, init_db
from applygo.models import CandidateEvidence, CandidateProfile, JobPosting, User
from applygo.services import create_evidence_from_text, normalize_job, run_fit_assessment, store_document

BASE_DIR = Path(__file__).parent
app = FastAPI(title="ApplyGo", version="0.2.0")
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
    return templates.TemplateResponse(request, "profile.html", {"profile": profile, "evidence": evidence})


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
    return RedirectResponse(f"/profiles/{profile.id}", status_code=303)


@app.post("/profiles/{profile_id}/notes")
def add_notes(profile_id: str, notes: str = Form(...), session: Session = Depends(get_session)) -> RedirectResponse:
    profile = require_profile(session, profile_id)
    create_evidence_from_text(session, profile, notes)
    return RedirectResponse(f"/profiles/{profile.id}", status_code=303)


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
    return RedirectResponse(f"/profiles/{evidence.profile_id}", status_code=303)


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
