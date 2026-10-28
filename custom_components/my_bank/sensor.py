"""Balance sensor of each chosen My Bank account (state = total balance), plus the schedules coming to an end."""
from __future__ import annotations

import logging

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .access import published_accounts, publishes_ending
from .const import DOMAIN, TERM_DAYS
from .coordinator import MyBankCoordinator

_LOGGER = logging.getLogger(__name__)
# Distinct from the Firefly III era prefix (my_bank_account_<id>): account ids
# don't match between the two backends, so the old sensors are pruned instead
# of being silently re-bound to a different account.
_PREFIX = f"{DOMAIN}_api_account_"
_ENDING_UNIQUE_ID = f"{DOMAIN}_api_ending_schedules"


def _unique_id(account_id: int) -> str:
    return f"{_PREFIX}{account_id}"


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Only the sensors chosen in the options: their state is visible to every Home Assistant user."""
    coordinator: MyBankCoordinator = entry.runtime_data
    chosen = published_accounts(entry)
    ending = publishes_ending(entry)

    def wanted(accounts: dict) -> set[int]:
        return {aid for aid in accounts if chosen is None or aid in chosen}

    _prune_stale_entities(hass, entry, wanted(coordinator.data.accounts), ending)
    known = wanted(coordinator.data.accounts)
    async_add_entities(
        [*([EndingSchedulesSensor(coordinator)] if ending else []), *(AccountBalanceSensor(coordinator, aid) for aid in known)]
    )

    @callback
    def _sync_entities() -> None:
        current = wanted(coordinator.data.accounts)
        if new := current - known:
            known.update(new)
            async_add_entities(AccountBalanceSensor(coordinator, aid) for aid in new)
        if known - current:
            known.intersection_update(current)
            _prune_stale_entities(hass, entry, current, ending)

    entry.async_on_unload(coordinator.async_add_listener(_sync_entities))


def _prune_stale_entities(hass: HomeAssistant, entry: ConfigEntry, accounts: set[int], ending: bool) -> None:
    """Remove this entry's sensors no longer published: account deleted or unchosen, Firefly III era."""
    registry = er.async_get(hass)
    valid = {_unique_id(aid) for aid in accounts} | ({_ENDING_UNIQUE_ID} if ending else set())
    for entity in list(er.async_entries_for_config_entry(registry, entry.entry_id)):
        if entity.domain == "sensor" and entity.unique_id not in valid:
            _LOGGER.info("Removing sensor %s (no longer published)", entity.entity_id)
            registry.async_remove(entity.entity_id)


def _float(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


class AccountBalanceSensor(CoordinatorEntity[MyBankCoordinator], SensorEntity):
    """Total balance of an account; pointed and reconciled balances as attributes.

    No IBAN in the attributes: the state of a sensor is readable by every Home Assistant user.
    """

    _attr_has_entity_name = True
    _attr_icon = "mdi:bank"
    _attr_device_class = SensorDeviceClass.MONETARY
    _attr_suggested_display_precision = 2

    def __init__(self, coordinator: MyBankCoordinator, account_id: int) -> None:
        super().__init__(coordinator)
        self._account_id = account_id
        self._attr_unique_id = _unique_id(account_id)

    @property
    def _account(self) -> dict:
        return self.coordinator.data.accounts.get(self._account_id, {})

    @property
    def available(self) -> bool:
        return super().available and self._account_id in self.coordinator.data.accounts

    @property
    def name(self) -> str:
        return self._account.get("name", f"Account {self._account_id}")

    @property
    def native_value(self) -> float | None:
        return _float(self._account.get("balances", {}).get("total"))

    @property
    def native_unit_of_measurement(self) -> str | None:
        return self._account.get("currency", "EUR")

    @property
    def extra_state_attributes(self) -> dict:
        account = self._account
        balances = account.get("balances", {})
        return {
            "account_id": self._account_id,
            "solde_pointe": _float(balances.get("pointed")),
            "solde_rapproche": _float(balances.get("reconciled")),
            "kind": account.get("kind"),
            "closed": account.get("closed"),
            "is_default": account.get("is_default"),
        }


class EndingSchedulesSensor(CoordinatorEntity[MyBankCoordinator], SensorEntity):
    """Number of schedules whose last occurrence falls within TERM_DAYS days; details as attributes.

    Meant for an automation (notification) and for dashboards: the list is in `planifications`.
    """

    _attr_has_entity_name = True
    _attr_translation_key = "ending_schedules"  # nom et unité traduits (strings.json)
    _attr_icon = "mdi:calendar-end"
    _attr_unique_id = _ENDING_UNIQUE_ID

    @property
    def native_value(self) -> int:
        return len(self.coordinator.data.ending)

    @property
    def extra_state_attributes(self) -> dict:
        accounts = self.coordinator.data.accounts
        return {
            "jours": TERM_DAYS,
            "planifications": [
                {
                    "id": e["schedule_id"],
                    "libelle": e["label"],
                    "echeancier": e["mode"] == "installments",
                    "compte": accounts.get(e["account_id"], {}).get("name"),
                    "derniere_echeance": e["last_date"],
                    "jours_restants": e["days_left"],
                    "echeances_restantes": e["remaining"],
                    "dernier_montant": _float(e["last_amount"]),
                }
                for e in self.coordinator.data.ending
            ],
        }
