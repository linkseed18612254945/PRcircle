from __future__ import annotations

import json
from collections.abc import AsyncGenerator
from typing import Any

import httpx

from .models import LLMConfig


async def call_llm(messages: list[dict[str, str]], config: LLMConfig) -> str:
    """Non-streaming LLM call – used only for short internal tasks (search planning)."""
    payload: dict[str, Any] = {
        "model": config.model_name,
        "messages": messages,
        "temperature": config.temperature,
        "max_tokens": config.max_tokens,
    }
    headers = {
        "Authorization": f"Bearer {config.api_key}",
        "Content-Type": "application/json",
    }
    url = f"{config.base_url.rstrip('/')}/chat/completions"
    async with httpx.AsyncClient(timeout=90) as client:
        response = await client.post(url, headers=headers, json=payload)
        response.raise_for_status()
        return response.json()["choices"][0]["message"]["content"]


async def call_llm_stream(
    messages: list[dict[str, str]], config: LLMConfig
) -> AsyncGenerator[str, None]:
    """
    Streaming LLM call using the OpenAI `stream: true` protocol.
    Yields text tokens as they arrive from the API.
    Falls back to yielding the full response as one chunk on non-streaming APIs.
    """
    payload: dict[str, Any] = {
        "model": config.model_name,
        "messages": messages,
        "temperature": config.temperature,
        "max_tokens": config.max_tokens,
        "stream": True,
    }
    headers = {
        "Authorization": f"Bearer {config.api_key}",
        "Content-Type": "application/json",
    }
    url = f"{config.base_url.rstrip('/')}/chat/completions"

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(connect=15, read=120, write=30, pool=5)) as client:
            async with client.stream("POST", url, headers=headers, json=payload) as response:
                response.raise_for_status()
                async for raw_line in response.aiter_lines():
                    line = raw_line.strip()
                    if not line:
                        continue
                    if line == "data: [DONE]":
                        return
                    if not line.startswith("data: "):
                        continue
                    try:
                        chunk = json.loads(line[6:])
                        delta = chunk["choices"][0]["delta"].get("content") or ""
                        if delta:
                            yield delta
                    except (json.JSONDecodeError, KeyError, IndexError):
                        continue
    except Exception:
        # Fallback: non-streaming call, yield result as one token
        text = await call_llm(messages=messages, config=config)
        if text:
            yield text
