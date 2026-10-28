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


async def test_transaction_id_must_be_an_integer(hass, aioclient_mock, loaded_entry, hass_client) -> None:
    """aiohttp decodes %2F and %3F in the parameter (HA's security filter already stops `..%2F`)."""
    client = await hass_client()
    for raw in ("..%2F..%2Faccounts%3Fx%3D", "1%3Fx%3D", "1%2Fstate", "abc", "-1"):
        resp = await client.get(f"/api/my_bank/attachment/{raw}")
        assert resp.status in (400, 404), raw
    assert not [call for call in aioclient_mock.mock_calls if "attachment" in str(call[1]) or "accounts?x" in str(call[1])]


async def test_active_content_is_downloaded(hass, aioclient_mock, loaded_entry, hass_client) -> None:
    """Served on Home Assistant's origin: HTML or SVG would run script with the user's session (older APIs)."""
    for content_type in ("text/html", "image/svg+xml"):
        aioclient_mock.clear_requests()
        aioclient_mock.get(
            f"{API}/transactions/1/attachment/content",
            content=b"<script>alert(1)</script>",
            headers={"Content-Type": content_type, "Content-Disposition": 'inline; filename="x.html"'},
        )
        client = await hass_client()
        resp = await client.get("/api/my_bank/attachment/1")
        assert resp.status == 200
        assert resp.headers["Content-Type"].startswith("application/octet-stream"), content_type
        assert resp.headers["Content-Disposition"] == 'attachment; filename="x.html"'
        assert resp.headers["X-Content-Type-Options"] == "nosniff"
        assert resp.headers["Content-Security-Policy"].startswith("sandbox")


async def test_image_is_shown_inline_in_a_sandbox(hass, aioclient_mock, loaded_entry, hass_client) -> None:
    aioclient_mock.get(
        f"{API}/transactions/1/attachment/content",
        content=b"\xff\xd8 fake",
        headers={"Content-Type": "image/jpeg", "Content-Disposition": 'inline; filename="photo.jpg"'},
    )
    client = await hass_client()
    resp = await client.get("/api/my_bank/attachment/1")
    assert resp.headers["Content-Type"].startswith("image/jpeg")
    assert resp.headers["Content-Disposition"] == 'inline; filename="photo.jpg"'
    assert resp.headers["Content-Security-Policy"].startswith("sandbox")


async def test_user_without_access_is_refused_with_403(hass, aioclient_mock, loaded_entry, hass_client, hass_read_only_access_token) -> None:
    """403, not 401: Home Assistant counts every 401 as a failed login and would end up banning the IP."""
    hass.config_entries.async_update_entry(
        loaded_entry, options={"default_access": "none", "access": {}, "ending_sensor": False, "balance_sensors": []}
    )
    client = await hass_client(hass_read_only_access_token)
    resp = await client.get("/api/my_bank/attachment/1")
    assert resp.status == 403
    assert not [call for call in aioclient_mock.mock_calls if "attachment" in str(call[1])]


async def test_read_access_opens_attachments(hass, aioclient_mock, loaded_entry, hass_client, hass_read_only_access_token) -> None:
    """Reading an attachment is reading: a user with read access may (entry older than 0.16.0: everyone could read)."""
    aioclient_mock.get(
        f"{API}/transactions/1/attachment/content",
        content=b"%PDF-1.4 fake",
        headers={"Content-Type": "application/pdf", "Content-Disposition": 'inline; filename="facture.pdf"'},
    )
    client = await hass_client(hass_read_only_access_token)
    resp = await client.get("/api/my_bank/attachment/1")
    assert resp.status == 200
