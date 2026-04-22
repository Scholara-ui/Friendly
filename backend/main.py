from __future__ import annotations

import asyncio
import hashlib
import logging
import json
import re
import resend as _resend_sdk
import secrets
import uuid
from pathlib import Path
import time
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any, Dict, List, Set, Tuple

from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from fastapi.staticfiles import StaticFiles
from sqlalchemy import func, text
from sqlalchemy.orm import Session, aliased

from auth import create_access_token, decode_token, hash_password, verify_password
from db import Base, SessionLocal, engine
from models import (
    Conversation,
    ConversationParticipant,
    ConversationDeliveryState,
    ConversationReadState,
    Message,
    PasswordResetToken,
    User,
)
from schemas import (
    ConversationCreateRequest,
    GroupConversationCreateRequest,
    ConversationSummary,
    UserPublic,
    LoginRequest,
    MeResponse,
    RegisterRequest,
    ForgotPasswordRequest,
    ResetPasswordRequest,
    TokenResponse,
    MessageCreateRequest,
    MessageEditRequest,
    MessageOut,
    DeliveredOut,
    DeliveredUpdateRequest,
    ReadReceiptOut,
    ReadReceiptUpdateRequest,
    ConversationStatesOut,
    ProfileUpdateRequest,
    AiPolishRequest,
    AiPolishResponse,
    AiSuggestionsRequest,
    AiSuggestionsResponse,
)
from settings import get_settings

from google import genai
from google.genai.types import GenerateContentConfig

logger = logging.getLogger(__name__)

settings = get_settings()

app = FastAPI(title="Friendly Messenger API")

uploads_dir = Path(__file__).resolve().parent / "uploads"
uploads_dir.mkdir(parents=True, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=str(uploads_dir)), name="uploads")

MAX_AVATAR_BYTES = 2 * 1024 * 1024  # 2MB
MAX_MESSAGE_IMAGE_BYTES = 6 * 1024 * 1024  # 6MB

message_uploads_dir = uploads_dir / "messages"
message_uploads_dir.mkdir(parents=True, exist_ok=True)

status_uploads_dir = uploads_dir / "status"
status_uploads_dir.mkdir(parents=True, exist_ok=True)

# Cloudinary (persistent storage). If credentials are not set, we fall back to
# writing to local disk (ephemeral on Render free tier).
import cloudinary
import cloudinary.uploader

_cloudinary_configured = False
if (
    settings.cloudinary_cloud_name
    and settings.cloudinary_api_key
    and settings.cloudinary_api_secret
):
    cloudinary.config(
        cloud_name=settings.cloudinary_cloud_name,
        api_key=settings.cloudinary_api_key,
        api_secret=settings.cloudinary_api_secret,
        secure=True,
    )
    _cloudinary_configured = True


def save_image_bytes(data: bytes, *, folder: str, public_id: str, local_dir: Path, local_filename: str, local_url_prefix: str) -> str:
    """Store image bytes in Cloudinary when configured, otherwise on local disk.

    Returns a URL suitable for direct use by the frontend (absolute https URL
    from Cloudinary, or a relative "/uploads/..." path for local fallback).
    """
    if _cloudinary_configured:
        result = cloudinary.uploader.upload(
            data,
            folder=f"friendly/{folder}",
            public_id=public_id,
            resource_type="image",
            overwrite=True,
        )
        return result.get("secure_url") or result.get("url")

    local_dir.mkdir(parents=True, exist_ok=True)
    file_path = local_dir / local_filename
    file_path.write_bytes(data)
    return f"{local_url_prefix}/{local_filename}"

if settings.resend_api_key:
    _resend_sdk.api_key = settings.resend_api_key


def send_reset_email(to_email: str, token: str) -> None:
    if not settings.resend_api_key:
        logger.warning("RESEND_API_KEY not set — skipping password reset email")
        return
    reset_url = f"{settings.frontend_url}/?reset_token={token}"
    _resend_sdk.Emails.send({
        "from": settings.from_email,
        "to": [to_email],
        "subject": "Reset your Friendly password",
        "html": (
            f"<p>Hi,</p>"
            f"<p>Click the link below to reset your password. It expires in 1 hour.</p>"
            f"<p><a href='{reset_url}'>{reset_url}</a></p>"
            f"<p>If you didn't request this, ignore this email.</p>"
        ),
    })


def _hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def _generate_username_from_email(email: str, db: Session) -> str:
    prefix = re.sub(r"[^a-z0-9_.-]", "", email.split("@")[0].lower()) or "user"
    candidate = prefix
    counter = 2
    while db.query(User).filter(User.username == candidate).first():
        candidate = f"{prefix}{counter}"
        counter += 1
    return candidate


_gemini_client: genai.Client | None = None
if settings.gemini_api_key:
    _gemini_client = genai.Client(api_key=settings.gemini_api_key)

USERNAME_BLANK_DETAIL = "Username cannot be blank"

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


RATE_LIMITS: Dict[str, Tuple[int, int]] = {
    "/auth/login": (10, 60),
    "/auth/register": (5, 300),
    "/conversations": (30, 60),
}
_requests: Dict[Tuple[str, str], List[float]] = defaultdict(list)


def rate_limit(ip: str, path: str) -> None:
    rule = RATE_LIMITS.get(path)
    if not rule:
        return
    max_calls, window = rule
    now = time.monotonic()
    key = (ip, path)
    bucket = _requests[key]
    cutoff = now - window
    while bucket and bucket[0] < cutoff:
        bucket.pop(0)
    if len(bucket) >= max_calls:
        raise HTTPException(status_code=429, detail="Too many requests, please slow down.")
    bucket.append(now)

