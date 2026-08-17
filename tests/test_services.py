from types import SimpleNamespace

from applygo.services import (
    build_rationale,
    deterministic_fit,
    deterministic_requirements_analysis,
    job_improvement_count,
    match_requirement_deterministic,
    normalize_job,
)


def test_normalize_job_extracts_known_signals() -> None:
    result = normalize_job("Remote Python machine learning role using Docker and SQL")
    assert result["remote"] is True
    assert {"python", "machine learning", "docker", "sql"}.issubset(result["skills"])


def test_fit_ignores_unapproved_evidence() -> None:
    profile = SimpleNamespace(summary="AI engineer")
    job = SimpleNamespace(raw_description="Python machine learning", normalized={"skills": ["python"]})
    evidence = [
        SimpleNamespace(id="1", claim="Built Python systems", usable_in_applications=False, verification_status="unreviewed"),
        SimpleNamespace(id="2", claim="Used machine learning", usable_in_applications=True, verification_status="user_confirmed"),
    ]
    result = deterministic_fit(profile, evidence, job)
    ids = {item["evidence_id"] for item in result["strong_matches"]}
    assert "1" not in ids
    assert "2" in ids


def test_requirement_gap_defaults_to_unknown_not_missing() -> None:
    requirement = {"category": "sql", "hard_constraint": False}
    result = match_requirement_deterministic(requirement, evidence=[])
    assert result["status"] == "unknown"


def test_requirement_supported_when_evidence_matches() -> None:
    requirement = {"category": "sql", "hard_constraint": False}
    evidence = [SimpleNamespace(id="1", claim="Wrote SQL queries against Postgres", usable_in_applications=True, verification_status="verified")]
    result = match_requirement_deterministic(requirement, evidence)
    assert result["status"] == "supported"
    assert result["evidence_ids"] == ["1"]


def test_requirement_hard_constraint_without_evidence() -> None:
    requirement = {"category": "work_authorization", "hard_constraint": True}
    result = match_requirement_deterministic(requirement, evidence=[])
    assert result["status"] == "hard_constraint"


def test_deterministic_requirements_analysis_extracts_multiple_requirements() -> None:
    profile = SimpleNamespace()
    job = SimpleNamespace(raw_description="Looking for a Python and SQL engineer, Docker required, bachelor's degree required.")
    analysis = deterministic_requirements_analysis(profile, evidence=[], job=job)
    categories = {req["category"] for req in analysis["requirements"]}
    assert {"python", "sql", "docker", "degree"}.issubset(categories)
    docker_req = next(req for req in analysis["requirements"] if req["category"] == "docker")
    assert docker_req["requirement_level"] == "required"


def test_job_improvement_count_excludes_hard_constraints_and_supported() -> None:
    job = SimpleNamespace(
        requirements_analysis={
            "requirements": [
                {"id": "r1", "category": "sql", "hard_constraint": False},
                {"id": "r2", "category": "degree", "hard_constraint": True},
                {"id": "r3", "category": "python", "hard_constraint": False},
            ],
            "evidence_map": {
                "r1": {"status": "unknown"},
                "r2": {"status": "hard_constraint"},
                "r3": {"status": "supported"},
            },
        }
    )
    assert job_improvement_count(job) == 1


def test_build_rationale_singular_and_plural() -> None:
    one_job = [SimpleNamespace(company="Acme", title="Engineer")]
    two_jobs = [SimpleNamespace(company="Acme", title="Engineer"), SimpleNamespace(company="Globex", title="Analyst")]
    assert "1 of your Interested role" in build_rationale(one_job)
    assert "2 of your Interested roles" in build_rationale(two_jobs)
