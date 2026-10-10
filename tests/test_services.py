"""Tests for the my_bank services: each one maps to a My Bank API endpoint."""
from __future__ import annotations

import pytest
from homeassistant.exceptions import HomeAssistantError
from homeassistant.setup import async_setup_component

from custom_components.my_bank.const import DOMAIN

from .conftest import ACCOUNTS, API


async def _call(hass, service, data, return_response=False):
    return await hass.services.async_call(DOMAIN, service, data, blocking=True, return_response=return_response)


_REFRESH = (f"{API}/accounts", f"{API}/schedules", f"{API}/schedules/upcoming?days=30")


def _last(aioclient_mock):
    """Last call other than the coordinator refresh that follows every write
    (GET /accounts, then /schedules and /schedules/upcoming)."""
    calls, i, raw = [], 0, aioclient_mock.mock_calls
    while i < len(raw):
        if raw[i][0] == "GET" and str(raw[i][1]) == _REFRESH[0]:
            i += 1
            while i < len(raw) and raw[i][0] == "GET" and str(raw[i][1]) in _REFRESH[1:]:
                i += 1
            continue
        calls.append(raw[i])
        i += 1
    method, url, body, _headers = calls[-1]
    return method, str(url), body


async def test_services_need_a_loaded_entry(hass):
    await async_setup_component(hass, DOMAIN, {})
    with pytest.raises(HomeAssistantError) as err:
        await _call(hass, "list_categories", {}, return_response=True)
    assert err.value.translation_key == "not_loaded"


async def test_create_transaction_body(hass, aioclient_mock, loaded_entry):
    aioclient_mock.post(f"{API}/transactions", json={"id": 9})

    result = await _call(
        hass,
        "create_transaction",
        {"account_id": "1", "date": "2026-10-06", "amount": -14.8, "payee_name": "Supermarché", "category_id": 3, "state": "1"},
        return_response=True,
    )

    assert result == {"id": 9}
    method, url, body = _last(aioclient_mock)
    assert (method, url) == ("POST", f"{API}/transactions")
    assert body == {"account_id": 1, "date": "2026-10-06", "amount": "-14.8", "payee_name": "Supermarché", "category_id": 3, "state": 1}


async def test_update_transaction_moves_id_to_path_and_keeps_nulls(hass, aioclient_mock, loaded_entry):
    aioclient_mock.patch(f"{API}/transactions/5", json={"id": 5})

    await _call(hass, "update_transaction", {"transaction_id": 5, "category_id": None, "label": "x"})

    method, url, body = _last(aioclient_mock)
    assert (method, url) == ("PATCH", f"{API}/transactions/5")
    assert body == {"category_id": None, "label": "x"}


async def test_splits_are_passed_through(hass, aioclient_mock, loaded_entry):
    aioclient_mock.patch(f"{API}/transactions/5", json={"id": 5})
    splits = [{"amount": "-10", "category_id": 1}, {"amount": "-20", "class_id": None, "label": "b"}]

    await _call(hass, "update_transaction", {"transaction_id": 5, "amount": "-30", "splits": splits})

    assert _last(aioclient_mock)[2] == {"amount": "-30", "splits": splits}


async def test_state_and_transfer_and_delete(hass, aioclient_mock, loaded_entry):
    aioclient_mock.patch(f"{API}/transactions/5/state", json={"id": 5, "state": 2})
    aioclient_mock.post(f"{API}/transactions/state", json=[{"id": 5}, {"id": 6}])
    aioclient_mock.post(f"{API}/transfers", json={"source": {}, "destination": {}})
    aioclient_mock.delete(f"{API}/transactions/5", status=204)

    await _call(hass, "set_transaction_state", {"transaction_id": 5, "state": 2})
    assert _last(aioclient_mock)[2] == {"state": 2}
    bulk = await _call(hass, "set_transactions_state", {"ids": [5, 6], "state": 1}, return_response=True)
    assert bulk == {"items": [{"id": 5}, {"id": 6}]}
    await _call(
        hass, "create_transfer", {"from_account_id": 1, "to_account_id": 2, "date": "2026-10-06", "amount": "200"}
    )
    assert _last(aioclient_mock)[2] == {"from_account_id": 1, "to_account_id": 2, "date": "2026-10-06", "amount": "200"}
    await _call(hass, "delete_transaction", {"transaction_id": 5})
    assert _last(aioclient_mock)[:2] == ("DELETE", f"{API}/transactions/5")


async def test_invalid_state_rejected_before_any_call(hass, aioclient_mock, loaded_entry):
    calls = len(aioclient_mock.mock_calls)
    with pytest.raises(Exception):
        await _call(hass, "set_transaction_state", {"transaction_id": 5, "state": 3})
    assert len(aioclient_mock.mock_calls) == calls


async def test_api_error_becomes_homeassistant_error(hass, aioclient_mock, loaded_entry):
    aioclient_mock.delete(f"{API}/transactions/5", status=409, json={"detail": "Opération rapprochée : …"})
    with pytest.raises(HomeAssistantError, match="Opération rapprochée"):
        await _call(hass, "delete_transaction", {"transaction_id": 5})


