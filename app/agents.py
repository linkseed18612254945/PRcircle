from __future__ import annotations

import json
from abc import ABC, abstractmethod
from typing import Any, Literal

from .llm_client import call_llm
from .models import AgentMessage, DialogueState, LLMConfig, RetrievalResult
from .search_tool import TavilySearchTool


class BaseAgent(ABC):
    def __init__(
        self,
        agent_id: Literal["A", "B"],
        role: Literal["analysis", "challenge"],
        llm_config: LLMConfig,
        system_prompt: str,
        capability_prompt: str,
        search_tool: TavilySearchTool,
        search_topk: int,
    ):
        self.id = agent_id
        self.role = role
        self.llm_config = llm_config
        self.system_prompt = system_prompt
        self.capability_prompt = capability_prompt
        self.search_tool = search_tool
        self.search_topk = search_topk

    @abstractmethod
    async def generate(self, state: DialogueState) -> AgentMessage:
        raise NotImplementedError

    async def maybe_call_search(self, query: str, topk: int | None = None) -> list[RetrievalResult]:
        return await self.search_tool.search(query=query, topk=topk or self.search_topk)

    async def call_llm(self, messages: list[dict[str, str]]) -> str:
        return await call_llm(messages=messages, config=self.llm_config)

    def _try_extract_json(self, text: str) -> dict[str, Any]:
        text = text.strip()
        if not text:
            return {}
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return {}

    def _build_system_prompt(self) -> str:
        return f"{self.system_prompt}\n\n能力偏好：\n{self.capability_prompt or '无'}"


class AnalysisAgent(BaseAgent):
    async def generate(self, state: DialogueState) -> AgentMessage:
        prior_critic = next((m for m in reversed(state.messages) if m.get("role") == "B"), None)
        prior_questions = prior_critic.get("content", "") if prior_critic else "无"

        retrievals = await self.maybe_call_search(state.topic)
        retrieval_digest = "\n".join(
            [f"- {r.title} ({r.url}): {r.content[:200]}" for r in retrievals[:3]]
        )

        user_prompt = (
            f"话题: {state.topic}\n"
            f"当前轮次: {state.turn_index}\n"
            f"Agent B 上一轮内容（请先回答其中的问题）:\n{prior_questions}\n"
            f"检索摘要:\n{retrieval_digest or '无'}\n"
            "请先逐条回答B的问题，再更新你的分析结论。"
        )
        response = await self.call_llm(
            [
                {"role": "system", "content": self._build_system_prompt()},
                {"role": "user", "content": user_prompt},
            ]
        )
        return AgentMessage(
            role="A",
            content=response,
            structured=self._try_extract_json(response),
            retrievals=retrievals,
        )


class ChallengeAgent(BaseAgent):
    async def generate(self, state: DialogueState) -> AgentMessage:
        last_a = next((m for m in reversed(state.messages) if m.get("role") == "A"), None)
        retrievals = await self.maybe_call_search(f"{state.topic} counterexample")
        retrieval_digest = "\n".join(
            [f"- {r.title} ({r.url}): {r.content[:200]}" for r in retrievals[:3]]
        )

        a_reference = last_a.get("content", "") if last_a else ""
        user_prompt = (
            f"话题: {state.topic}\n"
            f"分析者最新输出:\n{a_reference}\n"
            f"检索反例:\n{retrieval_digest or '无'}\n"
            "请提出关键批评、明确问题（至少1个）和测试建议。"
        )
        response = await self.call_llm(
            [
                {"role": "system", "content": self._build_system_prompt()},
                {"role": "user", "content": user_prompt},
            ]
        )
        return AgentMessage(
            role="B",
            content=response,
            structured=self._try_extract_json(response),
            retrievals=retrievals,
        )
