"""Phase 2 acceptance tests using an isolated, fully seeded in-memory database."""

from __future__ import annotations

import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app import models  # noqa: F401 - register every table with Base.metadata
from app.database import Base, get_db
from app.engines.timetable_cpsat import generate_timetable, validate_timetable
from app.models import (
    Asset,
    Building,
    Department,
    DistributionBoard,
    Floor,
    Lab,
    Room,
    StaffProfile,
    StudentClass,
    TimetableSlot,
    User,
)
from app.routers import timetable_router, twin_router

DEPARTMENTS = ("AIDS", "AIML", "CSE", "ECE", "MECH", "CYBER")
LAB_CODES = [
    *(f"LAB-CHEM-{number:02d}" for number in range(1, 5)),
    *(f"LAB-PHYS-{number:02d}" for number in range(1, 5)),
    *(f"LAB-MECH-{number:02d}" for number in range(1, 3)),
    *(f"LAB-ECE-{number:02d}" for number in range(1, 3)),
    *(f"LAB-OOPS-{number:02d}" for number in range(1, 5)),
    *(f"LAB-DBMS-{number:02d}" for number in range(1, 5)),
]


def _pool(department: str, year: int) -> str:
    if year == 1:
        return "SCIENCE"
    if department in {"MECH", "ECE"}:
        return department
    return "COMPUTING"


def _seed(db: Session) -> None:
    building = Building(code="C", name="Block C", total_floors=4)
    db.add(building)
    db.flush()
    floor = Floor(
        building_id=building.id,
        floor_number=4,
        code="C4",
        elevation_y=12.0,
    )
    board = DistributionBoard(
        code="DB-C4",
        building_id=building.id,
        floor_number=4,
        wing="CENTER",
    )
    db.add_all([floor, board])
    db.flush()

    departments = []
    for code in DEPARTMENTS:
        department = Department(code=code, full_name=f"{code} Department")
        departments.append(department)
    db.add_all(departments)
    db.flush()
    department_by_code = {department.code: department for department in departments}

    classes: list[StudentClass] = []
    class_number = 0
    for department_code in DEPARTMENTS:
        for year in (1, 2, 3):
            for section in "ABCDE":
                class_number += 1
                class_code = f"{department_code}-{year}-{section}"
                advisor = User(
                    email=f"advisor-{class_number}@example.test",
                    full_name=f"Advisor {class_number}",
                    role="FACULTY",
                    department_code=department_code,
                )
                db.add(advisor)
                db.flush()
                db.add(
                    StaffProfile(
                        user_id=advisor.id,
                        staff_code=f"FAC-{class_number:03d}",
                        staff_category="FACULTY",
                        assigned_class_code=class_code,
                    )
                )
                student_class = StudentClass(
                    class_code=class_code,
                    department_id=department_by_code[department_code].id,
                    year_number=year,
                    section_letter=section,
                    student_strength=58,
                    home_room_code="C4-03" if class_number == 1 else f"ROOM-{class_number:03d}",
                    advisor_faculty_id=advisor.id,
                    required_lab_pool=_pool(department_code, year),
                )
                classes.append(student_class)
    db.add_all(classes)
    db.flush()

    for lab_number, lab_code in enumerate(LAB_CODES, start=1):
        db.add(
            Lab(
                code=lab_code,
                name=lab_code,
                lab_category="SCIENCE" if lab_number <= 8 else "DEPARTMENT",
                distribution_board_id=board.id,
            )
        )
        for staff_index in range(2):
            staff = User(
                email=f"lab-{lab_number}-{staff_index}@example.test",
                full_name=f"Lab Staff {lab_number}-{staff_index + 1}",
                role="LAB_STAFF",
            )
            db.add(staff)
            db.flush()
            db.add(
                StaffProfile(
                    user_id=staff.id,
                    staff_code=f"LAB-{lab_number:02d}-{staff_index + 1}",
                    staff_category="LAB_STAFF",
                    assigned_lab_code=lab_code,
                )
            )

    db.add(
        Room(
            code="C4-03",
            zero_index_alias="C0-03",
            building_id=building.id,
            floor_id=floor.id,
            room_number_on_floor=3,
            distribution_board_id=board.id,
            home_class_id=classes[0].id,
        )
    )
    db.add(
        Asset(
            asset_code="C4-03-SB-00",
            name="Smart Board",
            asset_type="SMART_BOARD",
            parent_space_type="ROOM",
            parent_space_code="C4-03",
            slot_index=0,
        )
    )
    for index in range(1, 10):
        db.add(
            Asset(
                asset_code=f"C4-03-FAN-{index:02d}",
                name=f"Ceiling Fan {index}",
                asset_type="CEILING_FAN",
                parent_space_type="ROOM",
                parent_space_code="C4-03",
                slot_index=index,
            )
        )
    for index in range(10, 22):
        db.add(
            Asset(
                asset_code=f"C4-03-LED-{index - 9:02d}",
                name=f"LED Light {index - 9}",
                asset_type="LED_LIGHT",
                parent_space_type="ROOM",
                parent_space_code="C4-03",
                slot_index=index,
            )
        )
    db.commit()


