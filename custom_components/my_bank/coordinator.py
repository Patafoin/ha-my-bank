"""Polls My Bank API for the accounts (three balances each) and the schedules coming to an end."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed
from homeassistant.util import dt as dt_util

from .api import MyBankApiError, MyBankAuthError, MyBankClient
from .const import DOMAIN, TERM_DAYS

_LOGGER = logging.getLogger(__name__)


@dataclass
class MyBankData:
    accounts: dict[int, dict]  # keyed by id, each with its `balances` (total / pointed / reconciled)
    ending: list[dict] = field(default_factory=list)  # schedules whose last occurrence is within TERM_DAYS


def ending_schedules(schedules: list[dict], upcoming: list[dict], today: date) -> list[dict]:
    """Active finite schedules whose remaining occurrences all fall within the upcoming window.

    Same rule as the card: `remaining` (pending occurrences) equals the number of pending
    occurrences listed by /schedules/upcoming over TERM_DAYS days (overdue ones included).
    """
    result = []
    for s in schedules:
        if not s.get("active") or not s.get("remaining"):
            continue
        own = [o for o in upcoming if o["schedule_id"] == s["id"]]
        if len(own) != s["remaining"]:
            continue
        last = max(own, key=lambda o: o["date"])
        result.append(
            {
                "schedule_id": s["id"],
                "label": s["label"],
                "mode": s["mode"],
                "account_id": s["account_id"],
                "last_date": last["date"],
                "days_left": (date.fromisoformat(last["date"]) - today).days,
                "remaining": s["remaining"],
                "last_amount": last["amount"],
            }
        )
    return sorted(result, key=lambda e: e["last_date"])


class MyBankCoordinator(DataUpdateCoordinator[MyBankData]):
    """Accounts and schedules coming to an end, refreshed every 5 minutes and after each write."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, client: MyBankClient) -> None:
        super().__init__(
            hass, _LOGGER, name=DOMAIN, config_entry=entry, update_interval=timedelta(minutes=5)
        )
        self.client = client

    async def _async_update_data(self) -> MyBankData:
        try:
            accounts = await self.client.get("accounts")
        except MyBankAuthError as err:
            raise ConfigEntryAuthFailed(str(err)) from err
        except MyBankApiError as err:
            raise UpdateFailed(str(err)) from err
        previous = self.data.ending if self.data else []
        try:
            schedules = await self.client.get("schedules")
            upcoming = await self.client.get("schedules/upcoming", params={"days": TERM_DAYS})
            ending = ending_schedules(schedules, upcoming, dt_util.now().date())
        except MyBankAuthError as err:
            raise ConfigEntryAuthFailed(str(err)) from err
        except MyBankApiError as err:
            # best-effort: the balances stay up to date, the list of ending schedules is kept as is
            _LOGGER.warning("My Bank : planifications non lues (%s)", err)
            ending = previous
        return MyBankData(accounts={a["id"]: a for a in accounts}, ending=ending)
