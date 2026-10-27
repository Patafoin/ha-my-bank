"""Config flow for My Bank (My Bank API)."""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.const import CONF_URL
from homeassistant.helpers.service_info.hassio import HassioServiceInfo

from .api import MyBankApiError, MyBankAuthError, MyBankClient
from .const import CONF_ADMIN_ONLY, CONF_TOKEN, DEFAULT_URL, DOMAIN


def _schema(url: str) -> vol.Schema:
    return vol.Schema({vol.Required(CONF_URL, default=url): str, vol.Required(CONF_TOKEN): str})


class MyBankConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for My Bank."""

    VERSION = 2

    @staticmethod
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
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
                return self.async_create_entry(title="My Bank", data=user_input)
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
                return self.async_create_entry(title="My Bank", data=self._discovered)
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


class MyBankOptionsFlow(OptionsFlow):
    """Who may change data: Home Assistant administrators only (default), or every user."""

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(data=user_input)
        current = self.config_entry.options.get(CONF_ADMIN_ONLY, True)
        return self.async_show_form(
            step_id="init", data_schema=vol.Schema({vol.Required(CONF_ADMIN_ONLY, default=current): bool})
        )
