from sqlalchemy import Boolean, Float, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class Department(Base):
    __tablename__ = "departments"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(10), unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(120))
    monthly_maintenance_budget_inr: Mapped[float] = mapped_column(Float, default=500000)
    budget_spent_inr: Mapped[float] = mapped_column(Float, default=0)


class StudentClass(Base):
    __tablename__ = "student_classes"

    id: Mapped[int] = mapped_column(primary_key=True)
    class_code: Mapped[str] = mapped_column(String(20), unique=True, index=True)
    department_id: Mapped[int] = mapped_column(ForeignKey("departments.id"), index=True)
    year_number: Mapped[int] = mapped_column(Integer, index=True)
    section_letter: Mapped[str] = mapped_column(String(1))
    student_strength: Mapped[int] = mapped_column(Integer)
    home_room_code: Mapped[str] = mapped_column(String(20), unique=True, index=True)
    advisor_faculty_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    required_lab_pool: Mapped[str] = mapped_column(String(30))

    department: Mapped[Department] = relationship()
    advisor: Mapped["User | None"] = relationship(foreign_keys=[advisor_faculty_id])


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(200), unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(120))
    role: Mapped[str] = mapped_column(String(30), index=True)
    department_code: Mapped[str | None] = mapped_column(String(10), nullable=True, index=True)
    year_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    class_code: Mapped[str | None] = mapped_column(String(20), nullable=True, index=True)
    password_hash: Mapped[str | None] = mapped_column(String(200), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    staff_profile: Mapped["StaffProfile | None"] = relationship(back_populates="user", cascade="all, delete-orphan")


class StaffProfile(Base):
    __tablename__ = "staff_profiles"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), unique=True)
    staff_code: Mapped[str] = mapped_column(String(20), unique=True, index=True)
    staff_category: Mapped[str] = mapped_column(String(30), index=True)
    assigned_class_code: Mapped[str | None] = mapped_column(String(20), nullable=True)
    assigned_lab_code: Mapped[str | None] = mapped_column(String(30), nullable=True, index=True)
    primary_skill: Mapped[str | None] = mapped_column(String(30), nullable=True)
    skill_proficiency: Mapped[int] = mapped_column(Integer, default=3)
    risk_clearance: Mapped[str] = mapped_column(String(30), default="STANDARD")
    hourly_cost_inr: Mapped[float] = mapped_column(Float, default=0)
    shift_code: Mapped[str | None] = mapped_column(String(20), nullable=True)
    is_on_shift: Mapped[bool] = mapped_column(Boolean, default=True)
    is_on_leave: Mapped[bool] = mapped_column(Boolean, default=False)
    current_active_jobs: Mapped[int] = mapped_column(Integer, default=0)
    max_concurrent_jobs: Mapped[int] = mapped_column(Integer, default=3)
    current_block_location: Mapped[str | None] = mapped_column(String(20), nullable=True)

    user: Mapped[User] = relationship(back_populates="staff_profile")


class TimetableSlot(Base):
    __tablename__ = "timetable_slots"
    __table_args__ = (
        UniqueConstraint("day_of_week", "period_number", "class_code", name="uq_timetable_class_slot"),
        UniqueConstraint("day_of_week", "period_number", "effective_space_code", name="uq_timetable_space_slot"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    day_of_week: Mapped[str] = mapped_column(String(3), index=True)
    period_number: Mapped[int] = mapped_column(Integer, index=True)
    class_code: Mapped[str] = mapped_column(ForeignKey("student_classes.class_code"), index=True)
    session_type: Mapped[str] = mapped_column(String(10), index=True)
    subject_code: Mapped[str] = mapped_column(String(20))
    subject_title: Mapped[str] = mapped_column(String(120))
    scheduled_space_code: Mapped[str] = mapped_column(String(30), index=True)
    effective_space_code: Mapped[str] = mapped_column(String(30), index=True)
    is_relocated: Mapped[bool] = mapped_column(Boolean, default=False)
    relocated_from_code: Mapped[str | None] = mapped_column(String(30), nullable=True)
    relocation_reason: Mapped[str | None] = mapped_column(String(250), nullable=True)
    faculty_staff_code: Mapped[str] = mapped_column(String(20), index=True)
    assisting_lab_staff_code: Mapped[str | None] = mapped_column(String(20), nullable=True, index=True)

    student_class: Mapped[StudentClass] = relationship()