async def test_write_refreshes_balances(hass, aioclient_mock, loaded_entry):
    aioclient_mock.post(f"{API}/transactions", json={"id": 9})
    before = sum(1 for c in aioclient_mock.mock_calls if str(c[1]).endswith("/accounts"))

    await _call(hass, "create_transaction", {"account_id": 1, "date": "2026-10-06", "amount": "-1"})
    await loaded_entry.runtime_data.async_refresh()  # debounced refresh, forced here
    await hass.async_block_till_done()

    assert sum(1 for c in aioclient_mock.mock_calls if str(c[1]).endswith("/accounts")) > before


async def test_list_services_wrap_arrays(hass, aioclient_mock, loaded_entry):
    aioclient_mock.get(f"{API}/categories", json=[{"id": 1, "path": "Loisirs"}])
    assert await _call(hass, "list_categories", {}, return_response=True) == {"items": [{"id": 1, "path": "Loisirs"}]}


async def test_list_account_transactions_query(hass, aioclient_mock, loaded_entry):
    aioclient_mock.get(f"{API}/accounts/1/transactions", json={"account_id": 1, "items": []})

    result = await _call(
        hass,
        "list_account_transactions",
        {"account_id": 1, "start": "2026-10-01", "state": [0, 1], "order": "desc"},
        return_response=True,
    )

    assert result == {"account_id": 1, "items": []}
    _method, url, _body, _h = aioclient_mock.mock_calls[-1]
    assert url.path == "/api/v1/accounts/1/transactions"
    assert url.query.getall("state") == ["0", "1"]
    assert url.query["start"] == "2026-10-01" and url.query["order"] == "desc"


async def test_search_booleans_are_lowercase(hass, aioclient_mock, loaded_entry):
    aioclient_mock.get(f"{API}/transactions", json={"total": 0, "items": []})
    await _call(
        hass, "search_transactions", {"category_id": 3, "include_subcategories": False, "limit": 1}, return_response=True
    )
    url = aioclient_mock.mock_calls[-1][1]
    assert url.query["include_subcategories"] == "false" and url.query["limit"] == "1"


async def test_list_accounts(hass, aioclient_mock, loaded_entry):
    result = await _call(hass, "list_accounts", {}, return_response=True)
    assert result == {"items": ACCOUNTS}


async def test_schedule_services(hass, aioclient_mock, loaded_entry):
    aioclient_mock.post(f"{API}/schedules", json={"id": 4})
    aioclient_mock.put(f"{API}/schedules/4/occurrences", json={"schedule_id": 4, "items": []})
    aioclient_mock.post(f"{API}/schedules/4/occurrences/2/skip", json={"schedule_id": 4, "items": []})
    aioclient_mock.delete(f"{API}/schedules/4/occurrences/2/skip", json={"schedule_id": 4, "items": []})
    aioclient_mock.post(f"{API}/schedules/4/occurrences/3/generate", json={"created": [{"id": 50}]})
    aioclient_mock.get(f"{API}/schedules/upcoming", json=[{"schedule_id": 4, "rank": 3}])

    await _call(
        hass,
        "create_schedule",
        {"account_id": 1, "label": "Prêt", "start_date": "2026-11-05", "amount": "-300", "mode": "installments", "end_mode": "count", "count": "24"},
    )
    assert _last(aioclient_mock)[2] == {
        "account_id": 1, "label": "Prêt", "start_date": "2026-11-05", "amount": "-300", "mode": "installments", "end_mode": "count", "count": 24,
    }
    grid = [{"rank": "1", "amount": "-150"}, {"rank": 2, "amount": "-150", "date": "2027-09-01"}]
    await _call(hass, "set_schedule_occurrences", {"schedule_id": 4, "items": grid})
    assert _last(aioclient_mock) == (
        "PUT", f"{API}/schedules/4/occurrences", {"items": [{"rank": 1, "amount": "-150"}, {"rank": 2, "amount": "-150", "date": "2027-09-01"}]}
    )
    await _call(hass, "skip_occurrence", {"schedule_id": 4, "rank": 2})
    assert _last(aioclient_mock)[:2] == ("POST", f"{API}/schedules/4/occurrences/2/skip")
    await _call(hass, "restore_occurrence", {"schedule_id": 4, "rank": 2})
    assert _last(aioclient_mock)[:2] == ("DELETE", f"{API}/schedules/4/occurrences/2/skip")
    created = await _call(hass, "generate_occurrence", {"schedule_id": 4, "rank": 3}, return_response=True)
    assert created == {"created": [{"id": 50}]}
    upcoming = await _call(hass, "list_upcoming_occurrences", {"days": 15}, return_response=True)
    assert upcoming == {"items": [{"schedule_id": 4, "rank": 3}]}
    assert str(_last(aioclient_mock)[1]).endswith("/schedules/upcoming?days=15")


