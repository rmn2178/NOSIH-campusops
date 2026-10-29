import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class IdentityVault(Base):
    __tablename__ = "identity_vault"

    id: Mapped[int] = mapped_column(primary_key=True)
    vault_token: Mapped[str] = mapped_column(String(36), unique=True, index=True, default=lambda: str(uuid.uuid4()))
    target_entity_type: Mapped[str] = mapped_column(String(20), index=True)
    target_entity_id: Mapped[int] = mapped_column(Integer, index=True)
    encrypted_identity_blob: Mapped[str] = mapped_column(Text)
    reporter_rate_limit_hash: Mapped[str] = mapped_column(String(64), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    unsealed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    unsealed_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)


class Complaint(Base):
    __tablename__ = "complaints"

    id: Mapped[int] = mapped_column(primary_key=True)
    ticket_number: Mapped[str] = mapped_column(String(30), unique=True, index=True)
    space_type: Mapped[str] = mapped_column(String(20), index=True)
    space_code: Mapped[str] = mapped_column(String(30), index=True)
    building_code: Mapped[str | None] = mapped_column(String(20), nullable=True, index=True)
    floor_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text)
    image_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    is_anonymous: Mapped[bool] = mapped_column(Boolean, default=False)
    reporter_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    public_reporter_label: Mapped[str] = mapped_column(String(160))
    vault_token: Mapped[str | None] = mapped_column(String(36), unique=True, nullable=True)
    moderation_status: Mapped[str] = mapped_column(String(20), default="APPROVED", index=True)
    moderation_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    ai_extracted_json: Mapped[str] = mapped_column(Text, default="{}")
    missing_info_questions_json: Mapped[str] = mapped_column(Text, default="[]")
    missing_info_answers_json: Mapped[str] = mapped_column(Text, default="{}")
    category: Mapped[str | None] = mapped_column(String(30), nullable=True, index=True)
    urgency: Mapped[str] = mapped_column(String(10), default="MEDIUM", index=True)
    status: Mapped[str] = mapped_column(String(30), default="OPEN", index=True)
    parent_complaint_id: Mapped[int | None] = mapped_column(ForeignKey("complaints.id"), nullable=True)
    affected_upvote_count: Mapped[int] = mapped_column(Integer, default=0)
    linked_incident_id: Mapped[int | None] = mapped_column(ForeignKey("incidents.id"), nullable=True)
    source_channel: Mapped[str] = mapped_column(String(20), default="WEB_PORTAL")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    reporter: Mapped["User | None"] = relationship(foreign_keys=[reporter_user_id])
    parent_complaint: Mapped["Complaint | None"] = relationship(remote_side=[id])
    comments: Mapped[list["ComplaintComment"]] = relationship(back_populates="complaint", cascade="all, delete-orphan")


