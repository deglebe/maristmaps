"""Per-turn stash for a successful navigate() trip plan.

LangGraph's ToolNode runs tools in a ``ContextThreadPoolExecutor`` worker
thread. ``threading.local`` does NOT bridge that boundary, so a
threading.local-backed stash gets written by the worker and read as ``None``
in the parent — which is why a perfectly fine ``ROUTE_OK`` looked like
``navigated=False`` on the response.

The fix: keep a mutable dict in a ``ContextVar``. The executor calls
``contextvars.copy_context()`` before submitting the work, so the worker
sees the same dict object the parent thread created. Mutations to that dict
in the worker are visible to the parent because both threads point at the
same object.
"""

from __future__ import annotations

from contextvars import ContextVar

_holder: ContextVar[dict | None] = ContextVar("maristmaps_nav_holder", default=None)


def _get_or_create_holder() -> dict:
    holder = _holder.get()
    if holder is None:
        holder = {"plan": None}
        _holder.set(holder)
    return holder


def reset_navigation_result() -> None:
    """Start a fresh slot for the current turn (drops any prior plan)."""
    _holder.set({"plan": None})


def stash_navigation_plan(plan: dict) -> None:
    holder = _get_or_create_holder()
    holder["plan"] = plan


def take_navigation_plan() -> dict | None:
    holder = _holder.get()
    if holder is None:
        return None
    plan = holder.get("plan")
    holder["plan"] = None
    return plan
