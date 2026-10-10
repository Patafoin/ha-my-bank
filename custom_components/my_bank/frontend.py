"""Register the my_bank Lovelace card: static path + Lovelace resource.

Mirrors the decision already taken for My Music Library: register a
Lovelace resource (the standard mechanism for custom cards) rather than
`add_extra_js_url`, and version the URL from CARD_VERSION so browsers
pick up changes after an update.
"""
from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

CARD_VERSION = "0.12.0"
CARD_URL_PATH = "/my_bank/my-bank-card.js"
_REGISTERED = f"{DOMAIN}_frontend_registered"


async def async_register_frontend(hass: HomeAssistant) -> None:
    """Serve the card file and add it as a Lovelace resource, once."""
    if hass.data.get(_REGISTERED):
        return
    hass.data[_REGISTERED] = True

    www_dir = Path(__file__).parent / "www"
    await hass.http.async_register_static_paths(
        [StaticPathConfig(CARD_URL_PATH, str(www_dir / "my-bank-card.js"), False)]
    )

    try:
        from homeassistant.components.lovelace.const import LOVELACE_DATA
        from homeassistant.components.lovelace.resources import ResourceStorageCollection
    except ImportError:  # pragma: no cover - lovelace is always present on HA Core
        _LOGGER.warning("Lovelace component not found: card resource not registered")
        return

    lovelace_data = hass.data.get(LOVELACE_DATA)
    if lovelace_data is None:
        _LOGGER.warning("Lovelace not initialised yet: card resource not registered")
        return

    resources = lovelace_data.resources
    if not isinstance(resources, ResourceStorageCollection):
        _LOGGER.warning(
            "Lovelace est en mode YAML : ajoutez %s?v=%s manuellement aux ressources",
            CARD_URL_PATH,
            CARD_VERSION,
        )
        return

    if not resources.loaded:
        await resources.async_load()
        resources.loaded = True

    url = f"{CARD_URL_PATH}?v={CARD_VERSION}"
    for item in resources.async_items():
        if item["url"].startswith(CARD_URL_PATH):
            if item["url"] != url:
                await resources.async_update_item(item["id"], {"url": url})
            return

    await resources.async_create_item({"res_type": "module", "url": url})
