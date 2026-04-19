from __future__ import annotations

import base64
import logging
import os
from io import BytesIO

from flask import Flask
from langchain.agents import create_agent
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_openai import ChatOpenAI
from openai import OpenAI

from agent.logutil import get_logger, trunc_preview
from agent.nav_context import reset_navigation_result, take_navigation_plan
from agent.prompts import BITCH_MODE_SYSTEM_PROMPT, SYSTEM_PROMPT
from agent.tools import find_place, navigate
from app.locations import list_buildings

log = get_logger("service")

_graph = None
_graph_mode: str | None = None


def _bitch_mode_enabled() -> bool:
    v = (os.getenv("AGENT_BITCH_MODE") or "").strip().lower()
    return v in ("1", "true", "yes", "on")


def _places_hint() -> str:
    """Tell the model which buildings have indoor (room-level) data.

    Off-map places (other campus buildings, neighboring shops, POIs) are
    NOT enumerated here — the catalog is too large and grows with OSM
    imports. The model resolves those by calling ``find_place`` (or
    just letting ``navigate`` do its own OSM fallback).
    """
    indoor = list_buildings()
    if not indoor:
        return (
            "No indoor buildings are mapped yet. For any destination, call "
            "`find_place` first to confirm the name resolves on the map."
        )
    return (
        "Indoor buildings (these support `destination_room` / `current_room`): "
        + ", ".join(indoor)
        + ". Any other place name (off-campus shops, restaurants, parks, "
        "unmapped campus buildings, etc.) is resolved at tool time — pass it "
        "as `destination_building` (no room) or call `find_place` first if "
        "the request is vague or ambiguous."
    )


def get_agent_graph():
    global _graph, _graph_mode
    want = "bitch" if _bitch_mode_enabled() else "default"
    if _graph is not None and _graph_mode == want:
        return _graph
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")
    llm = ChatOpenAI(model="gpt-4o-mini", temperature=0, api_key=api_key)
    base = BITCH_MODE_SYSTEM_PROMPT if want == "bitch" else SYSTEM_PROMPT
    system = base.strip() + "\n\n" + _places_hint()
    _graph = create_agent(
        model=llm,
        tools=[find_place, navigate],
        system_prompt=system,
    )
    _graph_mode = want
    log.info(
        "agent_graph_built mode=%s model=gpt-4o-mini system_prompt_chars=%s",
        want,
        len(system),
    )
    return _graph


def _apply_agent_log_level() -> None:
    raw = (os.getenv("AGENT_LOG_LEVEL") or "").strip().upper()
    if not raw:
        return
    lvl = getattr(logging, raw, None)
    if not isinstance(lvl, int):
        return
    logging.getLogger("maristmaps.agent").setLevel(lvl)


def init_agent(app: Flask) -> None:
    """Warm configuration; graph is created lazily on first request."""
    _apply_agent_log_level()

    @app.teardown_appcontext
    def _clear_nav(_exc):
        reset_navigation_result()


def _format_user_message(
    text: str,
    *,
    from_lon,
    from_lat,
    from_label: str | None,
) -> str:
    parts = [f"User request:\n{text.strip()}"]
    loc_lines = []
    coords_ok = False
    if from_lon is not None and from_lat is not None:
        try:
            loc_lines.append(
                f"- Map coordinates (lon, lat): {float(from_lon)}, {float(from_lat)}"
            )
            coords_ok = True
        except (TypeError, ValueError):
            pass
    if from_label:
        loc_lines.append(f"- Map label: {from_label}")
    if loc_lines:
        block = "Current location context:\n" + "\n".join(loc_lines)
        if coords_ok:
            block += (
                "\n\nUsing this context block (FALLBACK ONLY): if the user "
                "did NOT explicitly name a starting building or room in "
                "their request, treat these map coordinates as the start "
                "and pass them to navigate as current_lon and current_lat. "
                "If the user DID name a start (e.g. \"from Hancock 2020 "
                "...\"), pass current_building / current_room from the "
                "user's words and ignore these coordinates. Either way, do "
                "NOT ask the user where they are starting from."
            )
        parts.append(block)
    else:
        parts.append(
            "Current location context: not provided — ask where they are if you "
            "need it for routing."
        )
    return "\n\n".join(parts)


