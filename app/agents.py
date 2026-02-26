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

    def _extract_keywords(self, text: str, maxn: int = 10) -> list[str]:
        tokens = re.findall(r"[A-Za-z0-9\u4e00-\u9fff]{2,}", text)
        seen: set[str] = set()
        keywords: list[str] = []
        for token in tokens:
            low = token.lower()
            if low in seen:
                continue
            seen.add(low)
            keywords.append(token)
            if len(keywords) >= maxn:
                break
        return keywords

    def _normalize_query(self, query: str) -> str:
        return " ".join(query.lower().split())

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

    def _format_citation_catalog(self, sources: list[RetrievalResult]) -> str:
        if not sources:
            return "无"
        return "\n".join([f"[R{idx}] {src.title} | {src.url}" for idx, src in enumerate(sources, start=1)])

    def _keep_specific_queries(self, queries: list[str], max_count: int = 4) -> list[str]:
        abstract = {"策略", "风险", "舆情", "传播", "问题", "事件", "影响", "机制", "分析", "方向"}
        kept: list[str] = []
        seen: set[str] = set()
        for query in queries:
            q = query.strip()
            if not q:
                continue
            norm = self._normalize_query(q)
            if norm in seen:
                continue
            tokens = self._extract_keywords(q, maxn=16)
            specific_tokens = [t for t in tokens if t not in abstract]
            if len(specific_tokens) < 2:
                continue
            seen.add(norm)
            kept.append(q)
            if len(kept) >= max_count:
                break
        return kept

    async def _plan_search_queries(
        self,
        state: DialogueState,
        counterpart_message: str,
        own_last_message: str,
    ) -> list[str]:
        planner_prompt = (
            f"你是{self.role}检索规划器。\n"
            f"话题: {state.topic}\n"
            f"时间背景: {state.time_context or '未提供'}\n"
            f"PR目标: {state.pr_goal or '未提供'}\n"
            f"当前轮次: {state.turn_index}\n"
            f"对方最新观点/问题: {counterpart_message[:600] or '无'}\n"
            f"我方上一轮结论: {own_last_message[:600] or '无'}\n"
            f"共享情报池摘要:\n{self._intel_digest(state)}\n\n"
            "请按以下步骤构建检索词，再输出4条结果(JSON数组字符串)：\n"
            "步骤1【提炼对象】：先从上下文中提炼具体对象词（人物/机构/平台/城市/政策名/话题标签）。\n"
            "步骤2【锁定意图】：为每条词指定一个检索意图（事实核验/反例查找/传播链路/合规边界）。\n"
            "步骤3【组合结构】：按“对象词 + 时间或场景 + 冲突点/争议点 + 证据类型”拼接。\n"
            "步骤4【发散隐藏变量】：至少1条加入隐藏变量，如利益相关方、二阶影响、执行约束。\n"
            "步骤5【去同质化】：4条词必须角度不同，不能只是同义改写。\n"
            "输出要求：\n"
            "- 每条都必须是可直接搜索的完整短句；\n"
            "- 避免抽象空词（如：策略、风险、舆情分析）；\n"
            "- 尽量使用具体名词和可验证线索词（通报/判例/数据截图/时间线/原始信源）。"
        )

        planned: list[str] = []
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
                    if isinstance(item, str):
                        planned.append(item.strip())
                    elif isinstance(item, dict):
                        planned.append(str(item.get("query", "")).strip())
        except Exception:
            pass

        queries = self._keep_specific_queries(planned, max_count=4)
        if not queries:
            seed_terms = self._extract_keywords(
                f"{state.topic} {state.time_context} {state.pr_goal} {counterpart_message} {own_last_message}",
                maxn=6,
            )
            seed_a = seed_terms[0] if len(seed_terms) > 0 else "涉事机构"
            seed_b = seed_terms[1] if len(seed_terms) > 1 else "核心平台"
            queries = [
                f"{state.topic} {seed_a} 时间线 关键节点 原始信源",
                f"{state.topic} {seed_b} 话题标签 扩散路径 数据截图",
                f"{state.topic} {state.pr_goal} 监管口径 政策条款 公开通报",
                f"{state.topic} {seed_a} 隐性关联方 二阶影响 反向案例",
            ]
            queries = self._keep_specific_queries(queries, max_count=4)

        deduped = state.add_queries(queries)
        if deduped:
            return deduped[:4]

        return [f"{q} round{state.turn_index}" for q in queries[:4]]


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
        retrieval_digest = "\n".join([f"- {r.title} ({r.url}): {r.content[:200]}" for r in focus_intel])

        user_prompt = (
            f"话题: {state.topic}\n"
            f"时间背景: {state.time_context or '未提供'}\n"
            f"PR目标: {state.pr_goal or '未提供'}\n"
            f"当前轮次: {state.turn_index}\n"
            f"Agent B 上一轮内容（请先回答其中的问题）:\n{prior_questions}\n"
            f"本轮检索词（具体关键词）:\n- " + "\n- ".join(search_queries) + "\n"
            f"本轮新增检索情报数: {len(new_intel)}\n"
            f"当前相关证据（从共享池按相关性筛选）:\n{retrieval_digest or '无'}\n"
            f"引用目录（回答中请使用 [R1]/[R2] 标注证据来源）:\n{self._format_citation_catalog(focus_intel)}\n"
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
            citation_sources=focus_intel,
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
        retrieval_digest = "\n".join([f"- {r.title} ({r.url}): {r.content[:200]}" for r in focus_intel])

        user_prompt = (
            f"话题: {state.topic}\n"
            f"时间背景: {state.time_context or '未提供'}\n"
            f"PR目标: {state.pr_goal or '未提供'}\n"
            f"分析者最新输出:\n{a_reference}\n"
            f"本轮检索词（具体关键词）:\n- " + "\n- ".join(search_queries) + "\n"
            f"本轮新增检索情报数: {len(new_intel)}\n"
            f"当前相关证据（从共享池按相关性筛选）:\n{retrieval_digest or '无'}\n"
            f"引用目录（回答中请使用 [R1]/[R2] 标注证据来源）:\n{self._format_citation_catalog(focus_intel)}\n"
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
            citation_sources=focus_intel,
            search_queries=search_queries,
        )
