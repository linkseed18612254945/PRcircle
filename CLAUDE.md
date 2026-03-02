# CLAUDE.md — PRcircle Codebase Guide

This document describes the architecture, conventions, and workflows of the **PRcircle** project for AI assistants and developers.

---

## Project Overview

PRcircle is a **Multi-Agent PR Strategy Analysis MVP** built with Python (FastAPI) and vanilla JavaScript. The system uses three AI agents that debate and synthesize public-relations strategies for a given topic, backed by live web search via the Tavily API.

**Core flow:**
1. User submits a PR topic, time context, goal, and LLM/API configs
2. The system runs N dialogue rounds where Agent A (Analyst) and Agent B (Challenger) debate
3. Agent C (Observer) synthesizes a final actionable strategy report
4. All output is streamed token-by-token to the browser via Server-Sent Events (SSE)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend framework | FastAPI 0.115 |
| ASGI server | Uvicorn 0.30 |
| HTTP client | httpx 0.27 (async) |
| Data validation | Pydantic v2 2.9 |
| Frontend | Vanilla JS + HTML/CSS |
| External APIs | OpenAI-compatible LLM, Tavily Search |

**No build tools, no bundler, no test framework.** This is an MVP.

---

## Directory Structure

```
PRcircle/
├── app/                    # Backend Python package
│   ├── __init__.py         # Empty
│   ├── main.py             # FastAPI app, routes, SSE headers
│   ├── agents.py           # BaseAgent + AnalysisAgent, ChallengeAgent, ObserverAgent
│   ├── dialogue_engine.py  # DialogueEngine — orchestrates multi-round debate
│   ├── llm_client.py       # OpenAI-compatible async LLM client (streaming + non-streaming)
│   ├── models.py           # All Pydantic models (request/response/state)
│   ├── prompts.py          # System prompts for all three agents (Chinese)
│   └── search_tool.py      # TavilySearchTool wrapper
├── static/
│   ├── index.html          # Single-page UI (~479 lines)
│   └── main.js             # Frontend logic — sessions, SSE parsing, DOM rendering (~889 lines)
├── requirements.txt        # Python dependencies (pinned versions)
└── README.md               # Chinese-language documentation
```

---

## Running the Application

```bash
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

- Web UI: `http://127.0.0.1:8000/`
- API docs: `http://127.0.0.1:8000/docs`

There is no `.env` file. LLM API keys and Tavily keys are passed in the JSON request body at runtime (configured in the Settings tab of the UI).

---

## API Endpoints

### `POST /api/run`
Non-streaming. Returns complete `RunResponse` after all agents finish.

### `POST /api/run/stream`
Streaming via SSE. Returns a stream of `data: {...}\n\n` events.

**Request body (`RunRequest`):**
```json
{
  "topic": "string",
  "time_context": "string (optional)",
  "pr_goal": "string (optional)",
  "session_id": "string (optional, auto-generated if omitted)",
  "max_rounds": 4,
  "agentA_config": { "model_name": "...", "base_url": "...", "api_key": "...", "capability_prompt": "..." },
  "agentB_config": { ... },
  "agentC_config": { ... },
  "tavily_api_key": "string",
  "search_topk": 5,
  "search_domains": []
}
```

---

## Architecture Deep Dive

### Agent System (`app/agents.py`)

All agents extend `BaseAgent` (abstract). Each agent's `generate()` method is an **async generator** yielding a fixed event sequence:

```
search_start   → { event, directives[] }
generate_start → { event }
token          → { event, content }   (many)
done           → { event, message: AgentMessage }
```

**AnalysisAgent (A):** Proposes strategies. Reads Agent B's last message as the counterpart prompt.

**ChallengeAgent (B):** Critiques Agent A's proposal. Can signal early termination via `structured.stop = true`.

**ObserverAgent (C):** Synthesizes the final report from the full A/B dialogue history. Does **not** perform searches — uses the shared `intel_pool`.

#### Search Planning (`_plan_search_queries`)
Before each response, agents A and B call the LLM non-streaming to generate 4 specific search directives (JSON array). The planner follows a 6-step reasoning process:
1. Extract concrete entity nouns
2. Assign retrieval intent to each query
3. Compose structured queries
4. Add hidden variable terms
5. De-duplicate / diversify angles
6. Optionally attach site domain filters

Fallback hardcoded queries are used if the LLM planner fails.

#### Shared Intel Pool
`DialogueState.intel_pool` is a session-scoped list of `RetrievalResult` objects shared across all agents. Deduplication is by MD5-derived ID. Each agent contributes new retrievals and selects relevant ones via keyword overlap scoring.

### Dialogue Engine (`app/dialogue_engine.py`)

