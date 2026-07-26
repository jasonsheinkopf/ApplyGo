import os
from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="APPLYGO_", extra="ignore")

    env: str = "development"
    database_url: str = "sqlite:///./data/applygo.db"
    storage_dir: Path = Path("./data/private")
    secret_key: str = "development-only-change-me"
    model_provider: str = "mock"
    model_name: str = "mock-fit-v1"

    openai_api_key: str | None = Field(default=None, validation_alias="OPENAI_API_KEY")
    anthropic_api_key: str | None = Field(default=None, validation_alias="ANTHROPIC_API_KEY")
    ollama_base_url: str = Field(
        default="http://localhost:11434/v1",
        validation_alias="OLLAMA_BASE_URL",
    )
    ollama_api_key: str = Field(default="ollama", validation_alias="OLLAMA_API_KEY")

    def ensure_runtime_dirs(self) -> None:
        self.storage_dir.mkdir(parents=True, exist_ok=True)
        if self.database_url.startswith("sqlite"):
            Path("./data").mkdir(parents=True, exist_ok=True)

    def expose_provider_environment(self) -> None:
        values = {
            "OPENAI_API_KEY": self.openai_api_key,
            "ANTHROPIC_API_KEY": self.anthropic_api_key,
            "OLLAMA_BASE_URL": self.ollama_base_url,
            "OLLAMA_API_KEY": self.ollama_api_key,
        }
        for name, value in values.items():
            if value:
                os.environ.setdefault(name, value)


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.ensure_runtime_dirs()
    settings.expose_provider_environment()
    return settings
