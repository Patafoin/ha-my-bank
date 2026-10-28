"""Config flow for My Bank (My Bank API)."""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigEntryState, ConfigFlow, ConfigFlowResult, OptionsFlowWithReload
from homeassistant.const import CONF_URL
from homeassistant.data_entry_flow import section
from homeassistant.helpers.selector import (
    BooleanSelector,
    SelectOptionDict,
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
)
from homeassistant.helpers.service_info.hassio import HassioServiceInfo

from .access import LEVELS, NEW_ENTRY_OPTIONS, published_accounts, publishes_ending, user_level
from .api import MyBankApiError, MyBankAuthError, MyBankClient
from .const import CONF_ACCESS, CONF_ADMIN_ONLY, CONF_BALANCE_SENSORS, CONF_DEFAULT_ACCESS, CONF_ENDING_SENSOR, CONF_TOKEN, DEFAULT_URL, DOMAIN


def _schema(url: str) -> vol.Schema:
    return vol.Schema({vol.Required(CONF_URL, default=url): str, vol.Required(CONF_TOKEN): str})


class MyBankConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for My Bank."""

    VERSION = 2

    @staticmethod
    def async_get_options_flow(config_entry: ConfigEntry) -> MyBankOptionsFlow:
        return MyBankOptionsFlow()

    def __init__(self) -> None:
        self._discovered: dict[str, Any] = {}
        self._addon_name = "My Bank API"

    async def _validate(self, user_input: dict[str, Any]) -> str | None:
        client = MyBankClient(self.hass, user_input[CONF_URL], user_input[CONF_TOKEN])
        try:
            await client.get("accounts")
        except MyBankAuthError:
            return "invalid_auth"
        except MyBankApiError:
            return "cannot_connect"
        return None

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            user_input[CONF_URL] = user_input[CONF_URL].rstrip("/")
            if (error := await self._validate(user_input)) is None:
                await self.async_set_unique_id(user_input[CONF_URL])
                self._abort_if_unique_id_configured()
                return self.async_create_entry(title="My Bank", data=user_input, options=NEW_ENTRY_OPTIONS)
            errors["base"] = error
        return self.async_show_form(step_id="user", data_schema=_schema(DEFAULT_URL), errors=errors)

    async def async_step_hassio(self, discovery_info: HassioServiceInfo) -> ConfigFlowResult:
        """The My Bank API add-on announced itself: URL and token come from the Supervisor."""
        config = discovery_info.config
        self._discovered = {CONF_URL: f"http://{config['host']}:{config['port']}", CONF_TOKEN: config["token"]}
        self._addon_name = discovery_info.name
        await self.async_set_unique_id(self._discovered[CONF_URL])
        # Same add-on announced again (restart, new token): refresh the entry instead of asking.
        self._abort_if_unique_id_configured(updates=self._discovered)
        return await self.async_step_hassio_confirm()

    async def async_step_hassio_confirm(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            if (error := await self._validate(self._discovered)) is None:
                return self.async_create_entry(title="My Bank", data=self._discovered, options=NEW_ENTRY_OPTIONS)
            errors["base"] = error
        return self.async_show_form(
            step_id="hassio_confirm", description_placeholders={"addon": self._addon_name}, errors=errors
        )

    async def async_step_reauth(self, entry_data: Mapping[str, Any]) -> ConfigFlowResult:
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        entry = self._get_reauth_entry()
        errors: dict[str, str] = {}
        if user_input is not None:
            user_input[CONF_URL] = user_input[CONF_URL].rstrip("/")
            if (error := await self._validate(user_input)) is None:
                return self.async_update_reload_and_abort(
                    entry, unique_id=user_input[CONF_URL], data=user_input
                )
            errors["base"] = error
        return self.async_show_form(
            step_id="reauth_confirm",
            data_schema=_schema(entry.data.get(CONF_URL) or DEFAULT_URL),
            errors=errors,
        )


_LEVEL_SELECTOR = SelectSelector(
    SelectSelectorConfig(options=list(LEVELS), translation_key="access_level", mode=SelectSelectorMode.DROPDOWN)
)


class MyBankOptionsFlow(OptionsFlowWithReload):
    """Access level of each non-admin Home Assistant user, and the sensors to publish.

    One drop-down per user, labelled with the user's name (no translation exists for it: the key is shown).
    Reloaded on save, so that the sensors follow; the access levels are read on each call anyway.
    """

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        entry = self.config_entry
        users = sorted(
            (u for u in await self.hass.auth.async_get_users() if not u.system_generated and not u.is_admin),
            key=lambda u: (u.name or "").casefold(),
        )
        # Libellé du champ = nom de l'utilisateur, rendu unique (deux comptes du même nom).
        fields: dict[str, Any] = {}
        for user in users:
            label = user.name or user.id
            while label in fields or label == CONF_DEFAULT_ACCESS:
                label += " "
            fields[label] = user

        if user_input is not None:
            access_input = user_input["users"]
            sensors_input = user_input["sensors"]
            return self.async_create_entry(
                data={
                    CONF_DEFAULT_ACCESS: access_input[CONF_DEFAULT_ACCESS],
                    CONF_ACCESS: {user.id: access_input[label] for label, user in fields.items()},
                    CONF_ENDING_SENSOR: sensors_input[CONF_ENDING_SENSOR],
                    CONF_BALANCE_SENSORS: sorted(sensors_input[CONF_BALANCE_SENSORS], key=int),
                }
            )

        # Entrée antérieure à 0.16.0 : les comptes créés plus tard gardent ce qu'ils avaient (lecture, ou tout).
        default_level = entry.options.get(CONF_DEFAULT_ACCESS) or ("read" if entry.options.get(CONF_ADMIN_ONLY, True) else "write")
        users_schema = {vol.Required(CONF_DEFAULT_ACCESS, default=default_level): _LEVEL_SELECTOR}
        for label, user in fields.items():
            users_schema[vol.Required(label, default=user_level(entry, user))] = _LEVEL_SELECTOR

        accounts = entry.runtime_data.data.accounts if entry.state is ConfigEntryState.LOADED else {}
        chosen = published_accounts(entry)
        chosen = set(accounts) if chosen is None else chosen
        names = {aid: a.get("name", str(aid)) for aid, a in accounts.items()}
        names.update({aid: str(aid) for aid in chosen if aid not in names})  # compte non chargé : gardé coché
        sensors_schema = {
            vol.Required(CONF_ENDING_SENSOR, default=publishes_ending(entry)): BooleanSelector(),
            vol.Required(CONF_BALANCE_SENSORS, default=[str(a) for a in sorted(chosen)]): SelectSelector(
                SelectSelectorConfig(
                    options=[SelectOptionDict(value=str(aid), label=name) for aid, name in names.items()],
                    multiple=True,
                    mode=SelectSelectorMode.LIST,
                )
            ),
        }
        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {
                    vol.Required("users"): section(vol.Schema(users_schema), {"collapsed": False}),
                    vol.Required("sensors"): section(vol.Schema(sensors_schema), {"collapsed": False}),
                }
            ),
        )
