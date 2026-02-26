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
        search_tool: TavilySearchTool,
        search_topk: int,
    ):
        self.id = agent_id
        self.role = role
        self.llm_config = llm_config
        self.system_prompt = system_prompt
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


class AnalysisAgent(BaseAgent):
    async def generate(self, state: DialogueState) -> AgentMessage:
        prior_critic = next((m for m in reversed(state.messages) if m.get("role") == "B"), None)
        required_mutations = []
        if prior_critic:
            required_mutations = prior_critic.get("structured", {}).get("required_mutations", [])

        retrievals = await self.maybe_call_search(state.topic)
        retrieval_digest = "\n".join(
            [f"- {r.title} ({r.url}): {r.content[:200]}" for r in retrievals[:3]]
        )

        user_prompt = (
            f"话题: {state.topic}\n"
            f"当前轮次: {state.turn_index}\n"
            f"上一轮要求变异: {required_mutations or ['无']}\n"
            f"检索摘要:\n{retrieval_digest or '无'}\n"
            "请给出清晰分析，可使用自然语言或 JSON 结构。"
        )
        response = await self.call_llm(
            [
                {"role": "system", "content": self.system_prompt},
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
            "请提出关键批评、必须修正项、测试建议与追问。可使用自然语言或 JSON。"
        )
        response = await self.call_llm(
            [
                {"role": "system", "content": self.system_prompt},
                {"role": "user", "content": user_prompt},
            ]
        )
        return AgentMessage(
            role="B",
            content=response,
            structured=self._try_extract_json(response),
            retrievals=retrievals,
        )
