import argparse
import json
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.database import Base, SessionLocal, engine, init_db
from app.engines.audit_chain import append_audit_log
from app.passwords import hash_password
from app.models import (
    Asset,
    AuditLog,
    BillBot,
    Building,
    Canteen,
    Complaint,
    Department,
    DistributionBoard,
    Floor,
    Incident,
    InventoryItem,
    Lab,
    MaintenanceHistory,
    PurchaseRequest,
    Room,
    StaffProfile,
    StudentClass,
    TimetableSlot,
    User,
    WorkOrder,
)

SEED_NOW = datetime(2026, 1, 31, 12, 0, tzinfo=timezone.utc)
STAFF_PASSWORD = "Nosih@2026"
DAYS = ("MON", "TUE", "WED", "THU", "FRI")
DEPARTMENTS = {
    "AIDS": "Artificial Intelligence and Data Science",
    "AIML": "Artificial Intelligence and Machine Learning",
    "CSE": "Computer Science and Engineering",
    "ECE": "Electronics and Communication Engineering",
    "MECH": "Mechanical Engineering",
    "CYBER": "Cyber Security",
}
FIRST_NAMES = ("Aarav", "Ananya", "Arjun", "Diya", "Ishaan", "Kavya", "Meera", "Neel", "Riya", "Vikram", "Zoya", "Aditi")
LAST_NAMES = ("Iyer", "Sharma", "Reddy", "Nair", "Khan", "Das", "Menon", "Rao", "Verma", "Singh")


def person_name(rng: random.Random) -> str:
    return f"{rng.choice(FIRST_NAMES)} {rng.choice(LAST_NAMES)}"


def add_assets(db: Session, space_type: str, space_code: str, installed_at: datetime) -> list[Asset]:
    assets: list[Asset] = []
    definitions = [("SMART_BOARD", "Smart Board", "SB", 1, "SKU-SB-PSU"), ("CEILING_FAN", "Ceiling Fan", "FAN", 9, "SKU-FAN-CAP"), ("LED_LIGHT", "LED Light", "LED", 12, "SKU-LED-DRIVER")]
    for asset_type, name, prefix, count, sku in definitions:
        for slot in range(1, count + 1):
            assets.append(
                Asset(
                    asset_code=f"{prefix}-{space_code}-{slot:02d}",
                    name=f"{name} {slot}",
                    asset_type=asset_type,
                    parent_space_type=space_type,
                    parent_space_code=space_code,
                    slot_index=slot,
                    status="OK",
                    sku_code=sku,
                    installed_at=installed_at,
                )
            )
    db.add_all(assets)
    return assets