def _had_navigate_tool_call(messages: list) -> bool:
    """True iff the model attempted ``navigate`` (the tool that actually
    plans a trip). ``find_place`` lookups don't count — calling only that
    means the model gathered info but never committed.
    """
    for m in messages:
        if isinstance(m, AIMessage):
            for tc in (m.tool_calls or []):
                if (tc.get("name") or "").lower() == "navigate":
                    return True
        if isinstance(m, ToolMessage) and (m.name or "").lower() == "navigate":
            return True
    return False


def looks_like_question(text: str) -> bool:
    """A reply that genuinely asks for clarification.

    We accept either a literal '?' (the prompts demand one for any
    clarification) or the assistant explicitly asking for a missing field.
    """
    if not text:
        return False
    s = text.strip()
    if "?" in s:
        return True
    low = s.lower()
    cues = (
        "what building",
        "which building",
        "what room",
        "which room",
        "where are you",
        "where do you",
        "tell me",
        "let me know",
        "could you say",
        "please say",
        "please tell",
    )
    return any(c in low for c in cues)


def _last_ai_text(messages: list) -> str:
    for m in reversed(messages):
        if isinstance(m, AIMessage):
            c = m.content
            if isinstance(c, str) and c.strip():
                return c.strip()
            if isinstance(c, list):
                chunks = []
                for block in c:
                    if isinstance(block, dict) and block.get("type") == "text":
                        chunks.append(block.get("text") or "")
                joined = " ".join(chunks).strip()
                if joined:
                    return joined
    return ""


def speech_to_text(audio_bytes: bytes, filename: str, _mime: str | None = None) -> str:
    log.info(
        "whisper_request bytes=%s filename=%s",
        len(audio_bytes),
        filename or "audio",
    )
    client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
    buf = BytesIO(audio_bytes)
    buf.name = filename or "audio.webm"
    tr = client.audio.transcriptions.create(
        model="whisper-1",
        file=buf,
    )
    text = (tr.text or "").strip()
    log.info("whisper_response text_preview=%r", trunc_preview(text, 600))
    return text


def text_to_speech_mp3(text: str) -> bytes:
    clip = text[:4096]
    log.info("tts_request chars=%s preview=%r", len(clip), trunc_preview(clip, 200))
    client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
    speech = client.audio.speech.create(
        model="tts-1",
        voice="alloy",
        input=clip,
    )
    raw = speech.content
    log.info("tts_response bytes=%s", len(raw) if raw else 0)
    return raw


def _without_system(msgs: list[BaseMessage]) -> list[BaseMessage]:
    return [m for m in msgs if not isinstance(m, SystemMessage)]


def _ai_text_for_replay(m: AIMessage) -> str:
    """Visible assistant text only (no tool_calls), for OpenAI replay."""
    c = m.content
    if isinstance(c, str) and c.strip():
        return c.strip()
    if isinstance(c, list):
        chunks = []
        for block in c:
            if isinstance(block, dict) and block.get("type") == "text":
                chunks.append(block.get("text") or "")
        return " ".join(chunks).strip()
    return ""


def flatten_messages_for_replay(msgs: list[BaseMessage]) -> list[BaseMessage]:
    """Strip tool/tool_call chains so replay never sends orphaned ``tool`` messages."""
    out: list[BaseMessage] = []
    for m in msgs:
        if isinstance(m, HumanMessage):
            out.append(HumanMessage(content=m.content))
        elif isinstance(m, AIMessage):
            t = _ai_text_for_replay(m)
            if t:
                out.append(AIMessage(content=t))
    return out


def _log_langgraph_messages(msgs: list) -> None:
    """Log each message: human, assistant text, tool_calls, tool results."""
    log.info("langgraph_message_count=%s", len(msgs))
    for i, m in enumerate(msgs):
        if isinstance(m, HumanMessage):
            log.info(
                "  msg[%s] type=HumanMessage content=%r",
                i,
                trunc_preview(m.content, 800),
            )
        elif isinstance(m, AIMessage):
            tcalls = list(m.tool_calls or [])
            if tcalls:
                for j, tc in enumerate(tcalls):
                    log.info(
                        "  msg[%s] type=AIMessage tool_call[%s] name=%r id=%r args=%r",
                        i,
                        j,
                        tc.get("name"),
                        tc.get("id"),
                        trunc_preview(tc.get("args"), 800),
                    )
            txt = _ai_text_for_replay(m)
            if txt:
                log.info(
                    "  msg[%s] type=AIMessage assistant_text=%r",
                    i,
                    trunc_preview(txt, 800),
                )
            if not tcalls and not txt:
                log.info("  msg[%s] type=AIMessage (no text, no tool_calls)", i)
        elif isinstance(m, ToolMessage):
            log.info(
                "  msg[%s] type=ToolMessage name=%r tool_call_id=%r content=%r",
                i,
                m.name,
                getattr(m, "tool_call_id", None),
                trunc_preview(str(m.content), 900),
            )
        elif isinstance(m, SystemMessage):
            log.info(
                "  msg[%s] type=SystemMessage len=%s",
                i,
                len(str(m.content)),
            )
        else:
            log.info("  msg[%s] type=%s repr=%r", i, type(m).__name__, trunc_preview(str(m), 300))


