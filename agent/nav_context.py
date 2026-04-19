"""Per-request stash for a successful navigate() trip plan (thread-local)."""

from __future__ import annotations

import threading

_tls = threading.local()


def reset_navigation_result() -> None:
    _tls.plan = None


def stash_navigation_plan(plan: dict) -> None:
    _tls.plan = plan


def take_navigation_plan() -> dict | None:
    plan = getattr(_tls, "plan", None)
    _tls.plan = None
    return plan