def ensure_sqlite_schema() -> None:
    # This project currently uses SQLite without migrations.
    # create_all() will not alter existing tables, so we do minimal safe DDL here.
    with engine.connect() as conn:
        # Add columns to messages if missing
        cols = {
            row[1] for row in conn.execute(text("PRAGMA table_info(messages)")).fetchall()
        }  # row: (cid, name, type, notnull, dflt_value, pk)

        if "edited_at" not in cols:
            conn.execute(text("ALTER TABLE messages ADD COLUMN edited_at DATETIME"))
        if "deleted" not in cols:
            conn.execute(text("ALTER TABLE messages ADD COLUMN deleted BOOLEAN NOT NULL DEFAULT 0"))
        if "deleted_at" not in cols:
            conn.execute(text("ALTER TABLE messages ADD COLUMN deleted_at DATETIME"))
        if "image_url" not in cols:
            conn.execute(text("ALTER TABLE messages ADD COLUMN image_url TEXT"))

        # Create read states table if missing
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS conversation_read_states (
                  conversation_id INTEGER NOT NULL,
                  user_id INTEGER NOT NULL,
                  last_read_message_id INTEGER NOT NULL DEFAULT 0,
                  updated_at DATETIME NOT NULL,
                  PRIMARY KEY (conversation_id, user_id),
                  CONSTRAINT uq_conversation_read_state UNIQUE (conversation_id, user_id),
                  FOREIGN KEY(conversation_id) REFERENCES conversations (id),
                  FOREIGN KEY(user_id) REFERENCES users (id)
                )
                """
            )
        )

        # Create delivery states table if missing
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS conversation_delivery_states (
                  conversation_id INTEGER NOT NULL,
                  user_id INTEGER NOT NULL,
                  last_delivered_message_id INTEGER NOT NULL DEFAULT 0,
                  updated_at DATETIME NOT NULL,
                  PRIMARY KEY (conversation_id, user_id),
                  CONSTRAINT uq_conversation_delivery_state UNIQUE (conversation_id, user_id),
                  FOREIGN KEY(conversation_id) REFERENCES conversations (id),
                  FOREIGN KEY(user_id) REFERENCES users (id)
                )
                """
            )
        )

        # Add columns to users if missing
        user_cols = {
            row[1] for row in conn.execute(text("PRAGMA table_info(users)")).fetchall()
        }
        if "display_name" not in user_cols:
            conn.execute(text("ALTER TABLE users ADD COLUMN display_name TEXT"))
        if "avatar_url" not in user_cols:
            conn.execute(text("ALTER TABLE users ADD COLUMN avatar_url TEXT"))
        if "status_image_url" not in user_cols:
            conn.execute(text("ALTER TABLE users ADD COLUMN status_image_url TEXT"))
        if "status_text" not in user_cols:
            conn.execute(text("ALTER TABLE users ADD COLUMN status_text TEXT"))
        if "status_expires_at" not in user_cols:
            conn.execute(text("ALTER TABLE users ADD COLUMN status_expires_at DATETIME"))
        if "last_active_at" not in user_cols:
            conn.execute(text("ALTER TABLE users ADD COLUMN last_active_at DATETIME"))

        conn.commit()


try:
    if settings.database_url.startswith("sqlite"):
        ensure_sqlite_schema()
    else:
        with engine.connect() as conn:
            try:
                conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR UNIQUE"))
                conn.commit()
            except Exception:
                conn.rollback()
        with engine.connect() as conn:
            try:
                conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 1"))
                conn.commit()
            except Exception:
                conn.rollback()
    Base.metadata.create_all(bind=engine)
except Exception as _startup_db_err:
    logger.error("Startup DB init failed (will retry on first request): %s", _startup_db_err)

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login/form")


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def normalize_username(username: str) -> str:
    return username.strip().lower()


def require_non_blank_username(username: str) -> str:
    normalized = normalize_username(username)
    if not normalized:
        raise HTTPException(status_code=422, detail=USERNAME_BLANK_DETAIL)
    return normalized


