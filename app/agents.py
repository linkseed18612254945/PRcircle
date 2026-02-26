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

    async def _plan_search_queries(
        self,
        state: DialogueState,
        counterpart_message: str,
        own_last_message: str,
    ) -> list[str]:
        """Use the model to produce directional, understanding-aware search queries."""
        planner_prompt = (
            f"你是{self.role}检索规划器。\n"
            f"话题: {state.topic}\n"
            f"当前轮次: {state.turn_index}\n"
            f"对方最新观点/问题: {counterpart_message[:500] or '无'}\n"
            f"我方上一轮结论: {own_last_message[:500] or '无'}\n"
            f"共享情报池摘要:\n{self._intel_digest(state)}\n\n"
            "请输出3条高质量检索词，每条都必须包含：\n"
            "1) 研究方向关键词（如机制/风险/反例/边界条件）\n"
            "2) 当前理解关键词（体现对话中的核心判断）\n"
            "3) 验证意图关键词（证据/数据/案例/实验）\n"
            "输出格式：仅输出JSON数组字符串，例如"
            '["query1", "query2", "query3"]'
        )
        try:
            raw = await self.call_llm(
                [
                    {"role": "system", "content": "你只输出 JSON 数组，不要解释。"},
                    {"role": "user", "content": planner_prompt},
                ]
            )
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                cleaned = [str(x).strip() for x in parsed if str(x).strip()]
                if cleaned:
                    return cleaned[:3]
        except Exception:
            pass

        fallback_core = counterpart_message[:80] if counterpart_message else "核心假设"
        return [
            f"{state.topic} 机制 {fallback_core} 证据 数据",
            f"{state.topic} 风险 边界条件 {fallback_core} 失败案例",
            f"{state.topic} 反例 验证 实验 {fallback_core}",
        ]


class AnalysisAgent(BaseAgent):
    async def generate(self, state: DialogueState) -> AgentMessage:
        prior_critic = next((m for m in reversed(state.messages) if m.get("role") == "B"), None)
        prior_questions = prior_critic.get("content", "") if prior_critic else "无"
        own_last = next((m for m in reversed(state.messages) if m.get("role") == "A"), None)
        own_last_content = own_last.get("content", "") if own_last else ""

        search_queries = await self._plan_search_queries(
            state=state,
            counterpart_message=prior_questions,
            own_last_message=own_last_content,
        )

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
            f"本轮检索词:\n- " + "\n- ".join(search_queries) + "\n"
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
        own_last = next((m for m in reversed(state.messages) if m.get("role") == "B"), None)
        own_last_content = own_last.get("content", "") if own_last else ""

        search_queries = await self._plan_search_queries(
            state=state,
            counterpart_message=a_reference,
            own_last_message=own_last_content,
        )

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
            f"本轮检索词:\n- " + "\n- ".join(search_queries) + "\n"
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
