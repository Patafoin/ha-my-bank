# My Bank for Home Assistant

🇫🇷 [Lire en français](https://github.com/Patafoin/ha-my-bank/blob/main/README.fr.md) · 🇩🇪 [Auf Deutsch lesen](https://github.com/Patafoin/ha-my-bank/blob/main/README.de.md) · 🇪🇸 [Leer en español](https://github.com/Patafoin/ha-my-bank/blob/main/README.es.md)

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://hacs.xyz/)
[![Validate](https://github.com/Patafoin/ha-my-bank/actions/workflows/validate.yml/badge.svg)](https://github.com/Patafoin/ha-my-bank/actions/workflows/validate.yml)
[![Tests](https://github.com/Patafoin/ha-my-bank/actions/workflows/tests.yml/badge.svg)](https://github.com/Patafoin/ha-my-bank/actions/workflows/tests.yml)

Personal bookkeeping in Home Assistant, the way desktop money managers do it: accounts with three balances, cleared and reconciled transactions, splits, transfers, hierarchical categories, scheduled transactions, budgets, and shared expenses between friends — from a dashboard card, on your phone, anywhere.

![Dashboard](https://raw.githubusercontent.com/Patafoin/ha-my-bank/main/docs/images/card-dashboard.png)

💬 Questions, feedback, ideas: [discussion on the Home Assistant Community forum](https://community.home-assistant.io/t/my-bank-personal-bookkeeping-in-home-assistant-accounts-budgets-charts-scheduled-shared-expenses-100-local/1029114).

> The integration and card UI are available in **English, French, German and Spanish**, following the Home Assistant language. My Bank API server messages are translated separately in its repository; Spanish server-message translations are not included here.

## How it works

My Bank comes in two parts:

| Part | What it is | How to install |
|---|---|---|
| **My Bank API** | The server: stores your data in a local SQLite database, computes balances and budgets, generates scheduled transactions, backs itself up every night | Home Assistant **app** (formerly *add-on*; Home Assistant OS / Supervised), or a **Docker** container |
| **My Bank** (this repository) | The integration and its Lovelace cards: sensors, services, and the user interface | **HACS** |

The integration is a thin client: every rule (balances, locking of reconciled transactions, budget computations…) lives in the server. Your data never leaves your network.

## Requirements

- Home Assistant **2026.2 or later**, and [HACS](https://hacs.xyz/) to install the integration. Tested on 2026.2.3 and 2026.10.0.
- For the server, either:
  - **Home Assistant OS** or a **Supervised** installation, on a 64-bit system (amd64 or aarch64, e.g. Raspberry Pi 4/5 with the 64-bit image), to use the app — tested on Home Assistant OS 18.3;
  - or **Docker** on any 64-bit machine of your network (amd64 or arm64), for Home Assistant Container / Core installations.

## Installation

### 1. The server

**Home Assistant OS / Supervised — app (recommended)**

[![Add the app repository to your Home Assistant.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FPatafoin%2Fha-addons)

Or by hand: Settings → **Apps** → **Install app** → ⋮ → **Repositories**, add `https://github.com/Patafoin/ha-addons`. Then install **My Bank API** and start it. That's all: the app creates an access token for Home Assistant and announces itself.

> Home Assistant versions before the renaming call apps **add-ons** (Settings → Add-ons → Add-on store).

**Home Assistant Container / Core — Docker**

First generate the access token, a long random string Home Assistant will use to talk to the server:

```bash
openssl rand -hex 32
# or: python3 -c "import secrets; print(secrets.token_urlsafe(32))"
```

Put it in `MYBANK_API_TOKEN` below, and keep it: you will enter it in Home Assistant at step 3.

```yaml
# compose.yaml
services:
  my-bank-api:
    image: ghcr.io/patafoin/my-bank-api:latest
    container_name: my-bank-api
    restart: unless-stopped
    ports:
      - "9931:8000"
    volumes:
      - ./data:/data
      - ./backups:/backups
    environment:
      TZ: Europe/Paris
      MYBANK_API_TOKEN: "paste-the-generated-token-here"
```

```bash
docker compose up -d
curl http://localhost:9931/api/v1/health   # the server answers
```

The token is stored hashed in the database. Change the variable and restart to replace it; remove it to revoke it. If you prefer not to keep the token in `compose.yaml`, leave `MYBANK_API_TOKEN` out and create one in the container instead: `docker exec my-bank-api my-bank token create ha` (shown only once).

If Home Assistant runs on the same host with `network_mode: host`, publish the port on the loopback interface only (`"127.0.0.1:9931:8000"`) and use `http://127.0.0.1:9931` at step 3: the server is then out of reach of the rest of your network. The interactive API documentation (`/docs`) is off by default; add `MYBANK_DOCS: "true"` to browse it.

See the [My Bank API README](https://github.com/Patafoin/my-bank-api) for all settings.

### 2. The integration

[![Open this repository in HACS.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=Patafoin&repository=ha-my-bank&category=integration)

In HACS: ⋮ → **Custom repositories** → `https://github.com/Patafoin/ha-my-bank`, type **Integration**. Download **My Bank**, then restart Home Assistant.

### 3. Connect them

- **With the app**: Settings → Devices & services shows **My Bank** as discovered. Click **Configure** → **Submit**.
- **With Docker**: Settings → Devices & services → **Add integration** → **My Bank**, then enter the server URL (e.g. `http://192.168.1.10:9931`) and the token generated in step 1.

![Setup](https://raw.githubusercontent.com/Patafoin/ha-my-bank/main/docs/images/config-flow.png)

### 4. Add the card

The card is registered automatically (no resource to add). Edit a dashboard → **Add card** → **My Bank**.

If the cards don't show up in the picker after installing or updating, force-reload the page (Ctrl+F5) or clear the cache of the Companion app. The custom cards are at the bottom of the picker, or search for "bank".

## The cards

### `custom:my-bank-card` — everything, one tab per subject

| Tab (`sections` key) | Content |
|---|---|
| `dashboard` | Balances of every account, budget of the current month |
| `transactions` | Transactions of an account with running balance; filters (savable as default); add, edit, split, transfer; clear (☐/☑) and reconcile (🔓/🔒) in one click; a reconciliation helper highlights the transaction that explains a balance gap; attach a receipt (a link, or a file kept by the server) to a transaction, opened in one click (📎) |
| `accounts` | Accounts (checking, savings, card, cash…), currency, opening balance, closing, one default account |
| `categories` / `tags` | Category tree (income / expense / savings) and classes, a second axis for analysis — see [Categories and classes](#categories-and-classes) |
| `payees` | Payees with default category |
| `budgets` | Monthly budget per account: planned vs actual, variance, copy from a previous budget |
| `recurrences` | Scheduled transactions (periodic or instalment plans), upcoming occurrences, automatic generation |
| `shares` | Shared expenses of a group (holidays…): who pays next, who owes whom at the end |
| `help` | In-app help: getting started, clearing vs reconciling (with a worked example), concepts, categories vs classes, schedules, budgets, shared expenses |

```yaml
type: custom:my-bank-card
sections:        # optional: omit to show every tab
  - dashboard
  - transactions
```

Give each card instance its own `sections` to build an operations-only view, a settings view, etc.

| Transactions | Budgets |
|---|---|
| ![Transactions](https://raw.githubusercontent.com/Patafoin/ha-my-bank/main/docs/images/card-transactions.png) | ![Budgets](https://raw.githubusercontent.com/Patafoin/ha-my-bank/main/docs/images/card-budgets.png) |

| Scheduled transactions | Shared expenses |
|---|---|
| ![Scheduled transactions](https://raw.githubusercontent.com/Patafoin/ha-my-bank/main/docs/images/card-schedules.png) | ![Shared expenses](https://raw.githubusercontent.com/Patafoin/ha-my-bank/main/docs/images/card-shares.png) |

### Small cards for a phone dashboard

<img src="https://raw.githubusercontent.com/Patafoin/ha-my-bank/main/docs/images/mobile-cards.png" alt="Phone dashboard" width="320" align="right">

| Card | Options |
|---|---|
| `custom:my-bank-balance-card` | `account_id` — the three balances of one account |
| `custom:my-bank-entry-card` | `account_id`, `fields` — quick entry, pre-filled from the payee; an "All fields" button shows the hidden fields |
| `custom:my-bank-budget-card` | `budget_id`, `levels`, `period` (`month`, `cumul`, `all`), `collapse_level` |
| `custom:my-bank-budget-trend-card` | `budget_id`, `period` (`12months`, `6months`, `year`, `last_year`, `budget`), `kinds` (`income`, `expense`, `savings`) — budget adherence month by month (actual / planned in %, one line per type, 100 % dashed); months outside the chosen budget come from another budget of the same account |
| `custom:my-bank-balance-history-card` | `account_ids`, `period` — balance history (line chart) of one or more accounts, same currency; one card = one chart, compose several cards to separate accounts of different scale or currency |
| `custom:my-bank-upcoming-charge-card` | `account_ids`, `horizon` — upcoming entered transactions (dated after today) and occurrences not yet entered (same green / red, lighter), by week or by month depending on the horizon; income above the axis, expenses below, label = balance of the period |
| `custom:my-bank-category-spending-card` | `account_ids`, `period` — spending by category (bars), the highest amount is 100 % |
| `custom:my-bank-share-card` | — shared expenses |
| `custom:my-bank-transactions-card` | — the main card's Transactions tab on its own (same code) |

All cards have a visual editor.

<br clear="right">

**Chart cards** — balance history, budget adherence, upcoming transactions and occurrences, expenses by category:

![Chart cards](https://raw.githubusercontent.com/Patafoin/ha-my-bank/main/docs/images/chart-cards.png)

## Categories and classes

My Bank offers two ways to classify a transaction: the **category** and the **class**. They do not play the same role.

**The category: what the money was for — use it first.** It answers "what was this spent on (or received for)?": Groceries, Housing, Fuel… Everything is built around it:
- **budgets** (planned vs actual per category),
- the **spending by category** card,
- the income / expense / savings tree, with its subcategories,
- the **default category** of payees, which pre-fills the entry form.

A transaction without a category shows up in none of these.

**The class: an optional extra axis, for analysis.** It answers another question: "for whom, or for what?". It is there for analytics: grouping transactions from different categories, or splitting one category. Classes have no budget; you mostly use them by filtering the transaction list, which then shows the total.

**Example: two cars**

| Transaction | Category | Class |
|---|---|---|
| Fill-up, 60 € | Fuel | Vehicle A |
| Fill-up, 45 € | Fuel | Vehicle B |
| Service, 180 € | Vehicle maintenance | Vehicle A |

- The **Fuel** category puts the 105 € of fuel in the budget and in the spending card, whichever the car.
- The **Vehicle A** class tells you what that car costs (240 €, fuel and maintenance included): filter the transaction list on this class. With Category = Fuel and Class = Vehicle A, you get the fuel of that car only.

Avoid setting only the class, without a category: the per-car analysis would still work, but these expenses would vanish from the budget and from the spending by category card. Avoid also creating "Fuel vehicle A" and "Fuel vehicle B" categories: that multiplies budget lines for information the class already gives.

**In short**: always set the category. Add a class when you want to follow an object, a project or a person across several categories. In a split transaction, each line has its own category and its own class.

## Entities

No sensor is created on a new installation: choose the ones to publish in the integration options (Settings → Devices & services → My Bank → Configure). The state of a sensor can be read by **every** Home Assistant user, whatever their access to My Bank, so publish only what you use in automations or dashboards; the cards don't need any sensor. An account created later is not published until you choose it.

- **One sensor per account**: state = total balance (including future-dated transactions), in the account's own currency; attributes `solde_pointe` (cleared), `solde_rapproche` (reconciled), `account_id`, `kind`, `closed`, `is_default`. Refreshed every 5 minutes and after every change.
- **Scheduled transactions ending** (`sensor.scheduled_transactions_ending` on an English installation; the entity ID follows the language of Home Assistant when the integration is added): number of scheduled transactions whose last occurrence falls within 30 days, with the list in attributes — handy for a notification automation.

## Services

Every object can be created, modified or deleted from automations and scripts: `my_bank.create_transaction`, `create_transfer`, `set_transaction_state`, `create_schedule`, `set_budget_lines`, `add_shared_expense`… (50+ services, see **Developer tools → Actions**). Read services (`list_accounts`, `search_transactions`, `get_budget_report`…) return data with `response_variable`.

```yaml
action: my_bank.create_transaction
data:
  account_id: 1
  date: "2026-10-09"
  amount: "-12.50"
  payee_name: Bakery
  category_id: 5
```

## Languages

The integration UI (setup, services and repairs) and cards follow the Home Assistant language: English, French, German or Spanish (English for any other language). My Bank API server messages are translated separately in the server repository; Spanish server-message translations are not included here. On a fresh install, the server's default payment methods are renamed according to the languages supported by My Bank API.

## Updating

Update the integration with HACS and the server from Settings → Apps (or `docker compose pull`). If the server is older than the integration needs, Home Assistant raises a repair issue telling you so.

## Importing from MS Comptes Bancaires

The server imports the QIF and payee CSV exports of MS Comptes Bancaires — see the [My Bank API README](https://github.com/Patafoin/my-bank-api).

## Security

Keep My Bank API on your local network. Never expose it to the Internet: remote access goes through Home Assistant, which already handles authentication.

Access to My Bank is set **per Home Assistant user** in the integration options (Settings → Devices & services → My Bank → Configure): for each user who is not an administrator, **No access**, **Read only** or **Read and write**, plus a level for users created later. Without access, the cards show a message instead of the data; read access also opens file attachments. On a new installation, non-admin users have no access. Administrators always have full access (they can change the options anyway), and automations and scripts started by Home Assistant are not restricted.

Sensors are the exception: Home Assistant gives the state of every entity to every logged-in user. See [Entities](#entities): publish only the sensors you need.

## Translations

Adding or fixing a language is welcome:

- Home Assistant texts (setup, services, repairs): `custom_components/my_bank/translations/<lang>.json`, with `strings.json` as the English source.
- Cards: the `I18N` dictionary at the end of `custom_components/my_bank/www/my-bank-card.js`, keyed by the French text of the card.
- Server messages: `src/my_bank_api/i18n_messages.py` in [my-bank-api](https://github.com/Patafoin/my-bank-api).

Tests check the Home Assistant translations against every source key and placeholder, and verify complete English, German and Spanish card dictionaries.

## License

MIT
