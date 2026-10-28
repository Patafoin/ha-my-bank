"""HTTP view that proxies a transaction's attachment content through My Bank API (decision 023).

The browser never holds the My Bank API token: only this integration does. The card opens this
view with a signed path from `hass.callWS({type: "auth/sign_path", path, expires})` — Home
Assistant's standard way to open an authenticated resource in a new tab without an Authorization
header (the same mechanism camera snapshots and media sources use).
"""
from __future__ import annotations

from aiohttp import web

from homeassistant.components.http import KEY_HASS, KEY_HASS_USER, HomeAssistantView
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant

from .api import MyBankApiError
from .access import READ, allows, user_level
from .const import DOMAIN

_REGISTERED = f"{DOMAIN}_attachment_view_registered"


class MyBankAttachmentView(HomeAssistantView):
    url = "/api/my_bank/attachment/{transaction_id}"
    name = "api:my_bank:attachment"

    async def get(self, request: web.Request, transaction_id: str) -> web.Response:
        hass: HomeAssistant = request.app[KEY_HASS]
        entry = next(
            (e for e in hass.config_entries.async_entries(DOMAIN) if e.state is ConfigEntryState.LOADED), None
        )
        if entry is None:
            return web.Response(status=503)
        # Même droit que les services de lecture. 403 et non `Unauthorized` (401) :
        # HA compte chaque 401 comme une connexion ratée et finirait par bannir l'IP de l'utilisateur.
        if not allows(user_level(entry, request[KEY_HASS_USER]), READ):
            return web.Response(status=403)
        coordinator = entry.runtime_data
        # Entier seulement : aiohttp décode %2F et %3F dans le paramètre, qui sortirait sinon du chemin prévu.
        if not transaction_id.isdecimal():
            return web.Response(status=404)
        try:
            content, content_type, disposition = await coordinator.client.get_raw(
                f"transactions/{int(transaction_id)}/attachment/content"
            )
        except MyBankApiError:
            return web.Response(status=404)
        return web.Response(body=content, content_type=_served_type(content_type), headers=_headers(content_type, disposition))


# Servi sur l'origine de Home Assistant : un type actif (HTML, SVG…) y exécuterait du script avec la session
# de l'utilisateur. Contrôlé ici aussi, et pas seulement par My Bank API (versions antérieures à 0.7.0).
_INLINE_TYPES = {"application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "text/plain"}
_DOWNLOAD = "application/octet-stream"


def _served_type(content_type: str) -> str:
    base = content_type.split(";")[0].strip().lower()
    return base if base in _INLINE_TYPES else _DOWNLOAD


def _headers(content_type: str, disposition: str | None) -> dict[str, str]:
    served = _served_type(content_type)
    headers = {"X-Content-Type-Options": "nosniff"}
    if disposition:
        # Ni retour à la ligne ni caractère hors latin-1 venus de l'API dans l'en-tête.
        disposition = "".join(c for c in disposition if c.isprintable() and ord(c) < 256)
        kind, sep, rest = disposition.partition(";")
        if served == _DOWNLOAD or kind.strip().lower() != "inline":
            kind = "attachment"
        headers["Content-Disposition"] = f"{kind.strip()}{sep}{rest}"
    elif served == _DOWNLOAD:
        headers["Content-Disposition"] = "attachment"
    # Pas pour le PDF : la visionneuse de Chrome refuse de l'afficher sous `sandbox`.
    if served != "application/pdf":
        headers["Content-Security-Policy"] = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'"
    return headers


async def async_register_view(hass: HomeAssistant) -> None:
    """Register the attachment proxy view, once."""
    if hass.data.get(_REGISTERED):
        return
    hass.data[_REGISTERED] = True
    hass.http.register_view(MyBankAttachmentView())
