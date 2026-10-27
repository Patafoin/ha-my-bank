"""Tests for the server version check (repair issue)."""
from __future__ import annotations

from homeassistant.core import HomeAssistant
from homeassistant.helpers import issue_registry as ir

from custom_components.my_bank.const import DOMAIN

from .conftest import ACCOUNTS, API, mock_schedules


async def _setup(hass, aioclient_mock, config_entry, version):
    aioclient_mock.get(f"{API}/accounts", json=ACCOUNTS)
    mock_schedules(aioclient_mock, version=version)
    config_entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(config_entry.entry_id)
    await hass.async_block_till_done()


async def test_outdated_server_raises_a_repair_issue(hass: HomeAssistant, aioclient_mock, config_entry) -> None:
    await _setup(hass, aioclient_mock, config_entry, "0.4.1")
    issue = ir.async_get(hass).async_get_issue(DOMAIN, "api_too_old")
    assert issue is not None
    assert issue.translation_placeholders == {"version": "0.4.1", "minimum": "0.8.0"}
    # The entry still loads: the issue is a warning, not a blocker.
    assert hass.states.get("sensor.compte_courant") is not None


async def test_recent_server_has_no_issue(hass: HomeAssistant, aioclient_mock, config_entry) -> None:
    await _setup(hass, aioclient_mock, config_entry, "0.10.0")
    assert ir.async_get(hass).async_get_issue(DOMAIN, "api_too_old") is None


DEFAULT_METHODS = [
    {"id": i, "name": name, "active": True, "position": i}
    for i, name in enumerate(["Carte bancaire", "Virement", "Chèque", "Prélèvement", "Versement"], start=1)
]


async def _setup_fresh(hass, aioclient_mock, config_entry, methods, accounts=()):
    aioclient_mock.get(f"{API}/accounts", json=list(accounts))
    aioclient_mock.get(f"{API}/payment-methods", json=methods)
    for m in methods:
        aioclient_mock.patch(f"{API}/payment-methods/{m['id']}", json=m)
    mock_schedules(aioclient_mock)
    config_entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(config_entry.entry_id)
    await hass.async_block_till_done()
    return {str(url).rsplit("/", 1)[-1]: data["name"] for method, url, data, _ in aioclient_mock.mock_calls if method == "PATCH"}


async def test_fresh_install_names_default_payment_methods_in_ha_language(hass, aioclient_mock, config_entry) -> None:
    hass.config.language = "de"
    renamed = await _setup_fresh(hass, aioclient_mock, config_entry, DEFAULT_METHODS)
    assert renamed == {"1": "Karte", "2": "Überweisung", "3": "Scheck", "4": "Lastschrift", "5": "Einzahlung"}


async def test_payment_methods_untouched_when_customised_or_in_use(hass, aioclient_mock, config_entry) -> None:
    hass.config.language = "en"
    custom = [*DEFAULT_METHODS[:4], {"id": 5, "name": "Espèces", "active": True, "position": 5}]
    assert await _setup_fresh(hass, aioclient_mock, config_entry, custom) == {}


async def test_payment_methods_untouched_once_accounts_exist(hass, aioclient_mock, config_entry) -> None:
    hass.config.language = "en"
    assert await _setup_fresh(hass, aioclient_mock, config_entry, DEFAULT_METHODS, ACCOUNTS) == {}


async def test_requests_carry_the_ha_language(hass, aioclient_mock, config_entry) -> None:
    hass.config.language = "de"
    await _setup(hass, aioclient_mock, config_entry, "0.6.0")
    assert all(headers["Accept-Language"] == "de" for _, _, _, headers in aioclient_mock.mock_calls)
