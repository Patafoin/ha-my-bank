"""Tests for the attachment content proxy view (decision 023): the browser never holds the
My Bank API token, only this integration does; the view fetches the bytes on its behalf.
"""
from __future__ import annotations

from homeassistant.setup import async_setup_component

from custom_components.my_bank.const import DOMAIN

from .conftest import API


async def test_serves_file_attachment(hass, aioclient_mock, loaded_entry, hass_client) -> None:
    aioclient_mock.get(
        f"{API}/transactions/1/attachment/content",
        content=b"%PDF-1.4 fake",
        headers={"Content-Type": "application/pdf", "Content-Disposition": 'inline; filename="facture.pdf"'},
    )
    client = await hass_client()
    resp = await client.get("/api/my_bank/attachment/1")
    assert resp.status == 200
    assert await resp.read() == b"%PDF-1.4 fake"
    assert resp.headers["Content-Type"].startswith("application/pdf")
    assert resp.headers["Content-Disposition"] == 'inline; filename="facture.pdf"'


async def test_missing_attachment_is_404(hass, aioclient_mock, loaded_entry, hass_client) -> None:
    aioclient_mock.get(f"{API}/transactions/1/attachment/content", status=404, json={"detail": "Justificatif 1 introuvable"})
    client = await hass_client()
    resp = await client.get("/api/my_bank/attachment/1")
    assert resp.status == 404


async def test_no_loaded_entry_is_503(hass, hass_client) -> None:
    assert await async_setup_component(hass, DOMAIN, {})
    await hass.async_block_till_done()
    client = await hass_client()
    resp = await client.get("/api/my_bank/attachment/1")
    assert resp.status == 503
