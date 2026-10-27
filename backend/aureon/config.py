"""Runtime configuration. Everything sensitive comes from environment variables (.env)."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", env_prefix="AUREON_", extra="ignore")

    data_dir: Path = ROOT / "data"
    db_path: Path | None = None
    log_level: str = "INFO"
    host: str = "127.0.0.1"
    port: int = 8000
    # Public deployments: block uploads / imports / collection so visitors can't change the data.
    read_only: bool = False
    # Real MCX data shipped with the code; loaded automatically into an empty database on start.
    seed_dir: Path = ROOT / "data" / "seed"

    # TinyFish web-agent API. The key is read from TINYFISH_API_KEY (no AUREON_ prefix) as well.
    tinyfish_api_key: str | None = None
    tinyfish_base_url: str = "https://agent.tinyfish.ai"
    tinyfish_timeout_s: int = 600
    tinyfish_browser_profile: str = "stealth"
    tinyfish_proxy_country: str | None = "IN"

    @property
    def database(self) -> Path:
        return self.db_path or (self.data_dir / "aureon.db")

    @property
    def prebuilt_dir(self) -> Path:
        return self.data_dir / "prebuilt"

    @property
    def raw_dir(self) -> Path:
        return self.data_dir / "raw"

    @property
    def import_dir(self) -> Path:
        return self.data_dir / "import"


@lru_cache
def get_settings() -> Settings:
    import os

    s = Settings()
    # Hosting platforms (Render, Railway, Fly, Heroku…) pass the port to listen on as PORT.
    if os.environ.get("PORT") and not os.environ.get("AUREON_PORT"):
        s.port = int(os.environ["PORT"])
    if not s.tinyfish_api_key and os.environ.get("TINYFISH_API_KEY"):
        s.tinyfish_api_key = os.environ["TINYFISH_API_KEY"]
    if not s.tinyfish_api_key:
        # Allow a plain TINYFISH_API_KEY entry inside .env as well.
        env = ROOT / ".env"
        if env.exists():
            for line in env.read_text(encoding="utf-8").splitlines():
                if line.strip().startswith("TINYFISH_API_KEY="):
                    s.tinyfish_api_key = line.split("=", 1)[1].strip().strip('"') or None
    for d in (s.data_dir, s.raw_dir, s.import_dir):
        d.mkdir(parents=True, exist_ok=True)
    return s