@pytest.fixture(scope="module")
def generated_database():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, class_=Session, expire_on_commit=False)
    db = session_factory()
    _seed(db)
    started = time.perf_counter()
    rows = generate_timetable(db)
    elapsed = time.perf_counter() - started
    yield db, rows, elapsed
    db.close()
    engine.dispose()


def test_cpsat_generates_and_validates_full_grid(generated_database) -> None:
    db, rows, elapsed = generated_database
    assert len(rows) == 2700
    assert db.query(TimetableSlot).count() == 2700
    assert elapsed < 8.0, f"CP-SAT generation took {elapsed:.2f}s"
    result = validate_timetable(db)
    assert result == {
        "valid": True,
        "total_slots": 2700,
        "constraint_results": {
            "one_lab_per_day_per_class": True,
            "zero_lab_collisions": True,
            "zero_room_collisions": True,
            "zero_staff_collisions": True,
            "vacant_home_rooms_per_period": 15,
        },
    }


def test_alias_space_inspector_has_periods_assets_and_timetable(generated_database) -> None:
    db, _rows, _elapsed = generated_database
    app = FastAPI()
    app.include_router(twin_router.router)
    app.include_router(timetable_router.router)

    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    from app.auth import get_current_user

    clock_admin = User(email="clock-admin@nosih.edu.in", full_name="Clock Admin", role="SYSTEM_ADMIN")
    db.add(clock_admin)
    db.flush()
    app.dependency_overrides[get_current_user] = lambda: clock_admin
    client = TestClient(app)
    clock = client.patch(
        "/api/clock", json={"day_of_week": "MON", "current_time": "11:10"}
    )
    assert clock.status_code == 200
    assert clock.json()["active_period"] == 3
    assert clock.json()["minutes_remaining"] == 35

    response = client.get("/api/twin/space/C0-03")
    assert response.status_code == 200, response.text
    detail = response.json()
    assert detail["code"] == "C4-03"
    assert detail["alias_code"] == "C0-03"
    assert detail["distribution_board_code"] == "DB-C4"
    assert len(detail["assets"]) == 22
    assert [asset["slot_index"] for asset in detail["assets"]] == list(range(22))
    assert all(detail["period_cards"][key] is not None for key in (
        "previous_period", "current_period", "next_period"
    ))
    assert detail["period_cards"]["current_period"]["minutes_remaining"] == 35
    assert len(detail["full_day_timeline"]) == 6
    assert [card["period_number"] for card in detail["full_day_timeline"]] == list(range(1, 7))
    assert any(
        card["away_in_lab_code"] is not None for card in detail["full_day_timeline"]
    )
    assert client.get("/api/timetable/validate").json()["valid"] is True
    assert len(client.get("/api/timetable/class/AIDS-1-A").json()) == 30
    assert client.get("/api/timetable/space/C0-03").status_code == 200
