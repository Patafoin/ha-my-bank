"""HTTP view that proxies a transaction's attachment content through My Bank API (decision 023).

The browser never holds the My Bank API token: only this integration does. The card opens this
view with a signed path from `hass.callWS({type: "auth/sign_path", path, expires})` — Home
Assistant's standard way to open an authenticated resource in a new tab without an Authorization
header (the same mechanism camera snapshots and media sources use).
"""
from __future__ import annotations

from aiohttp import web

from homeassistant.components.http import KEY_HASS, HomeAssistantView
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant

from .api import MyBankApiError
from .const import DOMAIN

_REGISTERED = f"{DOMAIN}_attachment_view_registered"


class MyBankAttachmentView(HomeAssistantView):
    url = "/api/my_bank/attachment/{transaction_id}"
    name = "api:my_bank:attachment"

    async def get(self, request: web.Request, transaction_id: str) -> web.Response:
        hass: HomeAssistant = request.app[KEY_HASS]
        coordinator = None
        for entry in hass.config_entries.async_entries(DOMAIN):
            if entry.state is ConfigEntryState.LOADED:
                coordinator = entry.runtime_data
                break
        if coordinator is None:
            return web.Response(status=503)
        try:
            content, content_type, disposition = await coordinator.client.get_raw(
                f"transactions/{transaction_id}/attachment/content"
            )
        except MyBankApiError:
            return web.Response(status=404)
        headers = {"Content-Disposition": disposition} if disposition else {}
        return web.Response(body=content, content_type=content_type, headers=headers)


async def async_register_view(hass: HomeAssistant) -> None:
    """Register the attachment proxy view, once."""
    if hass.data.get(_REGISTERED):
        return
    hass.data[_REGISTERED] = True
    hass.http.register_view(MyBankAttachmentView())