def get_current_user(token: str, db: Session) -> User:
    try:
        payload = decode_token(token)
    except ValueError:
        raise HTTPException(status_code=401, detail="Invalid token")

    try:
        user_id = int(payload["sub"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(status_code=401, detail="Invalid token")

    u = db.query(User).filter(User.id == user_id).first()
    if not u:
        raise HTTPException(status_code=401, detail="User not found")

    token_ver = int(payload.get("ver", 1))
    if token_ver != int(getattr(u, "token_version", 1) or 1):
        raise HTTPException(status_code=401, detail="session_replaced")

    u.last_active_at = datetime.utcnow()
    exp = getattr(u, "status_expires_at", None)
    if exp is not None and exp <= datetime.utcnow():
        u.status_image_url = None
        u.status_text = None
        u.status_expires_at = None
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def active_status(u: User) -> tuple[str | None, str | None, datetime | None]:
    url = getattr(u, "status_image_url", None)
    txt = getattr(u, "status_text", None)
    exp = getattr(u, "status_expires_at", None)
    if not exp or exp <= datetime.utcnow():
        return None, None, None
    return url, txt, exp


def require_member(db: Session, user_id: int, conversation_id: int) -> None:
    convo_exists = (
        db.query(Conversation.id).filter(Conversation.id == conversation_id).first()
    )
    if not convo_exists:
        raise HTTPException(status_code=404, detail="Conversation not found")

    membership = (
        db.query(ConversationParticipant)
        .filter(
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.user_id == user_id,
        )
        .first()
    )
    if not membership:
        raise HTTPException(status_code=403, detail="Not a member of this conversation")


def to_message_out(msg: Message, sender_username: str) -> MessageOut:
    text_out = "[deleted]" if getattr(msg, "deleted", False) else msg.text
    return MessageOut(
        id=msg.id,
        conversation_id=msg.conversation_id,
        sender_username=sender_username,
        text=text_out,
        image_url=getattr(msg, "image_url", None),
        created_at=msg.created_at,
        edited_at=getattr(msg, "edited_at", None),
        deleted=getattr(msg, "deleted", False),
        deleted_at=getattr(msg, "deleted_at", None),
    )


def upsert_delivery_state(
    db: Session,
    *,
    conversation_id: int,
    user_id: int,
    last_delivered_message_id: int,
) -> DeliveredOut:
    now = datetime.utcnow()
    state = (
        db.query(ConversationDeliveryState)
        .filter(
            ConversationDeliveryState.conversation_id == conversation_id,
            ConversationDeliveryState.user_id == user_id,
        )
        .first()
    )
    if state:
        if last_delivered_message_id > state.last_delivered_message_id:
            state.last_delivered_message_id = last_delivered_message_id
        state.updated_at = now
    else:
        state = ConversationDeliveryState(
            conversation_id=conversation_id,
            user_id=user_id,
            last_delivered_message_id=last_delivered_message_id,
            updated_at=now,
        )
        db.add(state)

    db.commit()
    db.refresh(state)
    return DeliveredOut(
        conversation_id=state.conversation_id,
        user_id=state.user_id,
        last_delivered_message_id=state.last_delivered_message_id,
        updated_at=state.updated_at,
    )


class ConnectionManager:
    def __init__(self) -> None:
        self._rooms: Dict[int, Set[WebSocket]] = {}
        self._user_sockets: Dict[int, Set[WebSocket]] = {}
        self._lock = asyncio.Lock()

    async def connect(self, conversation_id: int, ws: WebSocket, user_id: int) -> None:
        await ws.accept()
        async with self._lock:
            self._rooms.setdefault(conversation_id, set()).add(ws)
            self._user_sockets.setdefault(user_id, set()).add(ws)

    async def disconnect(self, conversation_id: int, ws: WebSocket, user_id: int) -> None:
        async with self._lock:
            room = self._rooms.get(conversation_id)
            if room:
                room.discard(ws)
                if not room:
                    self._rooms.pop(conversation_id, None)
            user_socks = self._user_sockets.get(user_id)
            if user_socks:
                user_socks.discard(ws)
                if not user_socks:
                    self._user_sockets.pop(user_id, None)

    async def kick_user(self, user_id: int) -> None:
        async with self._lock:
            sockets = list(self._user_sockets.get(user_id, set()))
        for sock in sockets:
            try:
                await sock.send_text(json.dumps({"type": "session_replaced"}))
            except Exception:
                pass
            try:
                await sock.close()
            except Exception:
                pass

    async def broadcast(self, conversation_id: int, payload: dict, *, exclude: WebSocket | None = None) -> None:
        async with self._lock:
            sockets = list(self._rooms.get(conversation_id, set()))

        if not sockets:
            return

        data = json.dumps(payload, default=str)
        for ws in sockets:
            if exclude is not None and ws is exclude:
                continue
            try:
                await ws.send_text(data)
            except Exception:
                # Best-effort; stale sockets will be removed on disconnect.
                pass


ws_manager = ConnectionManager()


def conversation_label(usernames: list[str]) -> str:
    if not usernames:
        return "Chat"
    if len(usernames) == 1:
        return usernames[0]
    shown = usernames[:3]
    more = len(usernames) - len(shown)
    suffix = f" +{more}" if more > 0 else ""
    return f"Group: {', '.join(shown)}{suffix}"


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/auth/register", response_model=TokenResponse)
def register(payload: RegisterRequest, request: Request, db: Session = Depends(get_db)):
    client_ip = request.client.host if request.client else "unknown"
    rate_limit(client_ip, "/auth/register")

    email = payload.email.strip().lower()
    if db.query(User).filter(func.lower(User.email) == email).first():
        raise HTTPException(status_code=409, detail="An account with this email already exists")

    username = _generate_username_from_email(email, db)
    u = User(
        username=username,
        email=email,
        password_hash=hash_password(payload.password),
        display_name=username,
    )
    db.add(u)
    db.commit()
    db.refresh(u)

    u.token_version = int(getattr(u, "token_version", 0) or 0) + 1
    db.commit()
    db.refresh(u)
    token = create_access_token(user_id=u.id, username=u.username, token_version=u.token_version)
    return TokenResponse(access_token=token)


@app.post("/auth/forgot-password")
def forgot_password(payload: ForgotPasswordRequest, db: Session = Depends(get_db)):
    email = payload.email.strip().lower()
    u = db.query(User).filter(func.lower(User.email) == email).first()
    if u:
        db.query(PasswordResetToken).filter(
            PasswordResetToken.user_id == u.id,
            PasswordResetToken.used_at.is_(None),
        ).delete()
        db.commit()

        raw = secrets.token_urlsafe(32)
        prt = PasswordResetToken(
            user_id=u.id,
            token_hash=_hash_token(raw),
            expires_at=datetime.utcnow() + timedelta(hours=1),
        )
        db.add(prt)
        db.commit()

        try:
            send_reset_email(u.email, raw)
        except Exception as exc:
            logger.error("Failed to send reset email: %s", exc)

    return {"detail": "If that email is registered, a reset link has been sent"}


@app.post("/auth/reset-password")
def reset_password(payload: ResetPasswordRequest, db: Session = Depends(get_db)):
    token_hash = _hash_token(payload.token)
    prt = db.query(PasswordResetToken).filter(
        PasswordResetToken.token_hash == token_hash,
    ).first()

    if not prt or prt.used_at is not None or prt.expires_at < datetime.utcnow():
        raise HTTPException(status_code=400, detail="Invalid or expired reset link")

    u = db.query(User).filter(User.id == prt.user_id).first()
    if not u:
        raise HTTPException(status_code=400, detail="Invalid reset link")

    u.password_hash = hash_password(payload.new_password)
    prt.used_at = datetime.utcnow()
    db.add(u)
    db.add(prt)
    db.commit()

    return {"detail": "Password reset successfully"}


@app.post("/auth/login", response_model=TokenResponse)
def login(payload: LoginRequest, request: Request, db: Session = Depends(get_db)):
    client_ip = request.client.host if request.client else "unknown"
    rate_limit(client_ip, "/auth/login")
    username = require_non_blank_username(payload.username)

    u = db.query(User).filter(User.username == username).first()
    if not u or not verify_password(payload.password, u.password_hash):
        raise HTTPException(status_code=401, detail="Invalid username or password")

    u.token_version = int(getattr(u, "token_version", 0) or 0) + 1
    db.commit()
    db.refresh(u)
    asyncio.create_task(ws_manager.kick_user(u.id))
    token = create_access_token(user_id=u.id, username=u.username, token_version=u.token_version)
    return TokenResponse(access_token=token)


@app.post("/auth/login/form", response_model=TokenResponse)
def login_form(
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: Session = Depends(get_db),
):
    username = require_non_blank_username(form_data.username)

    u = db.query(User).filter(User.username == username).first()
    if not u or not verify_password(form_data.password, u.password_hash):
        raise HTTPException(status_code=401, detail="Invalid username or password")

    u.token_version = int(getattr(u, "token_version", 0) or 0) + 1
    db.commit()
    db.refresh(u)
    asyncio.create_task(ws_manager.kick_user(u.id))
    token = create_access_token(user_id=u.id, username=u.username, token_version=u.token_version)
    return TokenResponse(access_token=token)


@app.get("/auth/me", response_model=MeResponse)
def me(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)):
    u = get_current_user(token, db)
    s_url, s_txt, s_exp = active_status(u)
    return MeResponse(
        id=u.id,
        username=u.username,
        email=getattr(u, "email", None),
        display_name=u.display_name,
        avatar_url=u.avatar_url,
        status_image_url=s_url,
        status_text=s_txt,
        status_expires_at=s_exp,
        last_active_at=u.last_active_at,
    )


@app.get("/users", response_model=List[UserPublic])
def list_users(
    q: str | None = None,
    limit: int = 200,
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
):
    me_user = get_current_user(token, db)
    limit = max(1, min(int(limit or 200), 500))

    query = db.query(User).filter(User.id != me_user.id)
    if q is not None and q.strip():
        needle = f"%{q.strip().lower()}%"
        query = query.filter(
            func.lower(User.username).like(needle) | func.lower(User.display_name).like(needle)
        )

    rows = query.order_by(User.username.asc()).limit(limit).all()
    return [
        UserPublic(
            id=u.id,
            username=u.username,
            display_name=u.display_name,
            avatar_url=u.avatar_url,
            status_image_url=active_status(u)[0],
            status_text=active_status(u)[1],
            status_expires_at=active_status(u)[2],
        )
        for u in rows
    ]


@app.patch("/me", response_model=MeResponse)
def update_me(
    payload: ProfileUpdateRequest,
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
):
    u = get_current_user(token, db)

    if payload.display_name is not None:
        name = payload.display_name.strip()
        u.display_name = name or None
    if payload.avatar_url is not None:
        url = payload.avatar_url.strip()
        u.avatar_url = url or None

    db.add(u)
    db.commit()
    db.refresh(u)

    return MeResponse(
        id=u.id,
        username=u.username,
        display_name=u.display_name,
        avatar_url=u.avatar_url,
        last_active_at=u.last_active_at,
    )


@app.post("/me/profile", response_model=MeResponse)
def update_profile(
    display_name: str | None = Form(default=None),
    email: str | None = Form(default=None),
    avatar: UploadFile | None = File(default=None),
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
):
    u = get_current_user(token, db)

    if display_name is not None:
        name = display_name.strip()
        u.display_name = name or None

    if email is not None:
        new_email = email.strip().lower()
        if new_email and new_email != getattr(u, "email", None):
            conflict = db.query(User).filter(func.lower(User.email) == new_email, User.id != u.id).first()
            if conflict:
                raise HTTPException(status_code=409, detail="Email already in use")
            u.email = new_email

    if avatar is not None:
        if not avatar.content_type or not avatar.content_type.startswith("image/"):
            raise HTTPException(status_code=422, detail="Avatar must be an image file")

        data = avatar.file.read()
        if len(data) > MAX_AVATAR_BYTES:
            raise HTTPException(status_code=422, detail="Avatar file is too large (max 2MB)")

        allowed_exts = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
        ext = Path(avatar.filename or "").suffix.lower()
        if ext not in allowed_exts:
            by_type = {
                "image/png": ".png",
                "image/jpeg": ".jpg",
                "image/jpg": ".jpg",
                "image/gif": ".gif",
                "image/webp": ".webp",
            }
            ext = by_type.get(avatar.content_type, ".png")

        public_id = f"{u.id}_{uuid.uuid4().hex}"
        filename = f"{public_id}{ext}"
        u.avatar_url = save_image_bytes(
            data,
            folder="avatars",
            public_id=public_id,
            local_dir=uploads_dir,
            local_filename=filename,
            local_url_prefix="/uploads",
        )

    db.add(u)
    db.commit()
    db.refresh(u)

    return MeResponse(
        id=u.id,
        username=u.username,
        email=getattr(u, "email", None),
        display_name=u.display_name,
        avatar_url=u.avatar_url,
        status_image_url=getattr(u, "status_image_url", None),
        status_text=getattr(u, "status_text", None),
        status_expires_at=getattr(u, "status_expires_at", None),
        last_active_at=u.last_active_at,
    )


@app.post("/me/status", response_model=MeResponse)
async def update_status(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
    image: UploadFile | None = File(default=None),
    text_value: str | None = Form(default=None),
):
    u = get_current_user(token, db)
    s_url, _, s_exp = active_status(u)
    if s_url and s_exp:
        raise HTTPException(status_code=409, detail="Status already set (wait 24h)")

    txt = (text_value or "").strip()
    if len(txt) > 300:
        txt = txt[:300]

    if image is None and not txt:
        raise HTTPException(status_code=422, detail="Provide an image or status text")

    if image is not None:
        if not image.content_type or not image.content_type.startswith("image/"):
            raise HTTPException(status_code=422, detail="Status image must be an image file")
        data = await image.read()
        if len(data) > MAX_MESSAGE_IMAGE_BYTES:
            raise HTTPException(status_code=422, detail="Status image is too large (max 6MB)")

        ext_map = {
            "image/png": ".png",
            "image/jpeg": ".jpg",
            "image/jpg": ".jpg",
            "image/gif": ".gif",
            "image/webp": ".webp",
        }
        ext = ext_map.get(image.content_type, Path(image.filename or "").suffix or ".png")
        public_id = f"status_{u.id}_{uuid.uuid4().hex}"
        filename = f"{public_id}{ext}"
        u.status_image_url = save_image_bytes(
            data,
            folder="status",
            public_id=public_id,
            local_dir=status_uploads_dir,
            local_filename=filename,
            local_url_prefix="/uploads/status",
        )
    else:
        u.status_image_url = None

    u.status_text = txt or None
    u.status_expires_at = datetime.utcnow() + timedelta(hours=24)
    db.add(u)
    db.commit()
    db.refresh(u)

    return MeResponse(
        id=u.id,
        username=u.username,
        display_name=u.display_name,
        avatar_url=u.avatar_url,
        status_image_url=getattr(u, "status_image_url", None),
        status_text=getattr(u, "status_text", None),
        status_expires_at=getattr(u, "status_expires_at", None),
        last_active_at=u.last_active_at,
    )


@app.delete("/me/status", response_model=MeResponse)
def delete_status(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
):
    u = get_current_user(token, db)
    u.status_image_url = None
    u.status_text = None
    u.status_expires_at = None
    db.add(u)
    db.commit()
    db.refresh(u)

    return MeResponse(
        id=u.id,
        username=u.username,
        display_name=u.display_name,
        avatar_url=u.avatar_url,
        status_image_url=getattr(u, "status_image_url", None),
        status_text=getattr(u, "status_text", None),
        status_expires_at=getattr(u, "status_expires_at", None),
        last_active_at=u.last_active_at,
    )


@app.delete("/me")
def delete_my_account(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
):
    me_user = get_current_user(token, db)

    convo_ids = [
        row[0]
        for row in db.query(ConversationParticipant.conversation_id)
        .filter(ConversationParticipant.user_id == me_user.id)
        .all()
    ]

    for conversation_id in convo_ids:
        db.query(Message).filter(Message.conversation_id == conversation_id).delete(synchronize_session=False)
        db.query(ConversationReadState).filter(ConversationReadState.conversation_id == conversation_id).delete(
            synchronize_session=False
        )
        db.query(ConversationDeliveryState).filter(
            ConversationDeliveryState.conversation_id == conversation_id
        ).delete(synchronize_session=False)
        db.query(ConversationParticipant).filter(ConversationParticipant.conversation_id == conversation_id).delete(
            synchronize_session=False
        )
        db.query(Conversation).filter(Conversation.id == conversation_id).delete(synchronize_session=False)

    db.query(Message).filter(Message.sender_id == me_user.id).delete(synchronize_session=False)
    db.query(ConversationReadState).filter(ConversationReadState.user_id == me_user.id).delete(synchronize_session=False)
    db.query(ConversationDeliveryState).filter(ConversationDeliveryState.user_id == me_user.id).delete(
        synchronize_session=False
    )
    db.query(ConversationParticipant).filter(ConversationParticipant.user_id == me_user.id).delete(
        synchronize_session=False
    )
    db.query(User).filter(User.id == me_user.id).delete(synchronize_session=False)
    db.commit()
    return {"ok": True}


@app.post("/conversations", response_model=ConversationSummary)
def create_or_get_conversation(
    payload: ConversationCreateRequest,
    request: Request,
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
):
    client_ip = request.client.host if request.client else "unknown"
    rate_limit(client_ip, "/conversations")
    me_user = get_current_user(token, db)

    other_username = require_non_blank_username(payload.username)
    if other_username == me_user.username:
        raise HTTPException(status_code=400, detail="You cannot chat with yourself")

    other_user = db.query(User).filter(User.username == other_username).first()
    if not other_user:
        raise HTTPException(status_code=404, detail="User not found")

    me_id = me_user.id
    other_id = other_user.id
    cp = ConversationParticipant

    existing_candidates = (
        db.query(cp.conversation_id)
        .filter(cp.user_id.in_([me_id, other_id]))
        .group_by(cp.conversation_id)
        .having(func.count() == 2)
        .having(func.count(func.distinct(cp.user_id)) == 2)
        .all()
    )

    for row in existing_candidates:
        convo_id = row[0]
        total_members = (
            db.query(func.count(ConversationParticipant.user_id))
            .filter(ConversationParticipant.conversation_id == convo_id)
            .scalar()
        ) or 0
        if int(total_members) == 2:
            return ConversationSummary(id=convo_id, other_username=other_user.username)

    convo = Conversation()
    db.add(convo)
    db.commit()
    db.refresh(convo)

    db.add_all(
        [
            ConversationParticipant(conversation_id=convo.id, user_id=me_id),
            ConversationParticipant(conversation_id=convo.id, user_id=other_id),
        ]
    )
    db.commit()

    return ConversationSummary(id=convo.id, other_username=other_user.username)


@app.post("/conversations/group", response_model=ConversationSummary)
def create_group_conversation(
    payload: GroupConversationCreateRequest,
    request: Request,
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
):
    client_ip = request.client.host if request.client else "unknown"
    rate_limit(client_ip, "/conversations")
    me_user = get_current_user(token, db)

    cleaned: list[str] = []
    seen: set[str] = set()
    for raw in payload.usernames or []:
        u = require_non_blank_username(raw)
        if u == me_user.username:
            continue
        if u in seen:
            continue
        seen.add(u)
        cleaned.append(u)

    if len(cleaned) < 2:
        raise HTTPException(status_code=422, detail="Select at least two users for a group chat")

    rows = db.query(User).filter(User.username.in_(cleaned)).all()
    by_name = {u.username: u for u in rows}
    missing = [u for u in cleaned if u not in by_name]
    if missing:
        raise HTTPException(status_code=404, detail=f"User not found: {missing[0]}")

    participant_ids = sorted({me_user.id, *[u.id for u in rows]})

    my_convo_ids = [
        r[0]
        for r in db.query(ConversationParticipant.conversation_id)
        .filter(ConversationParticipant.user_id == me_user.id)
        .all()
    ]
    for convo_id in my_convo_ids:
        member_ids = sorted(
            r[0]
            for r in db.query(ConversationParticipant.user_id)
            .filter(ConversationParticipant.conversation_id == convo_id)
            .all()
        )
        if member_ids == participant_ids:
            labels = sorted([u.username for u in rows])
            return ConversationSummary(id=convo_id, other_username=conversation_label(labels))

    convo = Conversation()
    db.add(convo)
    db.commit()
    db.refresh(convo)

    db.add_all([ConversationParticipant(conversation_id=convo.id, user_id=uid) for uid in participant_ids])
    db.commit()
    labels = sorted([u.username for u in rows])
    return ConversationSummary(id=convo.id, other_username=conversation_label(labels))


@app.get("/conversations", response_model=List[ConversationSummary])
def list_conversations(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
):
    me_user = get_current_user(token, db)

    convo_rows = (
        db.query(Conversation.id)
        .join(ConversationParticipant, ConversationParticipant.conversation_id == Conversation.id)
        .filter(ConversationParticipant.user_id == me_user.id)
        .order_by(Conversation.id.desc())
        .all()
    )
    convo_ids = [r[0] for r in convo_rows]
    out: list[ConversationSummary] = []
    for cid in convo_ids:
        members = (
            db.query(User.username)
            .join(ConversationParticipant, ConversationParticipant.user_id == User.id)
            .filter(ConversationParticipant.conversation_id == cid)
            .filter(User.id != me_user.id)
            .order_by(User.username.asc())
            .all()
        )
        names = [m[0] for m in members]
        out.append(ConversationSummary(id=cid, other_username=conversation_label(names)))
    return out


@app.delete("/conversations/{conversation_id}")
def delete_conversation(
    conversation_id: int,
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
):
    """
    Permanently deletes a conversation and its messages for all participants.
    """
    me_user = get_current_user(token, db)
    require_member(db, me_user.id, conversation_id)

    # Delete dependent rows first (SQLite FK cascades may not be enabled).
    db.query(Message).filter(Message.conversation_id == conversation_id).delete(synchronize_session=False)
    db.query(ConversationReadState).filter(ConversationReadState.conversation_id == conversation_id).delete(
        synchronize_session=False
    )
    db.query(ConversationParticipant).filter(ConversationParticipant.conversation_id == conversation_id).delete(
        synchronize_session=False
    )
    db.query(Conversation).filter(Conversation.id == conversation_id).delete(synchronize_session=False)
    db.commit()
    return {"ok": True}


@app.post("/conversations/{conversation_id}/messages", response_model=MessageOut)
def send_message(
    conversation_id: int,
    payload: MessageCreateRequest,
    request: Request,
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
):
    client_ip = request.client.host if request.client else "unknown"
    rate_limit(client_ip, "/conversations")
    me_user = get_current_user(token, db)
    require_member(db, me_user.id, conversation_id)

    text = payload.text.strip()
    if not text:
        raise HTTPException(status_code=422, detail="Message cannot be blank")

    msg = Message(conversation_id=conversation_id, sender_id=me_user.id, text=text)
    db.add(msg)
    db.commit()
    db.refresh(msg)

    out = to_message_out(msg, me_user.username)

    # fire-and-forget websocket event
    try:
        asyncio.create_task(
            ws_manager.broadcast(
                conversation_id,
                {"type": "message", "message": out.model_dump()},
            )
        )
    except RuntimeError:
        # no running loop (e.g. sync context in some servers); ignore
        pass

    return out


@app.post("/conversations/{conversation_id}/messages/image", response_model=MessageOut)
async def send_image_message(
    conversation_id: int,
    request: Request,
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
    image: UploadFile = File(...),
    caption: str | None = Form(default=None),
):
    # Basic rate limiting on the main conversations area
    client_ip = request.client.host if request.client else "unknown"
    rate_limit(client_ip, "/conversations")

    me_user = get_current_user(token, db)
    require_member(db, me_user.id, conversation_id)

    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(status_code=422, detail="Image must be an image/* file")

    data = await image.read()
    if len(data) > MAX_MESSAGE_IMAGE_BYTES:
        raise HTTPException(status_code=422, detail="Image file is too large (max 6MB)")

    ext_map = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/jpg": ".jpg",
        "image/gif": ".gif",
        "image/webp": ".webp",
    }
    ext = ext_map.get(image.content_type, Path(image.filename or "").suffix or ".png")
    public_id = f"{me_user.id}_{conversation_id}_{uuid.uuid4().hex}"
    filename = f"{public_id}{ext}"

    image_url = save_image_bytes(
        data,
        folder="messages",
        public_id=public_id,
        local_dir=message_uploads_dir,
        local_filename=filename,
        local_url_prefix="/uploads/messages",
    )

    cap = (caption or "").strip()
    msg = Message(
        conversation_id=conversation_id,
        sender_id=me_user.id,
        text=cap,
        image_url=image_url,
    )
    db.add(msg)
    db.commit()
    db.refresh(msg)

    out = to_message_out(msg, me_user.username)

    try:
        asyncio.create_task(
            ws_manager.broadcast(
                conversation_id,
                {"type": "message", "message": out.model_dump()},
            )
        )
    except RuntimeError:
        pass

    return out


