"""The My Bank integration — thin client for the self-hosted My Bank API.

No accounting logic lives here (balances, transfers, locking of reconciled
transactions, tree rules...): it all lives in My Bank API. This module only
exposes HA services mapped to its REST endpoints, so the Lovelace card (or an
automation) can read and write every kind of object.
"""
from __future__ import annotations

import logging
import re
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigEntryState
from homeassistant.const import CONF_URL, Platform
from homeassistant.core import HomeAssistant, ServiceCall, ServiceResponse, SupportsResponse
from homeassistant.exceptions import HomeAssistantError, Unauthorized, UnknownUser
from homeassistant.helpers import config_validation as cv, issue_registry as ir

from .api import MyBankApiError, MyBankClient
from .access import READ, WRITE, allows, user_level
from .const import CONF_TOKEN, DEFAULT_PAYMENT_METHODS, DEFAULT_URL, DOMAIN, MIN_API_VERSION
from .coordinator import MyBankCoordinator
from .frontend import async_register_frontend
from .views import async_register_view

_LOGGER = logging.getLogger(__name__)

PLATFORMS = [Platform.SENSOR]
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)
_SERVICES_REGISTERED = f"{DOMAIN}_services_registered"

type MyBankConfigEntry = ConfigEntry[MyBankCoordinator]


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Register the services and the card once, independently of any entry."""
    _register_services(hass)
    await async_register_frontend(hass)
    await async_register_view(hass)
    return True


async def async_migrate_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """v1 pointed at Firefly III: switch to My Bank API and ask for its token (reauth)."""
    if entry.version == 1:
        _LOGGER.warning("My Bank: switching from Firefly III to My Bank API, enter the My Bank API token (reauthentication)")
        hass.config_entries.async_update_entry(
            entry, data={CONF_URL: DEFAULT_URL, CONF_TOKEN: ""}, unique_id=DEFAULT_URL, version=2
        )
    return True


async def async_setup_entry(hass: HomeAssistant, entry: MyBankConfigEntry) -> bool:
    client = MyBankClient(hass, entry.data[CONF_URL], entry.data[CONF_TOKEN])
    coordinator = MyBankCoordinator(hass, entry, client)
    await coordinator.async_config_entry_first_refresh()
    await _check_api_version(hass, client)
    if not coordinator.data.accounts:
        await _localize_payment_methods(hass, client)
    entry.runtime_data = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


def _version(text: str) -> tuple[int, ...]:
    return tuple(int(n) for n in re.findall(r"\d+", text)[:3])


async def _check_api_version(hass: HomeAssistant, client: MyBankClient) -> None:
    """Raise a repair issue when My Bank API is older than this integration expects.

    HACS updates the integration and the add-on (or Docker image) is updated separately:
    without this, an outdated server would only show up as obscure errors in the card.
    """
    try:
        version = str((await client.get("health") or {}).get("version", ""))
    except MyBankApiError:
        return
    if version and _version(version) < _version(MIN_API_VERSION):
        ir.async_create_issue(
            hass,
            DOMAIN,
            "api_too_old",
            is_fixable=False,
            severity=ir.IssueSeverity.WARNING,
            translation_key="api_too_old",
            translation_placeholders={"version": version, "minimum": MIN_API_VERSION},
        )
    else:
        ir.async_delete_issue(hass, DOMAIN, "api_too_old")


async def _localize_payment_methods(hass: HomeAssistant, client: MyBankClient) -> None:
    """Fresh database (no account): give the default payment methods names in the language of Home Assistant.

    Only when they still all have the names the server created, so a user's own names are never touched.
    """
    lang = (hass.config.language or "en")[:2]
    if lang == "fr":
        return
    try:
        methods = await client.get("payment-methods")
        if {m["name"] for m in methods} != set(DEFAULT_PAYMENT_METHODS):
            return
        for method in methods:
            names = DEFAULT_PAYMENT_METHODS[method["name"]]
            await client.patch(f"payment-methods/{method['id']}", {"name": names.get(lang, names["en"])})
    except MyBankApiError as err:
        _LOGGER.warning("Could not rename the default payment methods: %s", err)


async def async_unload_entry(hass: HomeAssistant, entry: MyBankConfigEntry) -> bool:
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


def _entry(hass: HomeAssistant) -> MyBankConfigEntry:
    for entry in hass.config_entries.async_entries(DOMAIN):
        if entry.state is ConfigEntryState.LOADED:
            return entry
    raise HomeAssistantError(translation_domain=DOMAIN, translation_key="not_loaded")


def _coordinator(hass: HomeAssistant) -> MyBankCoordinator:
    return _entry(hass).runtime_data


async def _user_level(hass: HomeAssistant, call: ServiceCall) -> str:
    """Niveau d'accès de l'utilisateur à l'origine de l'appel (options de l'entrée, voir access.py).

    Sans utilisateur (automatisation, script lancé par HA) : accès complet.
    """
    if not call.context.user_id:
        return WRITE
    user = await hass.auth.async_get_user(call.context.user_id)
    if user is None:
        raise UnknownUser(context=call.context, user_id=call.context.user_id)
    return user_level(_entry(hass), user)


async def _check_access(hass: HomeAssistant, call: ServiceCall, needed: str) -> None:
    if not allows(await _user_level(hass, call), needed):
        raise Unauthorized(context=call.context)


# --- Schémas ---------------------------------------------------------------------------------------

_ID = vol.Coerce(int)
_OPT_ID = vol.Any(None, vol.Coerce(int))
_AMOUNT = cv.string  # "-14,80" ou -14.8 : la conversion et le contrôle sont faits par l'API
_TEXT = vol.Any(None, cv.string)
_STATE = vol.All(vol.Coerce(int), vol.In([0, 1, 2]))
_DATE = cv.matches_regex(r"^\d{4}-\d{2}-\d{2}$")
_CURRENCY = vol.All(cv.string, lambda v: v.strip().upper(), cv.matches_regex(r"^[A-Z]{3}$"))

_SPLIT = vol.Schema(
    {
        vol.Required("amount"): _AMOUNT,
        vol.Optional("category_id"): _OPT_ID,
        vol.Optional("class_id"): _OPT_ID,
        vol.Optional("label"): _TEXT,
    }
)

_ACCOUNT_FIELDS = {
    vol.Optional("kind"): vol.In(["checking", "savings", "card", "cash", "other"]),
    vol.Optional("number"): _TEXT,
    vol.Optional("iban"): _TEXT,
    vol.Optional("currency"): _CURRENCY,
    vol.Optional("opening_balance"): _AMOUNT,
    vol.Optional("opening_date"): vol.Any(None, _DATE),
    vol.Optional("closed"): cv.boolean,
    vol.Optional("position"): vol.Coerce(int),
    vol.Optional("notes"): _TEXT,
    vol.Optional("is_default"): cv.boolean,
}
_TREE_FIELDS = {
    vol.Optional("parent_id"): _OPT_ID,
    vol.Optional("active"): cv.boolean,
    vol.Optional("position"): vol.Coerce(int),
}
_PAYEE_TEXT_FIELDS = (
    "short_name payee_category address1 address2 address3 postal_code city region country phone phone2 "
    "mobile fax fax2 email url bank_name bank_code branch_code account_number rib_key iban swift "
    "free1 free2 free3 notes external_code"
).split()
_PAYEE_FIELDS = {
    vol.Optional("default_category_id"): _OPT_ID,
    vol.Optional("active"): cv.boolean,
    **{vol.Optional(f): _TEXT for f in _PAYEE_TEXT_FIELDS},
}
_TX_FIELDS = {
    vol.Optional("payee_id"): _OPT_ID,
    vol.Optional("payee_name"): cv.string,
    vol.Optional("payment_method_id"): _OPT_ID,
    vol.Optional("number"): _TEXT,
    vol.Optional("label"): _TEXT,
    vol.Optional("notes"): _TEXT,
    vol.Optional("state"): _STATE,
    vol.Optional("category_id"): _OPT_ID,
    vol.Optional("class_id"): _OPT_ID,
    vol.Optional("splits"): [_SPLIT],
}

_SCHEDULE_FIELDS = {
    vol.Optional("label"): cv.string,
    vol.Optional("mode"): vol.In(["periodic", "installments"]),
    vol.Optional("start_date"): _DATE,
    vol.Optional("unit"): vol.In(["day", "week", "month", "quarter", "year"]),
    vol.Optional("every"): vol.All(vol.Coerce(int), vol.Range(min=1)),
    vol.Optional("end_mode"): vol.In(["never", "date", "count"]),
    vol.Optional("end_date"): vol.Any(None, _DATE),
    vol.Optional("count"): vol.Any(None, vol.All(vol.Coerce(int), vol.Range(min=1))),
    vol.Optional("amount"): _AMOUNT,
    vol.Optional("payee_id"): _OPT_ID,
    vol.Optional("payee_name"): cv.string,
    vol.Optional("payment_method_id"): _OPT_ID,
    vol.Optional("category_id"): _OPT_ID,
    vol.Optional("class_id"): _OPT_ID,
    vol.Optional("transfer_account_id"): _OPT_ID,
    vol.Optional("notes"): _TEXT,
    vol.Optional("auto"): cv.boolean,
    vol.Optional("lead_days"): vol.All(vol.Coerce(int), vol.Range(min=0)),
    vol.Optional("generate_from"): _DATE,
    vol.Optional("active"): cv.boolean,
}
_OCCURRENCE = vol.Schema({vol.Required("schedule_id"): _ID, vol.Required("rank"): _ID})
_MONTH = cv.matches_regex(r"^\d{4}-\d{2}(-\d{2})?$")
_BUDGET_FIELDS = {
    vol.Optional("name"): cv.string,
    vol.Optional("start_month"): _MONTH,
    vol.Optional("months"): vol.All(vol.Coerce(int), vol.Range(min=1, max=36)),
    vol.Optional("archived"): cv.boolean,
    vol.Optional("notes"): _TEXT,
}
_BUDGET_LINE = vol.Schema({vol.Required("category_id"): _ID, vol.Required("month"): _MONTH, vol.Required("amount"): _AMOUNT})
# cv.url : http(s) seulement (un lien javascript: s'exécuterait à l'ouverture dans la carte)
_ATTACHMENT_LINK = vol.Schema({vol.Required("transaction_id"): _ID, vol.Required("url"): cv.url})
_ATTACHMENT_FILE = vol.Schema(
    {
        vol.Required("transaction_id"): _ID,
        vol.Required("filename"): cv.string,
        vol.Required("content_base64"): cv.string,
        vol.Optional("mime_type"): cv.string,
    }
)

# (service, schema, HTTP method, path template — its {placeholders} are taken out of the body)
_WRITE_SERVICES: list[tuple[str, vol.Schema, str, str]] = [
    ("create_account", vol.Schema({vol.Required("name"): cv.string, **_ACCOUNT_FIELDS}), "POST", "accounts"),
    ("update_account", vol.Schema({vol.Required("account_id"): _ID, vol.Optional("name"): cv.string, **_ACCOUNT_FIELDS}), "PATCH", "accounts/{account_id}"),
    ("delete_account", vol.Schema({vol.Required("account_id"): _ID}), "DELETE", "accounts/{account_id}"),
    ("create_category", vol.Schema({vol.Required("name"): cv.string, vol.Optional("kind"): vol.In(["income", "expense", "savings"]), **_TREE_FIELDS}), "POST", "categories"),
    ("update_category", vol.Schema({vol.Required("category_id"): _ID, vol.Optional("name"): cv.string, vol.Optional("kind"): vol.In(["income", "expense", "savings"]), **_TREE_FIELDS}), "PATCH", "categories/{category_id}"),
    ("delete_category", vol.Schema({vol.Required("category_id"): _ID}), "DELETE", "categories/{category_id}"),
    ("create_class", vol.Schema({vol.Required("name"): cv.string, **_TREE_FIELDS}), "POST", "classes"),
    ("update_class", vol.Schema({vol.Required("class_id"): _ID, vol.Optional("name"): cv.string, **_TREE_FIELDS}), "PATCH", "classes/{class_id}"),
    ("delete_class", vol.Schema({vol.Required("class_id"): _ID}), "DELETE", "classes/{class_id}"),
    ("create_payee", vol.Schema({vol.Required("name"): cv.string, **_PAYEE_FIELDS}), "POST", "payees"),
    ("update_payee", vol.Schema({vol.Required("payee_id"): _ID, vol.Optional("name"): cv.string, **_PAYEE_FIELDS}), "PATCH", "payees/{payee_id}"),
    ("delete_payee", vol.Schema({vol.Required("payee_id"): _ID}), "DELETE", "payees/{payee_id}"),
    ("create_payment_method", vol.Schema({vol.Required("name"): cv.string, vol.Optional("active"): cv.boolean, vol.Optional("position"): vol.Coerce(int)}), "POST", "payment-methods"),
    ("update_payment_method", vol.Schema({vol.Required("payment_method_id"): _ID, vol.Optional("name"): cv.string, vol.Optional("active"): cv.boolean, vol.Optional("position"): vol.Coerce(int)}), "PATCH", "payment-methods/{payment_method_id}"),
    ("delete_payment_method", vol.Schema({vol.Required("payment_method_id"): _ID}), "DELETE", "payment-methods/{payment_method_id}"),
    ("create_transaction", vol.Schema({vol.Required("account_id"): _ID, vol.Required("date"): _DATE, vol.Required("amount"): _AMOUNT, **_TX_FIELDS}), "POST", "transactions"),
    ("update_transaction", vol.Schema({vol.Required("transaction_id"): _ID, vol.Optional("account_id"): _ID, vol.Optional("date"): _DATE, vol.Optional("amount"): _AMOUNT, **_TX_FIELDS}), "PATCH", "transactions/{transaction_id}"),
    ("delete_transaction", vol.Schema({vol.Required("transaction_id"): _ID}), "DELETE", "transactions/{transaction_id}"),
    ("set_transaction_state", vol.Schema({vol.Required("transaction_id"): _ID, vol.Required("state"): _STATE}), "PATCH", "transactions/{transaction_id}/state"),
    ("set_transactions_state", vol.Schema({vol.Required("ids"): [_ID], vol.Required("state"): _STATE}), "POST", "transactions/state"),
    ("delete_transaction_attachment", vol.Schema({vol.Required("transaction_id"): _ID}), "DELETE", "transactions/{transaction_id}/attachment"),
    (
        "create_transfer",
        vol.Schema(
            {
                vol.Required("from_account_id"): _ID,
                vol.Required("to_account_id"): _ID,
                vol.Required("date"): _DATE,
                vol.Required("amount"): _AMOUNT,
                vol.Optional("payment_method_id"): _OPT_ID,
                vol.Optional("label"): _TEXT,
                vol.Optional("notes"): _TEXT,
                vol.Optional("category_id"): _OPT_ID,
                vol.Optional("class_id"): _OPT_ID,
                vol.Optional("from_state"): _STATE,
                vol.Optional("to_state"): _STATE,
            }
        ),
        "POST",
        "transfers",
    ),
    ("create_schedule", vol.Schema({vol.Required("account_id"): _ID, vol.Required("label"): cv.string, vol.Required("start_date"): _DATE, vol.Required("amount"): _AMOUNT, **_SCHEDULE_FIELDS}), "POST", "schedules"),
    ("update_schedule", vol.Schema({vol.Required("schedule_id"): _ID, vol.Optional("account_id"): _ID, **_SCHEDULE_FIELDS}), "PATCH", "schedules/{schedule_id}"),
    ("delete_schedule", vol.Schema({vol.Required("schedule_id"): _ID}), "DELETE", "schedules/{schedule_id}"),
    (
        "set_schedule_occurrences",
        vol.Schema({vol.Required("schedule_id"): _ID, vol.Required("items"): [vol.Schema({vol.Required("rank"): _ID, vol.Required("amount"): _AMOUNT, vol.Optional("date"): vol.Any(None, _DATE)})]}),
        "PUT",
        "schedules/{schedule_id}/occurrences",
    ),
    ("skip_occurrence", _OCCURRENCE, "POST", "schedules/{schedule_id}/occurrences/{rank}/skip"),
    ("restore_occurrence", _OCCURRENCE, "DELETE", "schedules/{schedule_id}/occurrences/{rank}/skip"),
    ("generate_occurrence", _OCCURRENCE, "POST", "schedules/{schedule_id}/occurrences/{rank}/generate"),
    ("generate_due_occurrences", vol.Schema({}), "POST", "schedules/generate"),
    ("create_budget", vol.Schema({vol.Required("account_id"): _ID, vol.Required("name"): cv.string, vol.Required("start_month"): _MONTH, **_BUDGET_FIELDS}), "POST", "budgets"),
    ("update_budget", vol.Schema({vol.Required("budget_id"): _ID, vol.Optional("account_id"): _ID, **_BUDGET_FIELDS}), "PATCH", "budgets/{budget_id}"),
    ("delete_budget", vol.Schema({vol.Required("budget_id"): _ID}), "DELETE", "budgets/{budget_id}"),
    ("set_budget_lines", vol.Schema({vol.Required("budget_id"): _ID, vol.Required("lines"): [_BUDGET_LINE]}), "PUT", "budgets/{budget_id}/lines"),
    (
        "copy_budget",
        vol.Schema({vol.Required("budget_id"): _ID, vol.Required("name"): cv.string, vol.Optional("start_month"): _MONTH, vol.Optional("months"): vol.All(vol.Coerce(int), vol.Range(min=1, max=36)), vol.Optional("account_id"): _ID}),
        "POST",
        "budgets/{budget_id}/copy",
    ),
    # Déplacement en masse des opérations d'un élément vers un autre (décision 020)
    ("move_account", vol.Schema({vol.Required("account_id"): _ID, vol.Required("target_id"): _ID, vol.Optional("include_reconciled"): cv.boolean}), "POST", "accounts/{account_id}/move"),
    ("move_category", vol.Schema({vol.Required("category_id"): _ID, vol.Required("target_id"): _ID}), "POST", "categories/{category_id}/move"),
    ("move_class", vol.Schema({vol.Required("class_id"): _ID, vol.Required("target_id"): _ID}), "POST", "classes/{class_id}/move"),
    ("move_payee", vol.Schema({vol.Required("payee_id"): _ID, vol.Required("target_id"): _ID}), "POST", "payees/{payee_id}/move"),
    # Comptes partagés (décision 019) : sans lien avec les comptes bancaires
    ("create_shared_account", vol.Schema({vol.Required("name"): cv.string, vol.Required("participants"): vol.All([cv.string], vol.Length(min=2)), vol.Optional("notes"): _TEXT}), "POST", "shared-accounts"),
    ("update_shared_account", vol.Schema({vol.Required("shared_account_id"): _ID, vol.Optional("name"): cv.string, vol.Optional("notes"): _TEXT, vol.Optional("closed"): cv.boolean}), "PATCH", "shared-accounts/{shared_account_id}"),
    ("delete_shared_account", vol.Schema({vol.Required("shared_account_id"): _ID}), "DELETE", "shared-accounts/{shared_account_id}"),
    ("add_shared_participant", vol.Schema({vol.Required("shared_account_id"): _ID, vol.Required("name"): cv.string}), "POST", "shared-accounts/{shared_account_id}/participants"),
    ("rename_shared_participant", vol.Schema({vol.Required("shared_account_id"): _ID, vol.Required("participant_id"): _ID, vol.Required("name"): cv.string}), "PATCH", "shared-accounts/{shared_account_id}/participants/{participant_id}"),
    ("remove_shared_participant", vol.Schema({vol.Required("shared_account_id"): _ID, vol.Required("participant_id"): _ID}), "DELETE", "shared-accounts/{shared_account_id}/participants/{participant_id}"),
    ("add_shared_expense", vol.Schema({vol.Required("shared_account_id"): _ID, vol.Required("participant_id"): _ID, vol.Required("amount"): _AMOUNT, vol.Optional("date"): _DATE, vol.Optional("label"): _TEXT}), "POST", "shared-accounts/{shared_account_id}/expenses"),
    (
        "update_shared_expense",
        vol.Schema({vol.Required("shared_account_id"): _ID, vol.Required("expense_id"): _ID, vol.Optional("participant_id"): _ID, vol.Optional("amount"): _AMOUNT, vol.Optional("date"): _DATE, vol.Optional("label"): _TEXT}),
        "PATCH",
        "shared-accounts/{shared_account_id}/expenses/{expense_id}",
    ),
    ("delete_shared_expense", vol.Schema({vol.Required("shared_account_id"): _ID, vol.Required("expense_id"): _ID}), "DELETE", "shared-accounts/{shared_account_id}/expenses/{expense_id}"),
]

_READ_SERVICES: list[tuple[str, vol.Schema, str]] = [
    ("list_accounts", vol.Schema({vol.Optional("date"): _DATE, vol.Optional("include_closed"): cv.boolean}), "accounts"),
    ("list_categories", vol.Schema({}), "categories"),
    ("list_classes", vol.Schema({}), "classes"),
    ("list_payees", vol.Schema({vol.Optional("q"): cv.string, vol.Optional("active"): cv.boolean}), "payees"),
    ("list_payment_methods", vol.Schema({}), "payment-methods"),
    (
        "list_account_transactions",
        vol.Schema(
            {
                vol.Required("account_id"): _ID,
                vol.Optional("start"): _DATE,
                vol.Optional("end"): _DATE,
                vol.Optional("state"): [_STATE],
                vol.Optional("order"): vol.In(["asc", "desc"]),
            }
        ),
        "accounts/{account_id}/transactions",
    ),
    (
        "search_transactions",
        vol.Schema(
            {
                vol.Optional("account_id"): _ID,
                vol.Optional("start"): _DATE,
                vol.Optional("end"): _DATE,
                vol.Optional("state"): [_STATE],
                vol.Optional("payee_id"): _ID,
                vol.Optional("category_id"): _ID,
                vol.Optional("include_subcategories"): cv.boolean,
                vol.Optional("class_id"): _ID,
                vol.Optional("q"): cv.string,
                vol.Optional("order"): vol.In(["asc", "desc"]),
                vol.Optional("limit"): vol.All(vol.Coerce(int), vol.Range(min=1, max=1000)),
                vol.Optional("offset"): vol.All(vol.Coerce(int), vol.Range(min=0)),
            }
        ),
        "transactions",
    ),
    ("list_schedules", vol.Schema({vol.Optional("account_id"): _ID, vol.Optional("active"): cv.boolean}), "schedules"),
    (
        "list_upcoming_occurrences",
        vol.Schema({vol.Optional("days"): vol.All(vol.Coerce(int), vol.Range(min=0, max=366)), vol.Optional("account_id"): _ID}),
        "schedules/upcoming",
    ),
    (
        "list_schedule_occurrences",
        vol.Schema({vol.Required("schedule_id"): _ID, vol.Optional("upcoming"): vol.All(vol.Coerce(int), vol.Range(min=1, max=240))}),
        "schedules/{schedule_id}/occurrences",
    ),
    ("list_budgets", vol.Schema({vol.Optional("account_id"): _ID, vol.Optional("include_archived"): cv.boolean}), "budgets"),
    ("get_budget_lines", vol.Schema({vol.Required("budget_id"): _ID}), "budgets/{budget_id}/lines"),
    ("get_budget_report", vol.Schema({vol.Required("budget_id"): _ID}), "budgets/{budget_id}/report"),
    ("list_shared_accounts", vol.Schema({}), "shared-accounts"),
    ("get_shared_account", vol.Schema({vol.Required("shared_account_id"): _ID}), "shared-accounts/{shared_account_id}"),
]


def _split_path(template: str, data: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """Fill {placeholders} from the call data and drop them from the body."""
    body = dict(data)
    keys = [part[1:-1] for part in template.split("/") if part.startswith("{")]
    return template.format(**{k: body.pop(k) for k in keys}), body


def _as_response(result: Any) -> ServiceResponse:
    if result is None:
        return None
    return result if isinstance(result, dict) else {"items": result}


def _query(body: dict[str, Any]) -> list[tuple[str, str]]:
    """aiohttp query params; lists become repeated keys, booleans lowercase."""
    params: list[tuple[str, str]] = []
    for key, value in body.items():
        for item in value if isinstance(value, list) else [value]:
            params.append((key, str(item).lower() if isinstance(item, bool) else str(item)))
    return params


def _register_services(hass: HomeAssistant) -> None:
    if hass.data.get(_SERVICES_REGISTERED):
        return
    hass.data[_SERVICES_REGISTERED] = True

    def make_write(name: str, method: str, template: str):
        async def handler(call: ServiceCall) -> ServiceResponse:
            await _check_access(hass, call, WRITE)
            coordinator = _coordinator(hass)
            path, body = _split_path(template, call.data)
            if name == "create_account":
                # Pas de devise choisie : celle réglée dans Paramètres > Général de HA plutôt que le EUR par défaut de l'API.
                body.setdefault("currency", hass.config.currency)
            try:
                if method == "POST":
                    result = await coordinator.client.post(path, body)
                elif method == "PATCH":
                    result = await coordinator.client.patch(path, body)
                elif method == "PUT":
                    result = await coordinator.client.put(path, body)
                else:
                    result = await coordinator.client.delete(path)
            except MyBankApiError as err:
                raise HomeAssistantError(str(err)) from err
            await coordinator.async_request_refresh()
            return _as_response(result)

        return handler

    def make_attachment_write(kind: str):
        # `kind` fixe le discriminant de l'API ; pas de template générique car il n'est pas un champ saisi par l'appelant.
        async def handler(call: ServiceCall) -> ServiceResponse:
            await _check_access(hass, call, WRITE)
            coordinator = _coordinator(hass)
            body = dict(call.data)
            tx_id = body.pop("transaction_id")
            try:
                result = await coordinator.client.put(f"transactions/{tx_id}/attachment", {"kind": kind, **body})
            except MyBankApiError as err:
                raise HomeAssistantError(str(err)) from err
            await coordinator.async_request_refresh()
            return _as_response(result)

        return handler

    def make_read(template: str):
        async def handler(call: ServiceCall) -> ServiceResponse:
            await _check_access(hass, call, READ)
            coordinator = _coordinator(hass)
            path, body = _split_path(template, call.data)
            try:
                return _as_response(await coordinator.client.get(path, params=_query(body)))
            except MyBankApiError as err:
                raise HomeAssistantError(str(err)) from err

        return handler

    async def get_access(call: ServiceCall) -> ServiceResponse:
        """Niveau d'accès de l'appelant, pour que la carte affiche un message clair au lieu d'erreurs en série."""
        return {"level": await _user_level(hass, call)}

    # Contrôle des droits dans chaque appel (options de l'entrée, modifiables sans redémarrer).
    for name, schema, method, template in _WRITE_SERVICES:
        hass.services.async_register(
            DOMAIN, name, make_write(name, method, template), schema=schema, supports_response=SupportsResponse.OPTIONAL
        )
    for name, kind, schema in (
        ("set_transaction_attachment_link", "link", _ATTACHMENT_LINK),
        ("set_transaction_attachment_file", "file", _ATTACHMENT_FILE),
    ):
        hass.services.async_register(
            DOMAIN, name, make_attachment_write(kind), schema=schema, supports_response=SupportsResponse.OPTIONAL
        )
    for name, schema, template in _READ_SERVICES:
        hass.services.async_register(
            DOMAIN, name, make_read(template), schema=schema, supports_response=SupportsResponse.ONLY
        )
    hass.services.async_register(DOMAIN, "get_access", get_access, schema=vol.Schema({}), supports_response=SupportsResponse.ONLY)
