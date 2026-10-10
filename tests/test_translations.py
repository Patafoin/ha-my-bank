"""Translations stay complete: HA strings (en/fr/de) and the card dictionary (en/de, French is the source)."""
from __future__ import annotations

import json
from pathlib import Path
import re

import yaml

from homeassistant.helpers.service import _SERVICES_SCHEMA

COMPONENT = Path(__file__).parent.parent / "custom_components" / "my_bank"
PLACEHOLDER = re.compile(r"\{\w+\}")


def _leaves(data: dict, prefix: str = "") -> dict[str, str]:
    out = {}
    for key, value in data.items():
        path = f"{prefix}.{key}" if prefix else key
        if isinstance(value, dict):
            out.update(_leaves(value, path))
        else:
            out[path] = value
    return out


def test_translations_match_strings() -> None:
    source = _leaves(json.loads((COMPONENT / "strings.json").read_text()))
    for lang in ("en", "fr", "de"):
        other = _leaves(json.loads((COMPONENT / "translations" / f"{lang}.json").read_text()))
        assert set(other) == set(source), f"{lang}: {set(source) ^ set(other)}"
        for key, text in source.items():
            assert set(PLACEHOLDER.findall(other[key])) == set(PLACEHOLDER.findall(text)), f"{lang}: {key}"


def test_every_service_and_field_is_translated() -> None:
    services = yaml.safe_load((COMPONENT / "services.yaml").read_text())
    _SERVICES_SCHEMA(services)
    strings = json.loads((COMPONENT / "strings.json").read_text())
    for service, spec in services.items():
        entry = strings["services"][service]
        assert entry["name"] and entry["description"]
        for field, field_spec in (spec or {}).get("fields", {}).items():
            assert entry["fields"][field]["name"] and entry["fields"][field]["description"]
            key = field_spec.get("selector", {}).get("select", {}).get("translation_key")
            if key:
                assert set(strings["selector"][key]["options"]) == set(field_spec["selector"]["select"]["options"])


def test_card_texts_have_english_and_german() -> None:
    card = (COMPONENT / "www" / "my-bank-card.js").read_text()
    block = re.search(r"const I18N = (\{.*?\n\});", card, re.S).group(1)
    dictionaries = json.loads(re.sub(r",(\s*[}\]])", r"\1", re.sub(r"^(\s*)(en|de):", r'\1"\2":', block, flags=re.M)))
    keys = {json.loads(m) for m in re.findall(r'\bt\(\s*("(?:[^"\\]|\\.)*")', card)}
    for lang in ("en", "de"):
        missing = sorted(k for k in keys if k not in dictionaries[lang])
        assert not missing, f"{lang}: {missing}"
        for key, text in dictionaries[lang].items():
            assert set(PLACEHOLDER.findall(text)) == set(PLACEHOLDER.findall(key.split("|")[0])), f"{lang}: {key}"
