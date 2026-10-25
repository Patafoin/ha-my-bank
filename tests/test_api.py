"""Tests for the generic MyBankClient REST helper."""
from __future__ import annotations

import pytest

from custom_components.my_bank.api import MyBankApiError, MyBankAuthError, MyBankClient

from .conftest import API, API_URL, TOKEN


@pytest.fixture
def client(hass):
    return MyBankClient(hass, API_URL + "/", TOKEN)


async def test_get_sends_bearer_token_and_params(hass, aioclient_mock, client):
    aioclient_mock.get(f"{API}/payees", json=[{"id": 1}])

    assert await client.get("payees", params=[("q", "lec")]) == [{"id": 1}]
    method, url, _data, headers = aioclient_mock.mock_calls[0]
    assert method == "GET"
    assert url.query["q"] == "lec"
    assert headers["Authorization"] == f"Bearer {TOKEN}"


async def test_post_patch_delete(hass, aioclient_mock, client):
    aioclient_mock.post(f"{API}/categories", json={"id": 3})
    aioclient_mock.patch(f"{API}/categories/3", json={"id": 3, "name": "Courses"})
    aioclient_mock.delete(f"{API}/categories/3", status=204)

    assert (await client.post("categories", {"name": "A"}))["id"] == 3
    assert (await client.patch("categories/3", {"name": "Courses"}))["name"] == "Courses"
    assert await client.delete("categories/3") is None
    assert aioclient_mock.mock_calls[0][2] == {"name": "A"}


async def test_401_raises_auth_error(hass, aioclient_mock, client):
    aioclient_mock.get(f"{API}/accounts", status=401, json={"detail": "jeton invalide"})
    with pytest.raises(MyBankAuthError):
        await client.get("accounts")


async def test_error_detail_is_readable(hass, aioclient_mock, client):
    aioclient_mock.patch(f"{API}/transactions/1", status=409, json={"detail": "Opération rapprochée : …"})
    with pytest.raises(MyBankApiError, match="Opération rapprochée"):
        await client.patch("transactions/1", {"amount": "1"})


async def test_validation_errors_are_joined(hass, aioclient_mock, client):
    aioclient_mock.post(
        f"{API}/transactions",
        status=422,
        json={"detail": [{"loc": ["body", "amount"], "msg": "deux décimales au maximum"}]},
    )
    with pytest.raises(MyBankApiError, match="amount : deux décimales au maximum"):
        await client.post("transactions", {})


async def test_connection_error(hass, aioclient_mock, client):
    aioclient_mock.get(f"{API}/accounts", exc=TimeoutError())
    with pytest.raises(MyBankApiError, match="unreachable"):
        await client.get("accounts")


async def test_get_raw_returns_content_type_and_filename(hass, aioclient_mock, client):
    aioclient_mock.get(
        f"{API}/transactions/1/attachment/content",
        content=b"%PDF-1.4 fake",
        headers={"Content-Type": "application/pdf", "Content-Disposition": 'inline; filename="facture.pdf"'},
    )
    content, content_type, disposition = await client.get_raw("transactions/1/attachment/content")
    assert content == b"%PDF-1.4 fake"
    assert content_type == "application/pdf"
    assert disposition == 'inline; filename="facture.pdf"'


async def test_get_raw_404(hass, aioclient_mock, client):
    aioclient_mock.get(f"{API}/transactions/1/attachment/content", status=404, json={"detail": "Justificatif 1 introuvable"})
    with pytest.raises(MyBankApiError, match="Justificatif"):
        await client.get_raw("transactions/1/attachment/content")