@app.patch("/messages/{message_id}", response_model=MessageOut)
def edit_message(
    message_id: int,
    payload: MessageEditRequest,
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
):
    me_user = get_current_user(token, db)

    msg = db.query(Message).filter(Message.id == message_id).first()
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")

    require_member(db, me_user.id, msg.conversation_id)
    if msg.sender_id != me_user.id:
        raise HTTPException(status_code=403, detail="You can only edit your own messages")
    if getattr(msg, "deleted", False):
        raise HTTPException(status_code=409, detail="Message is deleted")

    new_text = payload.text.strip()
    if not new_text:
        raise HTTPException(status_code=422, detail="Message cannot be blank")

    msg.text = new_text
    msg.edited_at = datetime.utcnow()
    db.add(msg)
    db.commit()
    db.refresh(msg)

    out = to_message_out(msg, me_user.username)
    try:
        asyncio.create_task(
            ws_manager.broadcast(
                msg.conversation_id,
                {"type": "message_updated", "message": out.model_dump()},
            )
        )
    except RuntimeError:
        pass

    return out


@app.delete("/messages/{message_id}", response_model=MessageOut)
def delete_message(
    message_id: int,
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
):
    me_user = get_current_user(token, db)

    msg = db.query(Message).filter(Message.id == message_id).first()
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")

    require_member(db, me_user.id, msg.conversation_id)
    if msg.sender_id != me_user.id:
        raise HTTPException(status_code=403, detail="You can only delete your own messages")

    msg.deleted = True
    msg.deleted_at = datetime.utcnow()
    db.add(msg)
    db.commit()
    db.refresh(msg)

    out = to_message_out(msg, me_user.username)
    try:
        asyncio.create_task(
            ws_manager.broadcast(
                msg.conversation_id,
                {"type": "message_deleted", "message": out.model_dump()},
            )
        )
    except RuntimeError:
        pass

    return out


