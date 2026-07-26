from applygo.config import Settings
from applygo.model_router import ExecutionMode, ModelRouter, ModelTask


def test_router_uses_default_provider_when_task_route_missing(tmp_path) -> None:
    settings = Settings(
        database_url=f"sqlite:///{tmp_path / 'applygo.db'}",
        storage_dir=tmp_path / "private",
        model_provider="mock",
        model_name="mock-default",
    )
    route = ModelRouter(settings).route_for(ModelTask.FIT_ASSESSMENT)
    assert route.provider == "mock"
    assert route.model == "mock-default"
    assert route.execution_mode is ExecutionMode.SYNCHRONOUS


def test_router_supports_task_specific_claude_routine(tmp_path) -> None:
    settings = Settings(
        database_url=f"sqlite:///{tmp_path / 'applygo.db'}",
        storage_dir=tmp_path / "private",
        model_routes_json=(
            '{"background_research": {'
            '"provider": "claude_routine", '
            '"model": "sonnet", '
            '"execution_mode": "queued"}}'
        ),
    )
    route = ModelRouter(settings).route_for(ModelTask.BACKGROUND_RESEARCH)
    assert route.provider == "claude_routine"
    assert route.model == "sonnet"
    assert route.execution_mode is ExecutionMode.QUEUED


def test_mock_adapter_preserves_route_metadata(tmp_path) -> None:
    settings = Settings(
        database_url=f"sqlite:///{tmp_path / 'applygo.db'}",
        storage_dir=tmp_path / "private",
        model_routes_json=(
            '{"fit_assessment": {'
            '"provider": "mock", '
            '"model": "mock-fit", '
            '"execution_mode": "local"}}'
        ),
    )
    result = ModelRouter(settings).invoke(
        ModelTask.FIT_ASSESSMENT,
        "Return JSON",
        {"job": "example"},
        mock_output={"overall_score": 42},
    )
    assert result.output == {"overall_score": 42}
    assert result.provider == "mock"
    assert result.model == "mock-fit"
    assert result.execution_mode is ExecutionMode.LOCAL
