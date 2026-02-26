from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .agents import AnalysisAgent, ChallengeAgent
from .dialogue_engine import DialogueEngine
from .models import RunRequest, RunResponse
from .prompts import DEFAULT_ANALYSIS_SYSTEM_PROMPT, DEFAULT_CHALLENGE_SYSTEM_PROMPT
from .search_tool import TavilySearchTool

app = FastAPI(title="Multi-Agent Analysis MVP")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/api/run", response_model=RunResponse)
async def run_dialogue(req: RunRequest) -> RunResponse:
    search_tool = TavilySearchTool(api_key=req.tavily_api_key)
    agent_a = AnalysisAgent(
        agent_id="A",
        role="analysis",
        llm_config=req.agentA_config,
        system_prompt=req.agentA_config.system_prompt or DEFAULT_ANALYSIS_SYSTEM_PROMPT,
        search_tool=search_tool,
        search_topk=req.search_topk,
    )
    agent_b = ChallengeAgent(
        agent_id="B",
        role="challenge",
        llm_config=req.agentB_config,
        system_prompt=req.agentB_config.system_prompt or DEFAULT_CHALLENGE_SYSTEM_PROMPT,
        search_tool=search_tool,
        search_topk=req.search_topk,
    )

    engine = DialogueEngine(analysis_agent=agent_a, challenge_agent=agent_b)
    state = await engine.run(topic=req.topic, max_rounds=req.max_rounds)
    return RunResponse(messages=state.messages)


static_dir = Path(__file__).resolve().parent.parent / "static"
app.mount("/static", StaticFiles(directory=static_dir), name="static")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(static_dir / "index.html")
