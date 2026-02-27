from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator

from .agents import AnalysisAgent, ChallengeAgent, ObserverAgent
from .models import DialogueState, UserMessage


class DialogueEngine:
    def __init__(
        self,
        analysis_agent: AnalysisAgent,
        challenge_agent: ChallengeAgent,
        observer_agent: ObserverAgent,
    ):
        self.analysis_agent = analysis_agent
        self.challenge_agent = challenge_agent
        self.observer_agent = observer_agent

    def create_state(
        self,
        topic: str,
        max_rounds: int,
        session_id: str | None = None,
        time_context: str = "",
        pr_goal: str = "",
    ) -> DialogueState:
        sid = session_id or str(uuid.uuid4())
        state = DialogueState(
            session_id=sid,
            topic=topic,
            time_context=time_context,
            pr_goal=pr_goal,
            max_rounds=max_rounds,
        )
        state.messages.append(
            UserMessage(
                content=topic,
                structured={"time_context": time_context, "pr_goal": pr_goal},
            ).model_dump()
        )
        return state

    async def run(
        self,
        topic: str,
        max_rounds: int,
        session_id: str | None = None,
        time_context: str = "",
        pr_goal: str = "",
    ) -> DialogueState:
        state = self.create_state(
            topic=topic,
            max_rounds=max_rounds,
            session_id=session_id,
            time_context=time_context,
            pr_goal=pr_goal,
        )
        async for _ in self.run_stream(state):
            pass
        return state

    async def run_stream(self, state: DialogueState) -> AsyncGenerator[dict, None]:
        sid = state.session_id

        # ── Initial event ──────────────────────────────────────────────────
        yield {
            "type": "session_started",
            "session_id": sid,
            "message": state.messages[0],
            "max_rounds": state.max_rounds,
        }

        # ── Debate rounds ──────────────────────────────────────────────────
        b_msg = None
        for round_idx in range(state.max_rounds):
            state.turn_index = round_idx

            yield {
                "type": "round_start",
                "session_id": sid,
                "round": round_idx + 1,
                "max_rounds": state.max_rounds,
            }

            # ---- Agent A ------------------------------------------------
            a_msg = None
            async for evt in self.analysis_agent.generate(state):
                if evt["event"] == "search_start":
                    yield {
                        "type": "phase",
                        "session_id": sid,
                        "agent": "A",
                        "phase": "searching",
                        "round": round_idx + 1,
                        "directives": evt.get("directives", []),
                    }
                elif evt["event"] == "generate_start":
                    yield {
                        "type": "phase",
                        "session_id": sid,
                        "agent": "A",
                        "phase": "generating",
                        "round": round_idx + 1,
                    }
                elif evt["event"] == "token":
                    yield {
                        "type": "token",
                        "session_id": sid,
                        "agent": "A",
                        "content": evt["content"],
                    }
                elif evt["event"] == "done":
                    a_msg = evt["message"]
                    a_dump = a_msg.model_dump()
                    state.messages.append(a_dump)
                    yield {
                        "type": "message",
                        "session_id": sid,
                        "message": a_dump,
                        "round": round_idx + 1,
                    }

            # ---- Agent B ------------------------------------------------
            async for evt in self.challenge_agent.generate(state):
                if evt["event"] == "search_start":
                    yield {
                        "type": "phase",
                        "session_id": sid,
                        "agent": "B",
                        "phase": "searching",
                        "round": round_idx + 1,
                        "directives": evt.get("directives", []),
                    }
                elif evt["event"] == "generate_start":
                    yield {
                        "type": "phase",
                        "session_id": sid,
                        "agent": "B",
                        "phase": "generating",
                        "round": round_idx + 1,
                    }
                elif evt["event"] == "token":
                    yield {
                        "type": "token",
                        "session_id": sid,
                        "agent": "B",
                        "content": evt["content"],
                    }
                elif evt["event"] == "done":
                    b_msg = evt["message"]
                    b_dump = b_msg.model_dump()
                    state.messages.append(b_dump)
                    yield {
                        "type": "message",
                        "session_id": sid,
                        "message": b_dump,
                        "round": round_idx + 1,
                    }

            if b_msg is not None and b_msg.structured.get("stop") is True:
                yield {"type": "stopped", "session_id": sid, "reason": "agent_b_stop"}
                break

        # ── Observer / synthesis ───────────────────────────────────────────
        yield {"type": "synthesis_start", "session_id": sid}

        async for evt in self.observer_agent.generate(state):
            if evt["event"] == "generate_start":
                yield {
                    "type": "phase",
                    "session_id": sid,
                    "agent": "C",
                    "phase": "synthesizing",
                }
            elif evt["event"] == "token":
                yield {
                    "type": "token",
                    "session_id": sid,
                    "agent": "C",
                    "content": evt["content"],
                }
            elif evt["event"] == "done":
                c_msg = evt["message"]
                c_dump = c_msg.model_dump()
                state.messages.append(c_dump)
                yield {
                    "type": "message",
                    "session_id": sid,
                    "message": c_dump,
                    "round": 0,
                }

        yield {"type": "done", "session_id": sid, "messages": state.messages}
