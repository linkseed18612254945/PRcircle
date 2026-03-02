from __future__ import annotations

import hashlib
from typing import Any

import httpx

from .models import RetrievalResult


class TavilySearchTool:
    def __init__(self, api_key: str):
        self.api_key = api_key

    async def search(
        self,
        query: str,
        topk: int,
        include_domains: list[str] | None = None,
        days: int | None = None,
    ) -> list[RetrievalResult]:
        url = "https://api.tavily.com/search"
        payload: dict[str, Any] = {
            "api_key": self.api_key,
            "query": query,
            "max_results": topk,
            "include_answer": False,
        }
        domains = [d.strip() for d in (include_domains or []) if d.strip()]
        if domains:
            payload["include_domains"] = domains
        if days and 1 <= days <= 365:
            payload["days"] = days
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                response = await client.post(url, json=payload)
                response.raise_for_status()
                data = response.json()
        except Exception:
            return []

        results: list[RetrievalResult] = []
        for idx, item in enumerate(data.get("results", [])):
            url_value = item.get("url", "")
            rid = hashlib.md5(f"{url_value}-{idx}".encode()).hexdigest()[:12]
            results.append(
                RetrievalResult(
                    id=rid,
                    title=item.get("title", ""),
                    url=url_value,
                    content=item.get("content", ""),
                    score=float(item.get("score", 0.0) or 0.0),
                )
            )
        return results
