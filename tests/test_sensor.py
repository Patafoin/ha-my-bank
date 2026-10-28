"""Tests for the my_bank account balance sensors."""
from __future__ import annotations

from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er

from .conftest import ACCOUNTS, API, mock_schedules


async def test_one_sensor_per_account_with_three_balances(hass: HomeAssistant, loaded_entry) -> None:
    state = hass.states.get("sensor.compte_courant")
    assert state.state == "1520.45"
    assert state.attributes["unit_of_measurement"] == "EUR"
    assert state.attributes["solde_pointe"] == 1498.15
    assert state.attributes["solde_rapproche"] == 1610.25
    assert state.attributes["account_id"] == 1
    assert state.attributes["kind"] == "checking"
    assert hass.states.get("sensor.livret_d_epargne").state == "5200.35"


async def test_unparseable_balance_is_unknown(hass: HomeAssistant, aioclient_mock, config_entry) -> None:
    broken = [{**ACCOUNTS[0], "balances": {"total": "n/a", "pointed": None, "reconciled": None}}]
    aioclient_mock.get(f"{API}/accounts", json=broken)
    mock_schedules(aioclient_mock)
    config_entry.add_to_hass(hass)
    await hass.config_entries.async_setup(config_entry.entry_id)
    await hass.async_block_till_done()
    assert hass.states.get("sensor.compte_courant").state == "unknown"


async def test_firefly_era_sensor_is_pruned(hass: HomeAssistant, aioclient_mock, config_entry) -> None:
    """The old `my_bank_account_<firefly id>` sensor must not survive the switch."""
    config_entry.add_to_hass(hass)
    registry = er.async_get(hass)
    old = registry.async_get_or_create(
        "sensor", "my_bank", "my_bank_account_1", config_entry=config_entry, suggested_object_id="ancien_compte"
    )
    aioclient_mock.get(f"{API}/accounts", json=ACCOUNTS)
    mock_schedules(aioclient_mock)
    await hass.config_entries.async_setup(config_entry.entry_id)
    await hass.async_block_till_done()

    assert registry.async_get(old.entity_id) is None
    assert hass.states.get("sensor.compte_courant") is not None


async def test_deleted_account_sensor_is_removed_on_refresh(hass: HomeAssistant, aioclient_mock, loaded_entry) -> None:
    registry = er.async_get(hass)
    assert registry.async_get("sensor.livret_d_epargne") is not None
    aioclient_mock.clear_requests()
    aioclient_mock.get(f"{API}/accounts", json=ACCOUNTS[:1])
    mock_schedules(aioclient_mock)

    await loaded_entry.runtime_data.async_refresh()
    await hass.async_block_till_done()

    assert registry.async_get("sensor.livret_d_epargne") is None
    assert registry.async_get("sensor.compte_courant") is not None


async def test_new_account_gets_a_sensor_on_refresh(hass: HomeAssistant, aioclient_mock, loaded_entry) -> None:
    aioclient_mock.clear_requests()
    extra = {**ACCOUNTS[0], "id": 3, "name": "Carte"}
    aioclient_mock.get(f"{API}/accounts", json=[*ACCOUNTS, extra])
    mock_schedules(aioclient_mock)

    await loaded_entry.runtime_data.async_refresh()
    await hass.async_block_till_done()

    assert hass.states.get("sensor.carte").state == "1520.45"


def _schedule(sid, label, remaining, mode="installments", active=True):
    return {"id": sid, "label": label, "mode": mode, "account_id": 1, "active": active, "remaining": remaining}


def _occ(sid, rank, date, amount="-150.00"):
    return {"schedule_id": sid, "rank": rank, "date": date, "amount": amount}