@app.get("/conversations/{conversation_id}/messages", response_model=List[MessageOut])
def list_messages(
    conversation_id: int,
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
):
    me_user = get_current_user(token, db)
    require_member(db, me_user.id, conversation_id)

    sender = aliased(User)

    rows = (
        db.query(Message, sender.username)
        .join(sender, sender.id == Message.sender_id)
        .filter(Message.conversation_id == conversation_id)
        .order_by(Message.created_at.asc())
        .all()
    )

    out: List[MessageOut] = []
    for msg, sender_username in rows:
        out.append(to_message_out(msg, sender_username))

    # If the user can fetch the messages, we consider them delivered to this device.
    if rows:
        try:
            last_msg_id = int(rows[-1][0].id)
        except Exception:
            last_msg_id = 0

        if last_msg_id:
            delivered = upsert_delivery_state(
                db,
                conversation_id=conversation_id,
                user_id=me_user.id,
                last_delivered_message_id=last_msg_id,
            )
            try:
                asyncio.create_task(
                    ws_manager.broadcast(
                        conversation_id,
                        {"type": "delivered", "delivered": delivered.model_dump(), "from_user_id": me_user.id},
                    )
                )
            except RuntimeError:
                pass
    return out


@app.post("/conversations/{conversation_id}/read", response_model=ReadReceiptOut)
def update_read_receipt(
    conversation_id: int,
    payload: ReadReceiptUpdateRequest,
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
):
    me_user = get_current_user(token, db)
    require_member(db, me_user.id, conversation_id)

    last_read = int(payload.last_read_message_id or 0)
    state = (
        db.query(ConversationReadState)
        .filter(
            ConversationReadState.conversation_id == conversation_id,
            ConversationReadState.user_id == me_user.id,
        )
        .first()
    )

    now = datetime.utcnow()
    if state:
        if last_read > state.last_read_message_id:
            state.last_read_message_id = last_read
        state.updated_at = now
    else:
        state = ConversationReadState(
            conversation_id=conversation_id,
            user_id=me_user.id,
            last_read_message_id=last_read,
            updated_at=now,
        )
        db.add(state)

    db.commit()
    db.refresh(state)

    out = ReadReceiptOut(
        conversation_id=state.conversation_id,
        user_id=state.user_id,
        last_read_message_id=state.last_read_message_id,
        updated_at=state.updated_at,
    )

    try:
        asyncio.create_task(
            ws_manager.broadcast(
                conversation_id,
                {"type": "read", "read": out.model_dump(), "from_user_id": me_user.id},
            )
        )
    except RuntimeError:
        pass

    return out


