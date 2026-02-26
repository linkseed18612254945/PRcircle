from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .agents import AnalysisAgent, ChallengeAgent
from .dialogue_engine import DialogueEngine
from .models import RunRequest, RunResponse
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
        system_prompt="你是分析者（Agent A）。请给出结构化分析方案，并严格输出 JSON。",
        search_tool=search_tool,
        search_topk=req.search_topk,
    )
    agent_b = ChallengeAgent(
        agent_id="B",
        role="challenge",
        llm_config=req.agentB_config,
        system_prompt="你是质询者（Agent B）。请输出批评、突变要求、测试案例，并严格输出 JSON。",
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
