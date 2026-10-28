"""Tests for the My Bank config flow, add-on discovery, reauth and the Firefly III → My Bank API migration."""
from __future__ import annotations

from pytest_homeassistant_custom_component.common import MockConfigEntry

from homeassistant import config_entries
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.helpers.service_info.hassio import HassioServiceInfo

from custom_components.my_bank.access import NEW_ENTRY_OPTIONS
from custom_components.my_bank.const import DEFAULT_URL, DOMAIN

from .conftest import ACCOUNTS, API, API_URL, TOKEN, mock_schedules


async def _start(hass):
    return await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})


async def test_user_flow_success(hass: HomeAssistant, aioclient_mock) -> None:
    aioclient_mock.get(f"{API}/accounts", json=ACCOUNTS)
    result = await _start(hass)
    assert result["type"] is FlowResultType.FORM

    result = await hass.config_entries.flow.async_configure(result["flow_id"], {"url": API_URL + "/", "token": TOKEN})

    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"] == {"url": API_URL, "token": TOKEN}
    assert result["options"] == NEW_ENTRY_OPTIONS  # rien pour les non-administrateurs, aucun capteur
    assert result["result"].unique_id == API_URL


async def test_user_flow_invalid_auth(hass: HomeAssistant, aioclient_mock) -> None:
    aioclient_mock.get(f"{API}/accounts", status=401, json={"detail": "jeton invalide"})
    result = await _start(hass)
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {"url": API_URL, "token": "x"})
    assert result["errors"] == {"base": "invalid_auth"}


async def test_user_flow_cannot_connect(hass: HomeAssistant, aioclient_mock) -> None:
    aioclient_mock.get(f"{API}/accounts", exc=TimeoutError())
    result = await _start(hass)
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {"url": API_URL, "token": TOKEN})
    assert result["errors"] == {"base": "cannot_connect"}


async def test_user_flow_aborts_on_duplicate(hass: HomeAssistant, aioclient_mock, config_entry) -> None:
    config_entry.add_to_hass(hass)
    aioclient_mock.get(f"{API}/accounts", json=ACCOUNTS)
    result = await _start(hass)
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {"url": API_URL, "token": TOKEN})
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "already_configured"


async def test_firefly_entry_is_migrated_and_asks_for_token(hass: HomeAssistant, aioclient_mock) -> None:
    """The live v1 entry pointed at Firefly III: after the update it must ask for a My Bank token."""
    old = MockConfigEntry(
        domain=DOMAIN,
        title="My Bank",
        unique_id="http://firefly.local:9930",
        version=1,
        data={"url": "http://firefly.local:9930", "token": "firefly-token"},
    )
    old.add_to_hass(hass)
    aioclient_mock.get(f"{DEFAULT_URL}/api/v1/accounts", status=401, json={"detail": "jeton manquant"})

    await hass.config_entries.async_setup(old.entry_id)
    await hass.async_block_till_done()

    assert old.version == 2
    assert old.data == {"url": DEFAULT_URL, "token": ""}
    assert old.unique_id == DEFAULT_URL
    assert old.state is ConfigEntryState.SETUP_ERROR
    flows = hass.config_entries.flow.async_progress_by_handler(DOMAIN)
    assert [f["context"]["source"] for f in flows] == ["reauth"]

    # The user pastes the token: the entry is updated and reloaded.
    aioclient_mock.clear_requests()
    aioclient_mock.get(f"{DEFAULT_URL}/api/v1/accounts", json=ACCOUNTS)
    mock_schedules(aioclient_mock, api=f"{DEFAULT_URL}/api/v1")
    result = await hass.config_entries.flow.async_configure(flows[0]["flow_id"], {"url": DEFAULT_URL, "token": TOKEN})
    await hass.async_block_till_done()

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "reauth_successful"
    assert old.data == {"url": DEFAULT_URL, "token": TOKEN}
    assert old.state is ConfigEntryState.LOADED
    assert hass.states.get("sensor.compte_courant").state == "1520.45"


async def test_reauth_wrong_token_shows_error(hass: HomeAssistant, aioclient_mock, config_entry) -> None:
    config_entry.add_to_hass(hass)
    aioclient_mock.get(f"{API}/accounts", status=401, json={"detail": "jeton invalide"})
    result = await config_entry.start_reauth_flow(hass)
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {"url": API_URL, "token": "bad"})
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "invalid_auth"}


def _addon_discovery(token: str = TOKEN) -> HassioServiceInfo:
    return HassioServiceInfo(
        config={"host": "mybank.local", "port": 9931, "token": token},
        name="My Bank API",
        slug="my_bank_api",
        uuid="1234",
    )


async def test_addon_discovery_creates_entry_after_confirmation(hass: HomeAssistant, aioclient_mock) -> None:
    aioclient_mock.get(f"{API}/accounts", json=ACCOUNTS)
    mock_schedules(aioclient_mock)
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_HASSIO}, data=_addon_discovery()
    )
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "hassio_confirm"
    assert result["description_placeholders"] == {"addon": "My Bank API"}

    result = await hass.config_entries.flow.async_configure(result["flow_id"], {})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"] == {"url": API_URL, "token": TOKEN}
    assert result["options"] == NEW_ENTRY_OPTIONS  # rien pour les non-administrateurs, aucun capteur
    assert result["result"].unique_id == API_URL


async def test_addon_rediscovery_updates_the_token(hass: HomeAssistant, aioclient_mock, config_entry) -> None:
    config_entry.add_to_hass(hass)
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_HASSIO}, data=_addon_discovery("new-token")
    )
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "already_configured"
    assert config_entry.data == {"url": API_URL, "token": "new-token"}


async def test_addon_discovery_shows_error_when_unreachable(hass: HomeAssistant, aioclient_mock) -> None:
    aioclient_mock.get(f"{API}/accounts", exc=TimeoutError())
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_HASSIO}, data=_addon_discovery()
    )
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {})
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "cannot_connect"}