@app.post("/conversations/{conversation_id}/delivered", response_model=DeliveredOut)
def update_delivered(
    conversation_id: int,
    payload: DeliveredUpdateRequest,
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
):
    me_user = get_current_user(token, db)
    require_member(db, me_user.id, conversation_id)

    out = upsert_delivery_state(
        db,
        conversation_id=conversation_id,
        user_id=me_user.id,
        last_delivered_message_id=int(payload.last_delivered_message_id or 0),
    )
    try:
        asyncio.create_task(
            ws_manager.broadcast(
                conversation_id,
                {"type": "delivered", "delivered": out.model_dump(), "from_user_id": me_user.id},
            )
        )
    except RuntimeError:
        pass
    return out


@app.get("/conversations/{conversation_id}/states", response_model=ConversationStatesOut)
def get_conversation_states(
    conversation_id: int,
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
):
    me_user = get_current_user(token, db)
    require_member(db, me_user.id, conversation_id)

    read_rows = (
        db.query(ConversationReadState)
        .filter(ConversationReadState.conversation_id == conversation_id)
        .all()
    )
    delivered_rows = (
        db.query(ConversationDeliveryState)
        .filter(ConversationDeliveryState.conversation_id == conversation_id)
        .all()
    )

    read = [
        ReadReceiptOut(
            conversation_id=r.conversation_id,
            user_id=r.user_id,
            last_read_message_id=r.last_read_message_id,
            updated_at=r.updated_at,
        )
        for r in read_rows
    ]
    delivered = [
        DeliveredOut(
            conversation_id=d.conversation_id,
            user_id=d.user_id,
            last_delivered_message_id=d.last_delivered_message_id,
            updated_at=d.updated_at,
        )
        for d in delivered_rows
    ]
    return ConversationStatesOut(read=read, delivered=delivered)


