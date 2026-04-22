from datetime import datetime

from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, UniqueConstraint, Boolean
from sqlalchemy.orm import relationship

from db import Base


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, nullable=False, unique=True, index=True)
    email = Column(String, nullable=True, unique=True, index=True)
    password_hash = Column(String, nullable=False)
    display_name = Column(String, nullable=True)
    avatar_url = Column(String, nullable=True)
    status_image_url = Column(String, nullable=True)
    status_text = Column(String, nullable=True)
    status_expires_at = Column(DateTime, nullable=True)
    last_active_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class Conversation(Base):
    __tablename__ = "conversations"

    id = Column(Integer, primary_key=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    participants = relationship("ConversationParticipant", back_populates="conversation")
    messages = relationship("Message", back_populates="conversation")
    read_states = relationship("ConversationReadState", back_populates="conversation")
    delivery_states = relationship("ConversationDeliveryState", back_populates="conversation")


class ConversationParticipant(Base):
    __tablename__ = "conversation_participants"

    conversation_id = Column(Integer, ForeignKey("conversations.id"), primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), primary_key=True)

    conversation = relationship("Conversation", back_populates="participants")
    user = relationship("User")

    __table_args__ = (
        UniqueConstraint("conversation_id", "user_id", name="uq_conversation_user"),
    )


class Message(Base):
    __tablename__ = "messages"

    id = Column(Integer, primary_key=True, index=True)
    conversation_id = Column(Integer, ForeignKey("conversations.id"), nullable=False, index=True)
    sender_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    text = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    edited_at = Column(DateTime, nullable=True)
    deleted = Column(Boolean, default=False, nullable=False)
    deleted_at = Column(DateTime, nullable=True)
    image_url = Column(String, nullable=True)

    conversation = relationship("Conversation", back_populates="messages")
    sender = relationship("User")


class ConversationReadState(Base):
    __tablename__ = "conversation_read_states"

    conversation_id = Column(Integer, ForeignKey("conversations.id"), primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), primary_key=True)
    last_read_message_id = Column(Integer, nullable=False, default=0)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    conversation = relationship("Conversation", back_populates="read_states")
    user = relationship("User")

    __table_args__ = (
        UniqueConstraint("conversation_id", "user_id", name="uq_conversation_read_state"),
    )


class ConversationDeliveryState(Base):
    __tablename__ = "conversation_delivery_states"

    conversation_id = Column(Integer, ForeignKey("conversations.id"), primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), primary_key=True)
    last_delivered_message_id = Column(Integer, nullable=False, default=0)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    conversation = relationship("Conversation", back_populates="delivery_states")
    user = relationship("User")

    __table_args__ = (
        UniqueConstraint("conversation_id", "user_id", name="uq_conversation_delivery_state"),
    )


class PasswordResetToken(Base):
    __tablename__ = "password_reset_tokens"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    token_hash = Column(String, nullable=False, unique=True, index=True)
    expires_at = Column(DateTime, nullable=False)
    used_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    user = relationship("User")