"""The tune / check split (the user, 2026-10-27: "lets split the test into 2 from now on. one for tuning and one for
vaulting" ... "i want 2026 to be in both list"): every trade belongs to the ISO week of its entry date; even weeks are
the tuning set, odd weeks the check set. Both sets cover 2024, 2025 and 2026 on the fair list and the Favorites. A
variant is picked on "tune", then run once on "check" without changes (at most 3 looks an idea); it is better only if
it beats the champion on both.
"""
import datetime as dt


def half(date):
    """'tune' for an entry in an even ISO week, 'check' for an odd one."""
    return "tune" if dt.date.fromisoformat(date).isocalendar()[1] % 2 == 0 else "check"
