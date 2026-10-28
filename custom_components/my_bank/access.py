"""Who may use My Bank, per Home Assistant user, and which sensors are published (options of the entry).

Home Assistant offers no per-entity permissions that an integration could rely on: every logged-in user
receives the state of every entity. So the access check is made by the integration itself, on each service
call and on the attachment view; the sensors, readable by everyone, are only created when chosen.
"""
from __future__ import annotations

from homeassistant.auth.models import User
from homeassistant.config_entries import ConfigEntry

from .const import (
    CONF_ACCESS,
    CONF_ADMIN_ONLY,
    CONF_BALANCE_SENSORS,
    CONF_DEFAULT_ACCESS,
    CONF_ENDING_SENSOR,
)

NONE, READ, WRITE = "none", "read", "write"
LEVELS = (NONE, READ, WRITE)

# New entry: nothing for the non-admin users, no sensor (strict by default).
NEW_ENTRY_OPTIONS = {CONF_DEFAULT_ACCESS: NONE, CONF_ACCESS: {}, CONF_ENDING_SENSOR: False, CONF_BALANCE_SENSORS: []}


def user_level(entry: ConfigEntry, user: User) -> str:
    """Access level of a user. Administrators always have full access: they can change the options anyway."""
    if user.is_admin:
        return WRITE
    options = entry.options
    if CONF_DEFAULT_ACCESS not in options:
        # Entrée antérieure à 0.16.0 : option `admin_only` (cochée par défaut), lecture ouverte à tous.
        return READ if options.get(CONF_ADMIN_ONLY, True) else WRITE
    level = options.get(CONF_ACCESS, {}).get(user.id, options[CONF_DEFAULT_ACCESS])
    return level if level in LEVELS else NONE


def allows(level: str, needed: str) -> bool:
    return LEVELS.index(level) >= LEVELS.index(needed)


def published_accounts(entry: ConfigEntry) -> set[int] | None:
    """Accounts with a balance sensor; None = every account (entry older than 0.16.0, as before)."""
    chosen = entry.options.get(CONF_BALANCE_SENSORS)
    return None if chosen is None else {int(a) for a in chosen}


def publishes_ending(entry: ConfigEntry) -> bool:
    return entry.options.get(CONF_ENDING_SENSOR, CONF_BALANCE_SENSORS not in entry.options)
