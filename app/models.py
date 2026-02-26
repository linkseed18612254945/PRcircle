from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, Field


class LLMConfig(BaseModel):
    model_name: str
    base_url: str
    api_key: str
    temperature: float = 0.7
    max_tokens: int = 800


class AgentConfig(LLMConfig):
    capability_prompt: str = ""


class RetrievalResult(BaseModel):
    id: str
    title: str
    url: str
    content: str
    score: float = 0.0


class AgentMessage(BaseModel):
    role: Literal["A", "B"]
    content: str
    structured: dict[str, Any] = Field(default_factory=dict)
    retrievals: list[RetrievalResult] = Field(default_factory=list)
    citation_sources: list[RetrievalResult] = Field(default_factory=list)
    search_queries: list[str] = Field(default_factory=list)
    timestamp: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class UserMessage(BaseModel):
    role: Literal["user"] = "user"
    content: str
    structured: dict[str, Any] = Field(default_factory=dict)
    timestamp: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class DialogueState(BaseModel):
    session_id: str
    topic: str
    turn_index: int = 0
    max_rounds: int = 4
    messages: list[dict[str, Any]] = Field(default_factory=list)
    intel_pool: list[RetrievalResult] = Field(default_factory=list)
    intel_ids: set[str] = Field(default_factory=set)
    searched_queries: list[str] = Field(default_factory=list)
    searched_query_fingerprints: set[str] = Field(default_factory=set)

    def add_intel(self, retrievals: list[RetrievalResult]) -> list[RetrievalResult]:
        newly_added: list[RetrievalResult] = []
        for item in retrievals:
            if item.id in self.intel_ids:
                continue
            self.intel_ids.add(item.id)
            self.intel_pool.append(item)
            newly_added.append(item)
        return newly_added

    def add_queries(self, queries: list[str]) -> list[str]:
        new_queries: list[str] = []
        for query in queries:
            q = query.strip()
            if not q:
                continue
            fingerprint = " ".join(q.lower().split())
            if fingerprint in self.searched_query_fingerprints:
                continue
            self.searched_query_fingerprints.add(fingerprint)
            self.searched_queries.append(q)
            new_queries.append(q)
        return new_queries


class RunRequest(BaseModel):
    topic: str
    session_id: str | None = None
    max_rounds: int = 4
    agentA_config: AgentConfig
    agentB_config: AgentConfig
    tavily_api_key: str
    search_topk: int = 5


class RunResponse(BaseModel):
    session_id: str
    messages: list[dict[str, Any]]
