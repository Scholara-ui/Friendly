from datetime import datetime
from pydantic import BaseModel, Field


class RegisterRequest(BaseModel):
    username: str = Field(min_length=3, max_length=30)
    password: str = Field(min_length=6, max_length=128)


class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class MeResponse(BaseModel):
    id: int
    username: str
    display_name: str | None = None
    avatar_url: str | None = None
    status_image_url: str | None = None
    status_text: str | None = None
    status_expires_at: datetime | None = None
    last_active_at: datetime | None = None


class ConversationCreateRequest(BaseModel):
    username: str = Field(min_length=1, max_length=30)


class GroupConversationCreateRequest(BaseModel):
    usernames: list[str] = Field(min_length=2)


class ConversationSummary(BaseModel):
    id: int
    other_username: str


class UserPublic(BaseModel):
    id: int
    username: str
    display_name: str | None = None
    avatar_url: str | None = None
    status_image_url: str | None = None
    status_text: str | None = None
    status_expires_at: datetime | None = None


class MessageCreateRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2000)


class MessageEditRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2000)


class ReadReceiptUpdateRequest(BaseModel):
    last_read_message_id: int = Field(ge=0)


class ReadReceiptOut(BaseModel):
    conversation_id: int
    user_id: int
    last_read_message_id: int
    updated_at: datetime


class DeliveredUpdateRequest(BaseModel):
    last_delivered_message_id: int = Field(ge=0)


class DeliveredOut(BaseModel):
    conversation_id: int
    user_id: int
    last_delivered_message_id: int
    updated_at: datetime


class ConversationStatesOut(BaseModel):
    read: list[ReadReceiptOut]
    delivered: list[DeliveredOut]


class ProfileUpdateRequest(BaseModel):
    display_name: str | None = Field(default=None, max_length=50)
    avatar_url: str | None = Field(default=None, max_length=300)


class MessageOut(BaseModel):
    id: int
    conversation_id: int
    sender_username: str
    text: str
    image_url: str | None = None
    created_at: datetime
    edited_at: datetime | None = None
    deleted: bool = False
    deleted_at: datetime | None = None


class AiPolishRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    mode: str = Field(
        default="polish",
        description="polish | autocorrect",
    )


class AiPolishResponse(BaseModel):
    text: str


class AiSuggestionsRequest(BaseModel):
    conversation_id: int = Field(ge=1)


class AiSuggestion(BaseModel):
    id: int
    text: str


class AiSuggestionsResponse(BaseModel):
    suggestions: list[AiSuggestion]