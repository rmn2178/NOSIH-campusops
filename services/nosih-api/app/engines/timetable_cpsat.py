"""OR-Tools CP-SAT generator and independent timetable validator."""

from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any

from ortools.sat.python import cp_model
from sqlalchemy.orm import Session

from app.config import settings
from app.models import Lab, StaffProfile, StudentClass, TimetableSlot

DAYS = ("MON", "TUE", "WED", "THU", "FRI")
PERIOD_NUMBERS = tuple(range(1, 7))
EXPECTED_CLASS_COUNT = 90
EXPECTED_SLOT_COUNT = EXPECTED_CLASS_COUNT * len(DAYS) * len(PERIOD_NUMBERS)
EXPECTED_LABS_PER_PERIOD = 15


def _allowed_lab_codes(student_class: StudentClass, labs: list[Lab]) -> list[str]:
    """Return the hard department/year lab pool for a class.

    First-year science classes may use all eight science rooms.  Chemistry and
    Physics are alternating *subjects* across days; restricting the physical room
    by subject would provide only 24 daily slots for 30 classes and is therefore
    intentionally not part of the pool constraint.
    """

    department = student_class.department.code.upper()
    if student_class.year_number == 1:
        prefixes = ("LAB-CHEM-", "LAB-PHYS-")
    elif department == "MECH":
        prefixes = ("LAB-MECH-",)
    elif department == "ECE":
        prefixes = ("LAB-ECE-",)
    elif department in {"AIDS", "AIML", "CSE", "CYBER"}:
        prefixes = ("LAB-OOPS-", "LAB-DBMS-")
    else:
        # The seed currently covers the six departments above.  This fallback also
        # honours an explicit pool value if another department is introduced.
        pool = (student_class.required_lab_pool or "").upper().replace("-", "_")
        pool_prefixes = {
            "SCIENCE": ("LAB-CHEM-", "LAB-PHYS-"),
            "SCIENCE_LABS": ("LAB-CHEM-", "LAB-PHYS-"),
            "MECH": ("LAB-MECH-",),
            "MECH_LABS": ("LAB-MECH-",),
            "ECE": ("LAB-ECE-",),
            "ECE_LABS": ("LAB-ECE-",),
            "COMPUTING": ("LAB-OOPS-", "LAB-DBMS-"),
            "COMPUTING_LABS": ("LAB-OOPS-", "LAB-DBMS-"),
        }
        if pool not in pool_prefixes:
            raise ValueError(
                f"No lab-pool rule for {student_class.class_code} "
                f"({department}, {student_class.required_lab_pool})"
            )
        prefixes = pool_prefixes[pool]
    return sorted(lab.code for lab in labs if lab.code.startswith(prefixes))


def _lab_subject(student_class: StudentClass, day: str, lab_code: str) -> tuple[str, str]:
    if student_class.year_number == 1:
        if day in {"MON", "WED", "FRI"}:
            return "CHEM-LAB", "Chemistry Laboratory"
        return "PHYS-LAB", "Physics Laboratory"
    if lab_code.startswith("LAB-OOPS-"):
        return "OOPS-LAB", "Object Oriented Programming Laboratory"
    if lab_code.startswith("LAB-DBMS-"):
        return "DBMS-LAB", "Database Management Systems Laboratory"
    department = student_class.department.code.upper()
    return f"{department}-LAB", f"{department} Engineering Laboratory"


