"""Shared helpers for agent logging (truncate previews, logger name)."""

from __future__ import annotations

import logging

LOGGER_NAME = "maristmaps.agent"


def get_logger(suffix: str | None = None) -> logging.Logger:
    name = LOGGER_NAME if not suffix else f"{LOGGER_NAME}.{suffix}"
    return logging.getLogger(name)


def trunc_preview(obj, max_len: int = 500) -> str:
    """Short string for logs (avoid huge payloads)."""
    if obj is None:
        return ""
    s = obj if isinstance(obj, str) else repr(obj)
    if len(s) <= max_len:
        return s
    return s[: max_len - 3] + "..."
