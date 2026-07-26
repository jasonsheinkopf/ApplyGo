from types import SimpleNamespace

from applygo.services import deterministic_fit, normalize_job


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
