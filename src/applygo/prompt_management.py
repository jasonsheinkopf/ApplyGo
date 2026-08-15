from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import quote

import httpx

if TYPE_CHECKING:
    from applygo.config import Settings

_MEMORY: dict[str, tuple[float, dict[str, Any]]] = {}
_TTL_SECONDS = 300
_VARIABLE = re.compile(r"{{\s*([A-Za-z_]+)\s*}}")


def compile_prompt(template: str, variables: dict[str, str]) -> str:
    for name in variables:
        if not re.fullmatch(r"[A-Za-z_]+", name):
            raise ValueError(f"langfuse_prompt_invalid_variable:{name}")
    required = set(_VARIABLE.findall(template))
    missing = sorted(required.difference(variables))
    if missing:
        raise ValueError(f"langfuse_prompt_missing_variables:{','.join(missing)}")
    without_empty_lines = re.sub(
        r"^[\t ]*{{\s*([A-Za-z_]+)\s*}}[\t ]*(?:\r?\n|$)",
        lambda match: "" if variables[match.group(1)] == "" else match.group(0),
        template,
        flags=re.MULTILINE,
    )
    compiled = _VARIABLE.sub(lambda match: variables[match.group(1)], without_empty_lines)
    if re.search(r"{{[^{}]+}}", compiled):
        raise ValueError("langfuse_prompt_unresolved_variable")
    return compiled


def _cache_path(settings: Settings) -> Path:
    return settings.storage_dir / "langfuse-prompt-cache.json"


def _read_disk(settings: Settings, name: str) -> dict[str, Any] | None:
    try:
        body = json.loads(_cache_path(settings).read_text(encoding="utf-8"))
        value = body.get(name)
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def _write_disk(settings: Settings, name: str, prompt: dict[str, Any]) -> None:
    path = _cache_path(settings)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        body = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    except (OSError, ValueError):
        body = {}
    body[name] = prompt
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(body), encoding="utf-8")
    temporary.replace(path)


def get_text_prompt(settings: Settings, name: str, variables: dict[str, str] | None = None) -> str:
    key = f"{settings.langfuse_base_url}:{settings.langfuse_public_key or ''}:{name}"
    cached = _MEMORY.get(key)
    prompt = cached[1] if cached and cached[0] > time.time() else None
    fetch_error: Exception | None = None
    if prompt is None and settings.langfuse_public_key and settings.langfuse_secret_key:
        try:
            response = httpx.get(
                f"{settings.langfuse_base_url.rstrip('/')}/api/public/v2/prompts/{quote(name, safe='')}",
                params={"label": "production"},
                auth=(settings.langfuse_public_key, settings.langfuse_secret_key),
                timeout=10,
            )
            response.raise_for_status()
            prompt = response.json()
            if prompt.get("type") != "text" or not isinstance(prompt.get("prompt"), str):
                raise RuntimeError(f"langfuse_prompt_wrong_type:{name}")
            _MEMORY[key] = (time.time() + _TTL_SECONDS, prompt)
            _write_disk(settings, name, prompt)
        except Exception as exc:  # use last-known-good below
            fetch_error = exc
    if prompt is None:
        prompt = _read_disk(settings, name)
    if prompt is None:
        raise RuntimeError(f"langfuse_prompt_unavailable:{name}") from fetch_error
    return compile_prompt(str(prompt["prompt"]), variables or {})
