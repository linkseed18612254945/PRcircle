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

    def _safe_json(self, text: str) -> dict[str, Any]:
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return {"raw": text}


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

        constraints = (
            "必须输出 JSON，格式为 {summary, candidates[]}。"
            "首轮至少给 2 个不同机制候选方案。"
            f"必须执行 mutations: {required_mutations or ['None']}。"
        )
        user_prompt = (
            f"话题: {state.topic}\n"
            f"当前轮次: {state.turn_index}\n"
            f"检索摘要:\n{retrieval_digest or '无'}\n"
            f"规则: {constraints}"
        )
        response = await self.call_llm(
            [
                {"role": "system", "content": self.system_prompt},
                {"role": "user", "content": user_prompt},
            ]
        )
        structured = self._safe_json(response)
        if state.turn_index == 0 and len(structured.get("candidates", [])) < 2:
            structured.setdefault("candidates", [])
            structured["candidates"].append(
                {
                    "name": "Fallback Candidate",
                    "core_mechanism": "Heuristic synthesis",
                    "assumptions": ["Need at least two candidates in round 1"],
                    "steps": ["Generate an alternative mechanism", "Compare trade-offs"],
                    "verification": "A/B evaluation against baseline",
                }
            )
        return AgentMessage(role="A", content=response, structured=structured, retrievals=retrievals)


class ChallengeAgent(BaseAgent):
    async def generate(self, state: DialogueState) -> AgentMessage:
        last_a = next((m for m in reversed(state.messages) if m.get("role") == "A"), None)
        retrievals = await self.maybe_call_search(f"{state.topic} counterexample")
        retrieval_digest = "\n".join(
            [f"- {r.title} ({r.url}): {r.content[:200]}" for r in retrievals[:3]]
        )
        user_prompt = (
            f"话题: {state.topic}\n"
            f"分析者最新输出: {json.dumps(last_a.get('structured', {}) if last_a else {}, ensure_ascii=False)}\n"
            f"检索反例:\n{retrieval_digest or '无'}\n"
            "必须输出 JSON，格式为 {criticisms, required_mutations, test_cases, questions}。"
            "至少 2 个批评，至少 1 个 mutation，至少 1 个 test case。"
        )
        response = await self.call_llm(
            [
                {"role": "system", "content": self.system_prompt},
                {"role": "user", "content": user_prompt},
            ]
        )
        structured = self._safe_json(response)
        structured.setdefault("criticisms", ["Need stronger evidence", "Assumptions may be fragile"])
        if len(structured["criticisms"]) < 2:
            structured["criticisms"].append("Please add robustness analysis")
        structured.setdefault("required_mutations", ["ConstraintFlip"])
        if len(structured["required_mutations"]) < 1:
            structured["required_mutations"] = ["AnalogyJump"]
        structured.setdefault("test_cases", ["Edge-case scenario validation"])
        if len(structured["test_cases"]) < 1:
            structured["test_cases"] = ["Out-of-distribution stress test"]
        structured.setdefault("questions", ["How would this fail under extreme constraints?"])
        return AgentMessage(role="B", content=response, structured=structured, retrievals=retrievals)
