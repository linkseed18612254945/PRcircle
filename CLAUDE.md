# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the Application

```bash
# Install dependencies
pip install -r requirements.txt

# Start development server with hot reload
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

Access the frontend at `http://127.0.0.1:8000/` and the Swagger API docs at `http://127.0.0.1:8000/docs`.

## Quick API Test

```bash
curl -N -X POST 'http://127.0.0.1:8000/api/run/stream' \
  -H 'Content-Type: application/json' \
  -d '{
    "topic": "test topic",
    "time_context": "2024",
    "pr_goal": "public awareness",
    "max_rounds": 1,
    "agentA_config": {"model_name": "gpt-4o-mini", "base_url": "https://api.openai.com/v1", "api_key": "YOUR_KEY", "temperature": 0.7, "max_tokens": 600},
    "agentB_config": {"model_name": "gpt-4o-mini", "base_url": "https://api.openai.com/v1", "api_key": "YOUR_KEY", "temperature": 0.7, "max_tokens": 600},
    "agentC_config": {"model_name": "gpt-4o-mini", "base_url": "https://api.openai.com/v1", "api_key": "YOUR_KEY", "temperature": 0.7, "max_tokens": 900},
    "tavily_api_key": "YOUR_TAVILY_KEY",
    "search_topk": 3
  }'
```

## Architecture

PRcircle is a multi-agent political PR analysis system. Users submit a topic, time context, and PR goal; three specialized AI agents debate and synthesize a strategic report. The entire process streams to the browser via SSE.

### Agent Pipeline

The `DialogueEngine` (`app/dialogue_engine.py`) orchestrates the conversation loop:

1. **Agent A** (`AnalysisAgent`) — Proposes PR strategy with evidence. Plans and executes Tavily searches, streams LLM response.
2. **Agent B** (`ChallengeAgent`) — Critiques Agent A's proposal with counter-evidence. Can emit `stop: true` in structured JSON to end early.
3. Rounds A→B repeat up to `max_rounds`.
4. **Agent C** (`ObserverAgent`) — Synthesizes the debate into a final strategy report. Skips search planning entirely; reads the last 8 items from the shared intel pool directly.

### Shared Intel Pool

All agents share a `DialogueState.intel_pool` (list of `RetrievalResult`). Each agent:
1. Calls `_plan_search_queries()` — uses a non-streaming LLM call to generate structured search directives.
2. Executes searches via `TavilySearchTool`, deduplicates results into the intel pool.
3. Calls `_select_intel_for_prompt()` — selects relevant intel via keyword scoring for the LLM prompt.

### Streaming Events (SSE)

`DialogueEngine.run_stream()` is an async generator that yields typed JSON events. The full event sequence:

```
session_started → round_start → phase(searching) → phase(generating) → token* → message → [repeat A/B] → [stopped?] → synthesis_start → phase(synthesizing) → token* → message → done
```

`stopped` is emitted when Agent B sets `structured.stop == true` to terminate debate early.

`app/main.py` wraps this in a `StreamingResponse` with `media_type="text/event-stream"`. The first event includes 2KB padding to flush proxy/browser buffers.

### Internal Agent Event Protocol

Each agent's `generate()` is an async generator emitting internal events (distinct from SSE types):
- `{"event": "search_start", "directives": [...]}` — before Tavily searches execute
- `{"event": "generate_start"}` — LLM streaming begins
- `{"event": "token", "content": "..."}` — one text fragment
- `{"event": "done", "message": AgentMessage}` — complete turn

`DialogueEngine` translates these internal events into SSE-typed events.

### LLM Client

`app/llm_client.py` makes direct `httpx` calls to any OpenAI-compatible API. Each agent has its own `LLMConfig` (model, base_url, api_key, temperature, max_tokens), so agents can use different providers or models.

- `call_llm()` — single blocking call, used for search query planning
- `call_llm_stream()` — yields tokens; falls back to non-streaming if needed

### Frontend

A single-page app in `static/` with no build step. `main.js` handles SSE parsing, token-level streaming (builds a temp "streaming card" → replaces on `message` event), and session management (in-memory, not persisted). Settings tab allows per-agent LLM config; all config is sent in the request body.

## Key Data Models (`app/models.py`)

- `RunRequest` — full API request, includes topic + three `AgentConfig` objects + Tavily config (`tavily_api_key`, `search_topk`, `search_domains`). `search_domains` is an optional list of site domains (e.g. `["reddit.com", "ptt.cc"]`) forwarded to Tavily's `include_domains` filter.
- `DialogueState` — mutable session state passed through the pipeline (messages, intel_pool, searched_queries)
- `AgentMessage` — output of each agent turn: `content`, `structured_json`, `retrievals`, `citations`, `search_queries`
- `AgentConfig` extends `LLMConfig` with `capability_prompt` (injected into agent system prompt)

## Agent Prompts (`app/prompts.py`)

- `ANALYSIS_LOGIC_PROMPT` — Agent A instructions
- `CHALLENGE_LOGIC_PROMPT` — Agent B instructions (defines `stop: true` termination signal)
- `OBSERVER_LOGIC_PROMPT` — Agent C instructions

Agent B's structured JSON schema (`stop`, `mutations`, `test_cases`) is defined in this file and documented in README.md.

## Tests and Linting

No test suite or linter is configured. The project relies on runtime Pydantic validation. To add tests: `pytest` + `pytest-asyncio` + `httpx.AsyncClient` against FastAPI's `app` instance. `requirements.txt` only pins 4 production dependencies (`fastapi`, `uvicorn`, `httpx`, `pydantic`); all Tavily calls use raw `httpx` with no extra SDK.
