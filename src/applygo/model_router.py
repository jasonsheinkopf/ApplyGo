from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Protocol

import httpx
from anthropic import Anthropic
from openai import OpenAI

from applygo.config import Settings, get_settings


class ModelTask(StrEnum):
    FIT_ASSESSMENT = "fit_assessment"
    DOCUMENT_EXTRACTION = "document_extraction"
    DOCUMENT_DRAFTING = "document_drafting"
    BACKGROUND_RESEARCH = "background_research"
    INTERACTIVE_ASSISTANCE = "interactive_assistance"


class ExecutionMode(StrEnum):
    SYNCHRONOUS = "synchronous"
    LOCAL = "local"
    QUEUED = "queued"


@dataclass(frozen=True)
class ModelRoute:
    provider: str
    model: str
    execution_mode: ExecutionMode


@dataclass(frozen=True)
class ModelResult:
    output: dict[str, Any]
    usage: dict[str, Any]
    provider: str
    model: str
    execution_mode: ExecutionMode


class ModelAdapter(Protocol):
    def invoke(self, instruction: str, payload: dict[str, Any], route: ModelRoute) -> ModelResult: ...


class MockAdapter:
    def __init__(self, output: dict[str, Any]) -> None:
        self.output = output

    def invoke(self, instruction: str, payload: dict[str, Any], route: ModelRoute) -> ModelResult:
        del instruction, payload
        return ModelResult(self.output, {}, route.provider, route.model, route.execution_mode)


class OpenAIAdapter:
    def invoke(self, instruction: str, payload: dict[str, Any], route: ModelRoute) -> ModelResult:
        client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
        response = client.chat.completions.create(
            model=route.model,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": instruction},
                {"role": "user", "content": json.dumps(payload)},
            ],
        )
        content = response.choices[0].message.content or "{}"
        usage = {"total_tokens": response.usage.total_tokens if response.usage else None}
        return ModelResult(json.loads(content), usage, route.provider, route.model, route.execution_mode)


class OpenAICompatibleAdapter:
    def __init__(self, base_url: str, api_key: str) -> None:
        self.base_url = base_url
        self.api_key = api_key

    def invoke(self, instruction: str, payload: dict[str, Any], route: ModelRoute) -> ModelResult:
        client = OpenAI(api_key=self.api_key, base_url=self.base_url)
        response = client.chat.completions.create(
            model=route.model,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": instruction},
                {"role": "user", "content": json.dumps(payload)},
            ],
        )
        content = response.choices[0].message.content or "{}"
        usage = {"total_tokens": response.usage.total_tokens if response.usage else None}
        return ModelResult(json.loads(content), usage, route.provider, route.model, route.execution_mode)


class AnthropicAdapter:
    def invoke(self, instruction: str, payload: dict[str, Any], route: ModelRoute) -> ModelResult:
        response = Anthropic().messages.create(
            model=route.model,
            max_tokens=2500,
            system=instruction,
            messages=[{"role": "user", "content": json.dumps(payload)}],
        )
        text = "".join(block.text for block in response.content if hasattr(block, "text"))
        usage = {
            "input_tokens": response.usage.input_tokens,
            "output_tokens": response.usage.output_tokens,
        }
        return ModelResult(json.loads(text), usage, route.provider, route.model, route.execution_mode)


class ClaudeCodeAdapter:
    def invoke(self, instruction: str, payload: dict[str, Any], route: ModelRoute) -> ModelResult:
        executable = shutil.which("claude")
        if executable is None:
            raise RuntimeError("Claude Code is not installed or not available on PATH")
        prompt = f"{instruction}\n\nINPUT JSON:\n{json.dumps(payload)}"
        completed = subprocess.run(
            [executable, "--print", "--output-format", "json", prompt],
            check=True,
            capture_output=True,
            text=True,
            timeout=300,
        )
        envelope = json.loads(completed.stdout)
        raw = envelope.get("result", envelope)
        output = json.loads(raw) if isinstance(raw, str) else raw
        return ModelResult(output, {}, route.provider, route.model, route.execution_mode)


class ClaudeRoutineAdapter:
    def __init__(self, url: str, token: str) -> None:
        self.url = url
        self.token = token

    def invoke(self, instruction: str, payload: dict[str, Any], route: ModelRoute) -> ModelResult:
        response = httpx.post(
            self.url,
            headers={"Authorization": f"Bearer {self.token}"},
            json={"text": instruction, "payload": payload, "model": route.model},
            timeout=30,
        )
        response.raise_for_status()
        body = response.json() if response.content else {}
        return ModelResult(body, {}, route.provider, route.model, route.execution_mode)


class ModelRouter:
    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()

    def route_for(self, task: ModelTask) -> ModelRoute:
        configured = self.settings.model_routes.get(task.value)
        if configured:
            return ModelRoute(
                provider=str(configured["provider"]).lower(),
                model=str(configured["model"]),
                execution_mode=ExecutionMode(str(configured.get("execution_mode", "synchronous"))),
            )
        return ModelRoute(
            provider=self.settings.model_provider.lower(),
            model=self.settings.model_name,
            execution_mode=ExecutionMode.SYNCHRONOUS,
        )

    def adapter_for(self, route: ModelRoute, mock_output: dict[str, Any]) -> ModelAdapter:
        if route.provider == "mock":
            return MockAdapter(mock_output)
        if route.provider == "openai":
            return OpenAIAdapter()
        if route.provider == "anthropic":
            return AnthropicAdapter()
        if route.provider == "ollama":
            return OpenAICompatibleAdapter(self.settings.ollama_base_url, self.settings.ollama_api_key)
        if route.provider == "openai_compatible":
            return OpenAICompatibleAdapter(
                self.settings.openai_compatible_base_url,
                self.settings.openai_compatible_api_key,
            )
        if route.provider == "claude_code":
            return ClaudeCodeAdapter()
        if route.provider == "claude_routine":
            if not self.settings.claude_routine_url or not self.settings.claude_routine_token:
                raise RuntimeError("Claude Routine URL and token must be configured")
            return ClaudeRoutineAdapter(
                self.settings.claude_routine_url,
                self.settings.claude_routine_token,
            )
        raise ValueError(f"Unsupported model provider: {route.provider}")

    def invoke(
        self,
        task: ModelTask,
        instruction: str,
        payload: dict[str, Any],
        mock_output: dict[str, Any],
    ) -> ModelResult:
        route = self.route_for(task)
        adapter = self.adapter_for(route, mock_output)
        return adapter.invoke(instruction, payload, route)
