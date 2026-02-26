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

    def _intel_digest(self, state: DialogueState, topn: int = 5) -> str:
        if not state.intel_pool:
            return "无"
        items = state.intel_pool[-topn:]
        return "\n".join([f"- {r.title} ({r.url}): {r.content[:160]}" for r in items])


class AnalysisAgent(BaseAgent):
    async def generate(self, state: DialogueState) -> AgentMessage:
        prior_critic = next((m for m in reversed(state.messages) if m.get("role") == "B"), None)
        prior_questions = prior_critic.get("content", "") if prior_critic else "无"

        query_candidates = [
            state.topic,
            f"{state.topic} {prior_questions[:120]}",
            f"{state.topic} 最新证据 争议点 数据",
        ]
        search_queries = [q.strip() for q in query_candidates if q.strip()]

        merged_results: list[RetrievalResult] = []
        for query in search_queries:
            merged_results.extend(await self.maybe_call_search(query))

        new_intel = state.add_intel(merged_results)
        retrieval_digest = "\n".join(
            [f"- {r.title} ({r.url}): {r.content[:200]}" for r in new_intel[:5]]
        )

        user_prompt = (
            f"话题: {state.topic}\n"
            f"当前轮次: {state.turn_index}\n"
            f"Agent B 上一轮内容（请先回答其中的问题）:\n{prior_questions}\n"
            f"本轮新增检索情报:\n{retrieval_digest or '无新增'}\n"
            f"历史共享情报池（去重汇总）:\n{self._intel_digest(state)}\n"
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
            retrievals=new_intel,
            search_queries=search_queries,
        )


class ChallengeAgent(BaseAgent):
    async def generate(self, state: DialogueState) -> AgentMessage:
        last_a = next((m for m in reversed(state.messages) if m.get("role") == "A"), None)
        a_reference = last_a.get("content", "") if last_a else ""

        query_candidates = [
            f"{state.topic} 反例",
            f"{state.topic} 风险 失败案例",
            f"{state.topic} {a_reference[:120]} 质疑 证据",
        ]
        search_queries = [q.strip() for q in query_candidates if q.strip()]

        merged_results: list[RetrievalResult] = []
        for query in search_queries:
            merged_results.extend(await self.maybe_call_search(query))

        new_intel = state.add_intel(merged_results)
        retrieval_digest = "\n".join(
            [f"- {r.title} ({r.url}): {r.content[:200]}" for r in new_intel[:5]]
        )

        user_prompt = (
            f"话题: {state.topic}\n"
            f"分析者最新输出:\n{a_reference}\n"
            f"本轮新增检索情报:\n{retrieval_digest or '无新增'}\n"
            f"历史共享情报池（去重汇总）:\n{self._intel_digest(state)}\n"
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
            retrievals=new_intel,
            search_queries=search_queries,
        )
