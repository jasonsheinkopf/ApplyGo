from __future__ import annotations

import pytest

from applygo.prompt_management import compile_prompt


def test_compile_prompt_replaces_variables() -> None:
    assert compile_prompt("Hello {{first_name}}", {"first_name": "Ada"}) == "Hello Ada"


def test_compile_prompt_rejects_missing_variables() -> None:
    with pytest.raises(ValueError, match="langfuse_prompt_missing_variables:company"):
        compile_prompt("Hello {{first_name}} at {{company}}", {"first_name": "Ada"})


def test_compile_prompt_rejects_invalid_variable_names() -> None:
    with pytest.raises(ValueError, match="langfuse_prompt_invalid_variable"):
        compile_prompt("Hello", {"first-name": "Ada"})