async def test_ending_schedules_sensor(hass: HomeAssistant, aioclient_mock, config_entry, freezer) -> None:
    """Only finite schedules whose remaining occurrences all fall within the next 30 days."""
    freezer.move_to("2026-10-09 12:00:00")
    schedules = [
        _schedule(1, "Prêt auto", 2),  # 2 restantes, toutes dans les 30 jours → à terme
        _schedule(2, "Crédit", 5),  # 5 restantes, 1 seule dans les 30 jours
        _schedule(3, "Loyer", None, mode="periodic"),  # sans fin
        _schedule(4, "Inactive", 1, active=False),
        _schedule(5, "Terminée", 0),
    ]
    upcoming = [_occ(1, 11, "2026-10-12"), _occ(2, 3, "2026-10-15"), _occ(1, 12, "2026-10-21", "-90.00"), _occ(3, 7, "2026-11-01")]
    aioclient_mock.get(f"{API}/accounts", json=ACCOUNTS)
    mock_schedules(aioclient_mock, schedules, upcoming)
    config_entry.add_to_hass(hass)
    await hass.config_entries.async_setup(config_entry.entry_id)
    await hass.async_block_till_done()

    state = hass.states.get("sensor.scheduled_transactions_ending")
    assert state.attributes["unit_of_measurement"] == "scheduled transactions"  # nom et unité traduits
    assert state.state == "1"
    assert state.attributes["jours"] == 30
    assert state.attributes["planifications"] == [
        {
            "id": 1, "libelle": "Prêt auto", "echeancier": True, "compte": "Compte courant",
            "derniere_echeance": "2026-10-21", "jours_restants": 12, "echeances_restantes": 2, "dernier_montant": -90.0,
        }
    ]
    # le capteur n'est pas pris pour un capteur de compte obsolète
    assert er.async_get(hass).async_get("sensor.scheduled_transactions_ending") is not None


async def test_schedules_error_keeps_balances(hass: HomeAssistant, aioclient_mock, config_entry) -> None:
    aioclient_mock.get(f"{API}/accounts", json=ACCOUNTS)
    aioclient_mock.get(f"{API}/schedules/upcoming", status=500, json={"detail": "boum"})
    aioclient_mock.get(f"{API}/schedules", status=500, json={"detail": "boum"})
    aioclient_mock.get(f"{API}/health", json={"status": "ok", "version": "0.6.0"})
    config_entry.add_to_hass(hass)
    await hass.config_entries.async_setup(config_entry.entry_id)
    await hass.async_block_till_done()

    assert hass.states.get("sensor.compte_courant").state == "1520.45"
    assert hass.states.get("sensor.scheduled_transactions_ending").state == "0"


async def _setup_with_options(hass, aioclient_mock, config_entry, options, accounts=ACCOUNTS):
    aioclient_mock.get(f"{API}/accounts", json=accounts)
    mock_schedules(aioclient_mock)
    config_entry.add_to_hass(hass)
    hass.config_entries.async_update_entry(config_entry, options=options)
    assert await hass.config_entries.async_setup(config_entry.entry_id)
    await hass.async_block_till_done()


async def test_new_entry_publishes_no_sensor(hass: HomeAssistant, aioclient_mock, config_entry) -> None:
    """Strict by default: a sensor's state is readable by every Home Assistant user."""
    from custom_components.my_bank.access import NEW_ENTRY_OPTIONS

    await _setup_with_options(hass, aioclient_mock, config_entry, NEW_ENTRY_OPTIONS)
    assert hass.states.async_entity_ids("sensor") == []


async def test_only_chosen_sensors_are_published(hass: HomeAssistant, aioclient_mock, config_entry) -> None:
    options = {"default_access": "none", "access": {}, "ending_sensor": True, "balance_sensors": ["2"]}
    await _setup_with_options(hass, aioclient_mock, config_entry, options)
    assert sorted(hass.states.async_entity_ids("sensor")) == ["sensor.livret_d_epargne", "sensor.scheduled_transactions_ending"]
    assert "iban" not in hass.states.get("sensor.livret_d_epargne").attributes  # visible de tous les utilisateurs

    # un compte créé ensuite n'est pas publié sans être choisi
    aioclient_mock.clear_requests()
    aioclient_mock.get(f"{API}/accounts", json=[*ACCOUNTS, {**ACCOUNTS[0], "id": 3, "name": "Carte"}])
    mock_schedules(aioclient_mock)
    await config_entry.runtime_data.async_refresh()
    await hass.async_block_till_done()
    assert hass.states.get("sensor.carte") is None


async def test_unchosen_sensor_is_removed(hass: HomeAssistant, aioclient_mock, loaded_entry) -> None:
    registry = er.async_get(hass)
    assert registry.async_get("sensor.compte_courant") is not None
    hass.config_entries.async_update_entry(
        loaded_entry, options={"default_access": "none", "access": {}, "ending_sensor": False, "balance_sensors": ["2"]}
    )
    await hass.config_entries.async_reload(loaded_entry.entry_id)
    await hass.async_block_till_done()
    assert registry.async_get("sensor.compte_courant") is None
    assert registry.async_get("sensor.scheduled_transactions_ending") is None
    assert hass.states.get("sensor.livret_d_epargne").state == "5200.35"