`DialogueEngine.run_stream()` orchestrates the full session as an async generator:

```
session_started
  round_start (× max_rounds)
    phase: A searching
    phase: A generating
    token (×N) for A
    message: A
    phase: B searching
    phase: B generating
    token (×N) for B
    message: B
  stopped (if B signals stop)
synthesis_start
  phase: C synthesizing
  token (×N) for C
  message: C
done
```

### LLM Client (`app/llm_client.py`)

Two functions targeting any OpenAI-compatible `/chat/completions` endpoint:
- `call_llm(messages, config)` — non-streaming, returns `str`
- `call_llm_stream(messages, config)` — async generator yielding tokens; falls back to non-streaming on error

### SSE Streaming (`app/main.py`)

The streaming endpoint sends a **2 KB padding comment first** (`": stream-start" × 80`) to flush reverse-proxy buffers (nginx, CloudFlare). SSE headers disable all buffering:
- `X-Accel-Buffering: no`
- `Content-Encoding: identity` (prevents gzip buffering)
- `Cache-Control: no-cache, no-transform`

### Frontend (`static/main.js`)

Key design rules enforced in the frontend:
- **Never wipe the message tree** — all DOM updates are incremental
- Token events append to the current agent card character by character
- `message` events finalize a card with structured data, citations, and search queries
- Sessions are stored in a `Map` keyed by `session_id`; switching sessions re-renders from stored state

---

## Data Models (`app/models.py`)

| Model | Purpose |
|---|---|
| `LLMConfig` | model_name, base_url, api_key, temperature, max_tokens |
| `AgentConfig` | Extends LLMConfig + capability_prompt |
| `RetrievalResult` | id, title, url, content, score |
| `SearchDirective` | query, domains[] |
| `AgentMessage` | role (A/B/C), content, structured, retrievals, citation_sources, search_queries, search_directives, timestamp |
| `UserMessage` | role="user", content, structured, timestamp |
| `DialogueState` | Full session state including intel_pool, messages, searched queries |
| `RunRequest` | Complete API request body |
| `RunResponse` | session_id + messages[] |

`DialogueState` is **not persisted** — it lives only for the duration of a single API request.

---

## Coding Conventions

### Python
- `from __future__ import annotations` at the top of every module
- Full type hints; Pydantic v2 `BaseModel` with `Field` defaults
- `async/await` throughout; `AsyncGenerator[dict, None]` for streaming
- snake_case for variables, functions, modules
- Abstract base classes via `abc.ABC` + `@abstractmethod`
- Graceful exception handling — search/LLM failures return empty results, never crash the pipeline
- System prompts and user-facing strings are in **Chinese**

### JavaScript
- camelCase for variables and functions
- Vanilla DOM manipulation — no framework
- Session state in module-level `Map`, never in global variables
- SSE parsing handles partial lines and multi-chunk events robustly
- `ensure_ascii=False` on the server side → emoji and CJK characters stream correctly

### General
- No test suite exists — this is an MVP; avoid introducing untested abstractions
- Do not add persistence (DB, file storage) without explicit requirement
- Do not restructure the module layout — the flat `app/` package is intentional
- API keys travel only in request bodies, never in headers or env vars at the server level
- CORS is fully open (`allow_origins=["*"]`) — appropriate for local/demo use

---

## Common Modification Patterns

### Adding a new agent
1. Create a subclass of `BaseAgent` in `agents.py`
2. Implement `generate()` as an async generator yielding the standard event sequence
3. Add a system prompt string in `prompts.py`
4. Wire it into `DialogueEngine` and `build_engine()` in `main.py`

### Changing agent behavior
- Modify the relevant system prompt in `prompts.py`
- Modify `_plan_search_queries()` in `BaseAgent` to change how search terms are generated
- Adjust `max_rounds` default in `RunRequest` or `DialogueState`

### Changing the streaming event schema
Events flow: `agents.py` → `dialogue_engine.py` → `main.py` SSE → `static/main.js`
All four files must be updated consistently if the event schema changes.

### Adding a new API field
1. Add to the relevant Pydantic model in `models.py`
2. Pass it through `build_engine()` / `create_state()` in `main.py`
3. Update the UI Settings panel in `static/index.html` and `static/main.js`

---

## Known Limitations (MVP)

- No session persistence — restarting the server loses all history
- No authentication or rate limiting
- All three agents share one `TavilySearchTool` instance (single API key)
- `ObserverAgent` truncates dialogue to last 16 messages (`dialogue_lines[-16:]`)
- Search relevance scoring is a simple keyword-overlap heuristic, not semantic
- The `stop` signal from Agent B is based on `structured.get("stop") is True` — requires the LLM to output valid JSON with a `stop` key
