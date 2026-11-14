"""Constants for the My Bank integration."""

DOMAIN = "my_bank"
CONF_TOKEN = "token"
# Avant 0.16.0 : écritures (services) et justificatifs fichiers réservés aux administrateurs de HA ; activée par
# défaut. Encore lue pour les entrées dont les options n'ont pas été réenregistrées depuis (voir access.py).
CONF_ADMIN_ONLY = "admin_only"
# Depuis 0.16.0 : niveau d'accès (none/read/write) par utilisateur non administrateur, niveau des autres
# (comptes créés plus tard), capteurs publiés.
CONF_ACCESS = "access"
CONF_DEFAULT_ACCESS = "default_access"
CONF_ENDING_SENSOR = "ending_sensor"
CONF_BALANCE_SENSORS = "balance_sensors"
DEFAULT_URL = "http://127.0.0.1:9931"
MIN_API_VERSION = "0.11.0"  # oldest My Bank API this version of the integration works with: the card always sends
# `due_date` (0.10.0+) on a transaction, `due_days` and `use_global_lead_days` (0.11.0+) on a schedule, and calls
# `schedules/settings` (0.11.0+) — all rejected (or missing) on an older API's strict schema

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
# Payment due dates (decision 027): an unpaid transaction (not pointed) is flagged in orange from this many days before
# its due date, in red once the due date has passed. Option of the entry.
CONF_DUE_WARNING_DAYS = "due_warning_days"
DEFAULT_DUE_WARNING_DAYS = 7
