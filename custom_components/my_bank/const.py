"""Constants for the My Bank integration."""

DOMAIN = "my_bank"
CONF_TOKEN = "token"
# Option : écritures (services) et justificatifs fichiers réservés aux administrateurs de HA ; activée par défaut.
CONF_ADMIN_ONLY = "admin_only"
DEFAULT_URL = "http://127.0.0.1:9931"
MIN_API_VERSION = "0.8.0"  # oldest My Bank API this version of the integration works with: create/update_account
# now always send `is_default` (0.7.0+) and `currency` (0.8.0+), which an older API's strict schema would reject

# Payment methods created by My Bank API in a new database, renamed in the language of Home Assistant on a fresh
# install (no account yet). Keys are the names the server creates.
DEFAULT_PAYMENT_METHODS = {
    "Carte bancaire": {"en": "Card", "de": "Karte"},
    "Virement": {"en": "Transfer", "de": "Überweisung"},
    "Chèque": {"en": "Cheque", "de": "Scheck"},
    "Prélèvement": {"en": "Direct debit", "de": "Lastschrift"},
    "Versement": {"en": "Deposit", "de": "Einzahlung"},
}
TERM_DAYS = 30  # warn when the last occurrence of a schedule falls within this many days (same as the card)