@app.post("/ai/polish", response_model=AiPolishResponse)
def ai_polish(
    payload: AiPolishRequest,
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
):
    if not settings.gemini_api_key or _gemini_client is None:
        raise HTTPException(status_code=503, detail="AI not configured on server")

    _ = get_current_user(token, db)

    mode = (payload.mode or "polish").lower()
    if mode not in {"polish", "autocorrect"}:
        mode = "polish"

    if mode == "autocorrect":
        system_msg = (
            "You are a writing assistant. Fix grammar and spelling while keeping the tone and wording "
            "as close as possible to the original. Reply with ONLY the corrected text."
        )
    else:
        system_msg = (
            "You are a helpful assistant that lightly rewrites chat messages to be clearer and friendlier "
            "without changing their meaning. Keep them concise. Reply with ONLY the rewritten text."
        )

    prompt = f"{system_msg}\n\nText:\n{payload.text}"

    try:
        response = _gemini_client.models.generate_content(
            model=settings.gemini_model,
            contents=prompt,
            config=GenerateContentConfig(temperature=0.25),
        )
        text = (response.text or "").strip()
    except Exception as exc:  # pragma: no cover - external service
        logger.exception("Gemini /ai/polish failed")
        # Don't leak secrets, but do send a helpful (non-sensitive) reason to the client.
        detail = f"{exc.__class__.__name__}: {str(exc)}"
        raise HTTPException(status_code=502, detail=f"AI service error: {detail[:300]}") from exc

    if not text:
        text = payload.text

    return AiPolishResponse(text=text)


