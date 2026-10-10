"""Fixtures for My Bank tests."""
from __future__ import annotations

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from homeassistant.core import HomeAssistant

from custom_components.my_bank.const import DOMAIN

API_URL = "http://mybank.local:9931"
API = f"{API_URL}/api/v1"
TOKEN = "test-token"  # noqa: S105 - test fixture, not a real secret

ACCOUNTS = [
    {
        "id": 1,
        "name": "Compte courant",
        "kind": "checking",
        "iban": None,
        "currency": "EUR",
        "closed": False,
        "balances": {"total": "1520.45", "pointed": "1498.15", "reconciled": "1610.25"},
    },
    {
        "id": 2,
        "name": "Livret d'épargne",
        "kind": "savings",
        "iban": "FR7600000000000000000000000",
        "currency": "EUR",
        "closed": False,
        "balances": {"total": "5200.35", "pointed": "5200.35", "reconciled": "5200.35"},
    },
]


def mock_schedules(aioclient_mock, schedules=(), upcoming=(), api=API, version="0.6.0") -> None:
    """What setup reads besides the accounts: schedules (none by default) and the server version."""
    aioclient_mock.get(f"{api}/schedules/upcoming?days=30", json=list(upcoming))
    aioclient_mock.get(f"{api}/schedules", json=list(schedules))
    aioclient_mock.get(f"{api}/health", json={"status": "ok", "version": version})


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations: None) -> None:
    """Load custom_components/ from this repository."""


@pytest.fixture
def config_entry() -> MockConfigEntry:
    """A My Bank (v2) config entry, not yet added to hass."""
    return MockConfigEntry(
        domain=DOMAIN, title="My Bank", unique_id=API_URL, version=2, data={"url": API_URL, "token": TOKEN}
    )


@pytest.fixture
async def loaded_entry(hass: HomeAssistant, aioclient_mock, config_entry) -> MockConfigEntry:
    """Entry set up against a mocked API returning ACCOUNTS."""
    aioclient_mock.get(f"{API}/accounts", json=ACCOUNTS)
    mock_schedules(aioclient_mock)
    config_entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(config_entry.entry_id)
    await hass.async_block_till_done()
    return config_entry