class ComplaintComment(Base):
    __tablename__ = "complaint_comments"

    id: Mapped[int] = mapped_column(primary_key=True)
    complaint_id: Mapped[int] = mapped_column(ForeignKey("complaints.id"), index=True)
    body: Mapped[str] = mapped_column(Text)
    is_anonymous: Mapped[bool] = mapped_column(Boolean, default=False)
    author_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    public_author_label: Mapped[str] = mapped_column(String(160))
    author_role_badge: Mapped[str] = mapped_column(String(30))
    vault_token: Mapped[str | None] = mapped_column(String(36), unique=True, nullable=True)
    moderation_status: Mapped[str] = mapped_column(String(20), default="APPROVED", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    complaint: Mapped[Complaint] = relationship(back_populates="comments")
    author: Mapped["User | None"] = relationship()


class ComplaintVote(Base):
    __tablename__ = "complaint_votes"
    __table_args__ = (UniqueConstraint("complaint_id", "voter_rate_limit_hash", name="uq_complaint_voter"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    complaint_id: Mapped[int] = mapped_column(ForeignKey("complaints.id"), index=True)
    voter_rate_limit_hash: Mapped[str] = mapped_column(String(64), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Incident(Base):
    __tablename__ = "incidents"

    id: Mapped[int] = mapped_column(primary_key=True)
    incident_number: Mapped[str] = mapped_column(String(30), unique=True, index=True)
    title: Mapped[str] = mapped_column(String(200))
    correlation_type: Mapped[str] = mapped_column(String(30))
    root_cause_key: Mapped[str] = mapped_column(String(60), index=True)
    severity: Mapped[str] = mapped_column(String(10))
    status: Mapped[str] = mapped_column(String(20), default="ACTIVE", index=True)
    ai_summary_text: Mapped[str] = mapped_column(Text)
    affected_rooms_csv: Mapped[str] = mapped_column(Text, default="")
    affected_classes_csv: Mapped[str] = mapped_column(Text, default="")
    total_students_impacted: Mapped[int] = mapped_column(Integer, default=0)
    chronic_replacement_advised: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class WorkOrder(Base):
    __tablename__ = "work_orders"

    id: Mapped[int] = mapped_column(primary_key=True)
    wo_number: Mapped[str] = mapped_column(String(30), unique=True, index=True)
    incident_id: Mapped[int | None] = mapped_column(ForeignKey("incidents.id"), nullable=True)
    complaint_id: Mapped[int | None] = mapped_column(ForeignKey("complaints.id"), nullable=True, unique=True)
    space_code: Mapped[str] = mapped_column(String(30), index=True)
    target_asset_codes_json: Mapped[str] = mapped_column(Text, default="[]")
    required_skill: Mapped[str] = mapped_column(String(30))
    required_risk_clearance: Mapped[str] = mapped_column(String(30), default="STANDARD")
    priority_score: Mapped[float] = mapped_column(Float, default=50)
    assigned_staff_code: Mapped[str | None] = mapped_column(String(20), nullable=True, index=True)
    assignment_score_breakdown_json: Mapped[str] = mapped_column(Text, default="{}")
    status: Mapped[str] = mapped_column(String(30), default="PENDING_ASSIGNMENT", index=True)
    reassignment_count: Mapped[int] = mapped_column(Integer, default=0)
    last_reassignment_reason: Mapped[str | None] = mapped_column(String(250), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    incident: Mapped[Incident | None] = relationship()
    complaint: Mapped[Complaint | None] = relationship()


class InventoryItem(Base):
    __tablename__ = "inventory_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    sku_code: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    part_name: Mapped[str] = mapped_column(String(120))
    category: Mapped[str] = mapped_column(String(30))
    on_hand_qty: Mapped[int] = mapped_column(Integer, default=0)
    reserved_qty: Mapped[int] = mapped_column(Integer, default=0)
    reorder_threshold: Mapped[int] = mapped_column(Integer, default=5)
    unit_cost_inr: Mapped[float] = mapped_column(Float)
    lead_time_hours: Mapped[int] = mapped_column(Integer, default=24)


class PartReservation(Base):
    __tablename__ = "part_reservations"

    id: Mapped[int] = mapped_column(primary_key=True)
    work_order_id: Mapped[int] = mapped_column(ForeignKey("work_orders.id"), index=True)
    sku_code: Mapped[str] = mapped_column(ForeignKey("inventory_items.sku_code"), index=True)
    quantity_reserved: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(20), default="RESERVED", index=True)
    reserved_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class PurchaseRequest(Base):
    __tablename__ = "purchase_requests"

    id: Mapped[int] = mapped_column(primary_key=True)
    pr_number: Mapped[str] = mapped_column(String(30), unique=True, index=True)
    linked_work_order_id: Mapped[int | None] = mapped_column(ForeignKey("work_orders.id"), nullable=True)
    department_code: Mapped[str] = mapped_column(ForeignKey("departments.code"), index=True)
    sku_code: Mapped[str] = mapped_column(ForeignKey("inventory_items.sku_code"), index=True)
    quantity_requested: Mapped[int] = mapped_column(Integer)
    unit_cost_inr: Mapped[float] = mapped_column(Float)
    total_cost_inr: Mapped[float] = mapped_column(Float)
    requested_by_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    status: Mapped[str] = mapped_column(String(30), default="PENDING_APPROVAL", index=True)
    requires_dual_approval: Mapped[bool] = mapped_column(Boolean, default=False)
    first_approver_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    second_approver_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    override_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    requester: Mapped["User"] = relationship(foreign_keys=[requested_by_user_id])


class SlaClock(Base):
    __tablename__ = "sla_clocks"
    __table_args__ = (UniqueConstraint("target_type", "target_id", name="uq_sla_target"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    target_type: Mapped[str] = mapped_column(String(20))
    target_id: Mapped[int] = mapped_column(Integer, index=True)
    space_code: Mapped[str] = mapped_column(String(30), index=True)
    urgency: Mapped[str] = mapped_column(String(10))
    response_target_mins: Mapped[int] = mapped_column(Integer)
    resolution_target_mins: Mapped[int] = mapped_column(Integer)
    elapsed_active_mins: Mapped[float] = mapped_column(Float, default=0)
    is_paused: Mapped[bool] = mapped_column(Boolean, default=False)
    pause_reason: Mapped[str | None] = mapped_column(String(250), nullable=True)
    breach_state: Mapped[str] = mapped_column(String(20), default="HEALTHY", index=True)
    current_escalation_tier: Mapped[int] = mapped_column(Integer, default=1)
    last_tick_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ResourceLock(Base):
    __tablename__ = "resource_locks"
    __table_args__ = (UniqueConstraint("resource_type", "resource_id", name="uq_resource_lock"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    resource_type: Mapped[str] = mapped_column(String(20))
    resource_id: Mapped[str] = mapped_column(String(60))
    holder_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    holder_name: Mapped[str] = mapped_column(String(120))
    holder_role: Mapped[str] = mapped_column(String(30))
    acquired_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    heartbeat_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class MaintenanceHistory(Base):
    __tablename__ = "maintenance_history"

    id: Mapped[int] = mapped_column(primary_key=True)
    space_code: Mapped[str] = mapped_column(String(30), index=True)
    asset_code: Mapped[str] = mapped_column(String(60), index=True)
    work_order_number: Mapped[str] = mapped_column(String(30))
    fault_category: Mapped[str] = mapped_column(String(30))
    action_taken: Mapped[str] = mapped_column(Text)
    parts_used_json: Mapped[str] = mapped_column(Text, default="[]")
    technician_code: Mapped[str] = mapped_column(String(20))
    downtime_mins: Mapped[int] = mapped_column(Integer)
    completed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class NotificationLog(Base):
    __tablename__ = "notification_logs"

    id: Mapped[int] = mapped_column(primary_key=True)
    channel: Mapped[str] = mapped_column(String(20), index=True)
    recipient: Mapped[str] = mapped_column(String(200))
    subject: Mapped[str] = mapped_column(String(250))
    payload_json: Mapped[str] = mapped_column(Text, default="{}")
    delivery_status: Mapped[str] = mapped_column(String(20), default="SENT")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(primary_key=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    actor_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    actor_email: Mapped[str] = mapped_column(String(200))
    actor_role: Mapped[str] = mapped_column(String(30))
    action: Mapped[str] = mapped_column(String(80), index=True)
    resource_type: Mapped[str] = mapped_column(String(30))
    resource_id: Mapped[str] = mapped_column(String(80))
    outcome: Mapped[str] = mapped_column(String(20), index=True)
    rule_fired: Mapped[str] = mapped_column(String(100), default="")
    reason: Mapped[str] = mapped_column(Text, default="")
    context_json: Mapped[str] = mapped_column(Text, default="{}")
    prev_hash: Mapped[str] = mapped_column(String(64))
    row_hash: Mapped[str] = mapped_column(String(64), unique=True)
