from __future__ import annotations

from .agents import AnalysisAgent, ChallengeAgent
from .models import DialogueState, UserMessage


class DialogueEngine:
    def __init__(self, analysis_agent: AnalysisAgent, challenge_agent: ChallengeAgent):
        self.analysis_agent = analysis_agent
        self.challenge_agent = challenge_agent

    async def run(self, topic: str, max_rounds: int) -> DialogueState:
        state = DialogueState(topic=topic, max_rounds=max_rounds)
        state.messages.append(UserMessage(content=topic).model_dump())

        for round_idx in range(max_rounds):
            state.turn_index = round_idx

            a_msg = await self.analysis_agent.generate(state)
            state.messages.append(a_msg.model_dump())

            b_msg = await self.challenge_agent.generate(state)
            state.messages.append(b_msg.model_dump())

            if b_msg.structured.get("stop") is True:
                break

        return state