@app.post("/ai/suggestions", response_model=AiSuggestionsResponse)
def ai_suggestions(
    payload: AiSuggestionsRequest,
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
):
    if not settings.gemini_api_key or _gemini_client is None:
        raise HTTPException(status_code=503, detail="AI not configured on server")

    me_user = get_current_user(token, db)
    require_member(db, me_user.id, payload.conversation_id)

    sender = aliased(User)
    rows = (
        db.query(Message, sender.username)
        .join(sender, sender.id == Message.sender_id)
        .filter(Message.conversation_id == payload.conversation_id)
        .order_by(Message.created_at.desc())
        .limit(20)
        .all()
    )
    rows = list(reversed(rows))

    transcript_lines: list[str] = []
    for msg, username in rows:
        who = "You" if username == me_user.username else username
        label = "DELETED" if getattr(msg, "deleted", False) else ""
        text = msg.text or ""
        if label:
            transcript_lines.append(f"{who} ({label}): {text}")
        else:
            transcript_lines.append(f"{who}: {text}")

    transcript = "\n".join(transcript_lines) or "No previous messages."

    prompt = (
        "You are helping a user reply in a chat app. Based on the recent conversation below, "
        "suggest 3 short, natural replies the user could send next. "
        "Keep each under 80 characters. Do not include numbering or bullet points.\n\n"
        "Conversation:\n"
        f"{transcript}\n\n"
        "Now output exactly 3 different reply options, each separated by a newline, "
        "with no extra commentary."
    )

    gemini_prompt = f"You are helping a user reply in a chat app.\n\n{prompt}"

    try:
        response = _gemini_client.models.generate_content(
            model=settings.gemini_model,
            contents=gemini_prompt,
            config=GenerateContentConfig(temperature=0.7),
        )
        raw = (response.text or "").strip()
    except Exception as exc:  # pragma: no cover - external service
        logger.exception("Gemini /ai/suggestions failed")
        detail = f"{exc.__class__.__name__}: {str(exc)}"
        raise HTTPException(status_code=502, detail=f"AI service error: {detail[:300]}") from exc

    lines = [ln.strip() for ln in raw.splitlines() if ln.strip()]
    unique: list[str] = []
    for ln in lines:
        if ln.lower().startswith(("1.", "2.", "3.")):
            ln = ln.split(".", 1)[1].strip()
        if ln not in unique:
            unique.append(ln)
        if len(unique) >= 3:
            break

    suggestions = [
        {"id": idx + 1, "text": txt}
        for idx, txt in enumerate(unique[:3])
    ]

    return AiSuggestionsResponse(suggestions=suggestions)


@app.websocket("/ws/conversations/{conversation_id}")
async def conversation_ws(ws: WebSocket, conversation_id: int):
    token = ws.query_params.get("token") or ""

    # Auth: open a short-lived session, verify, then release it immediately
    db: Session = SessionLocal()
    try:
        me_user = get_current_user(token, db)
        require_member(db, me_user.id, conversation_id)
        me_id = me_user.id
    finally:
        db.close()

    await ws_manager.connect(conversation_id, ws, me_id)
    try:
        await ws.send_text(
            json.dumps({"type": "hello", "conversation_id": conversation_id, "user_id": me_id})
        )

        while True:
            raw = await ws.receive_text()
            try:
                payload: Dict[str, Any] = json.loads(raw)
            except Exception:
                continue

            ptype = payload.get("type")
            if ptype == "typing":
                is_typing = bool(payload.get("is_typing"))
                await ws_manager.broadcast(
                    conversation_id,
                    {"type": "typing", "user_id": me_id, "is_typing": is_typing},
                    exclude=ws,
                )
            elif ptype == "read":
                try:
                    last_read = int(payload.get("last_read_message_id") or 0)
                except Exception:
                    last_read = 0

                db2: Session = SessionLocal()
                try:
                    state = (
                        db2.query(ConversationReadState)
                        .filter(
                            ConversationReadState.conversation_id == conversation_id,
                            ConversationReadState.user_id == me_id,
                        )
                        .first()
                    )
                    now = datetime.utcnow()
                    if state:
                        if last_read > state.last_read_message_id:
                            state.last_read_message_id = last_read
                        state.updated_at = now
                    else:
                        state = ConversationReadState(
                            conversation_id=conversation_id,
                            user_id=me_id,
                            last_read_message_id=last_read,
                            updated_at=now,
                        )
                        db2.add(state)
                    db2.commit()
                    db2.refresh(state)
                    out = ReadReceiptOut(
                        conversation_id=state.conversation_id,
                        user_id=state.user_id,
                        last_read_message_id=state.last_read_message_id,
                        updated_at=state.updated_at,
                    )
                finally:
                    db2.close()

                await ws_manager.broadcast(
                    conversation_id,
                    {"type": "read", "read": out.model_dump(), "from_user_id": me_id},
                    exclude=ws,
                )
            elif ptype == "delivered":
                try:
                    last_delivered = int(payload.get("last_delivered_message_id") or 0)
                except Exception:
                    last_delivered = 0

                db2: Session = SessionLocal()
                try:
                    out = upsert_delivery_state(
                        db2,
                        conversation_id=conversation_id,
                        user_id=me_id,
                        last_delivered_message_id=last_delivered,
                    )
                finally:
                    db2.close()

                await ws_manager.broadcast(
                    conversation_id,
                    {"type": "delivered", "delivered": out.model_dump(), "from_user_id": me_id},
                    exclude=ws,
                )
            else:
                # unknown type (includes "ping" keepalive — no DB needed)
                continue
    except WebSocketDisconnect:
        pass
    finally:
        try:
            await ws_manager.disconnect(conversation_id, ws, me_id)
        except Exception:
            pass
