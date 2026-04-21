import os
from functools import lru_cache
from typing import List

from dotenv import load_dotenv

# Load backend/.env automatically so OpenAI credentials work
# even after server restarts (especially on new PCs).
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"))


class Settings:
    def __init__(self) -> None:
        # Security
        self.secret_key: str = os.getenv("SECRET_KEY", "dev-change-me")
        self.algorithm: str = os.getenv("JWT_ALGORITHM", "HS256")
        self.access_token_expire_hours: int = int(os.getenv("ACCESS_TOKEN_EXPIRE_HOURS", "24"))

        # AI (Gemini)
        raw_key = os.getenv("GEMINI_API_KEY")
        if raw_key:
            # Users sometimes paste keys with surrounding quotes; strip them.
            raw_key = raw_key.strip().strip('"').strip("'")
        self.gemini_api_key: str | None = raw_key or None
        # Use a modern Flash model that is available on Gemini's free tier.
        # You can override as needed with GEMINI_MODEL env var.
        self.gemini_model: str = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

        # Database
        _db_url = os.getenv("DATABASE_URL", "sqlite:///./messenger.db")
        if _db_url.startswith("postgres://"):
            _db_url = "postgresql://" + _db_url[len("postgres://"):]
        self.database_url: str = _db_url

        # CORS
        default_origins = [
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://192.168.1.62:5173",
        ]
        raw = os.getenv("CORS_ORIGINS", "")
        if raw.strip():
            self.cors_origins: List[str] = [o.strip() for o in raw.split(",") if o.strip()]
        else:
            self.cors_origins = default_origins


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()