async def test_budget_services(hass, aioclient_mock, loaded_entry):
    aioclient_mock.put(f"{API}/budgets/2/lines", json={"budget_id": 2, "months": [], "lines": []})
    aioclient_mock.post(f"{API}/budgets/2/copy", json={"id": 3})
    aioclient_mock.get(f"{API}/budgets/2/report", json={"budget": {"id": 2}, "rows": []})

    lines = [{"category_id": "3", "month": "2027-01", "amount": "300"}]
    await _call(hass, "set_budget_lines", {"budget_id": 2, "lines": lines})
    assert _last(aioclient_mock) == ("PUT", f"{API}/budgets/2/lines", {"lines": [{"category_id": 3, "month": "2027-01", "amount": "300"}]})
    copy = await _call(hass, "copy_budget", {"budget_id": 2, "name": "2027"}, return_response=True)
    assert copy == {"id": 3} and _last(aioclient_mock)[2] == {"name": "2027"}
    report = await _call(hass, "get_budget_report", {"budget_id": 2}, return_response=True)
    assert report == {"budget": {"id": 2}, "rows": []}
    with pytest.raises(Exception):
        await _call(hass, "create_budget", {"account_id": 1, "name": "x", "start_month": "janvier"})


async def test_shared_account_services(hass, aioclient_mock, loaded_entry):
    base = f"{API}/shared-accounts"
    aioclient_mock.post(base, json={"id": 7})
    aioclient_mock.patch(f"{base}/7", json={"id": 7, "closed": True})
    aioclient_mock.post(f"{base}/7/expenses", json={"id": 7})
    aioclient_mock.patch(f"{base}/7/expenses/3", json={"id": 7})
    aioclient_mock.delete(f"{base}/7/expenses/3", status=200, json={"id": 7})
    aioclient_mock.post(f"{base}/7/participants", json={"id": 7})
    aioclient_mock.patch(f"{base}/7/participants/2", json={"id": 7})
    aioclient_mock.delete(f"{base}/7/participants/2", status=200, json={"id": 7})
    aioclient_mock.get(f"{base}/7", json={"id": 7, "expenses": []})
    aioclient_mock.get(base, json=[{"id": 7}])

    assert await _call(hass, "create_shared_account", {"name": "Vacances", "participants": ["Alice", "Bruno"]}, return_response=True) == {"id": 7}
    assert _last(aioclient_mock) == ("POST", base, {"name": "Vacances", "participants": ["Alice", "Bruno"]})
    with pytest.raises(Exception):
        await _call(hass, "create_shared_account", {"name": "Seul", "participants": ["Alice"]})
    await _call(hass, "add_shared_expense", {"shared_account_id": 7, "participant_id": "1", "amount": "12,50", "label": "Pain"})
    assert _last(aioclient_mock) == ("POST", f"{base}/7/expenses", {"participant_id": 1, "amount": "12,50", "label": "Pain"})
    await _call(hass, "update_shared_expense", {"shared_account_id": 7, "expense_id": 3, "amount": "13"})
    assert _last(aioclient_mock) == ("PATCH", f"{base}/7/expenses/3", {"amount": "13"})
    await _call(hass, "delete_shared_expense", {"shared_account_id": 7, "expense_id": 3})
    assert _last(aioclient_mock)[:2] == ("DELETE", f"{base}/7/expenses/3")
    await _call(hass, "add_shared_participant", {"shared_account_id": 7, "name": "Chloé"})
    assert _last(aioclient_mock) == ("POST", f"{base}/7/participants", {"name": "Chloé"})
    await _call(hass, "rename_shared_participant", {"shared_account_id": 7, "participant_id": 2, "name": "Chloé B."})
    assert _last(aioclient_mock) == ("PATCH", f"{base}/7/participants/2", {"name": "Chloé B."})
    await _call(hass, "remove_shared_participant", {"shared_account_id": 7, "participant_id": 2})
    assert _last(aioclient_mock)[:2] == ("DELETE", f"{base}/7/participants/2")
    await _call(hass, "update_shared_account", {"shared_account_id": 7, "closed": True})
    assert _last(aioclient_mock) == ("PATCH", f"{base}/7", {"closed": True})
    assert await _call(hass, "get_shared_account", {"shared_account_id": 7}, return_response=True) == {"id": 7, "expenses": []}
    assert await _call(hass, "list_shared_accounts", {}, return_response=True) == {"items": [{"id": 7}]}


async def test_move_services(hass, aioclient_mock, loaded_entry):
    aioclient_mock.post(f"{API}/categories/3/move", json={"transactions": 150, "schedules": 1})
    aioclient_mock.post(f"{API}/accounts/4/move", json={"transactions": 2, "schedules": 0})
    result = await _call(hass, "move_category", {"category_id": "3", "target_id": "8"}, return_response=True)
    assert result == {"transactions": 150, "schedules": 1}
    assert _last(aioclient_mock) == ("POST", f"{API}/categories/3/move", {"target_id": 8})
    await _call(hass, "move_account", {"account_id": 4, "target_id": 1, "include_reconciled": True})
    assert _last(aioclient_mock) == ("POST", f"{API}/accounts/4/move", {"target_id": 1, "include_reconciled": True})
