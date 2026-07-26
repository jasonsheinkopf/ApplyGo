from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from applygo.services import deterministic_fit, normalize_job


def main() -> None:
    cases = json.loads(Path("evaluation/cases.json").read_text(encoding="utf-8"))
    failures: list[str] = []
    for case in cases:
        evidence = [SimpleNamespace(**item) for item in case["candidate_evidence"]]
        job_data = case["job"]
        job = SimpleNamespace(
            title=job_data["title"],
            company=job_data["company"],
            raw_description=job_data["description"],
            normalized=normalize_job(job_data["description"]),
        )
        result = deterministic_fit(SimpleNamespace(summary=""), evidence, job)
        expected = case["expected"]
        if result["overall_score"] < expected.get("minimum_score", 0):
            failures.append(f"{case['id']}: score below minimum")
        if result["overall_score"] > expected.get("maximum_score", 100):
            failures.append(f"{case['id']}: score above maximum")
        used = {item["evidence_id"] for item in result["strong_matches"]}
        if not set(expected.get("required_evidence_ids", [])).issubset(used):
            failures.append(f"{case['id']}: required evidence missing")
        if set(expected.get("forbidden_evidence_ids", [])) & used:
            failures.append(f"{case['id']}: forbidden evidence used")
        if expected.get("requires_questions") and not result["questions_for_user"]:
            failures.append(f"{case['id']}: expected follow-up questions")
        print(json.dumps({"case": case["id"], "result": result}, indent=2))
    if failures:
        raise SystemExit("\n".join(failures))


if __name__ == "__main__":
    main()
