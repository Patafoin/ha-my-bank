"""Tests for the card's static path + Lovelace resource registration."""
from __future__ import annotations

from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component

from custom_components.my_bank.const import DOMAIN
from custom_components.my_bank.frontend import CARD_URL_PATH, CARD_VERSION


async def test_card_resource_is_registered(hass: HomeAssistant) -> None:
    assert await async_setup_component(hass, DOMAIN, {})
    await hass.async_block_till_done()

    from homeassistant.components.lovelace.const import LOVELACE_DATA
    from homeassistant.components.lovelace.resources import ResourceStorageCollection

    lovelace_data = hass.data[LOVELACE_DATA]
    assert isinstance(lovelace_data.resources, ResourceStorageCollection)

    if not lovelace_data.resources.loaded:
        await lovelace_data.resources.async_load()

    urls = [item["url"] for item in lovelace_data.resources.async_items()]
    assert f"{CARD_URL_PATH}?v={CARD_VERSION}" in urls


async def test_registering_twice_does_not_duplicate_resource(hass: HomeAssistant) -> None:
    from custom_components.my_bank.frontend import async_register_frontend

    assert await async_setup_component(hass, DOMAIN, {})
    await hass.async_block_till_done()

    # A second explicit call (e.g. a future reload) must be a no-op, not a
    # second resource entry.
    await async_register_frontend(hass)

    from homeassistant.components.lovelace.const import LOVELACE_DATA

    urls = [item["url"] for item in hass.data[LOVELACE_DATA].resources.async_items()]
    assert urls.count(f"{CARD_URL_PATH}?v={CARD_VERSION}") == 1
