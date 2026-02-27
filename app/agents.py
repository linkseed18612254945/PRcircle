from __future__ import annotations

import json
import re
from abc import ABC, abstractmethod
from collections.abc import AsyncGenerator
from typing import Any, Literal

from .llm_client import call_llm, call_llm_stream
from .models import AgentMessage, DialogueState, LLMConfig, RetrievalResult, SearchDirective
from .search_tool import TavilySearchTool


class BaseAgent(ABC):
    def __init__(
        self,
        agent_id: Literal["A", "B", "C"],
        role: Literal["analysis", "challenge"],
        llm_config: LLMConfig,
        system_prompt: str,
        capability_prompt: str,
        search_tool: TavilySearchTool,
        search_topk: int,
        default_search_domains: list[str] | None = None,
    ):
        self.id = agent_id
        self.role = role
        self.llm_config = llm_config
        self.system_prompt = system_prompt
        self.capability_prompt = capability_prompt
        self.search_tool = search_tool
        self.search_topk = search_topk
        self.default_search_domains = [d.strip() for d in (default_search_domains or []) if d.strip()]

    @abstractmethod
    async def generate(self, state: DialogueState) -> AsyncGenerator[dict, None]:
        """
        Async generator that yields a sequence of events:
          {"event": "search_start",   "directives": [...]}
          {"event": "generate_start"}
          {"event": "token",          "content": "<text fragment>"}   (many times)
          {"event": "done",           "message": AgentMessage}
        """
        raise NotImplementedError

    async def maybe_call_search(
        self,
        query: str,
        topk: int | None = None,
        domains: list[str] | None = None,
    ) -> list[RetrievalResult]:
        return await self.search_tool.search(
            query=query,
            topk=topk or self.search_topk,
            include_domains=domains or self.default_search_domains,
        )

    async def call_llm(self, messages: list[dict[str, str]]) -> str:
        """Non-streaming call – used only for internal planning steps."""
        return await call_llm(messages=messages, config=self.llm_config)

    async def stream_llm(self, messages: list[dict[str, str]]) -> AsyncGenerator[str, None]:
        """Streaming call – yields tokens for the main response."""
        async for token in call_llm_stream(messages=messages, config=self.llm_config):
            yield token

    # ------------------------------------------------------------------ #
    # Utilities (unchanged from original)                                  #
    # ------------------------------------------------------------------ #
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

    def _keep_specific_directives(self, directives: list[SearchDirective], max_count: int = 4) -> list[SearchDirective]:
        abstract = {"策略", "风险", "舆情", "传播", "问题", "事件", "影响", "机制", "分析", "方向"}
        kept: list[SearchDirective] = []
        seen: set[str] = set()
        for directive in directives:
            q = directive.query.strip()
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
            domains = [d.strip() for d in (directive.domains or []) if d.strip()]
            kept.append(SearchDirective(query=q, domains=domains))
            if len(kept) >= max_count:
                break
        return kept

    async def _plan_search_queries(
        self,
        state: DialogueState,
        counterpart_message: str,
        own_last_message: str,
    ) -> list[SearchDirective]:
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
            "步骤3【组合结构】：按"对象词 + 时间或场景 + 冲突点/争议点 + 证据类型"拼接。\n"
            "步骤4【发散隐藏变量】：至少1条加入隐藏变量，如利益相关方、二阶影响、执行约束。\n"
            "步骤5【去同质化】：4条词必须角度不同，不能只是同义改写。\n"
            "步骤6【站点范围】：按需要为每条词附加1-3个站点域名（如 reddit.com, ptt.cc, weibo.com），没有必要可留空。\n"
            "输出要求：\n"
            '- 每条都必须是对象：{"query":"...","domains":["..."]}；\n'
            "- query必须是可直接搜索的完整短句；\n"
            "- 避免抽象空词（如：策略、风险、舆情分析）；\n"
            "- 尽量使用具体名词和可验证线索词（通报/判例/数据截图/时间线/原始信源）。"
        )

        planned: list[SearchDirective] = []
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
                        planned.append(SearchDirective(query=item.strip(), domains=[]))
                    elif isinstance(item, dict):
                        query = str(item.get("query", "")).strip()
                        domains = item.get("domains") or []
                        if not isinstance(domains, list):
                            domains = []
                        planned.append(
                            SearchDirective(
                                query=query,
                                domains=[str(d).strip() for d in domains if str(d).strip()],
                            )
                        )
        except Exception:
            pass

        directives = self._keep_specific_directives(planned, max_count=4)
        if not directives:
            seed_terms = self._extract_keywords(
                f"{state.topic} {state.time_context} {state.pr_goal} {counterpart_message} {own_last_message}",
                maxn=6,
            )
            seed_a = seed_terms[0] if len(seed_terms) > 0 else "涉事机构"
            seed_b = seed_terms[1] if len(seed_terms) > 1 else "核心平台"
            fallback_domains = self.default_search_domains[:2]
            directives = [
                SearchDirective(query=f"{state.topic} {seed_a} 时间线 关键节点 原始信源", domains=fallback_domains),
                SearchDirective(query=f"{state.topic} {seed_b} 话题标签 扩散路径 数据截图", domains=fallback_domains),
                SearchDirective(query=f"{state.topic} {state.pr_goal} 监管口径 政策条款 公开通报", domains=[]),
                SearchDirective(query=f"{state.topic} {seed_a} 隐性关联方 二阶影响 反向案例", domains=[]),
            ]
            directives = self._keep_specific_directives(directives, max_count=4)

        deduped_queries = state.add_queries([d.query for d in directives])
        if deduped_queries:
            deduped_set = set(deduped_queries)
            return [d for d in directives if d.query in deduped_set][:4]

        return [
            SearchDirective(query=f"{d.query} round{state.turn_index}", domains=d.domains)
            for d in directives[:4]
        ]


