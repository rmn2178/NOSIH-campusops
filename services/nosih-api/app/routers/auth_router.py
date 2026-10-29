from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import create_access_token, get_current_user, validate_institutional_email
from app.database import get_db
from app.models import StudentClass, User
from app.passwords import verify_password
from app.schemas.auth import LoginRequest, LoginResponse
from app.serializers import user_dict

router = APIRouter(prefix="/api/auth", tags=["authentication"])
COMMAND_ROLES = {"MAINTENANCE", "INCIDENT_MANAGER", "FACILITIES_ADMIN", "PROCUREMENT_APPROVER", "SYSTEM_ADMIN"}


def _session_payload(user: User, db: Session) -> dict:
    home_room, section = None, None
    if user.class_code:
        student_class = db.scalar(select(StudentClass).where(StudentClass.class_code == user.class_code))
        if student_class:
            home_room, section = student_class.home_room_code, student_class.section_letter
    return {"access_token": create_access_token(user), "user": user_dict(user, home_room, section)}


@router.post("/login", response_model=LoginResponse)
def login(payload: LoginRequest, db: Annotated[Session, Depends(get_db)]) -> dict:
    email = str(payload.email).lower()
    if not validate_institutional_email(email):
        raise HTTPException(status_code=422, detail="Use an @nosih.edu.in or @college.edu institutional email")
    user = db.scalar(select(User).where(User.email == email))
    if user is None or user.role not in COMMAND_ROLES:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="This account is inactive")
    if not payload.password or not verify_password(payload.password, user.password_hash, email):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    return _session_payload(user, db)


@router.post("/portal-login", response_model=LoginResponse)
def portal_login(payload: LoginRequest, db: Annotated[Session, Depends(get_db)]) -> dict:
    email = str(payload.email).lower()
    department_labels = {"AI&DS": "AIDS", "Cyber Security": "CYBER"}
    payload.department_code = payload.department_code or department_labels.get(payload.department or "", payload.department)
    if payload.year_number is None and payload.academic_role in {"YEAR_1", "YEAR_2", "YEAR_3"}:
        payload.year_number = int(payload.academic_role[-1])
    if not validate_institutional_email(email):
        raise HTTPException(status_code=422, detail="Use an @nosih.edu.in or @college.edu institutional email")
    user = db.scalar(select(User).where(User.email == email))
    if not user:
        role = "STUDENT" if payload.year_number else "FACULTY"
        full_name = email.split("@")[0].replace(".", " ").replace("_", " ").title()
        user = User(email=email, full_name=full_name, role=role, department_code=payload.department_code, year_number=payload.year_number)
        db.add(user)
        db.flush()
    if not user.is_active:
        raise HTTPException(status_code=403, detail="This account is inactive")
    if payload.department_code and user.department_code and payload.department_code != user.department_code:
        raise HTTPException(status_code=403, detail="Department does not match the institutional record")
    if user.role == "STUDENT" and payload.year_number and payload.year_number != user.year_number:
        raise HTTPException(status_code=403, detail="Year does not match the institutional record")
    if payload.academic_role == "FACULTY_STAFF" and user.role == "STUDENT":
        raise HTTPException(status_code=403, detail="Student accounts cannot use Faculty/Staff login")
    db.commit()
    return _session_payload(user, db)


@router.get("/directory")
def directory(query: str = Query(default=""), limit: int = Query(default=8, ge=1, le=20), db: Session = Depends(get_db)) -> list[dict]:
    users = db.scalars(select(User).where(User.email.ilike(f"{query}%"), User.is_active.is_(True)).order_by(User.email).limit(limit)).all()
    department_labels = {"AIDS": "AI&DS", "CYBER": "Cyber Security"}
    return [{"email": user.email, "full_name": user.full_name, "department": department_labels.get(user.department_code or "", user.department_code), "academic_role": f"YEAR_{user.year_number}" if user.role == "STUDENT" else "FACULTY_STAFF", "year_number": user.year_number} for user in users]


@router.get("/me")
def me(user: Annotated[User, Depends(get_current_user)], db: Annotated[Session, Depends(get_db)]) -> dict:
    student_class = db.scalar(select(StudentClass).where(StudentClass.class_code == user.class_code)) if user.class_code else None
    return user_dict(user, student_class.home_room_code if student_class else None, student_class.section_letter if student_class else None)


@router.get("/users/search")
def search_users(q: str = Query(min_length=2), limit: int = Query(default=8, ge=1, le=20), db: Session = Depends(get_db)) -> list[dict]:
    users = db.scalars(select(User).where(User.email.ilike(f"{q}%"), User.is_active.is_(True)).order_by(User.email).limit(limit)).all()
    return [{"email": user.email, "full_name": user.full_name, "department_code": user.department_code, "year_number": user.year_number} for user in users]