def seed_campus(db: Session) -> dict[str, int]:
    rng = random.Random(42)
    buildings: dict[str, Building] = {}
    for code, name, floors, x, z in (
        ("A", "Block A", 3, -20, 0),
        ("B", "Block B", 5, 0, 0),
        ("C", "Block C", 7, 20, 0),
        ("LAB_WING", "Laboratory Wing", 1, 42, 0),
        ("COURTYARD", "Central Courtyard", 0, 0, 18),
    ):
        building = Building(code=code, name=name, total_floors=floors, x_offset=x, z_offset=z)
        db.add(building)
        buildings[code] = building
    db.flush()

    floors: dict[str, Floor] = {}
    boards: dict[tuple[str, int, str], DistributionBoard] = {}
    for block in ("A", "B", "C"):
        for floor_number in range(1, buildings[block].total_floors + 1):
            floor = Floor(
                building_id=buildings[block].id,
                floor_number=floor_number,
                code=f"{block}{floor_number}",
                elevation_y=(floor_number - 1) * 3.2,
            )
            db.add(floor)
            floors[floor.code] = floor
            for wing in ("EAST", "WEST"):
                board = DistributionBoard(
                    code=f"DB-{block}{floor_number}-{wing}",
                    building_id=buildings[block].id,
                    floor_number=floor_number,
                    wing=wing,
                    breaker_rating_amps=63,
                )
                db.add(board)
                boards[(block, floor_number, wing)] = board
    db.flush()

    rooms: list[Room] = []
    for block in ("A", "B", "C"):
        for floor_number in range(1, buildings[block].total_floors + 1):
            for room_number in range(1, 7):
                wing = "EAST" if room_number <= 3 else "WEST"
                alias_floor = floor_number - 1 if block != "C" or floor_number > 1 else 0
                room = Room(
                    code=f"{block}{floor_number}-{room_number:02d}",
                    zero_index_alias=f"{block}{alias_floor}-{room_number:02d}",
                    building_id=buildings[block].id,
                    floor_id=floors[f"{block}{floor_number}"].id,
                    room_number_on_floor=room_number,
                    distribution_board_id=boards[(block, floor_number, wing)].id,
                    x_pos=buildings[block].x_offset + (room_number - 3.5) * 3.1,
                    y_pos=(floor_number - 1) * 3.2,
                    z_pos=0,
                )
                rooms.append(room)
    db.add_all(rooms)
    db.flush()

    labs: list[Lab] = []
    lab_categories = (("CHEM", "CHEMISTRY", 4), ("PHYS", "PHYSICS", 4), ("OOPS", "OOPS", 4), ("DBMS", "DBMS", 4), ("MECH", "MECH", 2), ("ECE", "ECE", 2))
    for prefix, category, count in lab_categories:
        for index in range(1, count + 1):
            position = len(labs)
            lab = Lab(
                code=f"LAB-{prefix}-{index:02d}",
                name=f"{category.title()} Laboratory {index}",
                lab_category=category,
                distribution_board_id=boards[("A", 1, "EAST" if position % 2 == 0 else "WEST")].id,
                x_pos=36 + (position % 4) * 4,
                y_pos=0,
                z_pos=(position // 4) * 4 - 8,
            )
            labs.append(lab)
    db.add_all(labs)
    db.flush()

    for room in rooms:
        add_assets(db, "ROOM", room.code, SEED_NOW - timedelta(days=rng.randint(200, 900)))
    for lab in labs:
        add_assets(db, "LAB", lab.code, SEED_NOW - timedelta(days=rng.randint(200, 900)))
        for slot in range(1, 16):
            db.add(
                Asset(
                    asset_code=f"INST-{lab.code}-{slot:02d}",
                    name=f"{lab.name} Instrument {slot}",
                    asset_type="LAB_WORKSTATION",
                    parent_space_type="LAB",
                    parent_space_code=lab.code,
                    slot_index=slot,
                    sku_code="SKU-LAB-SENSOR",
                    installed_at=SEED_NOW - timedelta(days=rng.randint(200, 900)),
                )
            )

    canteen_specs = (
        ("CAN-01", "Cafe Tea & Things", "Tea and snacks"),
        ("CAN-02", "Bakery", "Fresh bakery"),
        ("CAN-03", "Breakfast Counter", "South Indian breakfast"),
        ("CAN-04", "Lunch Hall", "Meals and bowls"),
        ("CAN-05", "Chai Kings", "Chai and beverages"),
    )
    canteens: list[Canteen] = []
    for index, (code, name, specialty) in enumerate(canteen_specs):
        menu = ["Tea", "Coffee", "Sandwich", "Meals"] if index != 3 else ["Meals", "Curd Rice", "Lemon Rice"]
        canteen = Canteen(
            code=code,
            name=name,
            specialty=specialty,
            current_queue_length=rng.randint(0, 12),
            seating_capacity=60 + index * 10,
            active_menu_json=json.dumps(menu),
            x_pos=-14 + index * 7,
            z_pos=18,
        )
        canteens.append(canteen)
    db.add_all(canteens)
    db.flush()
    for canteen in canteens:
        for slot in range(1, 5):
            db.add(
                Asset(
                    asset_code=f"APPL-{canteen.code}-{slot:02d}",
                    name=("Refrigerator", "Induction Stove", "Coffee Machine", "Food Warmer")[slot - 1],
                    asset_type="CANTEEN_APPLIANCE",
                    parent_space_type="CANTEEN",
                    parent_space_code=canteen.code,
                    slot_index=slot,
                    sku_code="SKU-APPLIANCE-THERMOSTAT",
                    installed_at=SEED_NOW - timedelta(days=300),
                )
            )

    bots: list[BillBot] = []
    for index in range(1, 9):
        bot = BillBot(
            code=f"BOT-{index:02d}",
            name=f"Bill Bot {index}",
            location_description=f"{canteens[(index - 1) % 5].name} counter" if index <= 5 else f"Block {('A', 'B', 'C')[index - 6]} lobby",
            parent_canteen_id=canteens[index - 1].id if index <= 5 else None,
            paper_roll_pct=rng.randint(45, 100),
            thermal_head_health_pct=rng.randint(75, 100),
            active_queue_count=rng.randint(0, 6),
            last_bill_printed_at=SEED_NOW - timedelta(minutes=rng.randint(1, 60)),
            x_pos=-14 + ((index - 1) % 5) * 7 if index <= 5 else buildings[("A", "B", "C")[index - 6]].x_offset,
            z_pos=21 if index <= 5 else 5,
        )
        bots.append(bot)
    db.add_all(bots)
    db.flush()
    for index, bot in enumerate(bots):
        bot.nearest_fallback_bot_id = bots[(index + 1) % len(bots)].id
        db.add(
            Asset(
                asset_code=f"MECH-{bot.code}-01",
                name="Thermal Printer Mechanism",
                asset_type="BILL_BOT_MECHANISM",
                parent_space_type="BILL_BOT",
                parent_space_code=bot.code,
                slot_index=1,
                sku_code="SKU-BOT-HEAD",
                installed_at=SEED_NOW - timedelta(days=180),
            )
        )

    departments: dict[str, Department] = {}
    for code, full_name in DEPARTMENTS.items():
        department = Department(code=code, full_name=full_name, monthly_maintenance_budget_inr=500000)
        departments[code] = department
        db.add(department)
    db.flush()

    faculty: list[User] = []
    for index in range(1, 91):
        user = User(email=f"fac{index:03d}@nosih.edu.in", full_name=person_name(rng), role="FACULTY", department_code=list(DEPARTMENTS)[(index - 1) % 6])
        faculty.append(user)
    db.add_all(faculty)
    db.flush()

    classes: list[StudentClass] = []
    for department_index, department_code in enumerate(DEPARTMENTS):
        for year in (1, 2, 3):
            for section_index, section in enumerate("ABCDE"):
                strength = rng.randint(55, 60) if year == 1 else rng.randint(52, 59) if year == 2 else rng.randint(58, 60)
                class_code = f"{department_code}-Y{year}-{section}"
                advisor = faculty[len(classes)]
                pool = "FIRST_YEAR_SCI" if year == 1 else "MECH" if department_code == "MECH" else "ECE" if department_code == "ECE" else "COMPUTING"
                student_class = StudentClass(
                    class_code=class_code,
                    department_id=departments[department_code].id,
                    year_number=year,
                    section_letter=section,
                    student_strength=strength,
                    home_room_code=rooms[len(classes)].code,
                    advisor_faculty_id=advisor.id,
                    required_lab_pool=pool,
                )
                classes.append(student_class)
                db.add(student_class)
                db.add(
                    StaffProfile(
                        user_id=advisor.id,
                        staff_code=f"FAC-{len(classes):03d}",
                        staff_category="CLASS_FACULTY",
                        assigned_class_code=class_code,
                        current_block_location=rooms[len(classes) - 1].code[0],
                    )
                )
                advisor.department_code = department_code
                advisor.year_number = year
                advisor.class_code = class_code
                for roll in range(1, strength + 1):
                    db.add(
                        User(
                            email=f"{department_code.lower()}{year}{section.lower()}{roll:02d}@nosih.edu.in",
                            full_name=person_name(rng),
                            role="STUDENT",
                            department_code=department_code,
                            year_number=year,
                            class_code=class_code,
                        )
                    )
    db.flush()
    for student_class, room in zip(classes, rooms, strict=True):
        room.home_class_id = student_class.id

    lab_staff_number = 0
    for lab in labs:
        for _ in range(2):
            lab_staff_number += 1
            user = User(
                email=f"labstf{lab_staff_number:03d}@nosih.edu.in",
                full_name=person_name(rng),
                role="LAB_STAFF",
                department_code="CSE" if lab.lab_category in ("OOPS", "DBMS") else lab.lab_category if lab.lab_category in ("MECH", "ECE") else None,
            )
            db.add(user)
            db.flush()
            db.add(
                StaffProfile(
                    user_id=user.id,
                    staff_code=f"LABSTF-{lab_staff_number:03d}",
                    staff_category="LAB_STAFF",
                    assigned_lab_code=lab.code,
                    primary_skill="LAB_SUPPORT",
                    skill_proficiency=rng.randint(3, 5),
                    current_block_location="LAB_WING",
                )
            )

    skill_plan = ["ELECTRICAL"] * 4 + ["IT_AV"] * 3 + ["PLUMBING"] * 2 + ["CARPENTRY"] * 2 + ["HVAC"]
    technicians: list[StaffProfile] = []
    for index, skill in enumerate(skill_plan, start=1):
        email = f"maint{index:02d}@nosih.edu.in"
        user = User(email=email, full_name=person_name(rng), role="MAINTENANCE", department_code=list(DEPARTMENTS)[(index - 1) % 6], password_hash=hash_password(STAFF_PASSWORD, email))
        db.add(user)
        db.flush()
        profile = StaffProfile(
            user_id=user.id,
            staff_code=f"MAINT-{index:02d}",
            staff_category="MAINTENANCE_TECH",
            primary_skill=skill,
            skill_proficiency=rng.randint(3, 5),
            risk_clearance="HIGH_VOLTAGE" if skill == "ELECTRICAL" and index <= 3 else "CONFINED_SPACE_FIRE" if index == 4 else "STANDARD",
            hourly_cost_inr=rng.choice((300, 350, 400, 450, 500)),
            shift_code="DAY" if index <= 9 else "EVENING",
            is_on_shift=True,
            current_block_location=rng.choice(("A", "B", "C")),
        )
        technicians.append(profile)
        db.add(profile)

    admin_roles = (
        ("incident@nosih.edu.in", "INCIDENT_MANAGER", "NOSIH Incident Manager"),
        ("facilities@nosih.edu.in", "FACILITIES_ADMIN", "NOSIH Facilities Administrator"),
        ("procurement@nosih.edu.in", "PROCUREMENT_APPROVER", "NOSIH Procurement Approver"),
        ("sysadmin@nosih.edu.in", "SYSTEM_ADMIN", "NOSIH System Administrator"),
    )
    admins: list[User] = []
    for email, role, name in admin_roles:
        admin = User(email=email, full_name=name, role=role, department_code="CSE", password_hash=hash_password(STAFF_PASSWORD, email))
        admins.append(admin)
        db.add(admin)
    db.flush()

    inventory_specs = [
        ("SKU-FAN-CAP", "Fan Capacitor", "FANS_HVAC", 0, 85),
        ("SKU-SB-PSU", "Smart Board Power Supply", "IT_SMARTBOARD", 0, 2400),
        ("SKU-MCB-63A", "63A Miniature Circuit Breaker", "ELECTRICAL", 0, 1800),
        ("SKU-BOT-HEAD", "Thermal Print Head", "BILL_BOT", 0, 3200),
        ("SKU-FAN-BEARING", "Fan Bearing", "FANS_HVAC", 35, 220),
        ("SKU-FAN-MOTOR", "Fan Motor", "FANS_HVAC", 24, 1200),
        ("SKU-LED-DRIVER", "LED Driver", "ELECTRICAL", 80, 180),
        ("SKU-LED-PANEL", "LED Panel", "ELECTRICAL", 60, 350),
        ("SKU-SB-HDMI", "HDMI Cable", "IT_SMARTBOARD", 45, 450),
        ("SKU-SB-DISPLAY", "Smart Board Display", "IT_SMARTBOARD", 12, 8500),
        ("SKU-MCB-32A", "32A Miniature Circuit Breaker", "ELECTRICAL", 30, 1200),
        ("SKU-WIRE-1_5", "1.5mm Copper Wire Coil", "ELECTRICAL", 40, 1800),
        ("SKU-WIRE-2_5", "2.5mm Copper Wire Coil", "ELECTRICAL", 35, 2600),
        ("SKU-SWITCH", "Modular Switch", "ELECTRICAL", 100, 120),
        ("SKU-SOCKET", "Modular Socket", "ELECTRICAL", 90, 160),
        ("SKU-BOT-ROLL", "Thermal Paper Roll", "BILL_BOT", 120, 95),
        ("SKU-BOT-SENSOR", "Bill Bot Paper Sensor", "BILL_BOT", 25, 750),
        ("SKU-LAB-SENSOR", "Lab Instrument Sensor", "LAB_EQUIPMENT", 35, 1400),
        ("SKU-LAB-FUSE", "Lab Equipment Fuse", "LAB_EQUIPMENT", 100, 60),
        ("SKU-LAB-CABLE", "Lab Power Cable", "LAB_EQUIPMENT", 60, 250),
        ("SKU-TAP-CARTRIDGE", "Tap Cartridge", "PLUMBING", 45, 350),
        ("SKU-PIPE-SEAL", "Pipe Seal Kit", "PLUMBING", 55, 180),
        ("SKU-PIPE-PVC", "PVC Pipe Length", "PLUMBING", 40, 450),
        ("SKU-DOOR-HINGE", "Door Hinge", "FURNITURE", 65, 140),
        ("SKU-CHAIRS", "Student Chair", "FURNITURE", 30, 1800),
        ("SKU-DESK", "Classroom Desk", "FURNITURE", 25, 2600),
        ("SKU-HVAC-FILTER", "HVAC Filter", "FANS_HVAC", 30, 600),
        ("SKU-HVAC-BELT", "HVAC Drive Belt", "FANS_HVAC", 24, 480),
        ("SKU-APPLIANCE-THERMOSTAT", "Appliance Thermostat", "CANTEEN_APPLIANCE", 28, 950),
        ("SKU-CLEANING-KIT", "Cleaning Consumables Kit", "CLEANLINESS", 75, 300),
    ]
    for sku, name, category, quantity, cost in inventory_specs:
        db.add(InventoryItem(sku_code=sku, part_name=name, category=category, on_hand_qty=quantity, reserved_qty=0, reorder_threshold=5, unit_cost_inr=cost, lead_time_hours=24))

    from app.engines.timetable_cpsat import generate_timetable

    generate_timetable(db, classes=classes, labs=labs)

    active_statuses = ["RESOLVED"] * 50 + ["OPEN"] * 10 + ["TRIAGED"] * 5 + ["IN_PROGRESS"] * 10 + ["BLOCKED_PARTS"] * 5
    complaints: list[Complaint] = []
    categories = ["ELECTRICAL", "FANS_HVAC", "IT_SMARTBOARD", "PLUMBING", "FURNITURE"]
    for index in range(1, 81):
        room = rooms[(index * 7) % len(rooms)]
        category = categories[index % len(categories)]
        created = SEED_NOW - timedelta(days=rng.randint(0, 70), hours=rng.randint(0, 12))
        complaint = Complaint(
            ticket_number=f"CMP-2026-{index:04d}",
            space_type="ROOM",
            space_code=room.code,
            building_code=room.code[0],
            floor_number=int(room.code[1]),
            title=f"Historical {category.lower().replace('_', ' ')} report in {room.code}",
            description=f"Verified maintenance baseline for {room.code}; {category.lower()} issue was assessed by campus operations.",
            is_anonymous=False,
            reporter_user_id=faculty[index % len(faculty)].id,
            public_reporter_label="Campus Operations",
            moderation_status="APPROVED",
            ai_extracted_json="{}",
            category=category,
            urgency="HIGH" if index % 9 == 0 else "MEDIUM",
            status=active_statuses[index - 1],
            source_channel="WEB_PORTAL",
            created_at=created,
            updated_at=created + timedelta(hours=2),
        )
        complaints.append(complaint)
        db.add(complaint)
    db.flush()

    work_orders: list[WorkOrder] = []
    for index in range(1, 61):
        complaint = complaints[index - 1]
        technician = technicians[(index - 1) % len(technicians)]
        completed = index <= 45
        work_order = WorkOrder(
            wo_number=f"WO-2026-{index:04d}",
            complaint_id=complaint.id,
            space_code=complaint.space_code,
            target_asset_codes_json="[]",
            required_skill=technician.primary_skill or "ELECTRICAL",
            required_risk_clearance="HIGH_VOLTAGE" if complaint.urgency == "HIGH" else "STANDARD",
            priority_score=90 if complaint.urgency == "HIGH" else 50,
            assigned_staff_code=technician.staff_code,
            status="COMPLETED" if completed else "IN_PROGRESS",
            created_at=complaint.created_at,
            completed_at=complaint.created_at + timedelta(hours=4) if completed else None,
        )
        work_orders.append(work_order)
        db.add(work_order)
    db.flush()

    inventory = db.scalars(select(InventoryItem).order_by(InventoryItem.id)).all()
    for index in range(1, 26):
        item = inventory[(index + 3) % len(inventory)]
        db.add(
            PurchaseRequest(
                pr_number=f"PR-2026-{index:04d}",
                linked_work_order_id=work_orders[index - 1].id,
                department_code=list(DEPARTMENTS)[index % 6],
                sku_code=item.sku_code,
                quantity_requested=5,
                unit_cost_inr=item.unit_cost_inr,
                total_cost_inr=item.unit_cost_inr * 5,
                requested_by_user_id=technicians[index % len(technicians)].user_id,
                status="STOCK_RECEIVED" if index <= 15 else "APPROVED" if index <= 20 else "PENDING_APPROVAL",
                requires_dual_approval=item.unit_cost_inr * 5 > 100000,
                created_at=SEED_NOW - timedelta(days=60 - index),
            )
        )

    chronic_rooms = (rooms[0], rooms[1])
    for index in range(1, 51):
        if index <= 4:
            room = chronic_rooms[(index - 1) // 2]
            asset_code = f"FAN-{room.code}-01"
            completed = SEED_NOW - timedelta(days=4 + ((index - 1) % 2) * 8)
        else:
            room = rooms[(index * 11) % len(rooms)]
            asset_code = f"LED-{room.code}-{(index % 12) + 1:02d}"
            completed = SEED_NOW - timedelta(days=rng.randint(1, 90))
        work_order = work_orders[(index - 1) % len(work_orders)]
        db.add(
            MaintenanceHistory(
                space_code=room.code,
                asset_code=asset_code,
                work_order_number=work_order.wo_number,
                fault_category="FANS_HVAC" if index <= 4 else "ELECTRICAL",
                action_taken="Inspected, repaired, and tested the asset",
                parts_used_json="[]",
                technician_code=work_order.assigned_staff_code or "MAINT-01",
                downtime_mins=rng.randint(25, 120),
                completed_at=completed,
            )
        )

    for index in range(150):
        append_audit_log(
            db,
            actor=admins[-1],
            action="SEED_OPERATIONAL_BASELINE",
            resource_type="CAMPUS",
            resource_id=f"BASELINE-{index + 1:03d}",
            outcome="ALLOWED",
            rule_fired="DETERMINISTIC_SEED",
            reason="Deterministic campus baseline entry",
            context={"sequence": index + 1},
            timestamp=SEED_NOW - timedelta(minutes=150 - index),
        )

    db.commit()
    return {"rooms": len(rooms), "labs": len(labs), "classes": len(classes), "students": sum(item.student_strength for item in classes), "timetable_slots": 2700}


def seed_if_empty(db: Session) -> dict[str, int]:
    if db.scalar(select(func.count(Building.id))) or 0:
        return {"already_seeded": 1}
    return seed_campus(db)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reset", action="store_true")
    args = parser.parse_args()
    init_db()
    with SessionLocal() as db:
        if args.reset:
            Base.metadata.drop_all(bind=engine)
            Base.metadata.create_all(bind=engine)
        summary = seed_if_empty(db)
        total = db.scalar(select(func.count(User.id))) or 0
        print(json.dumps({**summary, "users_including_staff": total, "timetable_rows": db.scalar(select(func.count(TimetableSlot.id)))}, indent=2))


if __name__ == "__main__":
    main()
