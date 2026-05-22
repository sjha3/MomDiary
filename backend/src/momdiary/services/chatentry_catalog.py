"""Project the live `TOOL_REGISTRY` into JSON-Schema descriptors for the LLM.

Built fresh on every request (FR-009 + edge case "tool catalog drift").
The descriptor list is what the direct-LLM dispatcher embeds in the
system prompt and what bounds the `tool_name` enum on the structured
response schema.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from inspect import signature
from typing import Any

from pydantic import BaseModel

from momdiary.agents.tools import appointments, feeds, poops, sleeps
from momdiary.agents.tools.descriptions import TOOL_DESCRIPTIONS
from momdiary.agents.tools.registry import TOOL_REGISTRY


@dataclass(slots=True)
class ToolDescriptor:
    """Single LLM-facing tool descriptor."""

    name: str
    description: str
    parameters: dict[str, Any] = field(default_factory=dict)


# Mapping from registry tool name to its existing Pydantic argument model.
# Reusing the production models keeps the catalog projection in lock-step
# with the validation done inside each tool function.
_ARGS_MODELS: dict[str, type[BaseModel]] = {
    "log_feed": feeds.LogFeedArgs,
    "update_feed": feeds.UpdateFeedArgs,
    "delete_feed": feeds.DeleteFeedArgs,
    "log_sleep": sleeps.LogSleepArgs,
    "update_sleep": sleeps.UpdateSleepArgs,
    "delete_sleep": sleeps.DeleteSleepArgs,
    "log_poop": poops.LogPoopArgs,
    "update_poop": poops.UpdatePoopArgs,
    "delete_poop": poops.DeletePoopArgs,
    "log_appointment": appointments.LogAppointmentArgs,
    "update_appointment": appointments.UpdateAppointmentArgs,
    "delete_appointment": appointments.DeleteAppointmentArgs,
    "add_appointment_note": appointments.AddAppointmentNoteArgs,
}


_CLARIFICATION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["question"],
    "properties": {
        "question": {
            "type": "string",
            "minLength": 1,
            "maxLength": 500,
        },
        "suggested_candidates": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["entry_type", "entry_id", "summary"],
                "properties": {
                    "entry_type": {
                        "type": "string",
                        "enum": ["feed", "sleep", "poop", "appointment"],
                    },
                    "entry_id": {"type": "integer"},
                    "summary": {"type": "string"},
                },
            },
        },
    },
}


def _model_schema(model: type[BaseModel]) -> dict[str, Any]:
    """Return a JSON Schema dict for a Pydantic model.

    Uses pydantic v2's `model_json_schema()` and strips `$defs` /
    `definitions` keys that would inflate the prompt without adding
    information the model needs in the simple shapes used here.
    """
    schema = dict(model.model_json_schema())
    schema.pop("$defs", None)
    schema.pop("definitions", None)
    schema.pop("title", None)
    return schema


def build_tool_catalog() -> list[ToolDescriptor]:
    """Project the live `TOOL_REGISTRY` into JSON-Schema descriptors.

    Includes the synthetic `ask_for_clarification` entry so the LLM has
    one canonical, named way to defer instead of hallucinating a tool.
    """
    descriptors: list[ToolDescriptor] = []
    for name in TOOL_REGISTRY:
        args_model = _ARGS_MODELS.get(name)
        if args_model is None:
            # Defensive: a tool exists in the registry without a known
            # args model. Fall back to a permissive schema so the LLM can
            # still emit it, but mark the gap for the operator.
            params: dict[str, Any] = {
                "type": "object",
                "additionalProperties": True,
                "description": "Schema not registered; arguments accepted as-is.",
            }
        else:
            params = _model_schema(args_model)
        descriptors.append(
            ToolDescriptor(
                name=name,
                description=TOOL_DESCRIPTIONS.get(name, name),
                parameters=params,
            )
        )
    descriptors.append(
        ToolDescriptor(
            name="ask_for_clarification",
            description=TOOL_DESCRIPTIONS["ask_for_clarification"],
            parameters=_CLARIFICATION_SCHEMA,
        )
    )
    return descriptors


def catalog_tool_names(catalog: list[ToolDescriptor]) -> list[str]:
    """Return the ordered list of tool names — the LLM `tool_name` enum."""
    return [d.name for d in catalog]


def args_model_for(name: str) -> type[BaseModel] | None:
    """Return the Pydantic args model bound to `name`, or None for synthetic."""
    return _ARGS_MODELS.get(name)


# Public re-exports for callers that just want the projected schema list
# without instantiating descriptors.
def catalog_for_prompt(catalog: list[ToolDescriptor]) -> list[dict[str, Any]]:
    """Render the catalog as a JSON-friendly list of dicts for the prompt."""
    return [
        {
            "name": d.name,
            "description": d.description,
            "parameters": d.parameters,
        }
        for d in catalog
    ]


__all__ = [
    "ToolDescriptor",
    "args_model_for",
    "build_tool_catalog",
    "catalog_for_prompt",
    "catalog_tool_names",
    "_signature_summary",
]


def _signature_summary(name: str) -> str:
    """Return a one-line `name(arg1, arg2?)` summary for human-readable prompts."""
    fn = TOOL_REGISTRY.get(name)
    if fn is None:
        return name
    sig = signature(fn)
    parts: list[str] = []
    for param in sig.parameters.values():
        if param.name == "session":
            continue
        if param.default is param.empty:
            parts.append(param.name)
        else:
            parts.append(f"{param.name}?")
    return f"{name}({', '.join(parts)})"