def run_agent_turn(
    message: str,
    *,
    history: list[BaseMessage] | None = None,
    from_lon=None,
    from_lat=None,
    from_label: str | None = None,
) -> tuple[str, dict | None, bytes | None, list[BaseMessage]]:
    """Returns (reply, plan, tts_audio_or_none, full_messages_for_session_persist)."""
    reset_navigation_result()
    graph = get_agent_graph()
    user_content = _format_user_message(
        message,
        from_lon=from_lon,
        from_lat=from_lat,
        from_label=from_label,
    )
    prior = flatten_messages_for_replay(_without_system(list(history or [])))
    log.info(
        "agent_turn_start raw_user_message=%r prior_flat_messages=%s from_lon=%s from_lat=%s "
        "from_label=%r bitch_mode=%s",
        trunc_preview(message, 1200),
        len(prior),
        from_lon,
        from_lat,
        from_label,
        _bitch_mode_enabled(),
    )
    log.debug("agent_turn_formatted_user_block=%r", trunc_preview(user_content, 2000))

    initial_messages = prior + [HumanMessage(content=user_content)]
    result = graph.invoke({"messages": initial_messages})
    messages = result.get("messages") or []
    _log_langgraph_messages(messages)

    reply = _last_ai_text(messages)
    plan = take_navigation_plan()

    # The model sometimes whiffs: it produces a conversational reply like
    # "Sure, let me plan that for you" without ever calling `navigate`. That
    # confuses the voice loop (no plan, but no real question to answer either).
    # When that happens, nudge it once and retry.
    if (
        plan is None
        and not _had_navigate_tool_call(messages)
        and reply
        and not looks_like_question(reply)
    ):
        log.warning(
            "agent_turn_no_tool_no_question retrying with nudge reply_preview=%r",
            trunc_preview(reply, 300),
        )
        nudge = SystemMessage(content=(
            "You just replied without calling the `navigate` tool and without "
            "asking the user a clarifying question. That is not allowed. "
            "Either call `navigate` now with the destination and any starting "
            "point you have (the user's map coordinates count as a starting "
            "point), or reply with ONE specific clarifying question that ends "
            "in '?'. Do not say 'planning your trip' or any similar filler."
        ))
        retry_messages = list(messages) + [nudge]
        result = graph.invoke({"messages": retry_messages})
        messages = result.get("messages") or messages
        _log_langgraph_messages(messages)
        reply = _last_ai_text(messages) or reply
        plan = take_navigation_plan()

    if not reply:
        reply = (
            "Please say where you'd like to go and, if you can, where you're "
            "starting from."
        )
    audio: bytes | None = None
    if reply:
        audio = text_to_speech_mp3(reply)

    stored = flatten_messages_for_replay(_without_system(messages))
    log.info(
        "agent_turn_done reply_preview=%r navigated=%s session_out_messages=%s audio_bytes=%s",
        trunc_preview(reply, 900),
        plan is not None,
        len(stored),
        len(audio) if audio else 0,
    )
    if plan:
        log.info(
            "agent_route_summary origin_label=%r dest_label=%r distance_m=%s duration_s=%s",
            plan.get("origin_label"),
            plan.get("destination_label"),
            plan.get("distance_m"),
            plan.get("duration_s"),
        )
    return reply, plan, audio, stored


def run_agent_turn_b64(
    message: str,
    *,
    history: list[BaseMessage] | None = None,
    from_lon=None,
    from_lat=None,
    from_label: str | None = None,
) -> tuple[str, dict | None, str | None, list[BaseMessage]]:
    reply, plan, audio, stored = run_agent_turn(
        message,
        history=history,
        from_lon=from_lon,
        from_lat=from_lat,
        from_label=from_label,
    )
    b64 = base64.b64encode(audio).decode("ascii") if audio else None
    return reply, plan, b64, stored
