"""Compatibility shim: prefer `agent.service.get_agent_graph`."""

from agent.service import get_agent_graph as agent

__all__ = ["agent"]