# --------------------------------------------------------------------------- #
# AnalysisAgent                                                                #
# --------------------------------------------------------------------------- #
class AnalysisAgent(BaseAgent):
    async def generate(self, state: DialogueState) -> AsyncGenerator[dict, None]:  # type: ignore[override]
        prior_critic = next((m for m in reversed(state.messages) if m.get("role") == "B"), None)
        prior_questions = prior_critic.get("content", "") if prior_critic else "无"
        own_last = next((m for m in reversed(state.messages) if m.get("role") == "A"), None)
        own_last_content = own_last.get("content", "") if own_last else ""

        # ── Phase 1: plan searches ─────────────────────────────────────────
        search_directives = await self._plan_search_queries(
            state=state,
            counterpart_message=prior_questions,
            own_last_message=own_last_content,
        )
        yield {
            "event": "search_start",
            "directives": [{"query": d.query, "domains": d.domains} for d in search_directives],
        }

        # ── Phase 2: execute searches ──────────────────────────────────────
        merged_results: list[RetrievalResult] = []
        for directive in search_directives:
            merged_results.extend(await self.maybe_call_search(query=directive.query, domains=directive.domains))
        new_intel = state.add_intel(merged_results)
        focus_intel = self._select_intel_for_prompt(state, prior_questions)
        retrieval_digest = "\n".join([f"- {r.title} ({r.url}): {r.content[:200]}" for r in focus_intel])

        # ── Phase 3: stream main response ─────────────────────────────────
        user_prompt = (
            f"话题: {state.topic}\n"
            f"时间背景: {state.time_context or '未提供'}\n"
            f"PR目标: {state.pr_goal or '未提供'}\n"
            f"当前轮次: {state.turn_index}\n"
            f"Agent B 上一轮内容（请先回答其中的问题）:\n{prior_questions}\n"
            f"本轮检索词（具体关键词）:\n- "
            + "\n- ".join(
                [f"{d.query} | sites={','.join(d.domains) if d.domains else 'all'}" for d in search_directives]
            )
            + "\n"
            f"本轮新增检索情报数: {len(new_intel)}\n"
            f"当前相关证据（从共享池按相关性筛选）:\n{retrieval_digest or '无'}\n"
            f"引用目录（回答中请使用 [R1]/[R2] 标注证据来源）:\n{self._format_citation_catalog(focus_intel)}\n"
            "请在回答中明确：你使用了哪些证据、哪些仍需验证。"
        )
        messages = [
            {"role": "system", "content": self._build_system_prompt()},
            {"role": "user", "content": user_prompt},
        ]

        yield {"event": "generate_start"}

        full_content = ""
        async for token in self.stream_llm(messages):
            full_content += token
            yield {"event": "token", "content": token}

        # ── Phase 4: emit complete message ────────────────────────────────
        yield {
            "event": "done",
            "message": AgentMessage(
                role="A",
                content=full_content,
                structured=self._try_extract_json(full_content),
                retrievals=new_intel,
                citation_sources=focus_intel,
                search_queries=[d.query for d in search_directives],
                search_directives=search_directives,
            ),
        }


