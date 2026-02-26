from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator

from .agents import AnalysisAgent, ChallengeAgent
from .models import DialogueState, UserMessage


class DialogueEngine:
    def __init__(self, analysis_agent: AnalysisAgent, challenge_agent: ChallengeAgent):
        self.analysis_agent = analysis_agent
        self.challenge_agent = challenge_agent

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
        yield {"type": "session_started", "session_id": state.session_id, "message": state.messages[0]}

        for round_idx in range(state.max_rounds):
            state.turn_index = round_idx

            a_msg = await self.analysis_agent.generate(state)
            a_dump = a_msg.model_dump()
            state.messages.append(a_dump)
            yield {"type": "message", "session_id": state.session_id, "message": a_dump}

            b_msg = await self.challenge_agent.generate(state)
            b_dump = b_msg.model_dump()
            state.messages.append(b_dump)
            yield {"type": "message", "session_id": state.session_id, "message": b_dump}

            if b_msg.structured.get("stop") is True:
                yield {"type": "stopped", "session_id": state.session_id, "reason": "agent_b_stop"}
                break

        yield {
            "type": "done",
            "session_id": state.session_id,
            "messages": state.messages,
        }