def generate_timetable(
    db: Session,
    classes: list[StudentClass] | None = None,
    labs: list[Lab] | None = None,
) -> list[TimetableSlot]:
    """Solve and atomically persist the complete 2,700-slot weekly timetable.

    Every lab assignment is a CP-SAT Boolean.  The model enforces the daily lab,
    exact period balance, room/lab collision, staff non-overlap and weekly variety
    requirements before any existing rows are replaced.  Optional preloaded class
    and lab collections keep the seed path efficient; normal callers only pass db.
    """

    classes = classes or db.query(StudentClass).order_by(StudentClass.id).all()
    labs = labs or db.query(Lab).order_by(Lab.code).all()
    staff_profiles = db.query(StaffProfile).order_by(StaffProfile.id).all()
    if len(classes) != EXPECTED_CLASS_COUNT:
        raise ValueError(
            f"Timetable generation requires exactly {EXPECTED_CLASS_COUNT} classes; "
            f"found {len(classes)}"
        )

    staff_by_user_id = {profile.user_id: profile for profile in staff_profiles}
    advisor_codes: dict[str, str] = {}
    for student_class in classes:
        if student_class.advisor_faculty_id is None:
            raise ValueError(f"{student_class.class_code} has no advisor faculty")
        advisor = staff_by_user_id.get(student_class.advisor_faculty_id)
        if advisor is None:
            raise ValueError(f"{student_class.class_code} advisor has no staff profile")
        advisor_codes[student_class.class_code] = advisor.staff_code

    lab_staff: dict[str, list[str]] = {}
    for lab in labs:
        assigned = sorted(
            profile.staff_code
            for profile in staff_profiles
            if profile.assigned_lab_code == lab.code
        )
        if len(assigned) < 2:
            raise ValueError(f"{lab.code} requires two assigned lab staff")
        lab_staff[lab.code] = assigned[:2]

    allowed_labs = {
        student_class.class_code: _allowed_lab_codes(student_class, labs)
        for student_class in classes
    }
    for class_code, pool in allowed_labs.items():
        if not pool:
            raise ValueError(f"{class_code} has an empty lab pool")

    model = cp_model.CpModel()
    assignment: dict[tuple[str, str, int, str], cp_model.IntVar] = {}
    is_lab: dict[tuple[str, str, int], cp_model.IntVar] = {}

    for student_class in classes:
        class_code = student_class.class_code
        for day in DAYS:
            daily_assignments = []
            for period in PERIOD_NUMBERS:
                period_assignments = []
                for lab_code in allowed_labs[class_code]:
                    variable = model.NewBoolVar(f"x_{class_code}_{day}_{period}_{lab_code}")
                    assignment[class_code, day, period, lab_code] = variable
                    period_assignments.append(variable)
                    daily_assignments.append(variable)
                lab_variable = model.NewBoolVar(f"lab_{class_code}_{day}_{period}")
                is_lab[class_code, day, period] = lab_variable
                model.Add(lab_variable == sum(period_assignments))
            # Hard constraint 1: exactly one lab period per class per day.
            model.AddExactlyOne(daily_assignments)

    # Hard constraint 4: exactly fifteen classes are away at a lab in every slot.
    for day in DAYS:
        for period in PERIOD_NUMBERS:
            model.Add(
                sum(is_lab[c.class_code, day, period] for c in classes)
                == EXPECTED_LABS_PER_PERIOD
            )

    # Hard constraint 3: a lab accommodates at most one class per slot.
    for lab in labs:
        for day in DAYS:
            for period in PERIOD_NUMBERS:
                occupants = [
                    variable
                    for (class_code, variable_day, variable_period, lab_code), variable
                    in assignment.items()
                    if variable_day == day and variable_period == period and lab_code == lab.code
                ]
                if occupants:
                    model.AddAtMostOne(occupants)

    # Hard constraint 6: each class uses at least three distinct lab periods/week.
    for student_class in classes:
        class_code = student_class.class_code
        used_periods = []
        for period in PERIOD_NUMBERS:
            used = model.NewBoolVar(f"used_{class_code}_{period}")
            used_periods.append(used)
            daily = [is_lab[class_code, day, period] for day in DAYS]
            for daily_variable in daily:
                model.Add(used >= daily_variable)
            model.Add(used <= sum(daily))
        model.Add(sum(used_periods) >= 3)

    # Hard constraint 3 (classrooms): theory occupants use their home room.
    # Home-room codes are unique in the schema, so these normally contain one
    # expression; retaining the constraint makes the no-collision rule explicit.
    room_usage: dict[tuple[str, str, int], list[Any]] = defaultdict(list)
    for student_class in classes:
        for day in DAYS:
            for period in PERIOD_NUMBERS:
                room_usage[student_class.home_room_code, day, period].append(
                    1 - is_lab[student_class.class_code, day, period]
                )
    for usages in room_usage.values():
        if len(usages) > 1:
            model.Add(sum(usages) <= 1)

    # Hard constraint 5: combine advisor theory work and both lab-staff roles in
    # one non-overlap constraint per staff member and grid slot.  Normally each
    # advisor/lab employee has only one possible location, but keeping these
    # constraints explicit also handles shared staff safely.
    staff_usage: dict[tuple[str, str, int], list[Any]] = defaultdict(list)
    for student_class in classes:
        class_code = student_class.class_code
        advisor_code = advisor_codes[class_code]
        for day in DAYS:
            for period in PERIOD_NUMBERS:
                staff_usage[advisor_code, day, period].append(
                    1 - is_lab[class_code, day, period]
                )
                for lab_code in allowed_labs[class_code]:
                    variable = assignment[class_code, day, period, lab_code]
                    for staff_code in lab_staff[lab_code]:
                        staff_usage[staff_code, day, period].append(variable)
    for usages in staff_usage.values():
        if len(usages) > 1:
            model.Add(sum(usages) <= 1)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = settings.timetable_solver_seconds
    solver.parameters.num_search_workers = 8
    solver.parameters.random_seed = 42
    status = solver.Solve(model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        raise RuntimeError(f"CP-SAT could not generate a timetable: {solver.StatusName(status)}")

    selected_lab: dict[tuple[str, str, int], str] = {}
    for (class_code, day, period, lab_code), variable in assignment.items():
        if solver.BooleanValue(variable):
            selected_lab[class_code, day, period] = lab_code

    class_by_code = {student_class.class_code: student_class for student_class in classes}
    rows: list[TimetableSlot] = []
    for day in DAYS:
        for period in PERIOD_NUMBERS:
            for class_code in sorted(class_by_code):
                student_class = class_by_code[class_code]
                lab_code = selected_lab.get((class_code, day, period))
                if lab_code is not None:
                    subject_code, subject_title = _lab_subject(student_class, day, lab_code)
                    primary_staff, assisting_staff = lab_staff[lab_code]
                    rows.append(
                        TimetableSlot(
                            day_of_week=day,
                            period_number=period,
                            class_code=class_code,
                            session_type="LAB",
                            subject_code=subject_code,
                            subject_title=subject_title,
                            scheduled_space_code=lab_code,
                            effective_space_code=lab_code,
                            is_relocated=False,
                            faculty_staff_code=primary_staff,
                            assisting_lab_staff_code=assisting_staff,
                        )
                    )
                else:
                    department = student_class.department.code.upper()
                    rows.append(
                        TimetableSlot(
                            day_of_week=day,
                            period_number=period,
                            class_code=class_code,
                            session_type="THEORY",
                            subject_code=f"{department}-{student_class.year_number}T{period}",
                            subject_title=(
                                f"{department} Year {student_class.year_number} "
                                f"Theory {period}"
                            ),
                            scheduled_space_code=student_class.home_room_code,
                            effective_space_code=student_class.home_room_code,
                            is_relocated=False,
                            faculty_staff_code=advisor_codes[class_code],
                            assisting_lab_staff_code=None,
                        )
                    )

    if len(rows) != EXPECTED_SLOT_COUNT:
        raise RuntimeError(f"Internal solver error: generated {len(rows)} rows")
    try:
        db.query(TimetableSlot).delete(synchronize_session=False)
        db.add_all(rows)
        db.flush()
        db.commit()
    except Exception:
        db.rollback()
        raise
    return rows


def validate_timetable(db: Session) -> dict[str, Any]:
    """Re-read persisted rows and independently verify every hard constraint."""

    slots = db.query(TimetableSlot).all()
    classes = db.query(StudentClass).all()
    labs = db.query(Lab).all()
    class_by_code = {student_class.class_code: student_class for student_class in classes}
    lab_codes = {lab.code for lab in labs}

    grid_counts = Counter((slot.day_of_week, slot.period_number, slot.class_code) for slot in slots)
    expected_grid = {
        (day, period, student_class.class_code)
        for student_class in classes
        for day in DAYS
        for period in PERIOD_NUMBERS
    }
    grid_valid = (
        len(classes) == EXPECTED_CLASS_COUNT
        and len(slots) == EXPECTED_SLOT_COUNT
        and set(grid_counts) == expected_grid
        and all(count == 1 for count in grid_counts.values())
    )

    daily_lab_counts = Counter(
        (slot.day_of_week, slot.class_code)
        for slot in slots
        if slot.session_type == "LAB"
    )
    one_lab_per_day = grid_valid and all(
        daily_lab_counts[day, student_class.class_code] == 1
        for student_class in classes
        for day in DAYS
    )

    lab_occupancy = Counter(
        (slot.day_of_week, slot.period_number, slot.effective_space_code)
        for slot in slots
        if slot.session_type == "LAB"
    )
    zero_lab_collisions = all(count <= 1 for count in lab_occupancy.values())

    space_occupancy = Counter(
        (slot.day_of_week, slot.period_number, slot.effective_space_code)
        for slot in slots
    )
    zero_room_collisions = all(count <= 1 for count in space_occupancy.values())

    staff_occupancy: Counter[tuple[str, int, str]] = Counter()
    for slot in slots:
        staff_codes = [slot.faculty_staff_code]
        if slot.assisting_lab_staff_code:
            staff_codes.append(slot.assisting_lab_staff_code)
        for staff_code in staff_codes:
            if staff_code:
                staff_occupancy[slot.day_of_week, slot.period_number, staff_code] += 1
    zero_staff_collisions = all(count <= 1 for count in staff_occupancy.values())

    lab_pool_valid = True
    for slot in slots:
        if slot.session_type != "LAB":
            continue
        student_class = class_by_code.get(slot.class_code)
        if (
            student_class is None
            or slot.scheduled_space_code not in lab_codes
            or slot.scheduled_space_code not in _allowed_lab_codes(student_class, labs)
        ):
            lab_pool_valid = False
            break

    weekly_periods: dict[str, set[int]] = defaultdict(set)
    for slot in slots:
        if slot.session_type == "LAB":
            weekly_periods[slot.class_code].add(slot.period_number)
    weekly_variety_valid = all(
        len(weekly_periods[student_class.class_code]) >= 3 for student_class in classes
    )

    period_lab_counts = Counter(
        (slot.day_of_week, slot.period_number)
        for slot in slots
        if slot.session_type == "LAB"
    )
    exact_vacancies = all(
        period_lab_counts[day, period] == EXPECTED_LABS_PER_PERIOD
        for day in DAYS
        for period in PERIOD_NUMBERS
    )

    constraint_results = {
        "one_lab_per_day_per_class": one_lab_per_day,
        "zero_lab_collisions": zero_lab_collisions,
        "zero_room_collisions": zero_room_collisions,
        "zero_staff_collisions": zero_staff_collisions,
        "vacant_home_rooms_per_period": EXPECTED_LABS_PER_PERIOD if exact_vacancies else 0,
    }
    valid = all(
        (
            grid_valid,
            one_lab_per_day,
            zero_lab_collisions,
            zero_room_collisions,
            zero_staff_collisions,
            lab_pool_valid,
            weekly_variety_valid,
            exact_vacancies,
        )
    )
    return {
        "valid": valid,
        "total_slots": len(slots),
        "constraint_results": constraint_results,
    }
