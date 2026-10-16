# My Bank pour Home Assistant

🇬🇧 [Read in English](https://github.com/Patafoin/ha-my-bank/blob/main/README.md)

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://hacs.xyz/)
[![Validate](https://github.com/Patafoin/ha-my-bank/actions/workflows/validate.yml/badge.svg)](https://github.com/Patafoin/ha-my-bank/actions/workflows/validate.yml)
[![Tests](https://github.com/Patafoin/ha-my-bank/actions/workflows/tests.yml/badge.svg)](https://github.com/Patafoin/ha-my-bank/actions/workflows/tests.yml)

La gestion de vos comptes personnels dans Home Assistant, à la manière des logiciels de comptes sur ordinateur : comptes avec trois soldes, opérations pointées et rapprochées, ventilations, virements, catégories hiérarchiques, opérations planifiées, budgets et dépenses partagées entre amis — depuis une carte de tableau de bord, sur votre téléphone, partout.

![Tableau de bord](docs/images/card-dashboard.png)

> Disponible en **anglais, français et allemand** (cartes, services, configuration, messages du serveur), selon la langue de Home Assistant.

## Fonctionnement

My Bank se compose de deux parties :

| Partie | Ce que c'est | Installation |
|---|---|---|
| **My Bank API** | Le serveur : stocke vos données dans une base SQLite locale, calcule les soldes et les budgets, génère les opérations planifiées, se sauvegarde chaque nuit | **Application** Home Assistant (anciennement *add-on* ou module complémentaire ; Home Assistant OS / Supervised), ou conteneur **Docker** |
| **My Bank** (ce dépôt) | L'intégration et ses cartes Lovelace : capteurs, services et interface utilisateur | **HACS** |

L'intégration est un client léger : toutes les règles (soldes, verrouillage des opérations rapprochées, calculs de budget…) sont dans le serveur. Vos données ne quittent jamais votre réseau.

## Prérequis

- Home Assistant **2026.2 ou plus récent**, et [HACS](https://hacs.xyz/) pour installer l'intégration. Testé sur 2026.2.3 et 2026.10.0.
- Pour le serveur, au choix :
  - **Home Assistant OS** ou une installation **Supervised**, sur un système 64 bits (amd64 ou aarch64, par ex. Raspberry Pi 4/5 avec l'image 64 bits), pour utiliser l'application — testé sur Home Assistant OS 18.3 ;
  - ou **Docker** sur n'importe quelle machine 64 bits de votre réseau (amd64 ou arm64), pour les installations Home Assistant Container / Core.

## Installation

### 1. Le serveur

**Home Assistant OS / Supervised — application (recommandé)**

[![Ajouter le dépôt d'applications à votre Home Assistant.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FPatafoin%2Fha-addons)

Ou à la main : Paramètres → **Applications** → **Installer une application** → ⋮ → **Dépôts**, ajoutez `https://github.com/Patafoin/ha-addons`. Installez ensuite **My Bank API** et démarrez-la. C'est tout : l'application crée un jeton d'accès pour Home Assistant et s'annonce d'elle-même.

> Les versions de Home Assistant antérieures au changement de nom appellent les applications **modules complémentaires** (add-ons) : Paramètres → Modules complémentaires → Boutique.

**Home Assistant Container / Core — Docker**

Générez d'abord le jeton d'accès, une longue chaîne aléatoire que Home Assistant utilisera pour parler au serveur :

```bash
openssl rand -hex 32
# ou : python3 -c "import secrets; print(secrets.token_urlsafe(32))"
```

Mettez-le dans `MYBANK_API_TOKEN` ci-dessous, et gardez-le : vous le saisirez dans Home Assistant à l'étape 3.

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
      MYBANK_API_TOKEN: "collez-ici-le-jeton-genere"
```

```bash
docker compose up -d
curl http://localhost:9931/api/v1/health   # le serveur répond
```

Le jeton est stocké haché dans la base. Modifiez la variable et redémarrez pour le remplacer ; retirez-la pour le révoquer. Si vous préférez ne pas garder le jeton dans `compose.yaml`, laissez `MYBANK_API_TOKEN` de côté et créez-en un dans le conteneur : `docker exec my-bank-api my-bank token create ha` (affiché une seule fois).

Tous les réglages sont décrits dans le [README de My Bank API](https://github.com/Patafoin/my-bank-api/blob/main/README.fr.md).

### 2. L'intégration

[![Ouvrir ce dépôt dans HACS.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=Patafoin&repository=ha-my-bank&category=integration)

Dans HACS : ⋮ → **Dépôts personnalisés** → `https://github.com/Patafoin/ha-my-bank`, type **Intégration**. Téléchargez **My Bank**, puis redémarrez Home Assistant.

### 3. Les relier

- **Avec l'application** : Paramètres → Appareils et services affiche **My Bank** comme découvert. Cliquez sur **Configurer** → **Valider**.
- **Avec Docker** : Paramètres → Appareils et services → **Ajouter une intégration** → **My Bank**, puis saisissez l'URL du serveur (par ex. `http://192.168.1.10:9931`) et le jeton généré à l'étape 1.

![Configuration](docs/images/config-flow.png)

### 4. Ajouter la carte

La carte est enregistrée automatiquement (aucune ressource à ajouter). Modifiez un tableau de bord → **Ajouter une carte** → **My Bank**.

Si les cartes n'apparaissent pas dans le sélecteur après une installation ou une mise à jour, rechargez la page sans cache (Ctrl+F5) ou videz le cache de l'application Companion. Les cartes personnalisées sont en bas du sélecteur, ou cherchez « bank ».

## Les cartes

### `custom:my-bank-card` — tout, un onglet par sujet

| Onglet (clé `sections`) | Contenu |
|---|---|
| `dashboard` | Soldes de tous les comptes, budget du mois en cours |
| `transactions` | Opérations d'un compte avec solde progressif ; filtres ; ajout, modification, ventilation, virement ; pointage (☐/☑) et rapprochement (🔓/🔒) en un clic |
| `accounts` | Comptes (courant, épargne, carte, espèces…), solde initial, clôture |
| `categories` / `tags` | Arborescence des catégories (recettes / dépenses / épargne) et un second axe de classement libre |
| `payees` | Tiers avec catégorie par défaut |
| `budgets` | Budget mensuel par compte : prévu / réalisé, écart, copie d'un budget précédent |
| `recurrences` | Opérations planifiées (périodiques ou échéanciers), prochaines échéances, génération automatique |
| `shares` | Dépenses partagées d'un groupe (vacances…) : qui paie la prochaine fois, qui doit combien à qui à la fin |

```yaml
type: custom:my-bank-card
sections:        # facultatif : sans cette clé, tous les onglets sont affichés
  - dashboard
  - transactions
```

Donnez à chaque instance de la carte ses propres `sections` pour composer une vue dédiée à la saisie, une vue de paramétrage, etc.

| Opérations | Budgets |
|---|---|
| ![Opérations](docs/images/card-transactions.png) | ![Budgets](docs/images/card-budgets.png) |

| Opérations planifiées | Dépenses partagées |
|---|---|
| ![Opérations planifiées](docs/images/card-schedules.png) | ![Dépenses partagées](docs/images/card-shares.png) |

### Petites cartes pour un tableau de bord sur téléphone

<img src="docs/images/mobile-cards.png" alt="Tableau de bord sur téléphone" width="320" align="right">

| Carte | Options |
|---|---|
| `custom:my-bank-balance-card` | `account_id` — les trois soldes d'un compte |
| `custom:my-bank-entry-card` | `account_id`, `fields` — saisie rapide, pré-remplie à partir du tiers ; bouton « Tous les champs » pour afficher les champs masqués |
| `custom:my-bank-budget-card` | `budget_id`, `levels`, `period` (`month`, `cumul`, `all`) |
| `custom:my-bank-balance-history-card` | `account_ids`, `period` — évolution du solde (courbe) d'un ou plusieurs comptes ; une carte = un graphique, composer plusieurs cartes pour séparer des comptes d'échelles différentes |
| `custom:my-bank-upcoming-charge-card` | `account_ids`, `horizon` — montant des échéances à venir, par semaine ou par mois selon l'horizon |
| `custom:my-bank-category-spending-card` | `account_ids`, `period` — dépenses par rubrique (barres), le montant le plus élevé fait 100 % |
| `custom:my-bank-share-card` | — dépenses partagées |

Toutes les cartes disposent d'un éditeur visuel.

<br clear="right">

## Entités

- **Un capteur par compte** : état = solde total (y compris les opérations à date future) ; attributs `solde_pointe` (pointé), `solde_rapproche` (rapproché), `account_id`, `kind`, `iban`, `closed`. Rafraîchi toutes les 5 minutes et après chaque modification.
- **Planifications arrivant à terme** (`sensor.planifications_arrivant_a_terme` sur une installation en français ; l'identifiant suit la langue de Home Assistant au moment de l'ajout de l'intégration) : nombre d'opérations planifiées dont la dernière échéance tombe dans les 30 jours, avec la liste en attributs — pratique pour une automatisation de notification.

## Services

Chaque objet peut être créé, modifié ou supprimé depuis les automatisations et les scripts : `my_bank.create_transaction`, `create_transfer`, `set_transaction_state`, `create_schedule`, `set_budget_lines`, `add_shared_expense`… (plus de 50 services, voir **Outils de développement → Actions**). Les services de lecture (`list_accounts`, `search_transactions`, `get_budget_report`…) renvoient des données via `response_variable`.

```yaml
action: my_bank.create_transaction
data:
  account_id: 1
  date: "2026-10-09"
  amount: "-12.50"
  payee_name: Boulangerie
  category_id: 5
```

## Langues

Les cartes, les fenêtres de configuration, les services et les messages d'erreur du serveur suivent la langue de Home Assistant : anglais, français ou allemand (anglais pour toute autre langue). Sur une installation neuve, les moyens de paiement créés par défaut par le serveur sont renommés dans cette langue.

## Mise à jour

Mettez à jour l'intégration avec HACS et le serveur depuis Paramètres → Applications (ou `docker compose pull`). Si le serveur est trop ancien pour l'intégration, Home Assistant le signale par une notification de réparation.

## Import depuis MS Comptes Bancaires

Le serveur importe les exports QIF et le CSV des tiers de MS Comptes Bancaires — voir le [README de My Bank API](https://github.com/Patafoin/my-bank-api/blob/main/README.fr.md).

## Sécurité

Gardez My Bank API sur votre réseau local. Ne l'exposez jamais sur Internet : l'accès à distance passe par Home Assistant, qui gère déjà l'authentification.

## Traductions

Ajouter ou corriger une langue est bienvenu :

- Textes de Home Assistant (configuration, services, réparations) : `custom_components/my_bank/translations/<langue>.json`, avec `strings.json` comme source anglaise.
- Cartes : le dictionnaire `I18N` à la fin de `custom_components/my_bank/www/my-bank-card.js`, indexé par le texte français de la carte.
- Messages du serveur : `src/my_bank_api/i18n_messages.py` dans [my-bank-api](https://github.com/Patafoin/my-bank-api).

Les tests vérifient que chaque texte a une version anglaise et une version allemande, avec les mêmes `{paramètres}`.

## Licence

MIT