# --------------------------------------------------------------------------- #
# ChallengeAgent                                                               #
# --------------------------------------------------------------------------- #
class ChallengeAgent(BaseAgent):
    async def generate(self, state: DialogueState) -> AsyncGenerator[dict, None]:  # type: ignore[override]
        last_a = next((m for m in reversed(state.messages) if m.get("role") == "A"), None)
        a_reference = last_a.get("content", "") if last_a else ""
        own_last = next((m for m in reversed(state.messages) if m.get("role") == "B"), None)
        own_last_content = own_last.get("content", "") if own_last else ""

        # ── Phase 1: plan searches ─────────────────────────────────────────
        search_directives = await self._plan_search_queries(
            state=state,
            counterpart_message=a_reference,
            own_last_message=own_last_content,
        )
        yield {
            "event": "search_start",
            "directives": [{"query": d.query, "domains": d.domains} for d in search_directives],
        }

        # ── Phase 2: execute searches ──────────────────────────────────────
        merged_results: list[RetrievalResult] = []
        for directive in search_directives:
            merged_results.extend(await self.maybe_call_search(query=directive.query, domains=directive.domains))
        new_intel = state.add_intel(merged_results)
        focus_intel = self._select_intel_for_prompt(state, a_reference)
        retrieval_digest = "\n".join([f"- {r.title} ({r.url}): {r.content[:200]}" for r in focus_intel])

        # ── Phase 3: stream main response ─────────────────────────────────
        user_prompt = (
            f"话题: {state.topic}\n"
            f"时间背景: {state.time_context or '未提供'}\n"
            f"PR目标: {state.pr_goal or '未提供'}\n"
            f"分析者最新输出:\n{a_reference}\n"
            f"本轮检索词（具体关键词）:\n- "
            + "\n- ".join(
                [f"{d.query} | sites={','.join(d.domains) if d.domains else 'all'}" for d in search_directives]
            )
            + "\n"
            f"本轮新增检索情报数: {len(new_intel)}\n"
            f"当前相关证据（从共享池按相关性筛选）:\n{retrieval_digest or '无'}\n"
            f"引用目录（回答中请使用 [R1]/[R2] 标注证据来源）:\n{self._format_citation_catalog(focus_intel)}\n"
            "请基于证据提出关键批评、明确问题（至少1个）和测试建议。"
        )
        messages = [
            {"role": "system", "content": self._build_system_prompt()},
            {"role": "user", "content": user_prompt},
        ]

        yield {"event": "generate_start"}

        full_content = ""
        async for token in self.stream_llm(messages):
            full_content += token
            yield {"event": "token", "content": token}

        yield {
            "event": "done",
            "message": AgentMessage(
                role="B",
                content=full_content,
                structured=self._try_extract_json(full_content),
                retrievals=new_intel,
                citation_sources=focus_intel,
                search_queries=[d.query for d in search_directives],
                search_directives=search_directives,
            ),
        }


# --------------------------------------------------------------------------- #
# ObserverAgent                                                                #
# --------------------------------------------------------------------------- #
class ObserverAgent(BaseAgent):
    async def generate(self, state: DialogueState) -> AsyncGenerator[dict, None]:  # type: ignore[override]
        dialogue_lines: list[str] = []
        for m in state.messages:
            role = m.get("role", "")
            if role not in {"A", "B"}:
                continue
            content = str(m.get("content", "")).strip()
            if content:
                dialogue_lines.append(f"{role}: {content[:900]}")

        focus_intel = state.intel_pool[-8:]
        intel_digest = "\n".join([f"- {r.title} ({r.url}): {r.content[:180]}" for r in focus_intel]) or "无"

        user_prompt = (
            f"话题: {state.topic}\n"
            f"时间背景: {state.time_context or '未提供'}\n"
            f"PR目标: {state.pr_goal or '未提供'}\n"
            f"A/B讨论记录（按时间顺序）:\n" + "\n".join(dialogue_lines[-16:]) + "\n"
            f"共享情报池摘要:\n{intel_digest}\n"
            f"引用目录（回答中请使用 [R1]/[R2] 标注证据来源）:\n{self._format_citation_catalog(focus_intel)}\n"
            "请输出最终策略报告，要求可直接给PR团队执行。"
        )
        messages = [
            {"role": "system", "content": self._build_system_prompt()},
            {"role": "user", "content": user_prompt},
        ]

        yield {"event": "generate_start"}

        full_content = ""
        async for token in self.stream_llm(messages):
            full_content += token
            yield {"event": "token", "content": token}

        yield {
            "event": "done",
            "message": AgentMessage(
                role="C",
                content=full_content,
                structured=self._try_extract_json(full_content),
                retrievals=[],
                citation_sources=focus_intel,
                search_queries=[],
                search_directives=[],
            ),
        }
