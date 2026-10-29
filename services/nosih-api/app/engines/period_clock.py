"""In-memory campus clock and period calculations.

The clock is deliberately independent of the wall clock after it has been patched so
that the operations portal can demonstrate any part of the academic day.  A process
restart restores the current local day/time (weekends are clamped to Monday).
"""

from __future__ import annotations

from datetime import datetime
from math import ceil
from threading import RLock
from typing import Final

DAYS_OF_WEEK: Final[tuple[str, ...]] = ("MON", "TUE", "WED", "THU", "FRI")

# period: (start minutes after midnight, end minutes after midnight, display label)
PERIODS: Final[dict[int, tuple[int, int, str]]] = {
    1: (9 * 60, 9 * 60 + 50, "09:00 - 09:50"),
    2: (9 * 60 + 50, 10 * 60 + 40, "09:50 - 10:40"),
    3: (10 * 60 + 55, 11 * 60 + 45, "10:55 - 11:45"),
    4: (11 * 60 + 45, 12 * 60 + 35, "11:45 - 12:35"),
    5: (13 * 60 + 20, 14 * 60 + 10, "13:20 - 14:10"),
    6: (14 * 60 + 10, 15 * 60, "14:10 - 15:00"),
}

_BREAKS: Final[tuple[tuple[int, int], ...]] = (
    (10 * 60 + 40, 10 * 60 + 55),
    (12 * 60 + 35, 13 * 60 + 20),
)


def _initial_state() -> dict[str, str]:
    now = datetime.now()
    day_index = now.weekday() if now.weekday() < len(DAYS_OF_WEEK) else 0
    return {
        "day_of_week": DAYS_OF_WEEK[day_index],
        "current_time": now.strftime("%H:%M"),
    }


_lock = RLock()
_clock_state = _initial_state()


def _minutes_after_midnight(value: str) -> int:
    try:
        parsed = datetime.strptime(value.strip(), "%H:%M")
    except ValueError as exc:
        raise ValueError("current_time must use 24-hour HH:MM format") from exc
    return parsed.hour * 60 + parsed.minute


def period_time_label(period_number: int) -> str:
    """Return the contractual display label for a period."""

    return PERIODS[period_number][2]


def calculate_period_context(current_time: str) -> dict[str, int | bool | None]:
    """Calculate the active period, remaining minutes and break state.

    Remaining minutes are rounded up when this helper is supplied a time containing
    seconds.  Tea/lunch and time outside the academic grid have no active period.
    """

    normalized = current_time.strip()
    try:
        parsed = datetime.strptime(normalized, "%H:%M")
        seconds_into_day = parsed.hour * 3600 + parsed.minute * 60
    except ValueError:
        try:
            parsed = datetime.strptime(normalized, "%H:%M:%S")
        except ValueError as exc:
            raise ValueError("current_time must use 24-hour HH:MM format") from exc
        seconds_into_day = parsed.hour * 3600 + parsed.minute * 60 + parsed.second

    minute = seconds_into_day // 60
    for number, (start, end, _label) in PERIODS.items():
        if start * 60 <= seconds_into_day < end * 60:
            return {
                "active_period": number,
                "minutes_remaining": max(1, ceil((end * 60 - seconds_into_day) / 60)),
                "is_break": False,
            }

    is_break = any(start <= minute < end for start, end in _BREAKS)
    return {"active_period": None, "minutes_remaining": None, "is_break": is_break}


def get_clock() -> dict[str, str | int | bool | None]:
    """Return a consistent snapshot of the campus operational clock."""

    with _lock:
        day_of_week = _clock_state["day_of_week"]
        current_time = _clock_state["current_time"]
    return {
        "day_of_week": day_of_week,
        "current_time": current_time,
        **calculate_period_context(current_time),
    }


def update_clock(
    day_of_week: str | None = None,
    current_time: str | None = None,
) -> dict[str, str | int | bool | None]:
    """Patch the campus day and/or time and return the derived period context."""

    with _lock:
        if day_of_week is not None:
            normalized_day = day_of_week.strip().upper()
            if normalized_day not in DAYS_OF_WEEK:
                raise ValueError(f"day_of_week must be one of {', '.join(DAYS_OF_WEEK)}")
            _clock_state["day_of_week"] = normalized_day
        if current_time is not None:
            # Validate before mutating, then store one canonical representation.
            _minutes_after_midnight(current_time)
            _clock_state["current_time"] = datetime.strptime(
                current_time.strip(), "%H:%M"
            ).strftime("%H:%M")
        snapshot = dict(_clock_state)
    return {
        **snapshot,
        **calculate_period_context(snapshot["current_time"]),
    }


# Descriptive aliases for callers that prefer an explicit campus/period name.
get_campus_clock = get_clock
patch_campus_clock = update_clock
get_period_context = get_clock
