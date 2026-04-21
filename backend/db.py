from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

from settings import get_settings

settings = get_settings()

_is_sqlite = settings.database_url.startswith("sqlite")
_connect_args = {"check_same_thread": False, "timeout": 30} if _is_sqlite else {}

engine = create_engine(
    settings.database_url,
    connect_args=_connect_args,
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()