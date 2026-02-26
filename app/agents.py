from __future__ import annotations

import json
import re
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

    def _extract_keywords(self, text: str, maxn: int = 8) -> list[str]:
        tokens = re.findall(r"[A-Za-z0-9\u4e00-\u9fff]{2,}", text)
        seen: set[str] = set()
        keywords: list[str] = []
        for token in tokens:
            t = token.lower()
            if t in seen:
                continue
            seen.add(t)
            keywords.append(token)
            if len(keywords) >= maxn:
                break
        return keywords

    def _intel_digest(self, state: DialogueState, topn: int = 6) -> str:
        if not state.intel_pool:
            return "无"
        items = state.intel_pool[-topn:]
        return "\n".join([f"- {r.title} ({r.url}): {r.content[:160]}" for r in items])

    def _select_intel_for_prompt(self, state: DialogueState, focus_text: str, topn: int = 5) -> list[RetrievalResult]:
        if not state.intel_pool:
            return []
        focus_keywords = self._extract_keywords(f"{state.topic} {focus_text}")

        def score(item: RetrievalResult) -> float:
            hay = f"{item.title} {item.content}".lower()
            overlap = sum(1 for kw in focus_keywords if kw.lower() in hay)
            return overlap * 10 + item.score

        ranked = sorted(state.intel_pool, key=score, reverse=True)
        return ranked[:topn]

    async def _plan_search_queries(
        self,
        state: DialogueState,
        counterpart_message: str,
        own_last_message: str,
    ) -> list[str]:
        planner_prompt = (
            f"你是{self.role}检索规划器。\n"
            f"话题: {state.topic}\n"
            f"当前轮次: {state.turn_index}\n"
            f"对方最新观点/问题: {counterpart_message[:600] or '无'}\n"
            f"我方上一轮结论: {own_last_message[:600] or '无'}\n"
            f"共享情报池摘要:\n{self._intel_digest(state)}\n\n"
            "请输出3条检索规划，每条必须包含 direction / understanding / verification / query 字段。\n"
            "其中query要把方向、当前理解和验证意图融合成一个完整检索词。\n"
            "输出格式：仅输出 JSON 数组。"
        )
        queries: list[str] = []
        try:
            raw = await self.call_llm(
                [
                    {"role": "system", "content": "你只输出 JSON 数组，不要解释。"},
                    {"role": "user", "content": planner_prompt},
                ]
            )
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                for item in parsed:
                    if isinstance(item, dict):
                        query = str(item.get("query", "")).strip()
                        if query:
                            queries.append(query)
                    elif isinstance(item, str) and item.strip():
                        queries.append(item.strip())
        except Exception:
            pass

        if not queries:
            counter_keywords = " ".join(self._extract_keywords(counterpart_message, maxn=4)) or "核心假设"
            own_keywords = " ".join(self._extract_keywords(own_last_message, maxn=4)) or "当前结论"
            queries = [
                f"{state.topic} 机制路径 {own_keywords} 证据 数据",
                f"{state.topic} 风险边界 {counter_keywords} 反例 案例",
                f"{state.topic} 验证实验 指标 对照研究 {counter_keywords}",
            ]

        deduped = state.add_queries(queries)
        if deduped:
            return deduped[:3]

        # All planned queries are duplicates; force a novelty suffix using round index.
        return [f"{query} round{state.turn_index}" for query in queries[:3]]


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
        focus_intel = self._select_intel_for_prompt(state, prior_questions)
        retrieval_digest = "\n".join(
            [f"- {r.title} ({r.url}): {r.content[:200]}" for r in focus_intel]
        )

        user_prompt = (
            f"话题: {state.topic}\n"
            f"当前轮次: {state.turn_index}\n"
            f"Agent B 上一轮内容（请先回答其中的问题）:\n{prior_questions}\n"
            f"本轮检索词（思考结果）:\n- " + "\n- ".join(search_queries) + "\n"
            f"本轮新增检索情报数: {len(new_intel)}\n"
            f"当前相关证据（从共享池按相关性筛选）:\n{retrieval_digest or '无'}\n"
            "请在回答中明确：你使用了哪些证据、哪些仍需验证。"
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
        focus_intel = self._select_intel_for_prompt(state, a_reference)
        retrieval_digest = "\n".join(
            [f"- {r.title} ({r.url}): {r.content[:200]}" for r in focus_intel]
        )

        user_prompt = (
            f"话题: {state.topic}\n"
            f"分析者最新输出:\n{a_reference}\n"
            f"本轮检索词（思考结果）:\n- " + "\n- ".join(search_queries) + "\n"
            f"本轮新增检索情报数: {len(new_intel)}\n"
            f"当前相关证据（从共享池按相关性筛选）:\n{retrieval_digest or '无'}\n"
            "请基于证据提出关键批评、明确问题（至少1个）和测试建议。"
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
