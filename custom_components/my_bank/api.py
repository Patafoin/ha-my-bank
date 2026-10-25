"""Generic async REST client for My Bank API (/api/v1).

Deliberately thin: it knows nothing about accounts or transactions, it only
speaks HTTP + JSON. No business rule lives in this integration (decision 002).
"""
from __future__ import annotations

import asyncio
import json as json_lib
from typing import Any

from aiohttp import ClientError

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

_TIMEOUT = 30


class MyBankApiError(Exception):
    """My Bank API unreachable or returned an error (message shown to the user)."""


class MyBankAuthError(MyBankApiError):
    """Token missing, invalid or revoked."""


def _detail(text: str) -> str:
    """Readable message from a FastAPI error body ({"detail": str | list})."""
    try:
        detail = json_lib.loads(text).get("detail")
    except (ValueError, AttributeError):
        return text[:300]
    if isinstance(detail, list):
        return " ; ".join(
            f"{'.'.join(str(p) for p in d.get('loc', [])[1:])} : {d.get('msg')}".strip(" :") for d in detail
        )
    return str(detail)


class MyBankClient:
    """Thin async client for My Bank API."""

    def __init__(self, hass: HomeAssistant, url: str, token: str) -> None:
        self._session = async_get_clientsession(hass)
        self._base = url.rstrip("/") + "/api/v1"
        # Accept-Language : messages d'erreur de l'API dans la langue de Home Assistant (fr, en ou de)
        self._headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "Accept-Language": hass.config.language or "en",
        }

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            async with asyncio.timeout(_TIMEOUT):
                resp = await self._session.request(
                    method, f"{self._base}/{path}", headers=self._headers, **kwargs
                )
                text = await resp.text()
        except (ClientError, TimeoutError) as err:
            raise MyBankApiError(f"My Bank API unreachable: {err}") from err
        if resp.status == 401:
            raise MyBankAuthError("My Bank API rejected the token")
        if resp.status >= 400:
            raise MyBankApiError(_detail(text))
        return json_lib.loads(text) if text else None

    async def get(self, path: str, params: dict | None = None) -> Any:
        return await self._request("GET", path, params=params)

    async def get_raw(self, path: str) -> tuple[bytes, str, str | None]:
        """GET returning raw bytes, content-type and Content-Disposition, for a file download."""
        try:
            async with asyncio.timeout(_TIMEOUT):
                resp = await self._session.request("GET", f"{self._base}/{path}", headers=self._headers)
                content = await resp.read()
        except (ClientError, TimeoutError) as err:
            raise MyBankApiError(f"My Bank API unreachable: {err}") from err
        if resp.status == 401:
            raise MyBankAuthError("My Bank API rejected the token")
        if resp.status >= 400:
            raise MyBankApiError(_detail(content.decode(errors="replace")))
        return content, resp.content_type, resp.headers.get("Content-Disposition")

    async def post(self, path: str, data: dict) -> Any:
        return await self._request("POST", path, json=data)

    async def patch(self, path: str, data: dict) -> Any:
        return await self._request("PATCH", path, json=data)

    async def put(self, path: str, data: dict) -> Any:
        return await self._request("PUT", path, json=data)

    async def delete(self, path: str) -> None:
        await self._request("DELETE", path)
