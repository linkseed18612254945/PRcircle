from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .agents import AnalysisAgent, ChallengeAgent, ObserverAgent
from .dialogue_engine import DialogueEngine
from .models import RunRequest, RunResponse
from .prompts import ANALYSIS_LOGIC_PROMPT, CHALLENGE_LOGIC_PROMPT, OBSERVER_LOGIC_PROMPT
from .search_tool import TavilySearchTool

app = FastAPI(title="Multi-Agent Analysis MVP")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def build_engine(req: RunRequest) -> DialogueEngine:
    search_tool = TavilySearchTool(api_key=req.tavily_api_key)
    agent_a = AnalysisAgent(
        agent_id="A",
        role="analysis",
        llm_config=req.agentA_config,
        system_prompt=ANALYSIS_LOGIC_PROMPT,
        capability_prompt=req.agentA_config.capability_prompt,
        search_tool=search_tool,
        search_topk=req.search_topk,
        default_search_domains=req.search_domains,
    )
    agent_b = ChallengeAgent(
        agent_id="B",
        role="challenge",
        llm_config=req.agentB_config,
        system_prompt=CHALLENGE_LOGIC_PROMPT,
        capability_prompt=req.agentB_config.capability_prompt,
        search_tool=search_tool,
        search_topk=req.search_topk,
        default_search_domains=req.search_domains,
    )
    agent_c = ObserverAgent(
        agent_id="C",
        role="analysis",
        llm_config=req.agentC_config,
        system_prompt=OBSERVER_LOGIC_PROMPT,
        capability_prompt=req.agentC_config.capability_prompt,
        search_tool=search_tool,
        search_topk=req.search_topk,
        default_search_domains=req.search_domains,
    )
    return DialogueEngine(analysis_agent=agent_a, challenge_agent=agent_b, observer_agent=agent_c)


@app.post("/api/run", response_model=RunResponse)
async def run_dialogue(req: RunRequest) -> RunResponse:
    engine = build_engine(req)
    state = await engine.run(
        topic=req.topic,
        max_rounds=req.max_rounds,
        session_id=req.session_id,
        time_context=req.time_context,
        pr_goal=req.pr_goal,
    )
    return RunResponse(session_id=state.session_id, messages=state.messages)


@app.post("/api/run/stream")
async def run_dialogue_stream(req: RunRequest) -> StreamingResponse:
    engine = build_engine(req)
    state = engine.create_state(
        topic=req.topic,
        max_rounds=req.max_rounds,
        session_id=req.session_id,
        time_context=req.time_context,
        pr_goal=req.pr_goal,
    )

    async def event_gen():
        async for event in engine.run_stream(state):
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )


static_dir = Path(__file__).resolve().parent.parent / "static"
app.mount("/static", StaticFiles(directory=static_dir), name="static")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(static_dir / "index.html")
