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
    TextSelector,
    NumberSelector,
    NumberSelectorConfig,
    NumberSelectorMode,
    SelectOptionDict,
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
)
from homeassistant.helpers.service_info.hassio import HassioServiceInfo

from .access import LEVELS, NEW_ENTRY_OPTIONS, published_accounts, publishes_ending, user_level
from .api import MyBankApiError, MyBankAuthError, MyBankClient, outdated_server
from .const import (
    CONF_ACCESS,
    CONF_ADMIN_ONLY,
    CONF_BALANCE_SENSORS,
    CONF_DEFAULT_ACCESS,
    CONF_DUE_WARNING_DAYS,
    CONF_ENDING_SENSOR,
    CONF_TOKEN,
    DEFAULT_DUE_WARNING_DAYS,
    DEFAULT_URL,
    DOMAIN,
    MIN_API_VERSION,
)


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


CONF_NEW_PROFILE = "new_profile"


def _unique_labels(names: dict[Any, str], reserved: set[str]) -> dict[str, Any]:
    """Field label → key: the label is the name (no translation exists for it), made unique with trailing spaces."""
    fields: dict[str, Any] = {}
    for key, name in names.items():
        label = name
        while label in fields or label in reserved:
            label += " "
        fields[label] = key
    return fields


class MyBankOptionsFlow(OptionsFlowWithReload):
    """Access level of each non-admin Home Assistant user, the sensors to publish, the due date warning, and the profiles.

    One drop-down per user, labelled with the user's name (no translation exists for it: the key is shown); one
    text field per profile, labelled with its name. Profiles live in My Bank API: they are written on save, not
    kept in the options. Reloaded on save, so that the sensors follow; the access levels are read on each call anyway.

    From two profiles on, a menu first: the settings, or deleting a profile with all its data — a separate path,
    confirmed twice, never a side effect of the settings form (decision 028).
    """

    _profiles: list[dict]
    _api_too_old: str | None = None
    _doomed: dict | None = None

    async def _save_profiles(self, client: MyBankClient, profiles: list[dict], fields: dict[str, int], data: dict) -> str | None:
        """Renames and creates profiles (an emptied name is left unchanged); the API's message on the first refusal."""
        try:
            for label, profile_id in fields.items():
                name = (data.get(label) or "").strip()
                current = next(p for p in profiles if p["id"] == profile_id)
                if name and name != current["name"]:
                    await client.patch(f"profiles/{profile_id}", {"name": name})
            if new := (data.get(CONF_NEW_PROFILE) or "").strip():
                position = max((p["position"] for p in profiles), default=0) + 1
                await client.post("profiles", {"name": new, "position": position})
        except MyBankApiError as err:
            return str(err)
        return None

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        entry = self.config_entry
        self._profiles = []
        if entry.state is ConfigEntryState.LOADED:
            try:
                self._profiles = await entry.runtime_data.client.get("profiles")
            except MyBankApiError:
                self._profiles = []  # API older than 0.12.0, or unreachable: no profiles section
            if not self._profiles:
                self._api_too_old = await outdated_server(entry.runtime_data.client)
        if len(self._profiles) > 1:
            return self.async_show_menu(step_id="init", menu_options=["settings", "delete_profile"])
        return await self.async_step_settings()

    async def async_step_settings(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        entry = self.config_entry
        loaded = entry.state is ConfigEntryState.LOADED
        errors: dict[str, str] = {}
        placeholders: dict[str, str] = {}
        profiles = self._profiles
        if self._api_too_old:
            # Intégration mise à jour sans l'API (application HA ou image Docker) : le dire ici, où l'on cherche les profils.
            errors["base"] = "api_too_old"
            placeholders.update(version=self._api_too_old, minimum=MIN_API_VERSION)
        profile_fields = _unique_labels({p["id"]: p["name"] for p in profiles}, {CONF_NEW_PROFILE})
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

        if user_input is not None and profiles:
            if error := await self._save_profiles(entry.runtime_data.client, profiles, profile_fields, user_input.get("profiles", {})):
                errors["base"] = "profiles_failed"
                placeholders["error"] = error
            else:
                await entry.runtime_data.async_request_refresh()
        if user_input is not None and errors.get("base") != "profiles_failed":
            access_input = user_input["users"]
            sensors_input = user_input["sensors"]
            due_input = user_input["due"]
            return self.async_create_entry(
                data={
                    CONF_DEFAULT_ACCESS: access_input[CONF_DEFAULT_ACCESS],
                    CONF_ACCESS: {user.id: access_input[label] for label, user in fields.items()},
                    CONF_ENDING_SENSOR: sensors_input[CONF_ENDING_SENSOR],
                    CONF_BALANCE_SENSORS: sorted(sensors_input[CONF_BALANCE_SENSORS], key=int),
                    CONF_DUE_WARNING_DAYS: int(due_input[CONF_DUE_WARNING_DAYS]),
                }
            )

        # Entrée antérieure à 0.16.0 : les comptes créés plus tard gardent ce qu'ils avaient (lecture, ou tout).
        default_level = entry.options.get(CONF_DEFAULT_ACCESS) or ("read" if entry.options.get(CONF_ADMIN_ONLY, True) else "write")
        users_schema = {vol.Required(CONF_DEFAULT_ACCESS, default=default_level): _LEVEL_SELECTOR}
        for label, user in fields.items():
            users_schema[vol.Required(label, default=user_level(entry, user))] = _LEVEL_SELECTOR

        accounts = entry.runtime_data.data.accounts if loaded else {}
        chosen = published_accounts(entry)
        chosen = set(accounts) if chosen is None else chosen
        # Plusieurs profils : « Profil · Compte », deux comptes de même nom pouvant exister dans deux profils.
        profile_names = {p["id"]: p["name"] for p in profiles} if len(profiles) > 1 else {}
        names = {
            aid: " · ".join(filter(None, (profile_names.get(a.get("profile_id")), a.get("name", str(aid)))))
            for aid, a in accounts.items()
        }
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
        due_schema = {
            vol.Required(
                CONF_DUE_WARNING_DAYS, default=entry.options.get(CONF_DUE_WARNING_DAYS, DEFAULT_DUE_WARNING_DAYS)
            ): NumberSelector(NumberSelectorConfig(min=0, max=90, step=1, mode=NumberSelectorMode.BOX)),
        }
        schema = {
            vol.Required("users"): section(vol.Schema(users_schema), {"collapsed": False}),
            vol.Required("sensors"): section(vol.Schema(sensors_schema), {"collapsed": False}),
            vol.Required("due"): section(vol.Schema(due_schema), {"collapsed": False}),
        }
        if profiles:
            profiles_schema: dict[Any, Any] = {
                vol.Optional(label, description={"suggested_value": next(p["name"] for p in profiles if p["id"] == pid)}): TextSelector()
                for label, pid in profile_fields.items()
            }
            profiles_schema[vol.Optional(CONF_NEW_PROFILE)] = TextSelector()
            schema[vol.Required("profiles")] = section(vol.Schema(profiles_schema), {"collapsed": len(profiles) == 1})
        data_schema = vol.Schema(schema)
        if user_input is not None:
            data_schema = self.add_suggested_values_to_schema(data_schema, user_input)
        return self.async_show_form(
            step_id="settings", data_schema=data_schema, errors=errors, description_placeholders=placeholders
        )

    # --- Suppression d'un profil et de toutes ses données : choix, puis deux confirmations ----------------------

    async def async_step_delete_profile(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            self._doomed = next(p for p in self._profiles if str(p["id"]) == user_input["profile_id"])
            return await self.async_step_delete_confirm()
        options = [SelectOptionDict(value=str(p["id"]), label=p["name"]) for p in self._profiles]
        return self.async_show_form(
            step_id="delete_profile",
            data_schema=vol.Schema(
                {vol.Required("profile_id"): SelectSelector(SelectSelectorConfig(options=options, mode=SelectSelectorMode.LIST))}
            ),
        )

    def _doomed_placeholders(self) -> dict[str, str]:
        p = self._doomed or {}
        return {key: str(p.get(key, 0)) for key in ("accounts", "transactions", "categories", "classes", "payees")} | {
            "name": p.get("name", "")
        }

    async def async_step_delete_confirm(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """First question: what will be deleted, and do you want it."""
        if user_input is not None and "confirm" in user_input:
            if not user_input["confirm"]:
                return self.async_abort(reason="delete_cancelled")
            return await self.async_step_delete_confirm_again()
        return self.async_show_form(
            step_id="delete_confirm",
            data_schema=vol.Schema({vol.Required("confirm", default=False): BooleanSelector()}),
            description_placeholders=self._doomed_placeholders(),
        )

    async def async_step_delete_confirm_again(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Second question, the last chance: nothing can be undone after it."""
        errors: dict[str, str] = {}
        placeholders = self._doomed_placeholders()
        if user_input is not None and "confirm" in user_input:
            if not user_input["confirm"]:
                return self.async_abort(reason="delete_cancelled")
            entry = self.config_entry
            doomed = self._doomed
            gone = {aid for aid, a in entry.runtime_data.data.accounts.items() if a.get("profile_id") == doomed["id"]}
            try:
                await entry.runtime_data.client.delete(f"profiles/{doomed['id']}?with_data=true")
            except MyBankApiError as err:
                errors["base"] = "profiles_failed"
                placeholders["error"] = str(err)
            else:
                options = dict(entry.options)
                if isinstance(options.get(CONF_BALANCE_SENSORS), list):
                    options[CONF_BALANCE_SENSORS] = [a for a in options[CONF_BALANCE_SENSORS] if int(a) not in gone]
                self.hass.config_entries.async_update_entry(entry, options=options)
                # Rechargée : les capteurs des comptes supprimés disparaissent.
                self.hass.config_entries.async_schedule_reload(entry.entry_id)
                return self.async_abort(reason="profile_deleted", description_placeholders={"name": doomed["name"]})
        return self.async_show_form(
            step_id="delete_confirm_again",
            data_schema=vol.Schema({vol.Required("confirm", default=False): BooleanSelector()}),
            description_placeholders=placeholders,
            errors=errors,
        )
