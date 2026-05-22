"""Shared tool descriptions used by both the MAF agent (`maf_runner.py`)
and the direct-LLM dispatcher (feature 005, `chatentry_dispatcher.py`).

Single source of truth so the two prompt-assembly paths cannot drift.
"""

from __future__ import annotations

TOOL_DESCRIPTIONS: dict[str, str] = {
    "log_feed": (
        "Record a new feeding event. Use when the caregiver reports the baby "
        "ate, drank, breastfed, or had formula/solids/water. "
        "feed_type must be one of: breast_milk, formula, solids, water. "
        "unit must be 'ml' or 'g'. occurred_at is ISO-8601 with timezone offset; "
        "use the current local time when the caregiver does not specify one."
    ),
    "update_feed": (
        "Modify an existing feed entry. Use only when the caregiver wants to "
        "correct or change a previously recorded feeding. entry_id is required."
    ),
    "delete_feed": (
        "Soft-delete an existing feed entry. Use when the caregiver says a "
        "feeding was logged by mistake or should be removed."
    ),
    "log_sleep": (
        "Record a sleep session with start_at and end_at (both ISO-8601 with "
        "timezone offset). Use when the caregiver reports the baby slept, "
        "napped, or finished a nap."
    ),
    "update_sleep": (
        "Modify an existing sleep entry. Use when the caregiver corrects a "
        "previously recorded sleep's start or end time. entry_id is required."
    ),
    "delete_sleep": (
        "Soft-delete an existing sleep entry. Use when the caregiver says a "
        "sleep record was logged by mistake or should be removed."
    ),
    "log_poop": (
        "Record a diaper / bowel-movement event. occurred_at is ISO-8601 with "
        "timezone offset. consistency is one of: watery, soft, formed, hard."
    ),
    "update_poop": (
        "Modify an existing poop entry (occurred_at or consistency). "
        "entry_id is required."
    ),
    "delete_poop": (
        "Soft-delete an existing poop entry. Use when the caregiver says the "
        "entry was logged by mistake or should be removed."
    ),
    "log_appointment": (
        "Schedule a new medical or care appointment. scheduled_at is ISO-8601 "
        "with timezone offset. Optionally include a note (<= 2000 chars)."
    ),
    "update_appointment": (
        "Modify an existing appointment's scheduled time. entry_id is required."
    ),
    "delete_appointment": (
        "Soft-delete an existing appointment. Use when the caregiver cancels "
        "or removes a scheduled appointment."
    ),
    "add_appointment_note": (
        "Append a new note (<= 2000 chars) to an existing appointment. "
        "Notes are append-only; never overwrite existing notes. "
        "appointment_id is required."
    ),
    # --- read-only tools (do not mutate state) ---
    "list_feeds": (
        "List all feed entries for a local date (YYYY-MM-DD). If `date` is "
        "omitted, defaults to today in the configured timezone. Use to answer "
        "questions like 'what feeds today?' or to resolve which entry the "
        "caregiver means before an update/delete. Returns "
        '{"date", "count", "items": [...]}.'
    ),
    "list_sleeps": (
        "List all sleep entries that STARTED on a local date (YYYY-MM-DD). "
        "Defaults to today. Returns {\"date\", \"count\", \"items\": [...]}."
    ),
    "list_poops": (
        "List all poop entries for a local date (YYYY-MM-DD). Defaults to "
        "today. Returns {\"date\", \"count\", \"items\": [...]}."
    ),
    "list_appointments": (
        "List all appointments scheduled on a local date (YYYY-MM-DD). "
        "Defaults to today. Returns {\"date\", \"count\", \"items\": [...]}."
    ),
    # Synthetic tool for the direct-LLM dispatcher.
    "ask_for_clarification": (
        "Ask the caregiver to clarify ambiguous input. Use when zero or "
        "multiple plausible candidates exist, or when required parameters "
        "(quantity, unit, time, target entry) are missing. Does not write "
        "to the database."
    ),
}
