/**
 * My Bank card — thin UI over the my_bank services, which relay My Bank API.
 * No business rule here (balances, transfer legs, locking of reconciled
 * transactions, tree rules all live in the API): every read and write is a
 * my_bank.* service call. Configurable per instance via `sections`.
 */

// --- Traduction ---------------------------------------------------------------------------------
// Le texte français sert de clé : t("Comptes") donne « Accounts » en anglais, « Konten » en allemand ; les autres
// langues reçoivent l'anglais. « {nom} » dans un texte est remplacé par vars.nom. Un contexte après « | » distingue deux
// sens d'un même mot (« Saisie|vue ») et n'est jamais affiché. Dictionnaires : I18N, en fin de fichier.
let LANG = "fr";
let LOCALE = "fr-FR";

function setLanguage(hass) {
  const lang = (hass && ((hass.locale && hass.locale.language) || hass.language))
    || document.documentElement.lang || navigator.language || "fr";
  if (lang === LOCALE) return;
  LOCALE = lang;
  LANG = lang.slice(0, 2).toLowerCase();
  NUMBER = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function t(text, vars) {
  const source = text.includes("|") ? text.slice(0, text.indexOf("|")) : text;
  let out = LANG === "fr" ? source : (I18N[LANG] && I18N[LANG][text]) || I18N.en[text] || source;
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return out;
}

// Libellés traduits à la lecture : la langue n'est connue qu'à l'arrivée de `hass`, après le chargement du module.
function translated(map) {
  const out = {};
  for (const [k, v] of Object.entries(map)) Object.defineProperty(out, k, { enumerable: true, get: () => t(v) });
  return out;
}

const SECTION_DEFS = [
  { key: "dashboard", get label() { return t("Tableau de bord"); } },
  { key: "transactions", get label() { return t("Opérations"); } },
  { key: "accounts", get label() { return t("Comptes"); } },
  { key: "categories", get label() { return t("Rubriques"); } },
  { key: "tags", get label() { return t("Classes"); } }, // clé historique conservée pour les cartes déjà configurées
  { key: "payees", get label() { return t("Tiers"); } },
  { key: "budgets", get label() { return t("Budgets"); } },
  { key: "recurrences", get label() { return t("Échéancier"); } },
  { key: "shares", get label() { return t("Partages"); } }, // comptes partagés, indépendants des comptes bancaires
];

const ACCOUNT_KINDS = translated({ checking: "Courant", savings: "Épargne", card: "Carte", cash: "Espèces", other: "Autre" });
const CATEGORY_KINDS = translated({ expense: "Dépense", income: "Recette", savings: "Épargne" });
const KIND_TITLES = translated({ income: "Recettes", expense: "Dépenses", savings: "Épargne" });
const COLLAPSE_KEY = "my-bank-budget-collapsed";
// one : tous les 1 ; many : tous les N ({n}) ; plural : unité d'une durée.
const UNITS = {
  day: translated({ one: "Tous les jours", many: "Tous les {n} jours", plural: "jour(s)" }),
  week: translated({ one: "Toutes les semaines", many: "Toutes les {n} semaines", plural: "semaine(s)" }),
  month: translated({ one: "Tous les mois", many: "Tous les {n} mois", plural: "mois" }),
  quarter: translated({ one: "Tous les trimestres", many: "Tous les {n} trimestres", plural: "trimestre(s)" }),
  year: translated({ one: "Tous les ans", many: "Tous les {n} ans", plural: "an(s)" }),
};
const RANGES = [
  { key: "month", get label() { return t("Mois en cours"); } },
  { key: "3months", get label() { return t("3 derniers mois"); } },
  { key: "12months", get label() { return t("12 derniers mois"); } },
  { key: "year", get label() { return t("Année en cours"); } },
  { key: "custom", get label() { return t("Plage de dates…"); } },
];
const MAX_INSTALLMENTS = 400; // limite de l'API pour un échéancier (plus de 30 ans de mensualités)
const STEP_MONTHS = { month: 1, quarter: 3, year: 12 };
const TERM_DAYS = 30; // prévenir quand la dernière échéance d'une planification tombe dans ce délai (= « À venir (30 jours) »)
const TERM_DISMISS_KEY = "my-bank-term-dismissed";
const TERM_REFRESH_MS = 5 * 60 * 1000;
const NAV_KEY = "myBankCard"; // clé de la carte dans history.state (bouton Retour du navigateur)

// Planifications à durée finie dont la dernière échéance tombe dans les TERM_DAYS jours (ou est en retard) :
// toutes leurs échéances restantes figurent dans les échéances à venir de la période. Triées par date de fin.
function endingSchedules(schedules, upcoming) {
  return schedules
    .filter((s) => s.active && s.remaining > 0)
    .map((s) => {
      const own = upcoming.filter((o) => o.schedule_id === s.id);
      return own.length === s.remaining ? { schedule: s, last: own[own.length - 1] } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.last.date.localeCompare(b.last.date));
}

// « aujourd'hui », « demain », « dans 12 jours », « en retard ».
function daysFromToday(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const now = new Date();
  const days = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
  if (days < 0) return t("en retard");
  if (days === 0) return t("aujourd'hui");
  return days === 1 ? t("demain") : t("dans {n} jours", { n: days });
}

// Date de l'échéance n° rank, comme l'API : jours et semaines ajoutés ; mois ramenés au dernier jour si besoin (31 → 30, 28/29).
function occurrenceDate(start, unit, every, rank) {
  const [y, m, d] = start.split("-").map(Number);
  const steps = (rank - 1) * every;
  if (unit === "day") return isoDate(new Date(y, m - 1, d + steps));
  if (unit === "week") return isoDate(new Date(y, m - 1, d + 7 * steps));
  const first = new Date(y, m - 1 + steps * STEP_MONTHS[unit], 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return isoDate(new Date(first.getFullYear(), first.getMonth(), Math.min(d, last)));
}

// Décale `date` de l'écart entre `from` et `to` : en mois s'ils tombent le même jour du mois (1er juin → 1er septembre),
// sinon en jours. Sert à repousser les échéances qui suivent celle dont on change la date.
function shiftDate(date, from, to) {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const [y, m, d] = date.split("-").map(Number);
  if (fd === td) {
    const first = new Date(y, m - 1 + (ty - fy) * 12 + (tm - fm), 1);
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    return isoDate(new Date(first.getFullYear(), first.getMonth(), Math.min(d, last)));
  }
  const days = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
  return isoDate(new Date(y, m - 1, d + days));
}

// Première échéance dont la date précède celle de la précédente ({ rank, date }), ou undefined.
function misorderedDate(list) {
  return list.find((o, i) => i > 0 && o.date < list[i - 1].date);
}

const TX_FILTERS = {
  type: "", min: "", max: "", payee: "", category: "", sub: true, class: "", method: "",
  pointed: "", reconciled: "", number: "", text: "",
};

const STYLE = `
  :host { display: block; width: 100%; box-sizing: border-box; }
  ha-card { display: block; width: 100%; box-sizing: border-box; padding: 16px; overflow: hidden; }
  .body { width: 100%; box-sizing: border-box; }
  .table-wrap { width: 100%; overflow-x: auto; }
  .tabs { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 12px; border-bottom: 1px solid var(--divider-color); }
  .tabs button {
    background: none; border: none; cursor: pointer; padding: 10px 14px; min-height: 44px;
    color: var(--primary-text-color); font-size: 14px; border-bottom: 2px solid transparent;
  }
  .tabs button.active { border-bottom-color: var(--primary-color); color: var(--primary-color); font-weight: 500; }
  .tab-badge {
    display: inline-block; min-width: 18px; padding: 0 5px; margin-left: 4px; border-radius: 9px; box-sizing: border-box;
    font-size: 11px; line-height: 18px; text-align: center; background: var(--warning-color, #ffa600); color: #fff;
  }
  .term-alert {
    display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin-bottom: 8px; padding: 2px 4px 2px 12px;
    border-left: 4px solid var(--warning-color, #ffa600); border-radius: 4px; font-size: 14px;
    background: rgba(var(--rgb-warning-color, 255, 166, 0), 0.15);
  }
  .term-alert span { flex: 1 1 220px; padding: 6px 0; }
  .term-alert button { background: none; border: none; cursor: pointer; min-width: 44px; min-height: 44px; font-size: 14px; color: var(--primary-color); }
  .term-alert button.term-hide { color: var(--secondary-text-color); font-size: 16px; }
  form.entity-form .f-off { display: none !important; }
  .ok-msg { margin-bottom: 8px; padding: 10px 12px; border-radius: 4px; font-size: 14px;
    border-left: 4px solid var(--success-color, #43a047); background: rgba(var(--rgb-success-color, 67, 160, 71), 0.15); }
  .share-row { cursor: pointer; }
  .share-go { font-size: 22px; color: var(--secondary-text-color); padding: 0 4px; }
  .share-head { margin-bottom: 8px; }
  .share-name { font-size: 18px; font-weight: 500; }
  .share-nextpayer { margin: 8px 0; padding: 10px 12px; border-radius: 8px; font-size: 15px;
    background: rgba(var(--rgb-primary-color, 3, 169, 244), 0.1); border-left: 4px solid var(--primary-color); }
  .share-closed { margin: 8px 0; padding: 10px 12px; border-radius: 8px; font-size: 15px; background: var(--secondary-background-color); }
  .share-transfer { display: flex; justify-content: space-between; gap: 8px; padding: 10px 4px; font-size: 15px; border-bottom: 1px solid var(--divider-color); }
  .share-person { display: flex; gap: 6px; align-items: center; margin-top: 6px; }
  .share-person input { flex: 1; }
  .share-person button { background: none; border: none; cursor: pointer; font-size: 18px; min-width: 44px; min-height: 44px; color: var(--primary-text-color); }
  .share-person button:disabled { opacity: 0.3; cursor: not-allowed; }
  .share-actions { margin-top: 16px; }
  table.share-table td.pos { color: var(--success-color, #43a047); }
  table.share-table td.neg { color: var(--error-color, #db4437); }
  .badge.warn { background: rgba(var(--rgb-warning-color, 255, 166, 0), 0.25); color: var(--primary-text-color); }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--divider-color); }
  th { color: var(--secondary-text-color); font-weight: 500; }
  td.num, th.num { text-align: right; white-space: nowrap; }
  tr.tree-branch td { background: rgba(var(--rgb-primary-color, 3, 169, 244), 0.08); font-weight: 600; font-size: 15px; }
  td.actions { text-align: right; white-space: nowrap; }
  td.actions button, .tx-actions button, .split-row button.remove {
    background: none; border: none; cursor: pointer; font-size: 18px; min-width: 44px; min-height: 44px; padding: 4px;
    color: var(--primary-text-color);
  }
  .muted { color: var(--secondary-text-color); }
  .toolbar { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; align-items: center; margin-bottom: 8px; }
  .toolbar input[type="search"] { flex: 1 1 160px; }
  .toolbar button, .tx-toolbar button, .form-actions button, button.secondary {
    background: var(--primary-color); color: var(--text-primary-color, #fff);
    border: none; border-radius: 4px; padding: 12px 20px; min-height: 44px; cursor: pointer; font-size: 14px;
  }
  .form-actions button.cancel, button.secondary { background: var(--secondary-background-color); color: var(--primary-text-color); }
  .loading, .error, .empty { color: var(--secondary-text-color); padding: 12px 0; }
  .error { color: var(--error-color, #db4437); }
  input, select {
    font-size: 14px; padding: 6px; min-height: 36px; box-sizing: border-box; border: 1px solid var(--divider-color);
    border-radius: 4px; background: var(--card-background-color); color: var(--primary-text-color);
  }
  form.entity-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; margin-top: 12px; padding: 12px; background: var(--secondary-background-color); border-radius: 8px; }
  form.entity-form label { display: flex; flex-direction: column; font-size: 12px; color: var(--secondary-text-color); gap: 2px; }
  form.entity-form label.check { flex-direction: row; align-items: center; gap: 8px; font-size: 14px; }
  form.entity-form input[readonly] { opacity: 0.55; cursor: not-allowed; background: var(--secondary-background-color); }
  tr.editing { display: none; }
  tr.form-row > td { padding: 4px 0 8px; }
  tr.form-row form.entity-form { margin-top: 0; outline: 2px solid var(--primary-color); outline-offset: -2px; }
  tr.flash > td { animation: flash 2s ease-out; }
  @keyframes flash { from { background: rgba(var(--rgb-primary-color, 3, 169, 244), 0.25); } to { background: transparent; } }
  .form-actions, .full { grid-column: 1 / -1; }
  .form-actions { display: flex; gap: 8px; margin-top: 4px; flex-wrap: wrap; }
  .dashboard-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
  .balance-tile { background: var(--secondary-background-color); border-radius: 8px; padding: 12px; }
  .balance-tile .name { font-size: 14px; font-weight: 500; margin-bottom: 6px; }
  .balance-line { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; color: var(--secondary-text-color); padding: 2px 0; }
  .balance-line strong { color: var(--primary-text-color); font-weight: 600; }
  .balance-line.main strong { font-size: 16px; }
  .tx-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 8px; }
  .tx-summary {
    display: flex; gap: 16px; flex-wrap: wrap; font-size: 13px; color: var(--secondary-text-color);
    margin-bottom: 8px; padding: 8px 12px; background: var(--secondary-background-color); border-radius: 8px;
  }
  .tx-summary strong { color: var(--primary-text-color); }
  .month-sep {
    font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--primary-color); background: var(--secondary-background-color);
    padding: 6px 10px; border-radius: 4px; margin: 10px 0 4px;
  }
  .tx-row { border-bottom: 1px solid var(--divider-color); padding: 8px 4px; }
  .tx-row.future { opacity: 0.75; }
  .tx-main { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .tx-info { flex: 1 1 160px; min-width: 0; }
  .tx-desc { font-size: 14px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tx-sub { font-size: 12px; color: var(--secondary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tx-right { display: flex; align-items: center; gap: 10px; margin-left: auto; flex-shrink: 0; }
  .tx-amounts { text-align: right; flex-shrink: 0; }
  .tx-amount { font-size: 14px; font-weight: 600; }
  .tx-amount.credit { color: var(--success-color, #43a047); }
  .tx-balance { font-size: 11px; color: var(--secondary-text-color); }
  .tx-actions { display: flex; gap: 6px; flex-shrink: 0; }
  .tx-actions button.tx-state { border: 1px solid var(--divider-color); border-radius: 4px; line-height: 1; opacity: 0.45; }
  .tx-actions button.tx-state.on { color: var(--primary-color); border-color: var(--primary-color); opacity: 1; }
  .tx-row.editing { display: none; }
  .tx-edit form.entity-form { margin: 4px 0 8px; outline: 2px solid var(--primary-color); outline-offset: -2px; }
  .tx-filters { margin-bottom: 8px; }
  .tx-filters form.entity-form { margin-top: 0; }
  .tx-count { font-size: 13px; color: var(--secondary-text-color); margin-bottom: 8px; }
  .tiers-suggestions div.active { background: rgba(var(--rgb-primary-color, 3, 169, 244), 0.2); }
  .tiers-field { position: relative; }
  .tiers-suggestions {
    position: absolute; top: 100%; left: 0; right: 0; z-index: 20; margin-top: 2px;
    background: var(--card-background-color); border: 1px solid var(--divider-color);
    border-radius: 4px; max-height: 180px; overflow-y: auto; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  }
  .tiers-suggestions div { padding: 10px; font-size: 14px; cursor: pointer; color: var(--primary-text-color); }
  .tiers-suggestions div:hover { background: var(--secondary-background-color); }
  .splits { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 6px; }
  .split-row { display: grid; grid-template-columns: 2fr 1.5fr 1fr 1.5fr auto; gap: 6px; align-items: center; }
  .split-rest { font-size: 13px; }
  .split-rest.bad { color: var(--error-color, #db4437); }
  .badge { font-size: 11px; font-weight: 500; padding: 1px 6px; border-radius: 8px; background: var(--secondary-background-color); color: var(--secondary-text-color); }
  .tx-row.overdue .tx-sub { color: var(--error-color, #db4437); }
  td.pos { color: var(--success-color, #43a047); }
  td.neg, .balance-line.neg span { color: var(--error-color, #db4437); }
  tr.kind-row td { font-weight: 600; text-transform: uppercase; font-size: 12px; letter-spacing: 0.04em; color: var(--primary-color); }
  .hint { font-size: 12px; margin: 6px 0; }
  .f-lead-info { font-size: 11px; line-height: 1.3; }
  .check-inline { display: flex; align-items: center; gap: 6px; font-size: 14px; }
  .occ-panel table input, .inst-box table input { width: 90px; text-align: right; }
  .occ-panel table input[type="date"], .inst-box table input[type="date"] { width: auto; text-align: left; }
  .occ-panel input.custom { border-color: var(--primary-color); }
  .inst-box { border-top: 1px solid var(--divider-color); padding-top: 8px; }
  .inst-head { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-bottom: 6px; }
  .inst-wrap { max-height: 420px; overflow-y: auto; }
  .inst-box input.custom { border-color: var(--primary-color); }
  .inst-info.bad { color: var(--error-color, #db4437); }
  .inst-box td.actions button { min-width: 36px; min-height: 32px; }
  table.budget-grid { width: auto; }
  table.budget-grid input { width: 72px; text-align: right; min-height: 32px; padding: 4px; }
  table.budget-grid td, table.budget-grid th { padding: 3px 4px; white-space: nowrap; text-align: right; }
  table.budget-grid .sticky { text-align: left; }
  table.budget-grid tr.kind-row td, table.budget-grid tr.sum-row td, table.budget-grid tfoot td { padding-right: 8px; }
  table.budget-grid tr.sum-row td { font-style: italic; color: var(--secondary-text-color); }
  table.budget-grid tfoot td { font-weight: 600; border-top: 2px solid var(--divider-color); }
  table.budget-grid tr.cur-row > td, table.budget-grid .cur-col { box-shadow: inset 0 0 0 9999px rgba(var(--rgb-primary-color, 3, 169, 244), 0.07); }
  table.budget-grid tr.cur-row > td.cur-col { box-shadow: inset 0 0 0 9999px rgba(var(--rgb-primary-color, 3, 169, 244), 0.18); }
  table.budget-grid tr.cur-row input, table.budget-grid td.cur-col input { background: transparent; }
  button.cat-info {
    background: none; border: 1px solid var(--divider-color); border-radius: 50%; cursor: pointer; width: 22px; height: 22px;
    padding: 0; margin-left: 6px; font-size: 12px; line-height: 20px; color: var(--primary-color); vertical-align: middle;
  }
  button.cat-info:hover { border-color: var(--primary-color); }
  table.dash-budget { margin-bottom: 4px; }
  table.dash-budget td { padding: 4px 8px; }
  table.dash-budget td.bar { width: 120px; }
  .tx-back { background: none !important; color: var(--primary-color) !important; padding-left: 0 !important; }
  .pbar { position: relative; width: 110px; height: 16px; border-radius: 8px; background: var(--secondary-background-color); overflow: hidden; }
  .pbar > div { height: 100%; background: var(--primary-color); opacity: 0.55; }
  .pbar.over > div { background: var(--error-color, #db4437); }
  .pbar.good > div { background: var(--success-color, #43a047); }
  .pbar > span { position: absolute; inset: 0; font-size: 11px; line-height: 16px; text-align: center; color: var(--primary-text-color); font-weight: 500; }
  table.budget-grid .sticky { position: sticky; left: 0; z-index: 1; background: var(--card-background-color); min-width: 140px; }
  table.budget-grid tr.tree-branch .sticky { background: var(--card-background-color); background-image: linear-gradient(rgba(var(--rgb-primary-color, 3, 169, 244), 0.08), rgba(var(--rgb-primary-color, 3, 169, 244), 0.08)); }
  table.budget-grid button.b-right { background: none; border: none; cursor: pointer; font-size: 16px; min-width: 36px; min-height: 36px; color: var(--primary-color); }
  button.tree-toggle { background: none; border: none; cursor: pointer; font-size: 14px; width: 28px; min-height: 32px; padding: 0; color: var(--primary-text-color); }
  span.tree-spacer { display: inline-block; width: 28px; }
  table.budget-grid .agg { display: none; }
  table.budget-grid tr.collapsed .agg { display: inline-block; width: 72px; text-align: right; padding: 4px; box-sizing: border-box; }
  table.budget-grid tr.collapsed input, table.budget-grid tr.collapsed button.b-right { display: none; }
  tr[hidden] { display: none; }
  .occ-panel td.actions button { min-width: 40px; }
  @media (max-width: 480px) {
    form.entity-form { grid-template-columns: 1fr; }
    .split-row { grid-template-columns: 1fr 1fr; }
    .tx-info { flex-basis: 100%; }
    .tx-toolbar { flex-direction: column; align-items: stretch; }
    .tx-toolbar select, .tx-toolbar button { width: 100%; }
    .dashboard-grid { grid-template-columns: 1fr 1fr; }
  }
`;

let NUMBER = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
setLanguage(null); // langue de la page en attendant `hass` (HA renseigne <html lang>)

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Amounts come from the API as decimal strings ("-14.80"); displayed in the user's number format.
function fmtAmount(value) {
  if (value === null || value === undefined || value === "") return "";
  const n = Number(value);
  return Number.isFinite(n) ? esc(NUMBER.format(n)) : esc(value);
}

// For an <input>: "14,80" in French or German, "14.80" otherwise (the API accepts both).
function inputAmount(value) {
  if (value === null || value === undefined || value === "") return "";
  const text = String(Math.abs(Number(value)).toFixed(2));
  return LANG === "fr" || LANG === "de" ? text.replace(".", ",") : text;
}

// Montant d'une case de grille : vide = invalide (et non 0).
function gridNumber(text) {
  return String(text ?? "").trim() === "" ? NaN : toNumber(text);
}

function toNumber(text) {
  const n = Number(String(text ?? "").trim().replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
}

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Date d'inscription automatique d'une échéance : sa date moins les jours d'anticipation (comme l'API) ;
// null si la saisie est manuelle ou sans anticipation (inscrite le jour même).
function autoEntryDate(date, s) {
  if (!s || !s.auto || !s.lead_days) return null;
  const [y, m, d] = date.split("-").map(Number);
  return isoDate(new Date(y, m - 1, d - s.lead_days));
}

// Date courte dans le format de l'utilisateur (09/10/2026, 10/9/2026, 09.10.2026).
function frDate(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  if (!y || !m || !d) return String(iso);
  return new Date(y, m - 1, d).toLocaleDateString(LOCALE, { day: "2-digit", month: "2-digit", year: "numeric" });
}

function freqLabel(s) {
  const u = UNITS[s.unit] || UNITS.month;
  const base = s.every === 1 ? u.one : t(u.many, { n: s.every }); // u.many est déjà traduit : t() n'y change que {n}
  if (s.end_mode === "count") return t("{base}, {n} fois", { base, n: s.count });
  if (s.end_mode === "date") return t("{base}, jusqu'au {date}", { base, date: frDate(s.end_date) });
  return base;
}

// "2026-01" → "janv. 2026" (short) ou "janvier 2026" (long).
function monthLabel(ym, style) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(LOCALE, { month: style, year: style === "short" ? "2-digit" : "numeric" });
}

function errMsg(err) {
  return (err && (err.message || err.error || (err.body && err.body.message))) || String(err);
}

class MyBankCard extends HTMLElement {
  setConfig(config) {
    config = config || {};
    const requested = Array.isArray(config.sections) ? config.sections : null;
    this._sections = requested && requested.length
      ? SECTION_DEFS.filter((s) => requested.includes(s.key))
      : SECTION_DEFS.slice();
    if (!this._sections.length) this._sections = SECTION_DEFS.slice();
    this._config = config;
    this._active = this._sections[0].key;
    this._lookups = null;
    // une clé par configuration : deux cartes d'une même vue gardent chacune leur historique
    this._navKey = this._sections.map((s) => s.key).join(",");
    this._render();
  }

  connectedCallback() {
    if (!this._onPopState) this._onPopState = (ev) => this._navPop(ev);
    window.addEventListener("popstate", this._onPopState);
    // retour sur la vue du tableau de bord (nouvelle entrée d'historique) : y noter l'écran affiché
    if (this._hass && this._bodyEl) this._navCommit(true);
  }

  disconnectedCallback() {
    if (this._onPopState) window.removeEventListener("popstate", this._onPopState);
  }

  set hass(hass) {
    this._hass = hass;
    setLanguage(hass);
    // setConfig() runs before `hass` is first assigned: render once it arrives.
    if (this._needsInitialRender) {
      this._needsInitialRender = false;
      this._renderActive();
    }
  }

  getCardSize() {
    return 6;
  }

  static getStubConfig() {
    return { sections: SECTION_DEFS.map((s) => s.key) };
  }

  static getConfigElement() {
    return document.createElement("my-bank-card-editor");
  }

  async _call(service, data, wantResponse) {
    const res = await this._hass.connection.sendMessagePromise({
      type: "call_service",
      domain: "my_bank",
      service,
      service_data: data || {},
      return_response: !!wantResponse,
    });
    return wantResponse ? res && res.response : res;
  }

  async _items(service, data) {
    const res = await this._call(service, data || {}, true);
    return (res && res.items) || [];
  }

  async _ensureLookups(force) {
    if (this._lookups && !force) return this._lookups;
    const [accounts, categories, classes, payees, methods] = await Promise.all([
      this._items("list_accounts"),
      this._items("list_categories"),
      this._items("list_classes"),
      this._items("list_payees"),
      this._items("list_payment_methods"),
    ]);
    const byId = (list) => new Map(list.map((x) => [x.id, x]));
    this._lookups = {
      accounts, categories, classes, payees, methods,
      account: byId(accounts), category: byId(categories), class: byId(classes), payee: byId(payees), method: byId(methods),
    };
    return this._lookups;
  }

  _render() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `<style>${STYLE}</style><ha-card><div class="term-alerts"></div><div class="tabs"></div><div class="body"><div class="loading">${t("Chargement…")}</div></div></ha-card>`;
    this._alertsEl = this.shadowRoot.querySelector(".term-alerts");
    this._tabsEl = this.shadowRoot.querySelector(".tabs");
    this._bodyEl = this.shadowRoot.querySelector(".body");
    this._alertsAt = 0;
    this._alertsEl.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button");
      const box = ev.target.closest(".term-alert");
      if (!btn || !box) return;
      if (btn.classList.contains("term-hide")) {
        this._setTermDismissed([...this._termDismissed(), box.dataset.key]);
        this._paintAlerts();
      } else if (btn.classList.contains("term-see")) {
        this._returnTo = null;
        this._active = "recurrences";
        this._openSchedule = Number(box.dataset.id);
        this._renderTabs();
        this._renderActive();
      }
    });
    // Saisie en cours : marquée sur son formulaire, pour demander confirmation avant de la perdre par Retour.
    const markDirty = (ev) => {
      const form = ev.target.closest(".entity-form, table.budget-grid");
      if (form && !form.closest(".tx-filters")) form.dataset.dirty = "1";
    };
    this._bodyEl.addEventListener("input", markDirty);
    this._bodyEl.addEventListener("change", markDirty);
    // ⓘ d'une rubrique, où qu'il soit : ouvre ses opérations (contexte éventuel dans data-account / data-start / data-end).
    this._bodyEl.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button.cat-info");
      if (!btn) return;
      ev.preventDefault();
      const d = btn.dataset;
      this._showCategoryOps(Number(d.infoCat), { account: d.account ? Number(d.account) : null, start: d.start, end: d.end });
    });
    this._renderTabs();
    this._needsInitialRender = !this._hass;
    this._renderActive();
  }

  _renderTabs() {
    if (this._sections.length <= 1) {
      this._tabsEl.style.display = "none";
      return;
    }
    this._tabsEl.style.display = "flex";
    const ending = (this._ending || []).length;
    const badge = (key) => (key === "recurrences" && ending
      ? `<span class="tab-badge" title="${esc(t("{n} planification(s) arrivant à terme dans les {days} jours", { n: ending, days: TERM_DAYS }))}">${ending}</span>`
      : "");
    this._tabsEl.innerHTML = this._sections
      .map((s) => `<button data-key="${s.key}" class="${s.key === this._active ? "active" : ""}">${esc(s.label)}${badge(s.key)}</button>`)
      .join("");
    this._tabsEl.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._returnTo = null;
        this._shareId = null;
        this._active = btn.dataset.key;
        this._renderTabs();
        this._renderActive();
      });
    });
  }

  // quiet : rafraîchissement sur place, sans « Chargement… » qui ferait perdre la position de défilement
  async _renderActive(quiet) {
    if (!this._hass) return;
    if (!quiet) this._bodyEl.innerHTML = `<div class="loading">${t("Chargement…")}</div>`;
    // L'échéancier rafraîchit lui-même le bandeau « arrive à terme » avec ses propres données.
    if (!this._noAlerts && this._active !== "recurrences" && Date.now() - this._alertsAt > TERM_REFRESH_MS) this._refreshAlerts();
    try {
      switch (this._active) {
        case "dashboard": return await this._renderDashboard();
        case "transactions": return await this._renderTransactions();
        case "accounts": return await this._renderCrud(this._accountsConfig());
        case "categories": return await this._renderCrud(this._treeConfig("category"));
        case "tags": return await this._renderCrud(this._treeConfig("class"));
        case "payees": return await this._renderCrud(this._payeesConfig());
        case "budgets": return await this._renderBudgets();
        case "recurrences": return await this._renderSchedules();
        case "shares": return await this._renderShares();
        default:
          this._bodyEl.innerHTML = `<div class="empty">${t("Section inconnue.")}</div>`;
      }
    } catch (err) {
      this._bodyEl.innerHTML = `<div class="error">${esc(errMsg(err))}</div>`;
    } finally {
      this._focusId = null;
      this._navCommit();
    }
  }

  // --- Planifications arrivant à terme (bandeau en haut de la carte, quel que soit l'onglet) -------

  // data : [planifications, échéances à venir sur TERM_DAYS jours] déjà chargées par l'échéancier.
  async _refreshAlerts(data) {
    this._alertsAt = Date.now();
    try {
      const [schedules, upcoming] = data || await Promise.all([
        this._items("list_schedules"),
        this._items("list_upcoming_occurrences", { days: TERM_DAYS }),
      ]);
      this._ending = endingSchedules(schedules, upcoming);
    } catch (err) {
      return; // best-effort, comme les échéances du tableau de bord
    }
    this._paintAlerts();
  }

  _termKey(e) {
    return `${e.schedule.id}@${e.last.date}`;
  }

  _termDismissed() {
    try {
      return JSON.parse(window.localStorage.getItem(TERM_DISMISS_KEY) || "[]");
    } catch (err) {
      return [];
    }
  }

  _setTermDismissed(keys) {
    try {
      window.localStorage.setItem(TERM_DISMISS_KEY, JSON.stringify(keys));
    } catch (err) {
      // stockage indisponible : le bandeau reviendra au prochain chargement
    }
  }

  // Une ligne par planification arrivant à terme, sauf celles masquées (✕) ; masquer vaut pour cette date de fin :
  // si la dernière échéance change de date, l'alerte revient. Le badge de l'onglet Échéancier les compte toutes.
  _paintAlerts() {
    const ending = this._ending || [];
    const keys = ending.map((e) => this._termKey(e));
    const dismissed = this._termDismissed().filter((k) => keys.includes(k));
    this._setTermDismissed(dismissed); // oublie les planifications terminées
    const canSee = this._sections.some((s) => s.key === "recurrences");
    this._alertsEl.innerHTML = ending
      .filter((e) => !dismissed.includes(this._termKey(e)))
      .map((e) => {
        const s = e.schedule;
        const vars = { label: esc(s.label), date: esc(frDate(e.last.date)), when: esc(daysFromToday(e.last.date)) };
        const text = s.mode === "installments"
          ? t("L'échéancier « {label} » arrive à terme : dernière échéance le {date} ({when})", vars)
          : t("La planification « {label} » arrive à terme : dernière échéance le {date} ({when})", vars);
        const left = s.remaining > 1 ? t(" · encore {n} échéances", { n: s.remaining }) : "";
        return `<div class="term-alert" data-id="${s.id}" data-key="${esc(this._termKey(e))}">
          <span>⚠ ${text}${left}</span>
          ${canSee ? `<button type="button" class="term-see" title="${t("Voir ses échéances")}">${t("Voir")}</button>` : ""}
          <button type="button" class="term-hide" title="${t("Masquer cette alerte")}">✕</button>
        </div>`;
      })
      .join("");
    this._renderTabs();
  }

  // --- Navigation interne et bouton Retour (navigateur, souris, Android) ---------------------------
  // Chaque écran de la carte (onglet, compte, période, critères, budget et vue) est noté dans history.state,
  // à la même URL : HA ne réagit pas (il ne regarde que l'URL et ses propres clés de dialogue), et Retour
  // ramène à l'écran précédent de la carte avant de quitter la vue.

  _navView() {
    return {
      active: this._active,
      returnTo: this._returnTo || null,
      txAccountId: this._txAccountId ?? null,
      txRange: this._txRange || null,
      txStart: this._txStart || "",
      txEnd: this._txEnd || "",
      txFilters: this._txFilters ? { ...this._txFilters } : null,
      txFiltersOpen: !!this._txFiltersOpen,
      budgetId: this._budgetId ?? null,
      budgetView: this._budgetView || null,
      shareId: this._shareId || null,
    };
  }

  _navEnabled() {
    const st = history.state;
    // pas dans l'aperçu de l'éditeur de carte, ni par-dessus un dialogue de HA (il gère Retour avec history.state)
    return this.isConnected && !this.preview && !(st && ("dialog" in st || "dialogData" in st || "opensDialog" in st));
  }

  // Note l'écran affiché : nouvelle entrée d'historique s'il a changé, ou mise à jour de l'entrée courante
  // (replace, première fois sur cette entrée, ou écran rétabli par Retour).
  _navCommit(replace) {
    if (!this._navEnabled()) return;
    const st = history.state || {};
    const map = st[NAV_KEY] || {};
    const view = this._navView();
    const current = map[this._navKey];
    if (current && JSON.stringify(current) === JSON.stringify(view)) return;
    const views = { ...map, [this._navKey]: view };
    if (replace || !current || this._navRestoring) history.replaceState({ ...st, [NAV_KEY]: views }, "");
    else history.pushState({ [NAV_KEY]: views }, "");
  }

  async _navPop(ev) {
    const view = ev.state && ev.state[NAV_KEY] && ev.state[NAV_KEY][this._navKey];
    if (!view || !this._hass || !this._sections || !this._sections.some((s) => s.key === view.active)) return;
    if (JSON.stringify(view) === JSON.stringify(this._navView())) return;
    const dirty = this._bodyEl.querySelector("[data-dirty]");
    if (dirty && !confirm(t("Abandonner la saisie en cours ?"))) {
      // rester sur place : l'écran actuel redevient la dernière entrée
      history.pushState({ [NAV_KEY]: { ...ev.state[NAV_KEY], [this._navKey]: this._navView() } }, "");
      return;
    }
    this._active = view.active;
    this._returnTo = view.returnTo;
    this._txAccountId = view.txAccountId ?? undefined;
    this._txRange = view.txRange || undefined;
    this._txStart = view.txStart;
    this._txEnd = view.txEnd;
    this._txFilters = view.txFilters ? { ...view.txFilters } : undefined;
    this._txFiltersOpen = view.txFiltersOpen;
    this._budgetId = view.budgetId ?? undefined;
    this._budgetView = view.budgetView || undefined;
    this._shareId = view.shareId || null;
    this._renderTabs();
    this._navRestoring = true;
    try {
      await this._renderActive();
    } finally {
      this._navRestoring = false;
    }
  }

  // Bouton ⓘ d'une rubrique ; ctx = { account, start, end } quand la vue a une période (suivi de budget, tableau de bord).
  _catInfoHtml(categoryId, ctx) {
    const attrs = [`data-info-cat="${categoryId}"`];
    if (ctx && ctx.account) attrs.push(`data-account="${ctx.account}"`);
    if (ctx && ctx.start) attrs.push(`data-start="${ctx.start}"`, `data-end="${ctx.end || ""}"`);
    return `<button type="button" class="cat-info" ${attrs.join(" ")} title="${t("Voir les opérations de la rubrique (sous-rubriques comprises)")}">i</button>`;
  }

  // Ouvre le volet Opérations filtré sur la rubrique et ses sous-rubriques : sur la période donnée,
  // sinon la vue par défaut (mois en cours). Un bouton « ← Retour » ramène à la vue d'origine.
  async _showCategoryOps(categoryId, ctx) {
    if (this._active !== "transactions") this._returnTo = { active: this._active };
    this._active = "transactions";
    if (ctx.account) this._txAccountId = ctx.account;
    this._txFilters = { ...TX_FILTERS, category: String(categoryId), sub: true };
    this._txFiltersOpen = true;
    if (ctx.start) {
      this._txRange = "custom";
      this._txStart = ctx.start;
      this._txEnd = ctx.end || "";
    } else {
      this._txRange = "month";
    }
    this._renderTabs();
    await this._renderActive();
    this.scrollIntoView({ block: "start" });
  }

  // "2026-10" → bornes du mois, pour une période de suivi de budget.
  _monthBounds(first, last) {
    const [y, m] = last.split("-").map(Number);
    return { start: `${first}-01`, end: isoDate(new Date(y, m, 0)) };
  }

  // --- Tableau de bord ---------------------------------------------------------------------------

  async _renderDashboard() {
    const accounts = (await this._items("list_accounts")).filter((a) => !a.closed);
    const tiles = accounts
      .map((a) => `<div class="balance-tile">
          <div class="name">${esc(a.name)}</div>
          <div class="balance-line main"><span>${t("Solde")}</span><strong>${fmtAmount(a.balances.total)} €</strong></div>
          <div class="balance-line"><span>${t("Pointé")}</span><strong>${fmtAmount(a.balances.pointed)} €</strong></div>
          <div class="balance-line"><span>${t("Rapproché")}</span><strong>${fmtAmount(a.balances.reconciled)} €</strong></div>
        </div>`)
      .join("");
    this._bodyEl.innerHTML = `<div class="dashboard-grid">${tiles || `<div class="empty">${t("Aucun compte.")}</div>`}</div>`;
    // Budgets couvrant le mois en cours : best-effort, comme les échéances.
    try {
      await this._renderDashboardBudgets();
    } catch (err) {
      // ignoré
    }
    // Prochaines échéances : best-effort, le tableau de bord reste utilisable sans.
    try {
      const upcoming = await this._items("list_upcoming_occurrences", { days: 7 });
      if (!upcoming.length) return;
      const lines = upcoming
        .map((o) => `<div class="balance-line ${o.overdue ? "neg" : ""}"><span>${esc(frDate(o.date))} · ${esc(o.label)}${o.overdue ? ` (${t("en retard")})` : ""}</span><strong>${fmtAmount(o.amount)} €</strong></div>`)
        .join("");
      this._bodyEl.insertAdjacentHTML("beforeend", `<div class="month-sep">${t("Échéances des 7 prochains jours")}</div><div class="balance-tile">${lines}</div>`);
    } catch (err) {
      // ignoré
    }
  }

  // Un bloc par budget couvrant le mois en cours (les uns sous les autres) : barres de réalisation du mois
  // pour les rubriques racines et leur premier niveau qui ont un montant prévu ou réalisé ce mois-ci
  // (un réalisé sans prévu est marqué « hors budget »), plus une barre par type.
  async _renderDashboardBudgets() {
    const month = isoDate(new Date()).slice(0, 7);
    const budgets = (await this._items("list_budgets"))
      .filter((b) => !b.archived && b.start_month.slice(0, 7) <= month && b.end_month.slice(0, 7) >= month);
    if (!budgets.length) return;
    await this._ensureLookups();
    const reports = await Promise.all(budgets.map((b) => this._call("get_budget_report", { budget_id: b.id }, true)));
    const blocks = budgets.map((b, k) => {
      const r = reports[k];
      const i = r.months.indexOf(month);
      if (i < 0) return "";
      const ctx = { account: b.account_id, ...this._monthBounds(month, month) };
      const groups = this._byKind(r.rows.filter((x) => x.depth <= 1 && (Number(x.planned[i]) || Number(x.actual[i]))))
        .filter((g) => g.rows.length)
        .map((g) => {
          const tot = r.totals[g.kind];
          return `<tr class="kind-row"><td>${esc(KIND_TITLES[g.kind])}</td><td class="bar">${this._progressHtml(g.kind, tot.planned[i], tot.actual[i])}</td><td class="num">${fmtAmount(tot.actual[i])} / ${fmtAmount(tot.planned[i])} €</td></tr>`
            + g.rows.map((x) => `<tr class="${x.depth === 0 && x.has_children ? "tree-branch" : ""}">
            <td><span style="display: inline-block; padding-left: ${x.depth * 20}px">${esc(x.name)}</span>${this._catInfoHtml(x.category_id, ctx)}</td>
            <td class="bar">${this._progressHtml(g.kind, x.planned[i], x.actual[i])}</td>
            <td class="num">${fmtAmount(x.actual[i])} / ${fmtAmount(x.planned[i])} €</td>
          </tr>`).join("");
        })
        .join("");
      const account = this._lookups.account.get(b.account_id);
      return `<div class="month-sep">${t("Budget « {name} »", { name: esc(b.name) })} — ${esc(account ? account.name : "")} — ${esc(monthLabel(month, "long"))}</div>
        <div class="table-wrap"><table class="dash-budget"><tbody>${groups || `<tr><td class="muted">${t("Rien de prévu ce mois-ci.")}</td></tr>`}</tbody></table></div>`;
    });
    this._bodyEl.insertAdjacentHTML("beforeend", blocks.join(""));
  }

  // --- Opérations --------------------------------------------------------------------------------

  _rangeStart(range) {
    const now = new Date();
    if (range === "year") return `${now.getFullYear()}-01-01`;
    if (range === "3months") return isoDate(new Date(now.getFullYear(), now.getMonth() - 2, 1));
    if (range === "12months") return isoDate(new Date(now.getFullYear(), now.getMonth() - 11, 1));
    return isoDate(new Date(now.getFullYear(), now.getMonth(), 1));
  }

  _categoryLabel(tx) {
    if (tx.splits.length > 1) return t("Ventilée ({n})", { n: tx.splits.length });
    const c = this._lookups.category.get(tx.splits[0] && tx.splits[0].category_id);
    return c ? c.path : "";
  }

  _txTitle(tx) {
    if (tx.label) return tx.label;
    const p = this._lookups.payee.get(tx.payee_id);
    if (p) return p.name;
    return tx.transfer_account_id ? t("Virement") : t("Opération");
  }

  _txCounterpart(tx) {
    if (tx.transfer_account_id) {
      const other = this._lookups.account.get(tx.transfer_account_id);
      return `${Number(tx.amount) < 0 ? "→" : "←"} ${other ? other.name : t("compte {id}", { id: tx.transfer_account_id })}`;
    }
    const p = this._lookups.payee.get(tx.payee_id);
    return p ? p.name : "";
  }

  _txRowHtml(tx) {
    const today = isoDate(new Date());
    const credit = Number(tx.amount) > 0;
    const method = this._lookups.method.get(tx.payment_method_id);
    const sub = [frDate(tx.date), this._txCounterpart(tx), this._categoryLabel(tx), method ? method.name : ""]
      .filter(Boolean)
      .map(esc)
      .join(" · ");
    return `<div class="tx-row ${tx.date > today ? "future" : ""}" data-id="${tx.id}">
      <div class="tx-main">
        <div class="tx-info">
          <div class="tx-desc">${esc(this._txTitle(tx))}</div>
          <div class="tx-sub">${sub}</div>
        </div>
        <div class="tx-right">
          <div class="tx-amounts">
            <div class="tx-amount ${credit ? "credit" : ""}">${credit ? "+" : ""}${fmtAmount(tx.amount)} €</div>
            <div class="tx-balance">${t("Solde :")} ${fmtAmount(tx.balance_after)}</div>
          </div>
          <div class="tx-actions">
            ${this._stateButtonsHtml(tx.state)}
            <button class="edit" title="${t("Modifier")}">✎</button>
            <button class="del" title="${t("Supprimer")}">✕</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  async _renderTransactions() {
    await this._ensureLookups();
    const accounts = this._lookups.accounts.filter((a) => !a.closed);
    if (!accounts.length) {
      this._bodyEl.innerHTML = `<div class="empty">${t("Aucun compte. Crée d'abord un compte dans l'onglet « Comptes ».")}</div>`;
      return;
    }
    if (!accounts.some((a) => a.id === this._txAccountId)) this._txAccountId = accounts[0].id;
    this._txRange = this._txRange || "month";
    this._txFilters = this._txFilters || { ...TX_FILTERS };
    const query = { account_id: this._txAccountId, order: "desc" };
    if (this._txRange === "custom") {
      if (this._txStart) query.start = this._txStart;
      if (this._txEnd) query.end = this._txEnd;
    } else {
      query.start = this._rangeStart(this._txRange);
    }
    const data = await this._call("list_account_transactions", query, true);
    this._txAll = (data && data.items) || [];
    this._txItems = new Map(this._txAll.map((x) => [x.id, x]));

    this._bodyEl.innerHTML = `
      <div class="tx-toolbar">
        ${this._returnTo ? `<button class="secondary tx-back">← ${t("Retour")}</button>` : ""}
        <select class="tx-account">${accounts.map((a) => `<option value="${a.id}" ${a.id === this._txAccountId ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select>
        <select class="tx-range">${RANGES.map((r) => `<option value="${r.key}" ${r.key === this._txRange ? "selected" : ""}>${esc(r.label)}</option>`).join("")}</select>
        <button class="secondary tx-filter-btn"></button>
        <button class="add">+ ${t("Ajouter")}</button>
      </div>
      <div class="tx-filters" ${this._txFiltersOpen ? "" : "hidden"}>${this._txFiltersHtml(query)}</div>
      <div class="tx-summary"></div>
      <div class="form-container"></div>
      <div class="tx-count"></div>
      <div class="tx-list"></div>
    `;
    this._paintSummary(this._lookups.account.get(this._txAccountId));
    this._refreshSummary().catch(() => {}); // soldes éventuellement modifiés ailleurs depuis le dernier chargement
    this._paintTxList();

    const formContainer = this._bodyEl.querySelector(".form-container");
    const list = this._bodyEl.querySelector(".tx-list");
    const filtersBox = this._bodyEl.querySelector(".tx-filters");
    // Un seul formulaire ouvert à la fois : en haut (ajout) ou à la place de la ligne (modification).
    const closeForms = () => {
      formContainer.innerHTML = "";
      list.querySelectorAll(".tx-edit").forEach((el) => el.remove());
      list.querySelectorAll(".tx-row.editing").forEach((el) => el.classList.remove("editing"));
    };
    const back = this._bodyEl.querySelector(".tx-back");
    if (back) back.addEventListener("click", () => {
      this._active = this._returnTo.active;
      this._returnTo = null;
      this._renderTabs();
      this._renderActive();
    });
    this._bodyEl.querySelector(".tx-account").addEventListener("change", (ev) => {
      this._txAccountId = Number(ev.target.value);
      this._renderActive();
    });
    this._bodyEl.querySelector(".tx-range").addEventListener("change", (ev) => {
      this._txRange = ev.target.value;
      if (this._txRange === "custom") {
        // les dates de la plage partent de la période affichée ; on les ajuste dans les filtres
        this._txStart = this._txStart || query.start || "";
        this._txFiltersOpen = true;
      }
      this._renderActive(true);
    });
    this._bodyEl.querySelector(".tx-filter-btn").addEventListener("click", () => {
      this._txFiltersOpen = !this._txFiltersOpen;
      filtersBox.hidden = !this._txFiltersOpen;
      this._navCommit(true);
    });
    const filterForm = filtersBox.querySelector("form");
    const readFilters = () => {
      const f = this._txFilters;
      for (const key of Object.keys(TX_FILTERS)) {
        const el = filterForm.querySelector(`[name="${key}"]`);
        f[key] = el.type === "checkbox" ? el.checked : el.value;
      }
      this._paintTxList();
      this._navCommit(true); // critères notés sur l'écran courant, sans nouvelle entrée d'historique
    };
    filterForm.addEventListener("input", (ev) => { if (!ev.target.matches('[type="date"]')) readFilters(); });
    filterForm.addEventListener("change", (ev) => {
      if (!ev.target.matches('[type="date"]')) return readFilters();
      // changer une date recharge la période (le solde après chaque ligne vient de l'API)
      this._txRange = "custom";
      this._txStart = filterForm.querySelector('[name="start"]').value;
      this._txEnd = filterForm.querySelector('[name="end"]').value;
      this._renderActive(true);
    });
    filterForm.addEventListener("submit", (ev) => ev.preventDefault());
    filterForm.querySelector(".f-reset").addEventListener("click", () => {
      this._txFilters = { ...TX_FILTERS };
      this._renderActive(true);
    });
    this._bodyEl.querySelector(".add").addEventListener("click", () => {
      closeForms();
      this._showTransactionForm(formContainer, null);
    });
    list.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button");
      const row = ev.target.closest(".tx-row");
      if (!btn || !row) return;
      const tx = this._txItems.get(Number(row.dataset.id));
      if (btn.classList.contains("edit")) {
        closeForms();
        const box = document.createElement("div");
        box.className = "tx-edit";
        row.after(box);
        row.classList.add("editing");
        this._showTransactionForm(box, tx, closeForms);
      } else if (btn.classList.contains("del")) {
        this._deleteTransaction(row, btn, tx);
      } else if (btn.classList.contains("tx-point")) {
        this._toggleState(row, tx, "point");
      } else if (btn.classList.contains("tx-reco")) {
        this._toggleState(row, tx, "reco");
      }
    });
  }

  // Critères sur tous les champs d'une opération ; la plage de dates recharge la liste, le reste filtre sur place.
  _txFiltersHtml(query) {
    const f = this._txFilters;
    const L = this._lookups;
    const sel = (name, opts) => `<select name="${name}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(f[name]) === String(v) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    const tree = (list) => [["", t("Toutes")], ...list.map((c) => [c.id, `${"  ".repeat(c.depth)}${c.name}`])];
    const yesNo = [["", t("Indifférent")], ["yes", t("Oui")], ["no", t("Non")]];
    return `<form class="entity-form">
      <label>${t("Du")}<input type="date" name="start" value="${esc(query.start || "")}"></label>
      <label>${t("Au")}<input type="date" name="end" value="${esc(query.end || "")}"></label>
      <label>${t("Type")}${sel("type", [["", t("Tous")], ["expense", t("Dépenses")], ["income", t("Recettes")], ["transfer", t("Virements")]])}</label>
      <label>${t("Montant min.")}<input type="text" name="min" inputmode="decimal" value="${esc(f.min)}"></label>
      <label>${t("Montant max.")}<input type="text" name="max" inputmode="decimal" value="${esc(f.max)}"></label>
      <label>${t("Tiers / autre compte")}<input type="text" name="payee" value="${esc(f.payee)}"></label>
      <label>${t("Rubrique")}${sel("category", tree(L.categories))}</label>
      <label class="check"><input type="checkbox" name="sub" ${f.sub ? "checked" : ""}>${t("Sous-rubriques comprises")}</label>
      <label>${t("Classe")}${sel("class", tree(L.classes))}</label>
      <label>${t("Mode de règlement")}${sel("method", [["", t("Tous")], ...L.methods.map((m) => [m.id, m.name])])}</label>
      <label>${t("Pointée")}${sel("pointed", yesNo)}</label>
      <label>${t("Rapprochée")}${sel("reconciled", yesNo)}</label>
      <label>${t("N° de chèque")}<input type="text" name="number" value="${esc(f.number)}"></label>
      <label>${t("Libellé / notes")}<input type="text" name="text" value="${esc(f.text)}"></label>
      <div class="form-actions"><button type="button" class="cancel f-reset">${t("Réinitialiser les critères")}</button></div>
    </form>`;
  }

  _txFilterCount() {
    const f = this._txFilters;
    return Object.keys(TX_FILTERS).filter((k) => k !== "sub" && f[k] !== "").length;
  }

  _txMatches(tx, f) {
    const L = this._lookups;
    const amount = Number(tx.amount);
    const transfer = !!tx.transfer_account_id;
    if (f.type === "transfer" && !transfer) return false;
    if (f.type === "expense" && (transfer || amount >= 0)) return false;
    if (f.type === "income" && (transfer || amount <= 0)) return false;
    const min = toNumber(f.min);
    const max = toNumber(f.max);
    if (f.min !== "" && Number.isFinite(min) && Math.abs(amount) < min) return false;
    if (f.max !== "" && Number.isFinite(max) && Math.abs(amount) > max) return false;
    const has = (text, needle) => String(text || "").toLowerCase().includes(needle.trim().toLowerCase());
    if (f.payee && !has(this._txCounterpart(tx), f.payee)) return false;
    if (f.category) {
      const cat = L.category.get(Number(f.category));
      const ok = (id) => {
        const c = L.category.get(id);
        return !!c && (c.id === cat.id || (f.sub && c.path.startsWith(cat.path + " > ")));
      };
      if (!cat || !tx.splits.some((s) => ok(s.category_id))) return false;
    }
    if (f.class && !tx.splits.some((s) => s.class_id === Number(f.class))) return false;
    if (f.method && tx.payment_method_id !== Number(f.method)) return false;
    if (f.pointed && (tx.state >= 1) !== (f.pointed === "yes")) return false;
    if (f.reconciled && (tx.state === 2) !== (f.reconciled === "yes")) return false;
    if (f.number && !has(tx.number, f.number)) return false;
    if (f.text && !has(`${tx.label || ""} ${tx.notes || ""}`, f.text)) return false;
    return true;
  }

  _paintTxList() {
    const f = this._txFilters;
    const active = this._txFilterCount();
    const items = active ? this._txAll.filter((tx) => this._txMatches(tx, f)) : this._txAll;
    let lastMonth = null;
    const rowsHtml = items
      .map((tx) => {
        const month = tx.date.slice(0, 7);
        let sep = "";
        if (month !== lastMonth) {
          lastMonth = month;
          sep = `<div class="month-sep">${esc(monthLabel(month, "long"))}</div>`;
        }
        return sep + this._txRowHtml(tx);
      })
      .join("");
    const empty = active ? t("Aucune opération ne correspond aux critères.") : t("Aucune opération sur cette période.");
    this._bodyEl.querySelector(".tx-list").innerHTML = rowsHtml || `<div class="empty">${empty}</div>`;
    this._bodyEl.querySelector(".tx-filter-btn").textContent = active ? t("Critères ({n})", { n: active }) : t("Critères");
    // Avec un filtre de rubrique, le total ne compte que les lignes de ventilation de la rubrique
    // (comme le réalisé d'un budget) : une opération ventilée n'y entre que pour sa part.
    const cat = f.category ? this._lookups.category.get(Number(f.category)) : null;
    const catIds = cat
      ? new Set(this._lookups.categories.filter((c) => c.id === cat.id || (f.sub && c.path.startsWith(cat.path + " > "))).map((c) => c.id))
      : null;
    const part = (tx) => (catIds ? tx.splits.filter((x) => catIds.has(x.category_id)).reduce((a, x) => a + Number(x.amount), 0) : Number(tx.amount));
    const total = items.reduce((acc, tx) => acc + part(tx), 0);
    this._bodyEl.querySelector(".tx-count").textContent = active
      ? t("{n} opération(s) sur {all} · total {total} €", { n: items.length, all: this._txAll.length, total: NUMBER.format(total) })
        + (catIds ? ` ${t("(part de la rubrique)")}` : "")
      : "";
  }

  _paintSummary(account) {
    const el = this._bodyEl.querySelector(".tx-summary");
    if (!el || !account) return;
    const b = account.balances;
    el.innerHTML = `<span>${t("Solde prévisionnel :")} <strong>${fmtAmount(b.total)} €</strong></span>
      <span>${t("Solde banque :")} <strong>${fmtAmount(b.pointed)} €</strong></span>
      <span>${t("Rapproché :")} <strong>${fmtAmount(b.reconciled)} €</strong></span>`;
  }

  // Re-reads only the three balances above the list (after a state change or a delete).
  async _refreshSummary() {
    const accounts = await this._items("list_accounts");
    this._lookups.accounts = accounts;
    this._lookups.account = new Map(accounts.map((a) => [a.id, a]));
    this._paintSummary(this._lookups.account.get(this._txAccountId));
  }

  // Pointage et rapprochement : deux boutons distincts (une rapprochée est forcément pointée).
  _stateButtonsHtml(state) {
    return `<button class="tx-state tx-point ${state >= 1 ? "on" : ""}" title="${state >= 1 ? t("Pointée") : t("Non pointée")}">${state >= 1 ? "☑" : "☐"}</button>
      <button class="tx-state tx-reco ${state === 2 ? "on" : ""}" title="${state === 2 ? t("Rapprochée") : t("Non rapprochée")}">${state === 2 ? "🔒" : "🔓"}</button>`;
  }

  // Optimistic: the buttons change at once; reverted with a message if the API refuses.
  async _toggleState(row, tx, which) {
    const previous = tx.state;
    let next;
    if (which === "point") {
      if (previous === 2 && !confirm(t("Dé-rapprocher et dé-pointer cette opération ?"))) return;
      next = previous === 0 ? 1 : 0;
    } else {
      if (previous === 2 && !confirm(t("Dé-rapprocher cette opération (elle reste pointée) ?"))) return;
      next = previous === 2 ? 1 : 2;
    }
    const box = row.querySelector(".tx-actions");
    const paint = (s) => {
      box.querySelectorAll(".tx-state").forEach((el) => el.remove());
      box.insertAdjacentHTML("afterbegin", this._stateButtonsHtml(s));
    };
    tx.state = next;
    paint(next);
    box.querySelectorAll(".tx-state").forEach((el) => (el.disabled = true));
    try {
      await this._call("set_transaction_state", { transaction_id: tx.id, state: next }, false);
      await this._refreshSummary();
    } catch (err) {
      tx.state = previous;
      paint(previous);
      alert(errMsg(err));
    } finally {
      box.querySelectorAll(".tx-state").forEach((el) => (el.disabled = false));
    }
  }

  async _deleteTransaction(row, btn, tx) {
    const question = tx.transfer_account_id ? t("Supprimer ce virement (les deux opérations) ?") : t("Supprimer cette opération ?");
    if (!confirm(question)) return;
    row.style.opacity = "0.4";
    btn.disabled = true;
    try {
      await this._call("delete_transaction", { transaction_id: tx.id }, false);
      row.remove();
      await this._refreshSummary();
    } catch (err) {
      row.style.opacity = "";
      btn.disabled = false;
      alert(errMsg(err));
    }
  }

  _options(list, selected, labelOf, emptyLabel) {
    const empty = emptyLabel === undefined ? "" : `<option value="">${esc(emptyLabel)}</option>`;
    return empty + list
      .map((x) => `<option value="${x.id}" ${x.id === selected ? "selected" : ""}>${esc(labelOf(x))}</option>`)
      .join("");
  }

  _categoryOptions(selected) {
    const active = this._lookups.categories.filter((c) => c.active || c.id === selected);
    return this._options(active, selected, (c) => `${"  ".repeat(c.depth)}${c.name}`, "—");
  }

  _classOptions(selected) {
    const active = this._lookups.classes.filter((c) => c.active || c.id === selected);
    return this._options(active, selected, (c) => `${"  ".repeat(c.depth)}${c.name}`, "—");
  }

  _splitRowHtml(split) {
    return `<div class="split-row">
      <select class="s-category">${this._categoryOptions(split.category_id ?? null)}</select>
      <select class="s-class">${this._classOptions(split.class_id ?? null)}</select>
      <input class="s-amount" type="text" inputmode="decimal" placeholder="${t("Montant")}" value="${esc(inputAmount(split.amount))}">
      <input class="s-label" type="text" placeholder="${t("Libellé")}" value="${esc(split.label || "")}">
      <button type="button" class="remove" title="${t("Retirer la ligne")}">✕</button>
    </div>`;
  }

  // onClose : fermeture du formulaire affiché à la place de la ligne (Annuler).
  // opts (carte de saisie rapide) : chooseAccount (compte modifiable), hidden (Set de clés ENTRY_FIELDS masquées :
  // les champs restent dans le formulaire, pré-remplis depuis le tiers et envoyés), showHidden + onToggleHidden(on) (bouton
  // qui affiche / masque les champs masqués), cancelLabel, autofocus (défaut : oui), onSaved({ service, payload, accountId }) à la place du rafraîchissement du volet Opérations.
  _showTransactionForm(container, tx, onClose, opts = {}) {
    const L = this._lookups;
    let accountId = this._txAccountId;
    const account = L.account.get(accountId);
    const hidden = opts.hidden || new Set();
    const isTransfer = tx ? !!tx.transfer_account_id : false;
    const types = tx
      ? isTransfer ? ["transfer_out", "transfer_in"] : ["expense", "income"]
      : ["expense", "income", "transfer_out", "transfer_in"];
    const typeLabels = { expense: t("Dépense"), income: t("Recette"), transfer_out: t("Virement vers…"), transfer_in: t("Virement depuis…") };
    const currentType = tx
      ? (isTransfer ? (Number(tx.amount) < 0 ? "transfer_out" : "transfer_in") : (Number(tx.amount) < 0 ? "expense" : "income"))
      : "expense";
    const split = tx && tx.splits.length === 1 ? tx.splits[0] : null;
    const payee = tx ? L.payee.get(tx.payee_id) : null;
    const others = () => L.accounts.filter((a) => a.id !== accountId && !a.closed);
    const accountField = opts.chooseAccount
      ? `<select name="account_id">${this._options(L.accounts.filter((a) => !a.closed), accountId, (a) => a.name)}</select>`
      : `<input type="text" value="${esc(account ? account.name : "")}" disabled>`;

    container.innerHTML = `
      <form class="entity-form tx-form">
        <label data-f="account">${t("Compte")}${accountField}</label>
        <label data-f="type">${t("Type")}<select name="type">${types.map((ty) => `<option value="${ty}" ${ty === currentType ? "selected" : ""}>${typeLabels[ty]}</option>`).join("")}</select></label>
        <label data-f="date">${t("Date")}<input type="date" name="date" value="${esc(tx ? tx.date : isoDate(new Date()))}" required></label>
        <label class="tiers-field f-payee" data-f="payee">${t("Tiers|champ")}
          <input type="text" name="payee" value="${esc(payee ? payee.name : "")}" autocomplete="off">
          <div class="tiers-suggestions" style="display: none;"></div>
        </label>
        <label class="f-transfer">${t("Autre compte")}<select name="other_account" ${tx ? "disabled" : ""}>${this._options(others(), tx ? tx.transfer_account_id : null, (a) => a.name)}</select></label>
        <label>${t("Montant")}<input type="text" name="amount" inputmode="decimal" value="${esc(tx ? inputAmount(tx.amount) : "")}" required></label>
        <label data-f="payment_method">${t("Mode de règlement")}<select name="payment_method_id">${this._options(L.methods.filter((m) => m.active || (tx && m.id === tx.payment_method_id)), tx ? tx.payment_method_id : null, (m) => m.name, "—")}</select></label>
        <label data-f="number">${t("N° de chèque")}<input type="text" name="number" value="${esc(tx ? tx.number || "" : "")}"></label>
        <label class="full" data-f="label">${t("Libellé")}<input type="text" name="label" value="${esc(tx ? tx.label || "" : "")}"></label>
        <label class="f-single" data-f="category">${t("Rubrique")}<select name="category_id">${this._categoryOptions(split ? split.category_id : null)}</select></label>
        <label class="f-single" data-f="class">${t("Classe")}<select name="class_id">${this._classOptions(split ? split.class_id : null)}</select></label>
        <div class="splits" style="display: none;">
          <div class="split-lines"></div>
          <div class="form-actions"><button type="button" class="secondary add-split">+ ${t("Ligne")}</button><span class="split-rest"></span></div>
        </div>
        <label class="check" data-f="state"><input type="checkbox" name="pointed" ${tx && tx.state >= 1 ? "checked" : ""}>${t("Pointée")}</label>
        <label class="check" data-f="state"><input type="checkbox" name="reconciled" ${tx && tx.state === 2 ? "checked" : ""}>${t("Rapprochée")}</label>
        <label data-f="notes">${t("Notes")}<input type="text" name="notes" value="${esc(tx ? tx.notes || "" : "")}"></label>
        <div class="form-actions">
          <button type="submit">${tx ? t("Enregistrer") : t("Créer")}</button>
          <button type="button" class="secondary toggle-split" data-f="split">${t("Ventiler")}</button>
          ${hidden.size ? `<button type="button" class="secondary toggle-hidden"></button>` : ""}
          <button type="button" class="cancel">${esc(opts.cancelLabel || t("Annuler"))}</button>
        </div>
      </form>
    `;
    const form = container.querySelector("form");
    const $ = (sel) => form.querySelector(sel);
    let showHidden = !!opts.showHidden;
    const applyHidden = () => {
      form.querySelectorAll("[data-f]").forEach((el) => el.classList.toggle("f-off", !showHidden && hidden.has(el.dataset.f)));
      if (hidden.size) $(".toggle-hidden").textContent = showHidden ? t("Moins de champs") : t("Tous les champs");
    };
    applyHidden();
    if (hidden.size) {
      $(".toggle-hidden").addEventListener("click", () => {
        showHidden = !showHidden;
        applyHidden();
        if (opts.onToggleHidden) opts.onToggleHidden(showHidden);
      });
    }
    const splitsBox = $(".splits");
    const lines = $(".split-lines");
    let splitMode = false;

    const sign = () => (["expense", "transfer_out"].includes($('[name="type"]').value) ? -1 : 1);
    const updateRest = () => {
      const total = toNumber($('[name="amount"]').value);
      const used = [...lines.querySelectorAll(".s-amount")].reduce((acc, el) => acc + (toNumber(el.value) || 0), 0);
      const rest = Math.round(((Number.isFinite(total) ? total : 0) - used) * 100) / 100;
      const restEl = $(".split-rest");
      restEl.textContent = rest === 0 ? t("Ventilation complète") : t("Reste à ventiler : {n}", { n: NUMBER.format(rest) });
      restEl.classList.toggle("bad", rest !== 0);
    };
    const setSplitMode = (on, initial) => {
      splitMode = on;
      splitsBox.style.display = on ? "flex" : "none";
      form.querySelectorAll(".f-single").forEach((el) => (el.style.display = on ? "none" : ""));
      $(".toggle-split").textContent = on ? t("Sans ventilation") : t("Ventiler");
      if (on && !lines.children.length) {
        const seed = initial || [{ category_id: $('[name="category_id"]').value ? Number($('[name="category_id"]').value) : null, class_id: $('[name="class_id"]').value ? Number($('[name="class_id"]').value) : null, amount: $('[name="amount"]').value ? -toNumber($('[name="amount"]').value) : "" }];
        lines.innerHTML = seed.map((s) => this._splitRowHtml(s)).join("");
      }
      updateRest();
    };
    const syncType = () => {
      const transfer = $('[name="type"]').value.startsWith("transfer");
      $(".f-payee").style.display = transfer ? "none" : "";
      $(".f-transfer").style.display = transfer ? "" : "none";
    };
    syncType();
    if (tx && tx.splits.length > 1) setSplitMode(true, tx.splits);

    $('[name="type"]').addEventListener("change", syncType);
    if (opts.chooseAccount) {
      // l'autre compte d'un virement ne peut pas être le compte choisi
      $('[name="account_id"]').addEventListener("change", (ev) => {
        accountId = Number(ev.target.value);
        $('[name="other_account"]').innerHTML = this._options(others(), null, (a) => a.name);
      });
    }
    $('[name="amount"]').addEventListener("input", updateRest);
    lines.addEventListener("input", updateRest);
    lines.addEventListener("click", (ev) => {
      if (ev.target.closest("button.remove")) {
        ev.target.closest(".split-row").remove();
        updateRest();
      }
    });
    $(".add-split").addEventListener("click", () => {
      lines.insertAdjacentHTML("beforeend", this._splitRowHtml({}));
      updateRest();
    });
    $(".toggle-split").addEventListener("click", () => {
      if (splitMode) {
        lines.innerHTML = "";
        setSplitMode(false);
      } else {
        setSplitMode(true);
      }
    });
    $(".cancel").addEventListener("click", () => (onClose ? onClose() : (container.innerHTML = "")));
    // Rapprochée implique pointée ; dé-pointer dé-rapproche.
    const pointedEl = $('[name="pointed"]');
    const reconciledEl = $('[name="reconciled"]');
    reconciledEl.addEventListener("change", () => { if (reconciledEl.checked) pointedEl.checked = true; });
    pointedEl.addEventListener("change", () => { if (!pointedEl.checked) reconciledEl.checked = false; });

    const payeeInput = $('[name="payee"]');
    // Pré-remplissage depuis la dernière opération du tiers, refait à chaque changement de tiers
    // (les champs pré-remplis sont alors remplacés, y compris vidés si la dernière opération ne les avait pas).
    let filledFor = null;
    const autofill = async (name) => {
      if (tx || !name) return;
      const p = L.payees.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!p || filledFor === p.id) return;
      filledFor = p.id;
      const set = (field, value) => ($(`[name="${field}"]`).value = value == null ? "" : String(value));
      set("category_id", p.default_category_id);
      try {
        const res = await this._call("search_transactions", { payee_id: p.id, limit: 1, order: "desc" }, true);
        const last = res && res.items && res.items[0];
        if (!last || filledFor !== p.id) return; // aucun historique, ou un autre tiers choisi entre-temps
        const one = last.splits.length === 1 ? last.splits[0] : null;
        set("category_id", (one && one.category_id) || p.default_category_id);
        set("class_id", one && one.class_id);
        set("payment_method_id", last.payment_method_id);
        set("label", last.label);
        if (!last.transfer_account_id) set("type", Number(last.amount) < 0 ? "expense" : "income");
      } catch (err) {
        // pré-remplissage best-effort : ne jamais bloquer la saisie
      }
    };
    this._payeeAutocomplete(payeeInput, $(".tiers-suggestions"), autofill, $('[name="amount"]'));
    if (!tx && opts.autofocus !== false) (hidden.has("payee") && !showHidden ? $('[name="amount"]') : payeeInput).focus();

    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const type = $('[name="type"]').value;
      const amount = toNumber($('[name="amount"]').value);
      if (!Number.isFinite(amount) || amount <= 0) {
        alert(t("Montant invalide (saisir un montant positif ; le type indique le sens)."));
        return;
      }
      const signed = (sign() * amount).toFixed(2);
      const optId = (name) => ($(`[name="${name}"]`).value ? Number($(`[name="${name}"]`).value) : null);
      const text = (name) => $(`[name="${name}"]`).value.trim() || null;
      const common = {
        date: $('[name="date"]').value,
        payment_method_id: optId("payment_method_id"),
        number: text("number"),
        label: text("label"),
        notes: text("notes"),
      };
      let analytic;
      if (splitMode) {
        const splits = [...lines.querySelectorAll(".split-row")].map((row) => ({
          category_id: row.querySelector(".s-category").value ? Number(row.querySelector(".s-category").value) : null,
          class_id: row.querySelector(".s-class").value ? Number(row.querySelector(".s-class").value) : null,
          amount: (sign() * toNumber(row.querySelector(".s-amount").value)).toFixed(2),
          label: row.querySelector(".s-label").value.trim() || null,
        }));
        if (!splits.length || splits.some((s) => s.amount === "NaN")) {
          alert(t("Ventilation incomplète : chaque ligne doit avoir un montant."));
          return;
        }
        analytic = { splits };
      } else {
        analytic = { category_id: optId("category_id"), class_id: optId("class_id") };
      }
      const state = reconciledEl.checked ? 2 : pointedEl.checked ? 1 : 0;
      let service;
      let payload;
      if (tx) {
        service = "update_transaction";
        payload = { transaction_id: tx.id, amount: signed, state, ...common, ...analytic };
        if (!isTransfer) {
          const name = payeeInput.value.trim();
          if (name) payload.payee_name = name;
          else payload.payee_id = null;
        }
      } else if (type.startsWith("transfer")) {
        const other = optId("other_account");
        if (!other) {
          alert(t("Choisir l'autre compte du virement."));
          return;
        }
        if (splitMode) {
          alert(t("Un virement ne se ventile pas : choisir une seule rubrique."));
          return;
        }
        const out = type === "transfer_out";
        service = "create_transfer";
        payload = {
          from_account_id: out ? accountId : other,
          to_account_id: out ? other : accountId,
          amount: amount.toFixed(2),
          [out ? "from_state" : "to_state"]: state,
          ...common,
          ...analytic,
        };
        delete payload.number;
      } else {
        service = "create_transaction";
        payload = { account_id: accountId, amount: signed, state, ...common, ...analytic };
        const name = payeeInput.value.trim();
        if (name) payload.payee_name = name;
      }
      for (const key of Object.keys(payload)) if (payload[key] === null && !tx) delete payload[key];
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      try {
        await this._call(service, payload, false);
        if (opts.onSaved) {
          opts.onSaved({ service, payload, accountId });
          return;
        }
        container.innerHTML = "";
        this._lookups = null; // un tiers a pu être créé
        this._renderActive(true); // sur place : la liste ne remonte pas en haut
      } catch (err) {
        submit.disabled = false;
        alert(errMsg(err));
      }
    });
  }

  // --- Échéancier --------------------------------------------------------------------------------

  async _renderSchedules() {
    await this._ensureLookups();
    const [schedules, upcoming] = await Promise.all([
      this._items("list_schedules"),
      this._items("list_upcoming_occurrences", { days: TERM_DAYS }),
    ]);
    this._schedItems = new Map(schedules.map((s) => [s.id, s]));
    this._refreshAlerts([schedules, upcoming]);
    const endDate = new Map(endingSchedules(schedules, upcoming).map((e) => [e.schedule.id, e.last.date]));
    const upcomingHtml = upcoming
      .map((o) => {
        const s = this._schedItems.get(o.schedule_id);
        return `<div class="tx-row ${o.overdue ? "overdue" : ""}" data-schedule="${o.schedule_id}" data-rank="${o.rank}">
          <div class="tx-main">
            <div class="tx-info">
              <div class="tx-desc">${esc(o.label)}</div>
              <div class="tx-sub">${esc([
                frDate(o.date),
                o.overdue ? t("en retard") : "",
                autoEntryDate(o.date, s) ? t("inscription auto le {date}", { date: frDate(autoEntryDate(o.date, s)) }) : "",
                this._schedAccounts(s),
                o.auto ? "" : t("saisie manuelle"),
              ].filter(Boolean).join(" · "))}</div>
            </div>
            <div class="tx-right">
              <div class="tx-amounts"><div class="tx-amount ${Number(o.amount) > 0 ? "credit" : ""}">${Number(o.amount) > 0 ? "+" : ""}${fmtAmount(o.amount)} €</div></div>
              <div class="tx-actions">
                <button class="occ-generate" title="${t("Saisir l'opération maintenant")}">✓</button>
                <button class="occ-skip" title="${t("Sauter cette échéance")}">⏭</button>
              </div>
            </div>
          </div>
        </div>`;
      })
      .join("");
    const listHtml = schedules
      .map((s) => {
        const sub = [
          this._schedAccounts(s),
          freqLabel(s),
          s.next_date ? t("prochaine : {date}", { date: frDate(s.next_date) }) : t("terminée"),
          s.total_occurrences ? t("{done}/{total} générées", { done: s.generated, total: s.total_occurrences }) : "",
          s.active ? "" : t("inactive"),
          s.auto ? "" : t("saisie manuelle"),
        ].filter(Boolean);
        const amount = s.next_amount ?? s.amount;
        return `<div class="tx-row ${s.active ? "" : "future"}" data-id="${s.id}">
          <div class="tx-main">
            <div class="tx-info">
              <div class="tx-desc">${esc(s.label)}${s.mode === "installments" ? ` <span class="badge">${t("échéancier")}</span>` : ""}${endDate.has(s.id) ? ` <span class="badge warn" title="${t("Dernière échéance dans les {n} jours", { n: TERM_DAYS })}">${t("fin le {date}", { date: esc(frDate(endDate.get(s.id))) })}</span>` : ""}</div>
              <div class="tx-sub">${esc(sub.join(" · "))}</div>
            </div>
            <div class="tx-right">
              <div class="tx-amounts"><div class="tx-amount ${Number(amount) > 0 ? "credit" : ""}">${Number(amount) > 0 ? "+" : ""}${fmtAmount(amount)} €</div></div>
              <div class="tx-actions">
                <button class="grid" title="${t("Échéances")}">📅</button>
                <button class="edit" title="${t("Modifier")}">✎</button>
                <button class="del" title="${t("Supprimer")}">✕</button>
              </div>
            </div>
          </div>
        </div>`;
      })
      .join("");
    this._bodyEl.innerHTML = `
      <div class="toolbar"><button class="add">+ ${t("Opération planifiée")}</button></div>
      <div class="form-container"></div>
      <div class="month-sep">${t("À venir (30 jours)")}</div>
      <div class="upcoming-list">${upcomingHtml || `<div class="empty">${t("Aucune échéance dans les 30 prochains jours.")}</div>`}</div>
      <div class="month-sep">${t("Opérations planifiées")}</div>
      <div class="sched-list">${listHtml || `<div class="empty">${t("Aucune opération planifiée.")}</div>`}</div>
    `;
    const formContainer = this._bodyEl.querySelector(".form-container");
    this._bodyEl.querySelector(".add").addEventListener("click", () => this._showScheduleForm(formContainer, null));
    this._bodyEl.querySelector(".upcoming-list").addEventListener("click", async (ev) => {
      const btn = ev.target.closest("button");
      const row = ev.target.closest("[data-schedule]");
      if (!btn || !row) return;
      const data = { schedule_id: Number(row.dataset.schedule), rank: Number(row.dataset.rank) };
      const service = btn.classList.contains("occ-generate") ? "generate_occurrence" : "skip_occurrence";
      if (service === "skip_occurrence" && !confirm(t("Sauter cette échéance (elle ne sera pas saisie) ?"))) return;
      btn.disabled = true;
      try {
        await this._call(service, data, false);
        this._renderActive();
      } catch (err) {
        btn.disabled = false;
        alert(errMsg(err));
      }
    });
    this._bodyEl.querySelector(".sched-list").addEventListener("click", async (ev) => {
      const btn = ev.target.closest("button");
      const row = ev.target.closest(".tx-row[data-id]");
      if (!btn || !row) return;
      const s = this._schedItems.get(Number(row.dataset.id));
      if (btn.classList.contains("edit")) {
        this._showScheduleForm(formContainer, s);
      } else if (btn.classList.contains("grid")) {
        this._showOccurrences(formContainer, s);
      } else if (btn.classList.contains("del")) {
        if (!confirm(t("Supprimer « {label} » ? Les opérations déjà saisies restent.", { label: s.label }))) return;
        try {
          await this._call("delete_schedule", { schedule_id: s.id }, false);
          this._renderActive();
        } catch (err) {
          alert(errMsg(err));
        }
      }
    });
    // « Voir » du bandeau : panneau des échéances de la planification
    const open = this._openSchedule && this._schedItems.get(this._openSchedule);
    this._openSchedule = null;
    if (open) await this._showOccurrences(formContainer, open);
  }

  _schedAccounts(s) {
    if (!s) return "";
    const name = (id) => (this._lookups.account.get(id) || {}).name || t("compte {id}", { id });
    if (!s.transfer_account_id) return name(s.account_id);
    return Number(s.amount) <= 0
      ? `${name(s.account_id)} → ${name(s.transfer_account_id)}`
      : `${name(s.transfer_account_id)} → ${name(s.account_id)}`;
  }

  // Tiers : autocomplétion maison (le <datalist> natif est peu fiable sur mobile), dès 3 caractères.
  // Clavier : ↓ / ↑ parcourent les suggestions, Entrée ou Tab valident celle en surbrillance ;
  // Entrée passe ensuite au champ `next` (Tab y va de lui-même).
  _payeeAutocomplete(input, box, onPick, next) {
    let active = -1;
    const items = () => [...box.querySelectorAll("[data-name]")];
    const open = () => box.style.display !== "none" && items().length > 0;
    const highlight = (i) => {
      active = i;
      items().forEach((el, j) => el.classList.toggle("active", j === i));
      if (i >= 0) items()[i].scrollIntoView({ block: "nearest" });
    };
    const pick = (name) => {
      input.value = name;
      box.style.display = "none";
      active = -1;
      onPick(name);
    };
    input.addEventListener("input", () => {
      const value = input.value.trim().toLowerCase();
      const matches = value.length < 3 ? [] : this._lookups.payees.filter((p) => p.active && p.name.toLowerCase().includes(value)).slice(0, 8);
      box.innerHTML = matches.map((p) => `<div data-name="${esc(p.name)}">${esc(p.name)}</div>`).join("");
      box.style.display = matches.length ? "block" : "none";
      active = -1;
    });
    input.addEventListener("keydown", (ev) => {
      if (!open()) return;
      const n = items().length;
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        highlight((active + 1) % n);
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        highlight(active <= 0 ? n - 1 : active - 1);
      } else if (ev.key === "Escape") {
        box.style.display = "none";
      } else if ((ev.key === "Enter" || ev.key === "Tab") && active >= 0) {
        if (ev.key === "Enter") ev.preventDefault(); // ne pas valider le formulaire
        pick(items()[active].dataset.name);
        if (ev.key === "Enter" && next) next.focus();
      }
    });
    box.addEventListener("mousedown", (ev) => {
      const item = ev.target.closest("[data-name]");
      if (!item) return;
      ev.preventDefault();
      pick(item.dataset.name);
    });
    input.addEventListener("blur", () => {
      setTimeout(() => (box.style.display = "none"), 150);
      onPick(input.value.trim());
    });
  }

  _showScheduleForm(container, s) {
    const L = this._lookups;
    const accounts = L.accounts.filter((a) => !a.closed || (s && (a.id === s.account_id || a.id === s.transfer_account_id)));
    const accountId = s ? s.account_id : (this._txAccountId || (accounts[0] && accounts[0].id));
    const type = s
      ? (s.transfer_account_id ? (Number(s.amount) <= 0 ? "transfer_out" : "transfer_in") : (Number(s.amount) < 0 ? "expense" : "income"))
      : "expense";
    const typeLabels = { expense: t("Dépense"), income: t("Recette"), transfer_out: t("Virement vers…"), transfer_in: t("Virement depuis…") };
    const payee = s ? L.payee.get(s.payee_id) : null;
    const unitOptions = Object.entries(UNITS).map(([k, u]) => `<option value="${k}" ${k === (s ? s.unit : "month") ? "selected" : ""}>${u.plural}</option>`).join("");
    const endMode = s ? s.end_mode : "never";
    container.innerHTML = `
      <form class="entity-form sched-form">
        <label>${t("Compte")}<select name="account_id">${this._options(accounts, accountId, (a) => a.name)}</select></label>
        <label>${t("Type")}<select name="type">${Object.entries(typeLabels).map(([k, v]) => `<option value="${k}" ${k === type ? "selected" : ""}>${v}</option>`).join("")}</select></label>
        <label class="f-amount">${t("Montant")}<input type="text" name="amount" inputmode="decimal" value="${esc(s ? inputAmount(s.amount) : "")}" required></label>
        <label class="tiers-field f-payee">${t("Tiers|champ")}
          <input type="text" name="payee" value="${esc(payee ? payee.name : "")}" autocomplete="off">
          <div class="tiers-suggestions" style="display: none;"></div>
        </label>
        <label class="f-transfer">${t("Autre compte")}<select name="transfer_account_id">${this._options(accounts, s ? s.transfer_account_id : null, (a) => a.name, "—")}</select></label>
        <label class="full">${t("Libellé")}<input type="text" name="label" value="${esc(s ? s.label : "")}" placeholder="${t("Par défaut : le tiers")}"></label>
        <label>${t("Mode de règlement")}<select name="payment_method_id">${this._options(L.methods.filter((m) => m.active || (s && m.id === s.payment_method_id)), s ? s.payment_method_id : null, (m) => m.name, "—")}</select></label>
        <label>${t("Rubrique")}<select name="category_id">${this._categoryOptions(s ? s.category_id : null)}</select></label>
        <label>${t("Classe")}<select name="class_id">${this._classOptions(s ? s.class_id : null)}</select></label>
        <label>${t("Mode")}<select name="mode">
          <option value="periodic" ${!s || s.mode === "periodic" ? "selected" : ""}>${t("Périodique (montant fixe)")}</option>
          <option value="installments" ${s && s.mode === "installments" ? "selected" : ""}>${t("Échéancier (montant par échéance)")}</option>
        </select></label>
        <label>${t("Première échéance")}<input type="date" name="start_date" value="${esc(s ? s.start_date : isoDate(new Date()))}" required></label>
        <label>${t("Tous les")}<input type="number" name="every" min="1" value="${s ? s.every : 1}"></label>
        <label>${t("Unité")}<select name="unit">${unitOptions}</select></label>
        <label>${t("Fin")}<select name="end_mode">
          <option value="never" ${endMode === "never" ? "selected" : ""}>${t("Jamais")}</option>
          <option value="count" ${endMode === "count" ? "selected" : ""}>${t("Après N échéances")}</option>
          <option value="date" ${endMode === "date" ? "selected" : ""}>${t("À une date")}</option>
        </select></label>
        <label class="f-count">${t("Nombre d'échéances")}<input type="number" name="count" min="1" value="${s && s.count ? s.count : 12}"></label>
        <label class="f-end-date">${t("Dernière échéance au plus tard le")}<input type="date" name="end_date" value="${esc(s && s.end_date ? s.end_date : "")}"></label>
        <label>${t("Jours d'anticipation")}<input type="number" name="lead_days" min="0" max="90" value="${s ? s.lead_days : 0}"><span class="muted f-lead-info"></span></label>
        <label>${t("Ne rien saisir d'office avant le")}<input type="date" name="generate_from" value="${esc(s ? s.generate_from : isoDate(new Date()))}"></label>
        <label class="check"><input type="checkbox" name="auto" ${!s || s.auto ? "checked" : ""}>${t("Saisie automatique à l'échéance")}</label>
        <label class="check"><input type="checkbox" name="active" ${!s || s.active ? "checked" : ""}>${t("Active")}</label>
        <label class="full">${t("Notes")}<input type="text" name="notes" value="${esc(s ? s.notes || "" : "")}"></label>
        <div class="full inst-box" hidden>
          <div class="inst-head">
            <strong>${t("Montants et dates par échéance")}</strong><span class="muted inst-info"></span>
            <button type="button" class="secondary inst-dates">${t("Dates de la règle")}</button>
            <label class="check"><input type="checkbox" class="inst-shift" checked>${t("Changer une date décale les suivantes")}</label>
          </div>
          <div class="table-wrap inst-wrap"><table>
            <thead><tr><th class="num">${t("N°")}</th><th>${t("Date")}</th><th class="num">${t("Montant")}</th><th></th></tr></thead>
            <tbody></tbody>
          </table></div>
          <div class="muted hint">${t("Montants positifs (le type donne le sens) ; ⇓ recopie un montant sur les échéances suivantes. Une date changée (trou dans l'échéancier, report) ne suit plus la règle ; « Dates de la règle » les rétablit toutes. Les échéances déjà saisies ne se modifient pas ici.")}</div>
        </div>
        <div class="form-actions">
          <button type="submit">${s ? t("Enregistrer") : t("Créer")}</button>
          <button type="button" class="cancel">${t("Annuler")}</button>
        </div>
      </form>
    `;
    const form = container.querySelector("form");
    const $ = (sel) => form.querySelector(sel);
    const sync = () => {
      const transfer = $('[name="type"]').value.startsWith("transfer");
      $(".f-payee").style.display = transfer ? "none" : "";
      $(".f-transfer").style.display = transfer ? "" : "none";
      const end = $('[name="end_mode"]');
      if ($('[name="mode"]').value === "installments" && end.value === "never") end.value = "count";
      end.querySelector('option[value="never"]').disabled = $('[name="mode"]').value === "installments";
      $(".f-count").style.display = end.value === "count" ? "" : "none";
      $(".f-end-date").style.display = end.value === "date" ? "" : "none";
      const installments = $('[name="mode"]').value === "installments";
      // Échéancier : les montants se saisissent dans la grille, le champ Montant est grisé. Ce qu'il contenait
      // pré-remplit la grille ; au retour en périodique, il reprend le montant de la première échéance.
      const amountInput = $('[name="amount"]');
      if (installments && lastMode !== "installments") {
        base = amountInput.value;
        amountInput.value = "";
      } else if (!installments && lastMode === "installments") {
        const first = (ranks() || []).find((r) => !frozen.has(r.rank));
        amountInput.value = (first && valueOf(first.rank)) || base;
      }
      lastMode = installments ? "installments" : "periodic";
      amountInput.readOnly = installments;
      amountInput.required = !installments;
      amountInput.placeholder = installments ? t("Saisi dans la grille") : "";
      if (installments) $('[name="count"]').max = String(MAX_INSTALLMENTS);
      else $('[name="count"]').removeAttribute("max");
      renderGrid();
    };

    // Échéancier : un montant par échéance, saisi dès le choix du mode (dates calculées comme l'API).
    const box = $(".inst-box");
    const gridBody = box.querySelector("tbody");
    let base = ""; // montant (texte) des échéances non saisies : celui de la planification, ou le champ Montant avant l'échéancier
    let lastMode = null;
    const custom = new Map(); // rang → montant saisi (texte)
    const customDate = new Map(); // rang → date propre (AAAA-MM-JJ), différente de celle de la règle
    const frozen = new Map(); // rang → { amount, date } d'une échéance déjà saisie (non modifiable)
    let gridRanks = []; // [{ rank, date }] ; null si la durée dépasse la limite
    const ranks = () => {
      const start = $('[name="start_date"]').value;
      if (!start) return [];
      const unit = $('[name="unit"]').value;
      const every = Number($('[name="every"]').value) || 1;
      const endMode = $('[name="end_mode"]').value;
      const list = [];
      if (endMode === "count") {
        const n = Number($('[name="count"]').value) || 0;
        if (n > MAX_INSTALLMENTS) return null;
        for (let r = 1; r <= n; r++) list.push({ rank: r, date: occurrenceDate(start, unit, every, r) });
      } else if (endMode === "date") {
        const end = $('[name="end_date"]').value;
        if (!end) return [];
        for (let r = 1; ; r++) {
          const date = occurrenceDate(start, unit, every, r);
          if (date > end) break;
          if (r > MAX_INSTALLMENTS) return null;
          list.push({ rank: r, date });
        }
      }
      return list;
    };
    const valueOf = (rank) => (frozen.has(rank) ? inputAmount(frozen.get(rank).amount) : custom.has(rank) ? custom.get(rank) : base);
    const dateOf = ({ rank, date }) => (frozen.has(rank) ? frozen.get(rank).date : customDate.get(rank) || date);
    const setDate = (r, value) => (value === r.date ? customDate.delete(r.rank) : customDate.set(r.rank, value));
    const paintInfo = () => {
      const info = box.querySelector(".inst-info");
      if (gridRanks === null) {
        info.textContent = t("{n} échéances au maximum : réduire la durée", { n: MAX_INSTALLMENTS });
        info.classList.add("bad");
        return;
      }
      const total = gridRanks.reduce((acc, r) => acc + (toNumber(valueOf(r.rank)) || 0), 0);
      info.textContent = gridRanks.length
        ? t("{n} échéance(s) · total {total} €", { n: gridRanks.length, total: NUMBER.format(total) })
        : t("Indiquer la première échéance et la fin");
      info.classList.remove("bad");
    };
    // Sous « Jours d'anticipation » : date d'inscription de la 1re échéance à saisir (prochaine, en modification),
    // comme l'API : date ≥ « ne rien saisir avant le », inscription à la date − anticipation, tout de suite si elle est passée.
    const paintLead = () => {
      const info = $(".f-lead-info");
      const start = $('[name="start_date"]').value;
      if (!$('[name="active"]').checked) return void (info.textContent = t("Inactive : rien ne sera inscrit"));
      if (!$('[name="auto"]').checked) return void (info.textContent = t("Saisie manuelle : pas d'inscription automatique"));
      if (!start) return void (info.textContent = "");
      const unit = $('[name="unit"]').value;
      const every = Number($('[name="every"]').value) || 1;
      const endMode = $('[name="end_mode"]').value;
      const count = Number($('[name="count"]').value) || 0;
      const end = $('[name="end_date"]').value;
      const from = $('[name="generate_from"]').value || isoDate(new Date());
      const installments = $('[name="mode"]').value === "installments";
      let first = null;
      for (let r = s ? s.next_rank || (s.total_occurrences || 0) + 1 : 1; r <= 1200; r++) {
        const rule = occurrenceDate(start, unit, every, r);
        if ((endMode === "count" && r > count) || (endMode === "date" && (!end || rule > end))) break;
        const date = installments ? dateOf({ rank: r, date: rule }) : rule;
        if (installments && frozen.has(r)) continue;
        if (date >= from) {
          first = date;
          break;
        }
      }
      if (!first) return void (info.textContent = t("Aucune échéance à inscrire"));
      const [y, m, d] = first.split("-").map(Number);
      const entry = isoDate(new Date(y, m - 1, d - (Number($('[name="lead_days"]').value) || 0)));
      const vars = { date: frDate(first), entry: frDate(entry) };
      const now = entry <= isoDate(new Date());
      info.textContent = s
        ? (now ? t("Prochaine échéance ({date}) inscrite dès l'enregistrement", vars) : t("Prochaine échéance ({date}) inscrite le {entry}", vars))
        : (now ? t("1re échéance ({date}) inscrite dès l'enregistrement", vars) : t("1re échéance ({date}) inscrite le {entry}", vars));
    };
    const renderGrid = () => {
      paintLead();
      box.hidden = $('[name="mode"]').value !== "installments";
      if (box.hidden) return;
      gridRanks = ranks();
      gridBody.innerHTML = (gridRanks || []).map((r) => {
        const { rank } = r;
        return frozen.has(rank)
        ? `<tr class="muted" data-rank="${rank}"><td class="num">${rank}</td><td>${frDate(dateOf(r))}</td><td class="num">${fmtAmount(Math.abs(Number(frozen.get(rank).amount)))} €</td><td>${t("Saisie")}</td></tr>`
        : `<tr data-rank="${rank}"><td class="num">${rank}</td>
            <td><input class="i-date ${customDate.has(rank) ? "custom" : ""}" type="date" value="${esc(dateOf(r))}"></td>
            <td class="num"><input class="i-amount ${custom.has(rank) ? "custom" : ""}" type="text" inputmode="decimal" value="${esc(valueOf(rank))}"></td>
            <td class="actions"><button type="button" class="i-down" title="${t("Recopier ce montant sur les échéances suivantes")}">⇓</button></td></tr>`;
      }).join("");
      paintInfo();
    };
    gridBody.addEventListener("change", (ev) => {
      if (!ev.target.classList.contains("i-date")) return;
      const i = gridRanks.findIndex((r) => r.rank === Number(ev.target.closest("tr[data-rank]").dataset.rank));
      const before = dateOf(gridRanks[i]);
      const value = ev.target.value;
      if (!value) {
        ev.target.value = before;
        return;
      }
      setDate(gridRanks[i], value);
      if (box.querySelector(".inst-shift").checked) {
        for (const r of gridRanks.slice(i + 1)) if (!frozen.has(r.rank)) setDate(r, shiftDate(dateOf(r), before, value));
      }
      const scroll = box.querySelector(".inst-wrap").scrollTop;
      renderGrid();
      box.querySelector(".inst-wrap").scrollTop = scroll;
    });
    gridBody.addEventListener("input", (ev) => {
      if (!ev.target.classList.contains("i-amount")) return;
      const tr = ev.target.closest("tr[data-rank]");
      custom.set(Number(tr.dataset.rank), ev.target.value);
      ev.target.classList.add("custom");
      paintInfo();
    });
    gridBody.addEventListener("click", (ev) => {
      if (!ev.target.closest(".i-down")) return;
      const tr = ev.target.closest("tr[data-rank]");
      const value = tr.querySelector(".i-amount").value;
      let after = false;
      for (const row of gridBody.querySelectorAll("tr[data-rank]")) {
        const input = row.querySelector(".i-amount");
        if (after && input) {
          input.value = value;
          input.classList.add("custom");
          custom.set(Number(row.dataset.rank), value);
        }
        if (row === tr) after = true;
      }
      paintInfo();
    });
    box.querySelector(".inst-dates").addEventListener("click", () => {
      customDate.clear();
      renderGrid();
    });
    // Planification existante : montants et dates propres, échéances déjà saisies.
    if (s) {
      this._call("list_schedule_occurrences", { schedule_id: s.id, upcoming: 240 }, true)
        .then((data) => {
          for (const o of (data && data.items) || []) {
            if (o.status === "generated") {
              frozen.set(o.rank, { amount: o.amount, date: o.date });
              continue;
            }
            if (o.own_amount) custom.set(o.rank, inputAmount(o.amount));
            if (o.own_date) customDate.set(o.rank, o.date);
          }
          renderGrid();
        })
        .catch(() => {});
    }
    sync();
    form.addEventListener("input", paintLead);
    form.addEventListener("change", paintLead);
    ["type", "mode", "end_mode", "unit"].forEach((n) => $(`[name="${n}"]`).addEventListener("change", sync));
    ["start_date", "every", "count", "end_date"].forEach((n) => $(`[name="${n}"]`).addEventListener("input", renderGrid));
    $(".cancel").addEventListener("click", () => (container.innerHTML = ""));
    this._payeeAutocomplete($('[name="payee"]'), $(".tiers-suggestions"), (name) => {
      const p = L.payees.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (p && !$('[name="category_id"]').value && p.default_category_id) $('[name="category_id"]').value = String(p.default_category_id);
    }, $('[name="amount"]'));

    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const kind = $('[name="type"]').value;
      const installments = $('[name="mode"]').value === "installments";
      // Échéancier : le montant de la planification est celui de la première échéance modifiable (la grille fait foi).
      const firstEditable = installments ? (ranks() || []).find((r) => !frozen.has(r.rank)) : null;
      const amount = installments ? gridNumber(firstEditable ? valueOf(firstEditable.rank) : base) : toNumber($('[name="amount"]').value);
      if (!installments && (!Number.isFinite(amount) || amount < 0)) {
        alert(t("Montant invalide (saisir un montant positif ; le type indique le sens)."));
        return;
      }
      const transfer = kind.startsWith("transfer");
      const optId = (name) => ($(`[name="${name}"]`).value ? Number($(`[name="${name}"]`).value) : null);
      const payeeName = $('[name="payee"]').value.trim();
      const payload = {
        account_id: optId("account_id"),
        amount: ((["expense", "transfer_out"].includes(kind) ? -1 : 1) * amount).toFixed(2),
        label: $('[name="label"]').value.trim() || (!transfer && payeeName) || t("Opération planifiée"),
        payment_method_id: optId("payment_method_id"),
        category_id: optId("category_id"),
        class_id: optId("class_id"),
        transfer_account_id: transfer ? optId("transfer_account_id") : null,
        mode: $('[name="mode"]').value,
        start_date: $('[name="start_date"]').value,
        every: Number($('[name="every"]').value) || 1,
        unit: $('[name="unit"]').value,
        end_mode: $('[name="end_mode"]').value,
        count: $('[name="end_mode"]').value === "count" ? Number($('[name="count"]').value) : null,
        end_date: $('[name="end_mode"]').value === "date" ? $('[name="end_date"]').value || null : null,
        lead_days: Number($('[name="lead_days"]').value) || 0,
        auto: $('[name="auto"]').checked,
        active: $('[name="active"]').checked,
        notes: $('[name="notes"]').value.trim() || null,
      };
      if ($('[name="generate_from"]').value) payload.generate_from = $('[name="generate_from"]').value;
      if (transfer && !payload.transfer_account_id) {
        alert(t("Choisir l'autre compte du virement."));
        return;
      }
      if (!transfer) {
        if (payeeName) payload.payee_name = payeeName;
        else payload.payee_id = null;
      }
      if (s) payload.schedule_id = s.id;
      else for (const key of Object.keys(payload)) if (payload[key] === null) delete payload[key];
      // Échéancier : la grille est enregistrée juste après la planification. Pour qu'aucune échéance due ne soit
      // saisie entre-temps au montant de base, la planification reste inactive le temps d'enregistrer la grille.
      let items = null;
      if (payload.mode === "installments") {
        gridRanks = ranks();
        if (gridRanks === null) {
          alert(t("Un échéancier compte au plus {n} échéances : réduire la durée.", { n: MAX_INSTALLMENTS }));
          return;
        }
        const sign = ["expense", "transfer_out"].includes(kind) ? -1 : 1;
        const editable = gridRanks.filter((r) => !frozen.has(r.rank));
        const values = editable.map((r) => ({ rank: r.rank, value: gridNumber(valueOf(r.rank)) }));
        const bad = values.find((v) => !Number.isFinite(v.value) || v.value < 0);
        if (bad || !Number.isFinite(amount) || amount < 0) {
          alert(t("Échéance {n} : montant invalide (saisir un montant positif ; le type indique le sens).", { n: bad ? bad.rank : 1 }));
          return;
        }
        const late = misorderedDate(gridRanks.map((r) => ({ rank: r.rank, date: dateOf(r) })));
        if (late) {
          alert(t("Échéance {n} : sa date ({date}) précède celle de l'échéance {prev}.", { n: late.rank, date: frDate(late.date), prev: late.rank - 1 }));
          return;
        }
        items = values.map((v) => {
          const item = { rank: v.rank, amount: (sign * v.value).toFixed(2) };
          if (customDate.has(v.rank)) item.date = customDate.get(v.rank);
          return item;
        });
      }
      const reactivate = items !== null && payload.active && payload.auto;
      if (reactivate) payload.active = false;
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      let saved = null;
      try {
        saved = await this._call(s ? "update_schedule" : "create_schedule", payload, true);
        const id = s ? s.id : saved.id;
        if (items) await this._call("set_schedule_occurrences", { schedule_id: id, items }, false);
        if (reactivate) await this._call("update_schedule", { schedule_id: id, active: true }, false);
        container.innerHTML = "";
        this._lookups = null; // un tiers a pu être créé
        this._renderActive();
      } catch (err) {
        if (!saved) {
          submit.disabled = false;
          alert(errMsg(err));
          return;
        }
        // la planification est enregistrée, mais pas la suite : le dire clairement et montrer l'état réel
        const next = reactivate
          ? t("La planification a été enregistrée mais laissée inactive : vérifier ses montants (Échéances) puis la réactiver.")
          : t("La planification a été enregistrée : vérifier ses montants (Échéances).");
        alert(`${errMsg(err)}\n\n${next}`);
        container.innerHTML = "";
        this._lookups = null;
        this._renderActive();
      }
    });
    container.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  async _showOccurrences(container, s) {
    container.innerHTML = `<div class="loading">${t("Chargement…")}</div>`;
    const data = await this._call("list_schedule_occurrences", { schedule_id: s.id }, true);
    const items = (data && data.items) || [];
    const editable = s.mode === "installments";
    const sign = Number(s.amount) < 0 ? -1 : 1;
    const statusLabel = { pending: t("À venir"), generated: t("Saisie"), skipped: t("Sautée"), ignored: t("Antérieure") };
    const rowHtml = (o) => {
      const frozen = o.status === "generated";
      const amount = editable && !frozen
        ? `<input class="o-amount" type="text" inputmode="decimal" value="${esc(inputAmount(o.amount))}">`
        : `${fmtAmount(o.amount)} €`;
      const date = editable && !frozen
        ? `<input class="o-date ${o.own_date ? "custom" : ""}" type="date" value="${esc(o.date)}">`
        : frDate(o.date);
      const actions = [];
      if (editable && !frozen) actions.push(`<button type="button" class="o-down" title="${t("Recopier ce montant sur les échéances suivantes")}">⇓</button>`);
      if (o.status === "pending" || o.status === "ignored") {
        actions.push(`<button type="button" class="o-generate" title="${t("Saisir l'opération maintenant")}">✓</button>`);
        actions.push(`<button type="button" class="o-skip" title="${t("Sauter")}">⏭</button>`);
      }
      if (o.status === "skipped") actions.push(`<button type="button" class="o-restore" title="${t("Rétablir")}">↺</button>`);
      return `<tr data-rank="${o.rank}" class="${frozen ? "muted" : ""}">
        <td class="num">${o.rank}</td><td>${date}</td>
        <td class="num">${amount}</td><td>${statusLabel[o.status] || o.status}</td>
        <td class="actions">${actions.join("")}</td></tr>`;
    };
    container.innerHTML = `
      <div class="entity-form occ-panel">
        <div class="full"><strong>${esc(s.label)}</strong> — ${esc(freqLabel(s))}${s.total_occurrences ? t(", {n} échéances", { n: s.total_occurrences }) : ` ${t("(sans fin : prochaines échéances)")}`}</div>
        <div class="full table-wrap"><table>
          <thead><tr><th class="num">${t("N°")}</th><th>${t("Date")}</th><th class="num">${t("Montant")}</th><th>${t("État")}</th><th></th></tr></thead>
          <tbody>${items.map(rowHtml).join("")}</tbody>
        </table></div>
        <div class="form-actions">
          ${editable ? `<button type="button" class="o-save">${t("Enregistrer la grille")}</button><label class="check"><input type="checkbox" class="o-shift" checked>${t("Changer une date décale les suivantes")}</label>` : ""}
          <button type="button" class="cancel">${t("Fermer")}</button>
        </div>
      </div>`;
    const panel = container.querySelector(".occ-panel");
    const inputs = () => [...panel.querySelectorAll("tr[data-rank]")].filter((tr) => tr.querySelector(".o-amount"));
    panel.querySelector(".cancel").addEventListener("click", () => (container.innerHTML = ""));
    if (editable) {
      panel.querySelector("tbody").addEventListener("focusin", (ev) => {
        if (ev.target.classList.contains("o-date")) ev.target.dataset.before = ev.target.value;
      });
      panel.querySelector("tbody").addEventListener("change", (ev) => {
        if (!ev.target.classList.contains("o-date")) return;
        const before = ev.target.dataset.before;
        const value = ev.target.value;
        if (!value) {
          ev.target.value = before;
          return;
        }
        ev.target.classList.add("custom");
        ev.target.dataset.before = value;
        if (!before || !panel.querySelector(".o-shift").checked) return;
        let after = false;
        inputs().forEach((row) => {
          const input = row.querySelector(".o-date");
          if (after) {
            input.value = shiftDate(input.value, before, value);
            input.classList.add("custom");
          }
          if (row === ev.target.closest("tr")) after = true;
        });
      });
      panel.querySelector(".o-save").addEventListener("click", async (ev) => {
        const values = inputs().map((tr) => ({
          rank: Number(tr.dataset.rank),
          value: gridNumber(tr.querySelector(".o-amount").value),
          date: tr.querySelector(".o-date").value,
        }));
        if (values.some((v) => !Number.isFinite(v.value) || v.value < 0)) {
          alert(t("Chaque échéance doit avoir un montant positif (le sens est celui de l'opération planifiée)."));
          return;
        }
        const late = misorderedDate(items.map((o) => values.find((v) => v.rank === o.rank) || o));
        if (late) {
          alert(t("Échéance {n} : sa date ({date}) précède celle de l'échéance {prev}.", { n: late.rank, date: frDate(late.date), prev: late.rank - 1 }));
          return;
        }
        ev.target.disabled = true;
        try {
          // Date envoyée telle quelle : l'API ne garde comme date propre que celle qui diffère de la règle.
          const grid = values.map((v) => ({ rank: v.rank, amount: (sign * v.value).toFixed(2), date: v.date }));
          await this._call("set_schedule_occurrences", { schedule_id: s.id, items: grid }, false);
          this._renderActive();
        } catch (err) {
          ev.target.disabled = false;
          alert(errMsg(err));
        }
      });
    }
    panel.querySelector("tbody").addEventListener("click", async (ev) => {
      const btn = ev.target.closest("button");
      const tr = ev.target.closest("tr[data-rank]");
      if (!btn || !tr) return;
      if (btn.classList.contains("o-down")) {
        const value = tr.querySelector(".o-amount").value;
        let after = false;
        inputs().forEach((row) => {
          if (after) row.querySelector(".o-amount").value = value;
          if (row === tr) after = true;
        });
        return;
      }
      const service = btn.classList.contains("o-generate") ? "generate_occurrence"
        : btn.classList.contains("o-skip") ? "skip_occurrence" : "restore_occurrence";
      btn.disabled = true;
      try {
        await this._call(service, { schedule_id: s.id, rank: Number(tr.dataset.rank) }, false);
        const fresh = await this._items("list_schedules");
        this._schedItems = new Map(fresh.map((x) => [x.id, x]));
        await this._showOccurrences(container, this._schedItems.get(s.id) || s);
      } catch (err) {
        btn.disabled = false;
        alert(errMsg(err));
      }
    });
    container.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // --- Budgets -----------------------------------------------------------------------------------

  async _renderBudgets() {
    await this._ensureLookups();
    const budgets = await this._items("list_budgets");
    const accountName = (id) => (this._lookups.account.get(id) || {}).name || t("compte {id}", { id });
    if (!budgets.some((b) => b.id === this._budgetId)) {
      const month = isoDate(new Date()).slice(0, 7) + "-01";
      const current = budgets.find((b) => !b.archived && b.start_month <= month && b.end_month >= month);
      this._budgetId = (current || budgets.find((b) => !b.archived) || budgets[0] || {}).id;
    }
    this._budgetView = this._budgetView || "report";
    const budget = budgets.find((b) => b.id === this._budgetId);
    this._bodyEl.innerHTML = `
      <div class="tx-toolbar">
        ${budgets.length ? `<select class="b-select">${budgets.map((b) => `<option value="${b.id}" ${b.id === this._budgetId ? "selected" : ""}>${esc(b.name)} — ${esc(accountName(b.account_id))}${b.archived ? ` ${t("(archivé)")}` : ""}</option>`).join("")}</select>
        <select class="b-view"><option value="report" ${this._budgetView === "report" ? "selected" : ""}>${t("Suivi")}</option><option value="grid" ${this._budgetView === "grid" ? "selected" : ""}>${t("Saisie|vue")}</option></select>` : ""}
        <button class="b-add">+ ${t("Budget")}</button>
        ${budget ? `<button class="secondary b-copy">${t("Copier")}</button><button class="secondary b-edit">${t("Modifier")}</button><button class="secondary b-del">${t("Supprimer")}</button>` : ""}
      </div>
      <div class="form-container"></div>
      <div class="b-content">${budget ? `<div class="loading">${t("Chargement…")}</div>` : `<div class="empty">${t("Aucun budget. Un budget suit un compte : montants prévus par rubrique et par mois, puis réalisé et écarts.")}</div>`}</div>
    `;
    const formContainer = this._bodyEl.querySelector(".form-container");
    const on = (sel, evt, fn) => { const el = this._bodyEl.querySelector(sel); if (el) el.addEventListener(evt, fn); };
    on(".b-select", "change", (ev) => { this._budgetId = Number(ev.target.value); this._renderActive(); });
    on(".b-view", "change", (ev) => { this._budgetView = ev.target.value; this._renderActive(); });
    on(".b-add", "click", () => this._showForm(formContainer, this._budgetConfig(), null));
    // Modifier un budget = aussi saisir ses montants : on passe en vue saisie sous le formulaire.
    on(".b-edit", "click", async () => {
      if (this._budgetView !== "grid") {
        this._budgetView = "grid";
        await this._renderActive();
      }
      this._showForm(this._bodyEl.querySelector(".form-container"), this._budgetConfig(), { ...budget, start_month: budget.start_month.slice(0, 7) });
    });
    on(".b-copy", "click", () => this._showForm(formContainer, this._budgetCopyConfig(budget), null));
    on(".b-del", "click", async () => {
      if (!confirm(t("Supprimer le budget « {name} » et tous ses montants ?", { name: budget.name }))) return;
      try {
        await this._call("delete_budget", { budget_id: budget.id }, false);
        this._budgetId = null;
        this._renderActive();
      } catch (err) {
        alert(errMsg(err));
      }
    });
    if (!budget) return;
    const content = this._bodyEl.querySelector(".b-content");
    if (this._budgetView === "grid") await this._renderBudgetGrid(content, budget);
    else await this._renderBudgetReport(content, budget);
  }

  _budgetConfig() {
    return {
      idField: "budget_id",
      services: ["create_budget", "update_budget"],
      afterSave: (res) => {
        if (res && res.id) this._budgetId = res.id;
        this._budgetView = "grid"; // budget créé ou modifié : on enchaîne sur la saisie des montants
      },
      fields: [
        { key: "name", label: t("Nom"), required: true },
        { key: "account_id", label: t("Compte"), type: "select", options: () => this._lookups.accounts.filter((a) => !a.closed).map((a) => ({ id: a.id, name: a.name })) },
        { key: "start_month", label: t("Premier mois"), type: "month", required: true, default: `${new Date().getFullYear()}-01` },
        { key: "months", label: t("Nombre de mois"), type: "number", default: 12 },
        { key: "notes", label: t("Notes") },
        { key: "archived", label: t("Archivé"), type: "checkbox" },
      ],
    };
  }

  _budgetCopyConfig(source) {
    const [y, m] = source.end_month.split("-").map(Number);
    const next = isoDate(new Date(y, m, 1)).slice(0, 7); // mois suivant la fin du budget copié
    return {
      services: ["copy_budget"],
      submitLabel: t("Copier"),
      afterSave: (res) => { if (res && res.id) this._budgetId = res.id; },
      beforeSave: (payload) => ({ ...payload, budget_id: source.id }),
      fields: [
        { key: "name", label: t("Nom du nouveau budget"), required: true, default: t("{name} (copie)", { name: source.name }) },
        { key: "start_month", label: t("Premier mois"), type: "month", required: true, default: next },
        { key: "months", label: t("Nombre de mois"), type: "number", default: source.months },
      ],
    };
  }

  // Rubriques dans l'ordre de l'arbre, regroupées par type (recettes, dépenses, épargne).
  _byKind(rows) {
    return ["income", "expense", "savings"].map((kind) => ({ kind, rows: rows.filter((r) => r.kind === kind) }));
  }

  // Rubriques repliées (suivi et saisie partagent l'état), mémorisées dans le navigateur.
  _collapsedCats() {
    if (!this._budgetCollapsed) {
      let ids = [];
      try { ids = JSON.parse(window.localStorage.getItem(COLLAPSE_KEY) || "[]"); } catch (e) { /* stockage indisponible */ }
      this._budgetCollapsed = new Set(ids);
    }
    return this._budgetCollapsed;
  }

  _toggleCollapsed(id) {
    const set = this._collapsedCats();
    if (set.has(id)) set.delete(id);
    else set.add(id);
    try { window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set])); } catch (e) { /* idem */ }
  }

  // Lignes `tr[data-cat][data-parent]` : masque celles dont un ancêtre affiché est replié, met à jour les flèches.
  _applyCollapse(tbody) {
    const collapsed = this._collapsedCats();
    const rows = [...tbody.querySelectorAll("tr[data-cat]")];
    const parentOf = new Map(rows.map((tr) => [tr.dataset.cat, tr.dataset.parent]));
    for (const tr of rows) {
      let p = tr.dataset.parent;
      let hidden = false;
      while (p && parentOf.has(p) && !hidden) {
        hidden = collapsed.has(Number(p));
        p = parentOf.get(p);
      }
      tr.hidden = hidden;
      const btn = tr.querySelector(".tree-toggle");
      const isCollapsed = !!btn && collapsed.has(Number(tr.dataset.cat));
      tr.classList.toggle("collapsed", isCollapsed);
      if (btn) {
        btn.textContent = isCollapsed ? "▸" : "▾";
        btn.title = isCollapsed ? t("Déplier (montants sous-rubriques comprises)") : t("Replier");
      }
    }
  }

  // Flèches ▾ / ▸ et boutons « Tout replier / Tout déplier » d'un tableau de budget.
  _wireCollapse(content, onChange) {
    const tbody = content.querySelector("tbody");
    const apply = () => {
      this._applyCollapse(tbody);
      if (onChange) onChange();
    };
    tbody.addEventListener("click", (ev) => {
      const btn = ev.target.closest(".tree-toggle");
      if (!btn) return;
      this._toggleCollapsed(Number(btn.closest("tr").dataset.cat));
      apply();
    });
    const all = (fold) => {
      const set = this._collapsedCats();
      for (const btn of tbody.querySelectorAll(".tree-toggle")) {
        const id = Number(btn.closest("tr").dataset.cat);
        if (fold !== set.has(id)) this._toggleCollapsed(id);
      }
      apply();
    };
    content.querySelector(".b-fold").addEventListener("click", () => all(true));
    content.querySelector(".b-unfold").addEventListener("click", () => all(false));
    apply();
  }

  _treeLabel(name, depth, toggle, info) {
    return `<span style="display: inline-block; padding-left: ${depth * 20}px">${toggle ? '<button type="button" class="tree-toggle"></button>' : '<span class="tree-spacer"></span>'}${esc(name)}${info || ""}</span>`;
  }

  // Période du suivi : toute la période, jusqu'à la fin du mois précédent, un mois, ou une plage de mois.
  // Le rapport de l'API donne chaque montant mois par mois : les périodes se calculent ici.
  _budgetPeriodIndexes(months) {
    const current = isoDate(new Date()).slice(0, 7);
    const p = this._budgetMonth;
    if (p === "all") return months.map((_, i) => i);
    if (p === "todate") return months.map((m, i) => (m < current ? i : -1)).filter((i) => i >= 0);
    if (p === "range") {
      const from = this._budgetFrom || months[0];
      const to = this._budgetTo || months[months.length - 1];
      return months.map((m, i) => (m >= from && m <= to ? i : -1)).filter((i) => i >= 0);
    }
    return [months.indexOf(p)];
  }

  // Barre de réalisation : réalisé / prévu. Dépense au-delà du prévu en rouge, recette ou épargne atteinte en vert.
  _progressHtml(kind, planned, actual) {
    const p = Number(planned);
    const a = Number(actual);
    if (!p) return a ? `<span class="muted">${t("hors budget")}</span>` : "";
    const pct = Math.round((a / p) * 100);
    const cls = kind === "expense" ? (pct > 100 ? "over" : "") : pct >= 100 ? "good" : "";
    return `<div class="pbar ${cls}" title="${esc(t("{actual} réalisés sur {planned} prévus", { actual: fmtAmount(actual), planned: fmtAmount(planned) }))}"><div style="width: ${Math.max(0, Math.min(pct, 100))}%"></div><span>${pct} %</span></div>`;
  }

  async _renderBudgetReport(content, budget) {
    const r = await this._call("get_budget_report", { budget_id: budget.id }, true);
    const months = r.months;
    if (!["all", "todate", "range"].includes(this._budgetMonth) && !months.includes(this._budgetMonth)) {
      const current = isoDate(new Date()).slice(0, 7);
      this._budgetMonth = months.includes(current) ? current : "all";
    }
    const idx = this._budgetPeriodIndexes(months);
    // ⓘ : opérations du compte du budget sur la période affichée
    const ctx = { account: budget.account_id, ...(idx.length ? this._monthBounds(months[idx[0]], months[idx[idx.length - 1]]) : {}) };
    const pick = (arr) => idx.reduce((acc, i) => acc + Number(arr[i]), 0).toFixed(2);
    const hasValues = new Set(r.rows.filter((x) => Number(x.planned_total) || Number(x.actual_total)).map((x) => x.category_id));
    const showAll = !!this._budgetShowAll;
    const variance = (v) => `<td class="num ${Number(v) < 0 ? "neg" : Number(v) > 0 ? "pos" : ""}">${Number(v) > 0 ? "+" : ""}${fmtAmount(v)}</td>`;
    const groups = this._byKind(r.rows)
      .map(({ kind, rows }) => {
        const visible = rows.filter((x) => showAll || hasValues.has(x.category_id));
        if (!visible.length) return "";
        const branches = new Set(visible.map((x) => x.parent_id));
        const tot = r.totals[kind];
        const tp = pick(tot.planned);
        const ta = pick(tot.actual);
        const tv = kind === "expense" ? Number(tp) - Number(ta) : Number(ta) - Number(tp);
        return `<tr class="kind-row"><td>${esc(KIND_TITLES[kind])}</td><td>${this._progressHtml(kind, tp, ta)}</td><td class="num">${fmtAmount(tp)}</td><td class="num">${fmtAmount(ta)}</td>${variance(tv.toFixed(2))}</tr>`
          + visible.map((x) => {
            const xp = pick(x.planned);
            const xa = pick(x.actual);
            return `<tr data-cat="${x.category_id}" data-parent="${x.parent_id ?? ""}" class="${x.has_children ? "tree-branch" : ""}">
              <td>${this._treeLabel(x.name, x.depth, branches.has(x.category_id), this._catInfoHtml(x.category_id, ctx))}</td>
              <td>${this._progressHtml(kind, xp, xa)}</td>
              <td class="num">${fmtAmount(xp)}</td>
              <td class="num">${fmtAmount(xa)}</td>
              ${variance(pick(x.variance))}
            </tr>`;
          }).join("");
      })
      .join("");
    const net = r.totals.net;
    const uncategorized = pick(r.uncategorized);
    const monthOpts = (selected) => months.map((m) => `<option value="${m}" ${m === selected ? "selected" : ""}>${esc(monthLabel(m, "long"))}</option>`).join("");
    const period = this._budgetMonth;
    content.innerHTML = `
      <div class="tx-toolbar">
        <select class="b-month">
          <option value="all" ${period === "all" ? "selected" : ""}>${t("Toute la période")}</option>
          <option value="todate" ${period === "todate" ? "selected" : ""}>${t("Jusqu'à la fin du mois précédent")}</option>
          <option value="range" ${period === "range" ? "selected" : ""}>${t("Plage de mois…")}</option>
          ${monthOpts(period)}
        </select>
        ${period === "range" ? `<label class="check-inline">${t("de")} <select class="b-from">${monthOpts(this._budgetFrom || months[0])}</select></label>
          <label class="check-inline">${t("à")} <select class="b-to">${monthOpts(this._budgetTo || months[months.length - 1])}</select></label>` : ""}
        <label class="check-inline"><input type="checkbox" class="b-all" ${showAll ? "checked" : ""}> ${t("Toutes les rubriques")}</label>
        <button type="button" class="secondary b-fold">${t("Tout replier")}</button><button type="button" class="secondary b-unfold">${t("Tout déplier")}</button>
      </div>
      <div class="table-wrap"><table class="budget-report">
        <thead><tr><th>${t("Rubrique")}</th><th>${t("Réalisation")}</th><th class="num">${t("Prévu")}</th><th class="num">${t("Réalisé")}</th><th class="num">${t("Écart")}</th></tr></thead>
        <tbody>${groups || `<tr><td colspan="5" class="muted">${t("Aucun montant prévu ni réalisé.")}</td></tr>`}</tbody>
        <tfoot>
          ${Number(uncategorized) ? `<tr><td>${t("Sans rubrique")}</td><td></td><td></td><td class="num">${fmtAmount(uncategorized)}</td><td></td></tr>` : ""}
          <tr class="kind-row"><td>${t("Solde du compte sur la période")}</td><td></td><td class="num">${fmtAmount(pick(net.planned))}</td><td class="num">${fmtAmount(pick(net.actual))}</td>${variance((Number(pick(net.actual)) - Number(pick(net.planned))).toFixed(2))}</tr>
        </tfoot>
      </table></div>
      <div class="muted hint">${idx.length ? "" : `${t("Aucun mois du budget dans cette période.")} `}${t("Écart positif = favorable (moins dépensé, plus reçu ou épargné). Montants des rubriques parentes, sous-rubriques comprises. ▾ / ▸ replie ou déplie une rubrique.")}</div>
    `;
    this._wireCollapse(content);
    const rerender = () => this._renderBudgetReport(content, budget);
    content.querySelector(".b-month").addEventListener("change", (ev) => { this._budgetMonth = ev.target.value; rerender(); });
    content.querySelector(".b-all").addEventListener("change", (ev) => { this._budgetShowAll = ev.target.checked; rerender(); });
    const from = content.querySelector(".b-from");
    const to = content.querySelector(".b-to");
    if (from) {
      from.addEventListener("change", () => {
        this._budgetFrom = from.value;
        if ((this._budgetTo || months[months.length - 1]) < from.value) this._budgetTo = from.value;
        rerender();
      });
      to.addEventListener("change", () => {
        this._budgetTo = to.value;
        if ((this._budgetFrom || months[0]) > to.value) this._budgetFrom = to.value;
        rerender();
      });
    }
  }

  async _renderBudgetGrid(content, budget) {
    const data = await this._call("get_budget_lines", { budget_id: budget.id }, true);
    const months = data.months;
    const cell = new Map(data.lines.map((l) => [`${l.category_id}|${l.month}`, l.amount]));
    const used = new Set(data.lines.map((l) => l.category_id));
    const cats = this._lookups.categories.filter((c) => c.active || used.has(c.id));
    const parents = new Set(this._lookups.categories.map((c) => c.parent_id).filter((id) => id !== null));
    const shown = new Set(cats.map((c) => c.parent_id));
    const account = this._lookups.account.get(budget.account_id);
    // Sens d'une rubrique dans le solde du compte (même règle que le suivi de l'API).
    const direction = (kind) => (kind === "income" || (kind === "savings" && account && account.kind === "savings") ? 1 : -1);
    const valueCells = (cls) => months.map((m) => `<td class="${cls}" data-month="${m}"></td>`).join("") + `<td class="num row-total"></td>`;
    const rowHtml = (c) => `<tr data-cat="${c.id}" data-parent="${c.parent_id ?? ""}" data-kind="${c.kind}" class="${parents.has(c.id) ? "tree-branch" : ""}">
        <td class="sticky">${this._treeLabel(c.name, c.depth, shown.has(c.id), this._catInfoHtml(c.id, { account: budget.account_id }))}
          <button type="button" class="b-right" title="${t("Recopier le dernier montant saisi sur les mois suivants")}">⇉</button></td>
        ${months.map((m) => `<td><input type="text" inputmode="decimal" data-month="${m}" value="${esc(cell.has(`${c.id}|${m}`) ? inputAmount(cell.get(`${c.id}|${m}`)) : "")}"><span class="agg"></span></td>`).join("")}
        <td class="num row-total"></td>
      </tr>`;
    // Ligne « Total <rubrique mère> » (sous-rubriques comprises), après le dernier de ses descendants.
    const sumHtml = (c) => `<tr class="sum-row" data-sum="${c.id}">
        <td class="sticky"><span style="display: inline-block; padding-left: ${c.depth * 20 + 28}px">${t("Total {name}", { name: esc(c.name) })}</span></td>${valueCells("v")}
      </tr>`;
    const groupHtml = (rows) => {
      let html = "";
      const open = []; // rubriques mères dont le sous-arbre est en cours
      for (const c of rows) {
        while (open.length && open[open.length - 1].depth >= c.depth) html += sumHtml(open.pop());
        html += rowHtml(c);
        if (shown.has(c.id)) open.push(c);
      }
      while (open.length) html += sumHtml(open.pop());
      return html;
    };
    const body = this._byKind(cats)
      .filter((g) => g.rows.length)
      .map((g) => `<tr class="kind-row" data-kind-total="${g.kind}"><td class="sticky">${esc(KIND_TITLES[g.kind])}</td>${valueCells("v")}</tr>${groupHtml(g.rows)}`)
      .join("");
    content.innerHTML = `
      <div class="tx-toolbar"><button type="button" class="secondary b-fold">${t("Tout replier")}</button><button type="button" class="secondary b-unfold">${t("Tout déplier")}</button></div>
      <div class="muted hint">${t("Montants positifs, dans le sens de la rubrique (300 = 300 € de dépense prévus). ⇉ recopie le dernier montant saisi de la ligne sur les mois suivants. Une rubrique repliée (▸) affiche ses montants sous-rubriques comprises. Les lignes en majuscules totalisent chaque type ; « Total … » totalise une rubrique mère et ses sous-rubriques.")}</div>
      <div class="table-wrap"><table class="budget-grid">
        <thead><tr><th class="sticky">${t("Rubrique")}</th>${months.map((m) => `<th>${esc(monthLabel(m, "short"))}</th>`).join("")}<th>${t("Total")}</th></tr></thead>
        <tbody>${body}</tbody>
        <tfoot>
          <tr class="net-total"><td class="sticky">${account && account.kind === "savings" ? t("Solde prévu (recettes − dépenses + épargne)") : t("Solde prévu (recettes − dépenses − épargne)")}</td>${valueCells("v")}</tr>
        </tfoot>
      </table></div>
      <div class="form-actions"><button type="button" class="b-save">${t("Enregistrer")}</button><button type="button" class="cancel b-reset">${t("Annuler")}</button></div>
    `;
    const table = content.querySelector("table");
    const tbody = content.querySelector("tbody");
    const lastFocus = new Map();
    let dirty = false;
    const rows = [...tbody.querySelectorAll("tr[data-cat]")];
    const rowOf = new Map(rows.map((tr) => [tr.dataset.cat, tr]));
    const childrenOf = new Map();
    for (const tr of rows) if (tr.dataset.parent) childrenOf.set(tr.dataset.parent, [...(childrenOf.get(tr.dataset.parent) || []), tr]);
    const own = (tr) => [...tr.querySelectorAll("input")].map((el) => toNumber(el.value) || 0);
    const subtree = (tr) => {
      const v = own(tr);
      for (const child of childrenOf.get(tr.dataset.cat) || []) subtree(child).forEach((x, i) => (v[i] += x));
      return v;
    };
    const fmt = (x) => (Math.round(x * 100) ? NUMBER.format(x) : "");
    const paint = (tr, v) => {
      tr.querySelectorAll("td.v").forEach((td, i) => (td.textContent = fmt(v[i])));
      tr.querySelector(".row-total").textContent = fmt(v.reduce((a, b) => a + b, 0));
    };
    // Totaux : chaque montant saisi compte une fois (lignes « propres »), quelle que soit l'arborescence.
    const refresh = () => {
      const byKind = {};
      const net = months.map(() => 0);
      for (const tr of rows) {
        const mine = own(tr);
        const collapsed = tr.classList.contains("collapsed");
        const v = collapsed ? subtree(tr) : mine;
        if (collapsed) tr.querySelectorAll(".agg").forEach((el, i) => (el.textContent = v[i] ? NUMBER.format(v[i]) : ""));
        tr.querySelector(".row-total").textContent = fmt(v.reduce((a, b) => a + b, 0));
        const kind = tr.dataset.kind;
        byKind[kind] = byKind[kind] || months.map(() => 0);
        mine.forEach((x, i) => {
          byKind[kind][i] += x;
          net[i] += direction(kind) * x;
        });
      }
      for (const tr of tbody.querySelectorAll("tr[data-kind-total]")) paint(tr, byKind[tr.dataset.kindTotal] || months.map(() => 0));
      for (const tr of tbody.querySelectorAll("tr.sum-row")) {
        const parent = rowOf.get(tr.dataset.sum);
        // inutile quand la rubrique mère est repliée (elle affiche déjà le cumul) ou masquée
        tr.hidden = !parent || parent.hidden || parent.classList.contains("collapsed");
        if (parent) paint(tr, subtree(parent));
      }
      paint(table.querySelector("tr.net-total"), net);
    };
    this._wireCollapse(content, refresh);
    tbody.addEventListener("input", () => {
      dirty = true;
      refresh();
    });
    // Repère de la cellule en cours : ligne et colonne légèrement teintées.
    const clearCross = () => table.querySelectorAll(".cur-row, .cur-col").forEach((el) => el.classList.remove("cur-row", "cur-col"));
    tbody.addEventListener("focusin", (ev) => {
      if (!ev.target.matches("input")) return;
      const td = ev.target.closest("td");
      const tr = td.closest("tr");
      lastFocus.set(tr, ev.target);
      clearCross();
      tr.classList.add("cur-row");
      for (const row of table.rows) if (row.cells.length > td.cellIndex) row.cells[td.cellIndex].classList.add("cur-col");
    });
    tbody.addEventListener("focusout", (ev) => {
      if (!ev.relatedTarget || !tbody.contains(ev.relatedTarget)) clearCross();
    });
    tbody.addEventListener("click", (ev) => {
      const btn = ev.target.closest(".b-right");
      if (!btn) return;
      const tr = btn.closest("tr");
      const inputs = [...tr.querySelectorAll("input")];
      const from = lastFocus.get(tr) || inputs.find((el) => el.value.trim()) || inputs[0];
      const start = inputs.indexOf(from);
      inputs.slice(start + 1).forEach((el) => (el.value = from.value));
      dirty = true;
      refresh();
    });
    // Annuler : abandonne les saisies et revient au suivi.
    content.querySelector(".b-reset").addEventListener("click", () => {
      if (dirty && !confirm(t("Abandonner les montants saisis non enregistrés ?"))) return;
      this._budgetView = "report";
      this._renderActive();
    });
    content.querySelector(".b-save").addEventListener("click", async (ev) => {
      const lines = [];
      for (const tr of tbody.querySelectorAll("tr[data-cat]")) {
        for (const el of tr.querySelectorAll("input")) {
          if (!el.value.trim()) continue;
          const n = toNumber(el.value);
          if (!Number.isFinite(n)) {
            alert(t("Montant invalide : « {value} »", { value: el.value }));
            el.focus();
            return;
          }
          if (n) lines.push({ category_id: Number(tr.dataset.cat), month: el.dataset.month, amount: n.toFixed(2) });
        }
      }
      ev.target.disabled = true;
      try {
        await this._call("set_budget_lines", { budget_id: budget.id, lines }, false);
        this._budgetView = "report";
        this._renderActive();
      } catch (err) {
        ev.target.disabled = false;
        alert(errMsg(err));
      }
    });
  }

  // --- Listes avec formulaire (comptes, rubriques, classes, tiers) ------------------------------

  // --- Comptes partagés (décision 019) : dépenses communes d'un groupe, sans lien avec les comptes bancaires ---
  // Liste des comptes partagés, puis un écran par compte (this._shareId). Tout le calcul (parts, prochain payeur,
  // remboursements) vient de l'API.

  async _renderShares() {
    if (this._shareId) return this._renderShareDetail();
    const items = await this._items("list_shared_accounts");
    const row = (a) => {
      const names = a.participants.map((p) => p.name).join(", ");
      const next = a.participants.find((p) => p.id === a.next_participant_id);
      const sub = [
        names,
        t("{n} dépense(s)", { n: a.expense_count }),
        a.closed ? t("clôturé le {date}", { date: frDate(a.closed_on) }) : next ? t("prochain : {name}", { name: next.name }) : "",
      ];
      return `<div class="tx-row share-row" data-share="${a.id}">
        <div class="tx-main">
          <div class="tx-info">
            <div class="tx-desc">${esc(a.name)}</div>
            <div class="tx-sub">${esc(sub.filter(Boolean).join(" · "))}</div>
          </div>
          <div class="tx-right"><div class="tx-amounts"><div class="tx-amount">${fmtAmount(a.total)} €</div></div><span class="share-go">›</span></div>
        </div>
      </div>`;
    };
    const open = items.filter((a) => !a.closed);
    const closed = items.filter((a) => a.closed);
    this._bodyEl.innerHTML = `
      <div class="toolbar"><button class="add">+ ${t("Compte partagé")}</button></div>
      <div class="form-container"></div>
      <div class="month-sep">${t("En cours")}</div>
      <div class="share-list">${open.map(row).join("") || `<div class="empty">${t("Aucun compte partagé en cours. Un compte partagé réunit les dépenses communes d'un groupe (vacances…) pour les équilibrer.")}</div>`}</div>
      ${closed.length ? `<div class="month-sep">${t("Clôturés")}</div><div class="share-list">${closed.map(row).join("")}</div>` : ""}`;
    this._bodyEl.querySelectorAll(".share-row").forEach((el) => el.addEventListener("click", () => {
      this._shareId = Number(el.dataset.share);
      this._renderActive();
    }));
    this._bodyEl.querySelector(".add").addEventListener("click", () => this._showShareForm(this._bodyEl.querySelector(".form-container"), null));
  }

  // Création (account = null) ou modification : nom, notes, participants (renommer, retirer, ajouter).
  _showShareForm(container, account) {
    const people = account ? account.participants : [{ name: "" }, { name: "" }];
    const personHtml = (p) => `<div class="share-person" data-id="${p.id || ""}">
        <input type="text" class="p-name" value="${esc(p.name)}" placeholder="${t("Prénom")}">
        ${account && p.id ? `<button type="button" class="p-del" title="${p.expense_count ? t("A payé des dépenses : ne peut pas être retiré") : t("Retirer")}" ${p.expense_count ? "disabled" : ""}>✕</button>` : ""}
      </div>`;
    container.innerHTML = `
      <form class="entity-form share-form">
        <label class="full">${t("Nom")}<input type="text" name="name" value="${esc(account ? account.name : "")}" placeholder="${t("Week-end à la mer")}" required></label>
        <div class="full share-people"><div class="muted">${t("Participants (toi compris), au moins deux")}</div>${people.map(personHtml).join("")}</div>
        <div class="full"><button type="button" class="secondary p-add">+ ${t("Participant")}</button></div>
        <label class="full">${t("Notes")}<input type="text" name="notes" value="${esc(account ? account.notes || "" : "")}"></label>
        <div class="form-actions">
          <button type="submit">${account ? t("Enregistrer") : t("Créer")}</button>
          <button type="button" class="cancel">${t("Annuler")}</button>
        </div>
      </form>`;
    const form = container.querySelector("form");
    const list = form.querySelector(".share-people");
    const removed = [];
    form.querySelector(".p-add").addEventListener("click", () => {
      list.insertAdjacentHTML("beforeend", personHtml({ name: "" }));
      list.lastElementChild.querySelector("input").focus();
    });
    list.addEventListener("click", (ev) => {
      const btn = ev.target.closest(".p-del");
      if (!btn) return;
      const row = btn.closest(".share-person");
      removed.push(Number(row.dataset.id));
      row.remove();
    });
    form.querySelector(".cancel").addEventListener("click", () => (container.innerHTML = ""));
    form.querySelector('[name="name"]').focus();
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const name = form.querySelector('[name="name"]').value.trim();
      const notes = form.querySelector('[name="notes"]').value.trim() || null;
      const rows = [...list.querySelectorAll(".share-person")]
        .map((el) => ({ id: el.dataset.id ? Number(el.dataset.id) : null, name: el.querySelector(".p-name").value.trim() }))
        .filter((p) => p.id || p.name);
      if (rows.some((p) => !p.name)) return alert(t("Chaque participant doit avoir un nom."));
      if (rows.length < 2) return alert(t("Il faut au moins deux participants."));
      const folded = rows.map((p) => p.name.toLowerCase());
      if (new Set(folded).size !== folded.length) return alert(t("Deux participants portent le même nom."));
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      try {
        if (!account) {
          const res = await this._call("create_shared_account", { name, participants: rows.map((p) => p.name), ...(notes ? { notes } : {}) }, true);
          this._shareId = res.id;
        } else {
          const id = account.id;
          await this._call("update_shared_account", { shared_account_id: id, name, notes }, false);
          // ajouts d'abord : on ne descend jamais sous deux participants en cours de route
          for (const p of rows.filter((x) => !x.id)) await this._call("add_shared_participant", { shared_account_id: id, name: p.name }, false);
          for (const p of rows.filter((x) => x.id && x.name !== account.participants.find((o) => o.id === x.id).name)) {
            await this._call("rename_shared_participant", { shared_account_id: id, participant_id: p.id, name: p.name }, false);
          }
          for (const pid of removed) await this._call("remove_shared_participant", { shared_account_id: id, participant_id: pid }, false);
        }
        this._renderActive();
      } catch (err) {
        submit.disabled = false;
        alert(errMsg(err));
        if (account) this._renderActive(true); // une partie a pu être enregistrée : montrer l'état réel
      }
    });
  }

  async _renderShareDetail() {
    let a;
    try {
      a = await this._call("get_shared_account", { shared_account_id: this._shareId }, true);
    } catch (err) {
      this._shareId = null; // supprimé entre-temps
      return this._renderShares();
    }
    const name = new Map(a.participants.map((p) => [p.id, p.name]));
    const next = a.participants.find((p) => p.id === a.next_participant_id);
    const share = a.participants.length ? a.participants[0].share : "0";
    const signed = (v) => `${Number(v) > 0 ? "+" : ""}${fmtAmount(v)} €`;
    const people = `<div class="table-wrap"><table class="share-table">
        <thead><tr><th>${t("Participant")}</th><th class="num">${t("Payé")}</th><th class="num">${t("Part")}</th><th class="num">${t("Solde")}</th></tr></thead>
        <tbody>${a.participants.map((p) => `<tr class="${p.id === a.next_participant_id ? "share-next" : ""}">
          <td>${esc(p.name)}${p.id === a.next_participant_id ? ` <span class="badge warn">${t("prochain")}</span>` : ""}</td>
          <td class="num">${fmtAmount(p.paid)} €</td><td class="num">${fmtAmount(p.share)} €</td>
          <td class="num ${Number(p.balance) < 0 ? "neg" : Number(p.balance) > 0 ? "pos" : ""}">${signed(p.balance)}</td></tr>`).join("")}</tbody>
      </table></div>
      <div class="muted hint">${t("Solde = payé − part : positif, la personne doit recevoir ; négatif, elle doit verser.")}</div>`;
    const transfers = a.settlement.length
      ? a.settlement.map((x) => `<div class="share-transfer"><span>${t("{from} verse à {to}", { from: `<strong>${esc(x.from_name)}</strong>`, to: `<strong>${esc(x.to_name)}</strong>` })}</span><strong>${fmtAmount(x.amount)} €</strong></div>`).join("")
      : `<div class="empty">${t("Personne ne doit rien : chacun a payé sa part.")}</div>`;
    const expenses = a.expenses.map((e) => `<div class="tx-row" data-expense="${e.id}">
        <div class="tx-main">
          <div class="tx-info">
            <div class="tx-desc">${esc(e.label || t("Dépense"))}</div>
            <div class="tx-sub">${esc(`${frDate(e.date)} · ${t("payé par {name}", { name: name.get(e.participant_id) || "?" })}`)}</div>
          </div>
          <div class="tx-right">
            <div class="tx-amounts"><div class="tx-amount">${fmtAmount(e.amount)} €</div></div>
            ${a.closed ? "" : `<div class="tx-actions"><button class="edit" title="${t("Modifier")}">✎</button><button class="del" title="${t("Supprimer")}">✕</button></div>`}
          </div>
        </div>
      </div>`).join("") || `<div class="empty">${t("Aucune dépense pour l'instant.")}</div>`;
    const head = `<div class="tx-toolbar"><button class="secondary tx-back sh-back">← ${t("Comptes partagés")}</button></div>
      <div class="share-head"><div class="share-name">${esc(a.name)}</div>
        <div class="muted">${t("Total {total} € · part de chacun {share} €", { total: fmtAmount(a.total), share: fmtAmount(share) })}${a.participants.length && a.participants.some((p) => p.share !== share) ? ` ${t("(à un centime près)")}` : ""}${a.notes ? ` · ${esc(a.notes)}` : ""}</div></div>
      <div class="ok-msg" hidden></div>
      <div class="form-container"></div>`;
    const actions = a.closed
      ? `<div class="form-actions share-actions"><button class="secondary sh-reopen">${t("Rouvrir")}</button><button class="secondary sh-del">${t("Supprimer")}</button></div>`
      : `<div class="form-actions share-actions"><button class="sh-close">${t("Clôturer et équilibrer")}</button><button class="secondary sh-edit">${t("Modifier")}</button><button class="secondary sh-del">${t("Supprimer")}</button></div>`;
    if (a.closed) {
      this._bodyEl.innerHTML = `${head}
        <div class="share-closed">${t("Clôturé le {date}", { date: esc(frDate(a.closed_on)) })}</div>
        <div class="month-sep">${t("Remboursements à faire")}</div><div class="share-transfers">${transfers}</div>
        <div class="month-sep">${t("Participants")}</div>${people}
        <div class="month-sep">${t("Dépenses ({n})", { n: a.expenses.length })}</div><div class="share-expenses">${expenses}</div>
        ${actions}`;
    } else {
      const options = a.participants.map((p) => `<option value="${p.id}" ${p.id === a.next_participant_id ? "selected" : ""}>${esc(p.name)}</option>`).join("");
      this._bodyEl.innerHTML = `${head}
        <div class="share-nextpayer">${t("Prochaine dépense :")} <strong>${esc(next ? next.name : "")}</strong>${next && a.total !== "0.00" ? ` <span class="muted">${t("(a payé {paid} €, le moins du groupe)", { paid: fmtAmount(next.paid) })}</span>` : ""}</div>
        <form class="entity-form sh-add">
          <label>${t("Payé par")}<select name="participant_id">${options}</select></label>
          <label>${t("Montant")}<input type="text" name="amount" inputmode="decimal" required></label>
          <label>${t("Libellé")}<input type="text" name="label" placeholder="${t("Courses, restaurant…")}"></label>
          <label>${t("Date")}<input type="date" name="date" value="${isoDate(new Date())}" required></label>
          <div class="form-actions"><button type="submit">${t("Ajouter la dépense")}</button></div>
        </form>
        <div class="month-sep">${t("Participants")}</div>${people}
        <div class="month-sep">${t("Pour équilibrer si l'on clôturait maintenant")}</div><div class="share-transfers">${transfers}</div>
        <div class="month-sep">${t("Dépenses ({n})", { n: a.expenses.length })}</div><div class="share-expenses">${expenses}</div>
        ${actions}`;
    }
    const $ = (sel) => this._bodyEl.querySelector(sel);
    const on = (sel, fn) => { const el = $(sel); if (el) el.addEventListener("click", fn); };
    const id = a.id;
    const run = async (service, data, after) => {
      try {
        await this._call(service, { shared_account_id: id, ...data }, false);
        if (after) after();
        await this._renderActive(true);
      } catch (err) {
        alert(errMsg(err));
      }
    };
    on(".sh-back", () => {
      this._shareId = null;
      this._renderActive();
    });
    on(".sh-edit", () => this._showShareForm($(".form-container"), a));
    on(".sh-close", () => {
      if (!confirm(t("Clôturer « {name} » ? Les dépenses seront figées et les remboursements définitifs (le compte pourra être rouvert).", { name: a.name }))) return;
      run("update_shared_account", { closed: true });
    });
    on(".sh-reopen", () => run("update_shared_account", { closed: false }));
    on(".sh-del", () => {
      if (!confirm(t("Supprimer « {name} », ses participants et ses {n} dépense(s) ?", { name: a.name, n: a.expenses.length }))) return;
      run("delete_shared_account", {}, () => (this._shareId = null));
    });
    const add = $(".sh-add");
    if (add) {
      add.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const amount = toNumber(add.querySelector('[name="amount"]').value);
        if (!Number.isFinite(amount) || amount <= 0) return alert(t("Montant invalide (saisir un montant positif)."));
        const pid = Number(add.querySelector('[name="participant_id"]').value);
        const label = add.querySelector('[name="label"]').value.trim();
        const btn = add.querySelector('button[type="submit"]');
        btn.disabled = true;
        try {
          const res = await this._call("add_shared_expense", {
            shared_account_id: id, participant_id: pid, amount: amount.toFixed(2), date: add.querySelector('[name="date"]').value, ...(label ? { label } : {}),
          }, true);
          await this._renderActive(true);
          const after = res && res.participants && res.participants.find((p) => p.id === res.next_participant_id);
          const msg = $(".ok-msg");
          msg.textContent = `✓ ${t("{amount} € payés par {name}.", { amount: NUMBER.format(amount), name: name.get(pid) })}${after ? ` ${t("Prochaine dépense : {name}.", { name: after.name })}` : ""}`;
          msg.hidden = false;
          clearTimeout(this._msgTimer);
          this._msgTimer = setTimeout(() => (msg.hidden = true), 8000);
        } catch (err) {
          btn.disabled = false;
          alert(errMsg(err));
        }
      });
    }
    $(".share-expenses").addEventListener("click", (ev) => {
      const btn = ev.target.closest("button");
      const row = ev.target.closest("[data-expense]");
      if (!btn || !row) return;
      const e = a.expenses.find((x) => x.id === Number(row.dataset.expense));
      if (btn.classList.contains("del")) {
        if (!confirm(t("Supprimer la dépense « {label} » de {amount} € ?", { label: e.label || t("Dépense"), amount: NUMBER.format(Number(e.amount)) }))) return;
        run("delete_shared_expense", { expense_id: e.id });
      } else if (btn.classList.contains("edit")) {
        this._bodyEl.querySelectorAll(".tx-edit").forEach((el) => el.remove());
        this._bodyEl.querySelectorAll(".tx-row.editing").forEach((el) => el.classList.remove("editing"));
        row.classList.add("editing");
        row.insertAdjacentHTML("afterend", `<div class="tx-edit"><form class="entity-form">
            <label>${t("Payé par")}<select name="participant_id">${a.participants.map((p) => `<option value="${p.id}" ${p.id === e.participant_id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>
            <label>${t("Montant")}<input type="text" name="amount" inputmode="decimal" value="${esc(inputAmount(e.amount))}" required></label>
            <label>${t("Libellé")}<input type="text" name="label" value="${esc(e.label || "")}"></label>
            <label>${t("Date")}<input type="date" name="date" value="${esc(e.date)}" required></label>
            <div class="form-actions"><button type="submit">${t("Enregistrer")}</button><button type="button" class="cancel">${t("Annuler")}</button></div>
          </form></div>`);
        const box = row.nextElementSibling;
        const f = box.querySelector("form");
        f.querySelector(".cancel").addEventListener("click", () => { box.remove(); row.classList.remove("editing"); });
        f.addEventListener("submit", (ev2) => {
          ev2.preventDefault();
          const amount = toNumber(f.querySelector('[name="amount"]').value);
          if (!Number.isFinite(amount) || amount <= 0) return alert(t("Montant invalide (saisir un montant positif)."));
          run("update_shared_expense", {
            expense_id: e.id, participant_id: Number(f.querySelector('[name="participant_id"]').value), amount: amount.toFixed(2),
            date: f.querySelector('[name="date"]').value, label: f.querySelector('[name="label"]').value.trim() || null,
          });
        });
      }
    });
  }

  // Colonne « Opérations » des listes : nombre d'opérations rattachées, fourni par l'API (transaction_count).
  _countColumn() {
    return {
      label: t("Opérations"),
      num: true,
      html: (n) => (n.transaction_count ? n.transaction_count.toLocaleString(LOCALE) : '<span class="muted">0</span>'),
    };
  }

  _accountsConfig() {
    return {
      deleteQuestion: t("Supprimer ce compte ?"),
      load: async () => (await this._ensureLookups(true)).accounts,
      idField: "account_id",
      services: ["create_account", "update_account", "delete_account"],
      move: {
        service: "move_account",
        account: true,
        hint: t("(le solde initial reste sur ce compte)"),
        targets: (item) => this._lookups.accounts.filter((a) => a.id !== item.id).map((a) => ({ id: a.id, name: `${a.name}${a.closed ? ` ${t("(clos)")}` : ""}` })),
      },
      columns: [
        { label: t("Nom"), html: (a) => `${esc(a.name)}${a.closed ? ` <span class="muted">${t("(clos)")}</span>` : ""}` },
        { label: t("Type"), html: (a) => esc(ACCOUNT_KINDS[a.kind] || a.kind) },
        { label: t("Solde"), num: true, html: (a) => `${fmtAmount(a.balances.total)} €` },
        this._countColumn(), // chaque jambe d'un virement compte sur son compte
      ],
      fields: [
        { key: "name", label: t("Nom"), required: true },
        { key: "kind", label: t("Type"), type: "select", options: () => Object.entries(ACCOUNT_KINDS).map(([id, name]) => ({ id, name })), default: "checking" },
        { key: "number", label: t("Numéro") },
        { key: "iban", label: "IBAN" },
        { key: "opening_balance", label: t("Solde initial"), type: "amount", default: "0" },
        { key: "opening_date", label: t("Date du solde initial"), type: "date" },
        { key: "notes", label: t("Notes") },
        { key: "closed", label: t("Compte clos"), type: "checkbox" },
      ],
    };
  }

  _treeConfig(kind) {
    const isCategory = kind === "category";
    const listKey = isCategory ? "categories" : "classes";
    // Parents possibles : ni lui-même ni un de ses descendants ; pour une rubrique, seulement le type choisi
    // (et, pour une rubrique existante, seulement son propre type : l'API refuse un déplacement qui le changerait).
    const parentChoices = (item, kind) => this._lookups[listKey]
      .filter((n) => !item || (n.id !== item.id && !n.path.startsWith(item.path + " > ")))
      .filter((n) => !isCategory || !kind || (n.kind === kind && (!item || item.kind === kind)));
    const fields = [
      { key: "name", label: t("Nom"), required: true },
      {
        key: "parent_id",
        label: t("Parent"),
        type: "select",
        empty: t("— (racine)"),
        options: (item) => parentChoices(item, item && item.kind)
          .map((n) => ({ id: n.id, name: `${"  ".repeat(n.depth)}${n.name}` })),
      },
    ];
    if (isCategory) {
      fields.push({
        key: "kind",
        label: t("Type (rubrique racine ; hérité sinon)"),
        type: "select",
        options: () => Object.entries(CATEGORY_KINDS).map(([id, name]) => ({ id, name })),
        default: "expense",
      });
    }
    fields.push({ key: "active", label: isCategory ? t("Active|rubrique") : t("Active|classe"), type: "checkbox", default: true });
    const columns = [
      { label: t("Nom"), html: (n) => `<span style="display: inline-block; padding-left: ${n.depth * 20}px">${esc(n.name)}</span>${n.active ? "" : ` <span class="muted">${isCategory ? t("(inactive)|rubrique") : t("(inactive)|classe")}</span>`}${isCategory ? this._catInfoHtml(n.id) : ""}` },
    ];
    if (isCategory) columns.push({ label: t("Type"), html: (n) => esc(CATEGORY_KINDS[n.kind] || n.kind) });
    // opérations rattachées directement (les sous-éléments ne sont pas cumulés)
    columns.push(this._countColumn());
    return {
      deleteQuestion: isCategory ? t("Supprimer cette rubrique ?") : t("Supprimer cette classe ?"),
      load: async () => (await this._ensureLookups(true))[listKey],
      idField: isCategory ? "category_id" : "class_id",
      services: isCategory
        ? ["create_category", "update_category", "delete_category"]
        : ["create_class", "update_class", "delete_class"],
      columns,
      fields,
      childAction: true,
      // ⇄ : opérations rattachées directement (les sous-éléments gardent les leurs)
      move: {
        service: isCategory ? "move_category" : "move_class",
        hint: t("(rattachées directement, pas celles des sous-éléments)"),
        targets: (item) => this._lookups[listKey].filter((n) => n.id !== item.id)
          .map((n) => ({ id: n.id, name: `${"  ".repeat(n.depth)}${n.name}${isCategory && n.kind !== item.kind ? ` (${CATEGORY_KINDS[n.kind].toLowerCase()})` : ""}` })),
        warn: (item, target) => {
          const tgt = this._lookups.category.get(target);
          return isCategory && tgt && tgt.kind !== item.kind
            ? t("Attention : « {target} » est de type {targetKind}, « {name} » de type {kind} (les suivis de budget changent).", {
              target: tgt.name, targetKind: CATEGORY_KINDS[tgt.kind].toLowerCase(), name: item.name, kind: CATEGORY_KINDS[item.kind].toLowerCase(),
            })
            : "";
        },
      },
      // Branche (a au moins un enfant) : ligne mise en avant ; feuille : ligne simple.
      rowClass: (n, items) => (items.some((c) => c.parent_id === n.id) ? "tree-branch" : ""),
      // Type et parent liés : un parent impose son type (champ verrouillé) ; changer le type d'une racine
      // recharge la liste « Parent » avec les rubriques de ce type.
      onFormReady: isCategory
        ? (form, item) => {
            const parentEl = form.querySelector('[name="parent_id"]');
            const kindEl = form.querySelector('[name="kind"]');
            const sync = () => {
              const parent = this._lookups.category.get(Number(parentEl.value));
              if (parent) kindEl.value = parent.kind;
              kindEl.disabled = !!parent;
              const keep = parentEl.value;
              const choices = parentChoices(item, kindEl.value);
              parentEl.innerHTML = `<option value="">${t("— (racine)")}</option>` + choices
                .map((n) => `<option value="${n.id}">${esc(`${"  ".repeat(n.depth)}${n.name}`)}</option>`)
                .join("");
              parentEl.value = choices.some((n) => String(n.id) === keep) ? keep : "";
            };
            parentEl.addEventListener("change", sync);
            kindEl.addEventListener("change", sync);
            sync();
          }
        : null,
      // Le type d'une sous-rubrique est hérité : on ne l'envoie que pour une racine.
      beforeSave: (payload) => {
        if (isCategory && payload.parent_id) delete payload.kind;
        return payload;
      },
    };
  }

  _payeesConfig() {
    return {
      deleteQuestion: t("Supprimer ce tiers ?"),
      search: true,
      load: async () => (await this._ensureLookups(true)).payees,
      idField: "payee_id",
      services: ["create_payee", "update_payee", "delete_payee"],
      move: {
        service: "move_payee",
        targets: (item) => this._lookups.payees.filter((p) => p.id !== item.id).map((p) => ({ id: p.id, name: `${p.name}${p.active ? "" : ` ${t("(inactif)")}`}` })),
      },
      columns: [
        { label: t("Nom"), html: (p) => `${esc(p.name)}${p.active ? "" : ` <span class="muted">${t("(inactif)")}</span>`}` },
        { label: t("Rubrique par défaut"), html: (p) => esc((this._lookups.category.get(p.default_category_id) || {}).path || "") },
        this._countColumn(),
      ],
      fields: [
        { key: "name", label: t("Nom"), required: true },
        { key: "short_name", label: t("Nom abrégé") },
        {
          key: "default_category_id",
          label: t("Rubrique par défaut"),
          type: "select",
          empty: "—",
          options: () => this._lookups.categories.map((c) => ({ id: c.id, name: `${"  ".repeat(c.depth)}${c.name}` })),
        },
        { key: "phone", label: t("Téléphone") },
        { key: "mobile", label: t("Mobile") },
        { key: "email", label: t("E-mail") },
        { key: "address1", label: t("Adresse") },
        { key: "postal_code", label: t("Code postal") },
        { key: "city", label: t("Ville") },
        { key: "iban", label: "IBAN" },
        { key: "swift", label: "BIC / SWIFT" },
        { key: "notes", label: t("Remarque") },
        { key: "active", label: t("Actif"), type: "checkbox", default: true },
      ],
    };
  }

  async _renderCrud(cfg) {
    const items = await cfg.load();
    const header = cfg.columns.map((c) => `<th class="${c.num ? "num" : ""}">${esc(c.label)}</th>`).join("");
    const rowHtml = (it) => `<tr class="${cfg.rowClass ? cfg.rowClass(it, items) : ""}" data-id="${it.id}" data-text="${esc(String(it.name || "").toLowerCase())}">
        ${cfg.columns.map((c) => `<td class="${c.num ? "num" : ""}">${c.html(it)}</td>`).join("")}
        <td class="actions">
          ${cfg.childAction ? `<button class="child" title="${t("Ajouter un sous-élément")}">＋</button>` : ""}
          ${cfg.move && it.transaction_count ? `<button class="move" title="${t("Déplacer ses opérations vers…")}">⇄</button>` : ""}
          <button class="edit" title="${t("Modifier")}">✎</button>
          <button class="del" title="${t("Supprimer")}">✕</button>
        </td>
      </tr>`;
    this._bodyEl.innerHTML = `
      <div class="toolbar">
        ${cfg.search ? `<input type="search" class="filter" placeholder="${t("Rechercher…")}">` : ""}
        <button class="add">+ ${t("Ajouter")}</button>
      </div>
      <div class="ok-msg" ${this._flashMsg ? "" : "hidden"}>${esc(this._flashMsg || "")}</div>
      <div class="form-container"></div>
      <div class="table-wrap"><table><thead><tr>${header}<th></th></tr></thead>
      <tbody>${items.map(rowHtml).join("") || `<tr><td colspan="${cfg.columns.length + 1}">${t("Aucun élément.")}</td></tr>`}</tbody></table></div>
    `;
    this._flashMsg = null;
    const formContainer = this._bodyEl.querySelector(".form-container");
    // Un seul formulaire ouvert à la fois : en haut (ajout) ou dans le tableau (modification, sous-élément).
    const closeForms = () => {
      formContainer.innerHTML = "";
      this._bodyEl.querySelectorAll("tbody tr.form-row").forEach((r) => r.remove());
      this._bodyEl.querySelectorAll("tbody tr.editing").forEach((r) => r.classList.remove("editing"));
    };
    // Modification : le formulaire remplace la ligne ; sous-élément : il s'insère juste sous le parent.
    const inlineForm = (tr, item, preset) => {
      closeForms();
      const formRow = document.createElement("tr");
      formRow.className = "form-row";
      formRow.innerHTML = `<td colspan="${cfg.columns.length + 1}"></td>`;
      tr.after(formRow);
      if (item) tr.classList.add("editing");
      this._showForm(formRow.firstElementChild, cfg, item, preset, closeForms);
    };
    this._bodyEl.querySelector(".add").addEventListener("click", () => {
      closeForms();
      this._showForm(formContainer, cfg, null);
    });
    if (this._focusId != null) {
      const tr = this._bodyEl.querySelector(`tbody tr[data-id="${this._focusId}"]`);
      this._focusId = null;
      if (tr) tr.classList.add("flash"); // mise en évidence sans défilement : la liste reste où elle était
    }
    const filter = this._bodyEl.querySelector(".filter");
    if (filter) {
      filter.addEventListener("input", () => {
        const q = filter.value.trim().toLowerCase();
        this._bodyEl.querySelectorAll("tbody tr[data-id]").forEach((tr) => {
          tr.style.display = !q || tr.dataset.text.includes(q) ? "" : "none";
        });
      });
    }
    this._bodyEl.querySelector("tbody").addEventListener("click", async (ev) => {
      const btn = ev.target.closest("button");
      const tr = ev.target.closest("tr[data-id]");
      if (!btn || !tr) return;
      const item = items.find((it) => it.id === Number(tr.dataset.id));
      if (btn.classList.contains("edit")) {
        inlineForm(tr, item);
      } else if (btn.classList.contains("child")) {
        inlineForm(tr, null, { parent_id: item.id });
      } else if (btn.classList.contains("move")) {
        closeForms();
        const formRow = document.createElement("tr");
        formRow.className = "form-row";
        formRow.innerHTML = `<td colspan="${cfg.columns.length + 1}"></td>`;
        tr.after(formRow);
        this._showMoveForm(formRow.firstElementChild, cfg, item, closeForms);
      } else if (btn.classList.contains("del")) {
        if (!confirm(cfg.deleteQuestion)) return;
        try {
          await this._call(cfg.services[2], { [cfg.idField]: item.id }, false);
          this._lookups = null;
          this._renderActive(true);
        } catch (err) {
          alert(errMsg(err));
        }
      }
    });
  }

  // Déplacement en masse (décision 020) : toutes les opérations (et planifications) de `item` vers un autre élément,
  // puis, si demandé, suppression de `item` devenu inutilisé.
  _showMoveForm(container, cfg, item, onClose) {
    const m = cfg.move;
    const count = item.transaction_count.toLocaleString(LOCALE);
    container.innerHTML = `
      <form class="entity-form move-form">
        <div class="full">${t("Déplacer les {count} opération(s) de « {name} »{hint}, et ses planifications, vers :", { count: `<strong>${count}</strong>`, name: esc(item.name), hint: m.hint ? ` ${esc(m.hint)}` : "" })}</div>
        <label class="full">${t("Vers")}<select name="target" required><option value="">${t("— choisir —")}</option>${m.targets(item).map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}</select></label>
        ${m.account ? `<label class="check full"><input type="checkbox" name="reconciled">${t("Inclure les opérations rapprochées (les soldes rapprochés des deux comptes changent)")}</label>` : ""}
        <label class="check full"><input type="checkbox" name="delete">${t("Supprimer « {name} » ensuite", { name: esc(item.name) })}</label>
        <div class="form-actions"><button type="submit">${t("Déplacer")}</button><button type="button" class="cancel">${t("Annuler")}</button></div>
      </form>`;
    const form = container.querySelector("form");
    form.querySelector(".cancel").addEventListener("click", onClose);
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const select = form.querySelector('[name="target"]');
      if (!select.value) return alert(t("Choisir l'élément qui reçoit les opérations."));
      const target = Number(select.value);
      const targetName = m.targets(item).find((x) => x.id === target).name.trim();
      const warning = m.warn ? m.warn(item, target) : "";
      const question = t("Déplacer les {count} opération(s) de « {name} » vers « {target} » ?", { count, name: item.name, target: targetName });
      if (!confirm(`${question}${warning ? `\n\n${warning}` : ""}`)) return;
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      let res;
      try {
        const data = { [cfg.idField]: item.id, target_id: target };
        if (m.account && form.querySelector('[name="reconciled"]').checked) data.include_reconciled = true;
        res = await this._call(m.service, data, true);
      } catch (err) {
        submit.disabled = false;
        return alert(errMsg(err));
      }
      const vars = { n: res.transactions, s: res.schedules, name: item.name, target: targetName };
      let msg = `✓ ${res.schedules
        ? t("{n} opération(s) et {s} planification(s) déplacée(s) de « {name} » vers « {target} ».", vars)
        : t("{n} opération(s) déplacée(s) de « {name} » vers « {target} ».", vars)}`;
      if (form.querySelector('[name="delete"]').checked) {
        try {
          await this._call(cfg.services[2], { [cfg.idField]: item.id }, false);
          msg += ` ${t("« {name} » a été supprimé.", vars)}`;
        } catch (err) {
          msg += ` ${t("« {name} » n'a pas pu être supprimé : {error}", { ...vars, error: errMsg(err) })}`;
        }
      }
      this._flashMsg = msg;
      this._focusId = target;
      this._lookups = null;
      this._renderActive(true);
    });
  }

  _fieldHtml(f, item, preset) {
    const value = item ? item[f.key] : preset && f.key in preset ? preset[f.key] : f.default;
    const name = esc(f.key);
    if (f.type === "select") {
      const empty = f.empty !== undefined ? `<option value="">${esc(f.empty)}</option>` : "";
      const opts = f.options(item)
        .map((o) => `<option value="${esc(o.id)}" ${String(o.id) === String(value ?? "") ? "selected" : ""}>${esc(o.name)}</option>`)
        .join("");
      return `<label>${esc(f.label)}<select name="${name}">${empty}${opts}</select></label>`;
    }
    if (f.type === "checkbox") {
      return `<label class="check"><input type="checkbox" name="${name}" ${value ? "checked" : ""}>${esc(f.label)}</label>`;
    }
    if (f.type === "date" || f.type === "month" || f.type === "number") {
      return `<label>${esc(f.label)}<input type="${f.type}" name="${name}" value="${esc(value ?? "")}" ${f.required ? "required" : ""}></label>`;
    }
    const shown = f.type === "amount" && (LANG === "fr" || LANG === "de") ? String(value ?? "").replace(".", ",") : value ?? "";
    return `<label>${esc(f.label)}<input type="text" name="${name}" ${f.type === "amount" ? 'inputmode="decimal"' : ""} value="${esc(shown)}" ${f.required ? "required" : ""}></label>`;
  }

  _showForm(container, cfg, item, preset, onClose) {
    container.innerHTML = `
      <form class="entity-form">
        ${cfg.fields.map((f) => this._fieldHtml(f, item, preset)).join("")}
        <div class="form-actions">
          <button type="submit">${cfg.submitLabel || (item ? t("Enregistrer") : t("Créer"))}</button>
          <button type="button" class="cancel">${t("Annuler")}</button>
        </div>
      </form>
    `;
    const form = container.querySelector("form");
    if (cfg.onFormReady) cfg.onFormReady(form, item, preset);
    form.querySelector(".cancel").addEventListener("click", () => (onClose ? onClose() : (container.innerHTML = "")));
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      let payload = {};
      for (const f of cfg.fields) {
        const el = form.querySelector(`[name="${f.key}"]`);
        if (f.type === "checkbox") payload[f.key] = el.checked;
        else if (f.type === "select") payload[f.key] = el.value === "" ? null : (/^\d+$/.test(el.value) ? Number(el.value) : el.value);
        else if (f.type === "number") payload[f.key] = el.value === "" ? null : Number(el.value);
        else payload[f.key] = el.value.trim() === "" ? null : el.value.trim();
      }
      if (!item) for (const key of Object.keys(payload)) if (payload[key] === null) delete payload[key];
      if (item) payload[cfg.idField] = item.id;
      if (cfg.beforeSave) payload = cfg.beforeSave(payload);
      try {
        const res = await this._call(item ? cfg.services[1] : cfg.services[0], payload, true);
        if (cfg.afterSave) cfg.afterSave(res);
        container.innerHTML = "";
        this._lookups = null;
        // rafraîchissement sur place, l'élément enregistré est brièvement surligné
        this._focusId = item ? item.id : res && res.id;
        this._renderActive(true);
      } catch (err) {
        alert(errMsg(err));
      }
    });
    container.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

class MyBankCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config || {};
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    setLanguage(hass);
  }

  _render() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const selected = new Set(
      Array.isArray(this._config.sections) && this._config.sections.length
        ? this._config.sections
        : SECTION_DEFS.map((s) => s.key)
    );
    this.shadowRoot.innerHTML = `
      <style>
        .row { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
        p { color: var(--secondary-text-color); font-size: 13px; }
      </style>
      <p>${t("Volets affichés par cette carte (décoche ceux dont tu n'as pas besoin sur ce dashboard) :")}</p>
      ${SECTION_DEFS.map(
        (s) => `<div class="row"><input type="checkbox" id="s-${s.key}" ${selected.has(s.key) ? "checked" : ""}><label for="s-${s.key}">${esc(s.label)}</label></div>`
      ).join("")}
    `;
    SECTION_DEFS.forEach((s) => {
      this.shadowRoot.getElementById(`s-${s.key}`).addEventListener("change", () => this._emit());
    });
  }

  _emit() {
    const sections = SECTION_DEFS.filter((s) => this.shadowRoot.getElementById(`s-${s.key}`).checked).map((s) => s.key);
    this._config = { ...this._config, sections };
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config } }));
  }
}

// --- Cartes simples (tableau de bord smartphone) ---------------------------------------------------
// Saisie rapide, soldes d'un compte, suivi d'un budget. Elles réutilisent les appels de service et les briques
// de MyBankCard (formulaire de saisie, barres de réalisation) ; ni onglets, ni bandeau, ni historique.

// Champs masquables de la carte de saisie ; le montant est toujours affiché.
const ENTRY_FIELDS = [
  ["account", "Compte"],
  ["type", "Type (dépense, recette, virement)"],
  ["date", "Date"],
  ["payee", "Tiers|champ"],
  ["payment_method", "Mode de règlement"],
  ["number", "N° de chèque"],
  ["label", "Libellé"],
  ["category", "Rubrique"],
  ["class", "Classe"],
  ["split", "Ventilation"],
  ["state", "Pointée / rapprochée"],
  ["notes", "Notes"],
].map(([key, label]) => ({ key, get label() { return t(label); } }));
const BUDGET_PERIODS = translated({ month: "Mois en cours", cumul: "Du début du budget au mois en cours", all: "Toute la période" });
const SIMPLE_REFRESH_MS = 5 * 60 * 1000;

const SIMPLE_STYLE = `
  .card-title { font-size: 18px; font-weight: 500; margin: 0 0 8px; }
  .entry-msg { margin-bottom: 8px; padding: 10px 12px; border-radius: 4px; font-size: 14px;
    border-left: 4px solid var(--success-color, #43a047); background: rgba(var(--rgb-success-color, 67, 160, 71), 0.15); }
  .entry-card form.entity-form { margin-top: 0; }
  .bal-name { font-size: 15px; font-weight: 500; margin-bottom: 6px; }
  .bal-main { font-size: 26px; font-weight: 600; margin-bottom: 6px; }
  .neg { color: var(--error-color, #db4437); }
  .bl { padding: 6px 0; border-bottom: 1px solid var(--divider-color); }
  .bl-head { display: flex; justify-content: space-between; gap: 8px; font-size: 14px; margin-bottom: 4px; }
  .bl-amt { white-space: nowrap; color: var(--secondary-text-color); font-size: 13px; }
  .bl.branch .bl-name { font-weight: 600; }
  .bl.kind .bl-name { font-weight: 600; text-transform: uppercase; font-size: 12px; letter-spacing: 0.04em; color: var(--primary-color); }
  .bl .pbar { width: 100%; }
`;

class MyBankSimpleCard extends MyBankCard {
  setConfig(config) {
    this._config = config || {};
    this._loadedAt = 0;
    this._txAccountId = undefined; // carte de saisie : repartir du compte par défaut configuré
    this._render();
  }

  connectedCallback() {}

  disconnectedCallback() {}

  set hass(hass) {
    this._hass = hass;
    setLanguage(hass);
    if (this._needsInitialRender) {
      this._needsInitialRender = false;
      this._renderActive();
    }
  }

  getCardSize() {
    return 3;
  }

  _render() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const title = this._config.title ? `<h1 class="card-title">${esc(this._config.title)}</h1>` : "";
    this.shadowRoot.innerHTML = `<style>${STYLE}${SIMPLE_STYLE}</style><ha-card>${title}<div class="body"><div class="loading">${t("Chargement…")}</div></div></ha-card>`;
    this._bodyEl = this.shadowRoot.querySelector(".body");
    this._needsInitialRender = !this._hass;
    this._renderActive();
  }

  async _renderActive() {
    if (!this._hass) return;
    this._loadedAt = Date.now();
    try {
      await this._renderCard();
    } catch (err) {
      this._bodyEl.innerHTML = `<div class="error">${esc(errMsg(err))}</div>`;
    }
  }
}

// Saisie rapide d'opérations : compte par défaut et champs affichés réglables. Après l'enregistrement, un message
// confirme l'opération et un formulaire vierge (date du jour) est prêt pour la suivante.
class MyBankEntryCard extends MyBankSimpleCard {
  static getStubConfig() {
    return {};
  }

  static getConfigElement() {
    return document.createElement("my-bank-entry-card-editor");
  }

  getCardSize() {
    return 5;
  }

  async _renderCard() {
    await this._ensureLookups();
    const accounts = this._lookups.accounts.filter((a) => !a.closed);
    if (!accounts.length) {
      this._bodyEl.innerHTML = `<div class="empty">${t("Aucun compte.")}</div>`;
      return;
    }
    if (!accounts.some((a) => a.id === this._txAccountId)) {
      const wanted = Number(this._config.account_id);
      this._txAccountId = accounts.some((a) => a.id === wanted) ? wanted : accounts[0].id;
    }
    const shown = Array.isArray(this._config.fields) ? new Set(this._config.fields) : null;
    const hidden = new Set(ENTRY_FIELDS.map((f) => f.key).filter((k) => shown && !shown.has(k)));
    this._bodyEl.innerHTML = `<div class="entry-card"><div class="entry-msg" hidden></div><div class="form-container"></div></div>`;
    const msg = this._bodyEl.querySelector(".entry-msg");
    const container = this._bodyEl.querySelector(".form-container");
    const show = (autofocus) => this._showTransactionForm(container, null, () => show(true), {
      chooseAccount: true,
      hidden,
      showHidden: this._showHidden, // choix gardé d'une opération à l'autre
      onToggleHidden: (on) => (this._showHidden = on),
      cancelLabel: t("Effacer"),
      autofocus, // pas au chargement du tableau de bord (clavier du téléphone)
      onSaved: async ({ service, payload, accountId }) => {
        msg.textContent = this._savedMessage(service, payload, accountId);
        msg.hidden = false;
        clearTimeout(this._msgTimer);
        this._msgTimer = setTimeout(() => (msg.hidden = true), 8000);
        this._txAccountId = accountId; // le compte choisi reste proposé pour la suivante
        this._lookups = null; // un tiers a pu être créé
        await this._ensureLookups();
        show(true);
      },
    });
    show(false);
  }

  _savedMessage(service, payload, accountId) {
    const L = this._lookups;
    const name = (id) => (L.account.get(id) || {}).name || "";
    const amount = NUMBER.format(Math.abs(Number(payload.amount)));
    if (service === "create_transfer") {
      return `✓ ${t("Virement de {amount} € enregistré : {from} → {to}.", { amount, from: name(payload.from_account_id), to: name(payload.to_account_id) })}`;
    }
    const vars = { amount, who: payload.payee_name ? ` — ${payload.payee_name}` : "", account: name(accountId), date: frDate(payload.date) };
    return `✓ ${Number(payload.amount) < 0
      ? t("Dépense de {amount} € enregistrée{who} ({account}, {date}).", vars)
      : t("Recette de {amount} € enregistrée{who} ({account}, {date}).", vars)}`;
  }
}

// Les trois soldes d'un compte, lus sur son capteur (mis à jour par l'intégration toutes les 5 min et après chaque écriture).
class MyBankBalanceCard extends MyBankSimpleCard {
  static getStubConfig() {
    return {};
  }

  static getConfigElement() {
    return document.createElement("my-bank-balance-card-editor");
  }

  set hass(hass) {
    this._hass = hass;
    setLanguage(hass);
    const state = this._accountState();
    if (state !== this._lastState) {
      this._lastState = state;
      this._renderActive();
    }
  }

  // Capteur du compte choisi (attribut account_id), ou du premier compte à défaut.
  _accountState() {
    if (!this._hass) return null;
    const sensors = Object.values(this._hass.states)
      .filter((s) => s.entity_id.startsWith("sensor.") && s.attributes.account_id !== undefined && "solde_pointe" in s.attributes)
      .sort((a, b) => a.attributes.account_id - b.attributes.account_id);
    const wanted = Number(this._config.account_id);
    return sensors.find((s) => s.attributes.account_id === wanted) || (this._config.account_id ? null : sensors[0]) || null;
  }

  async _renderCard() {
    const s = this._accountState();
    if (!s) {
      this._bodyEl.innerHTML = `<div class="empty">${t("Compte introuvable (capteur My Bank absent).")}</div>`;
      return;
    }
    const n = (v) => Number(v);
    const line = (label, value) => `<div class="balance-line ${n(value) < 0 ? "neg" : ""}"><span>${label}</span><strong>${fmtAmount(value)} €</strong></div>`;
    this._bodyEl.innerHTML = `
      <div class="bal-name">${esc(s.attributes.friendly_name || "")}</div>
      <div class="bal-main ${n(s.state) < 0 ? "neg" : ""}" title="${t("Solde prévisionnel (toutes opérations)")}">${fmtAmount(s.state)} €</div>
      ${line(t("Solde prévisionnel"), s.state)}
      ${line(t("Solde banque (pointé)"), s.attributes.solde_pointe)}
      ${line(t("Rapproché"), s.attributes.solde_rapproche)}`;
  }
}

// Suivi d'un budget : barres de réalisation et réalisé / prévu par type et par rubrique, jusqu'au niveau choisi.
class MyBankBudgetCard extends MyBankSimpleCard {
  static getStubConfig() {
    return { levels: 2, period: "month" };
  }

  static getConfigElement() {
    return document.createElement("my-bank-budget-card-editor");
  }

  getCardSize() {
    return 6;
  }

  set hass(hass) {
    super.hass = hass;
    // les opérations saisies ailleurs font bouger le réalisé : relecture au plus toutes les 5 minutes
    if (this._loadedAt && Date.now() - this._loadedAt > SIMPLE_REFRESH_MS) this._renderActive();
  }

  async _renderCard() {
    const month = isoDate(new Date()).slice(0, 7);
    const budgets = await this._items("list_budgets");
    const wanted = Number(this._config.budget_id);
    const budget = budgets.find((b) => b.id === wanted)
      || (this._config.budget_id ? null : budgets.find((b) => !b.archived && b.start_month.slice(0, 7) <= month && b.end_month.slice(0, 7) >= month));
    if (!budget) {
      this._bodyEl.innerHTML = `<div class="empty">${this._config.budget_id ? t("Budget introuvable.") : t("Aucun budget ne couvre le mois en cours.")}</div>`;
      return;
    }
    const r = await this._call("get_budget_report", { budget_id: budget.id }, true);
    const period = BUDGET_PERIODS[this._config.period] ? this._config.period : "month";
    const current = r.months.indexOf(month);
    let idx;
    if (period === "all") idx = r.months.map((_, i) => i);
    else if (current < 0) idx = period === "cumul" && month > r.months[r.months.length - 1] ? r.months.map((_, i) => i) : [];
    else idx = period === "cumul" ? r.months.slice(0, current + 1).map((_, i) => i) : [current];
    const pick = (arr) => idx.reduce((acc, i) => acc + Number(arr[i]), 0).toFixed(2);
    const levels = Math.max(1, Number(this._config.levels) || 2);
    const line = (cls, name, depth, kind, planned, actual) => `<div class="bl ${cls}" style="padding-left: ${depth * 14}px">
        <div class="bl-head"><span class="bl-name">${esc(name)}</span><span class="bl-amt">${fmtAmount(actual)} / ${fmtAmount(planned)} €</span></div>
        ${this._progressHtml(kind, planned, actual)}
      </div>`;
    const groups = this._byKind(r.rows)
      .map(({ kind, rows }) => {
        const visible = rows.filter((x) => x.depth < levels && (Number(pick(x.planned)) || (this._config.show_unbudgeted && Number(pick(x.actual)))));
        if (!visible.length) return "";
        const tot = r.totals[kind];
        return line("kind", KIND_TITLES[kind], 0, kind, pick(tot.planned), pick(tot.actual))
          + visible.map((x) => line(x.has_children && x.depth < levels - 1 ? "branch" : "", x.name, x.depth, kind, pick(x.planned), pick(x.actual))).join("");
      })
      .join("");
    const when = period === "month" ? monthLabel(month, "long") : BUDGET_PERIODS[period].toLowerCase();
    const heading = this._config.title ? "" : `<div class="bal-name">${t("Budget « {name} »", { name: esc(budget.name) })} — ${esc(when)}</div>`;
    this._bodyEl.innerHTML = `${heading}${groups || `<div class="empty">${idx.length ? t("Rien de prévu sur la période.") : t("Le mois en cours est hors du budget.")}</div>`}`;
  }
}

// Comptes partagés seuls (tableau de bord smartphone) : la carte principale réduite au volet « Partages »,
// avec le bouton Retour entre la liste et un compte ; sans le bandeau des planifications.
class MyBankShareCard extends MyBankCard {
  setConfig(config) {
    this._noAlerts = true;
    super.setConfig({ ...(config || {}), sections: ["shares"] });
  }

  static getStubConfig() {
    return {};
  }

  static getConfigElement() {
    return document.createElement("my-bank-share-card-editor");
  }
}

// Éditeur commun des cartes simples : une liste de champs décrits par la carte.
class MyBankSimpleEditor extends HTMLElement {
  setConfig(config) {
    this._config = config || {};
    this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    setLanguage(hass);
    if (first) this._load();
  }

  async _items(service) {
    const res = await this._hass.connection.sendMessagePromise({
      type: "call_service", domain: "my_bank", service, service_data: {}, return_response: true,
    });
    return (res && res.response && res.response.items) || [];
  }

  async _load() {
    try {
      this._options = await this._loadOptions();
    } catch (err) {
      this._options = {};
    }
    this._render();
  }

  async _loadOptions() {
    return {};
  }

  _fields() {
    return [];
  }

  _render() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    if (!this._config) return;
    const c = this._config;
    const opts = this._options || {};
    const html = this._fields().map((f) => {
      if (f.type === "select") {
        const list = f.options || opts[f.key] || [];
        const empty = f.empty ? `<option value="">${esc(f.empty)}</option>` : "";
        return `<label>${esc(f.label)}<select data-key="${f.key}" data-num="${f.number ? 1 : ""}">${empty}${list.map((o) => `<option value="${esc(o.id)}" ${String(c[f.key] ?? "") === String(o.id) ? "selected" : ""}>${esc(o.name)}</option>`).join("")}</select></label>`;
      }
      if (f.type === "checks") {
        const on = Array.isArray(c[f.key]) ? new Set(c[f.key]) : new Set(f.options.map((o) => o.key));
        return `<div class="group"><div>${esc(f.label)}</div>${f.options.map((o) => `<label class="row"><input type="checkbox" data-check="${f.key}" value="${o.key}" ${on.has(o.key) ? "checked" : ""}>${esc(o.label)}</label>`).join("")}<p>${esc(f.help || "")}</p></div>`;
      }
      if (f.type === "bool") return `<label class="row"><input type="checkbox" data-bool="${f.key}" ${c[f.key] ? "checked" : ""}>${esc(f.label)}</label>`;
      return `<label>${esc(f.label)}<input type="${f.type || "text"}" data-key="${f.key}" data-num="${f.type === "number" ? 1 : ""}" ${f.min ? `min="${f.min}"` : ""} value="${esc(c[f.key] ?? "")}"></label>`;
    }).join("");
    this.shadowRoot.innerHTML = `
      <style>
        label { display: flex; flex-direction: column; gap: 4px; margin: 8px 0; font-size: 13px; color: var(--secondary-text-color); }
        label.row { flex-direction: row; align-items: center; gap: 8px; margin: 2px 0; color: var(--primary-text-color); font-size: 14px; }
        input:not([type="checkbox"]), select { font-size: 14px; padding: 6px; min-height: 36px; }
        .group { margin: 12px 0; font-size: 13px; color: var(--secondary-text-color); }
        p { color: var(--secondary-text-color); font-size: 12px; margin: 4px 0; }
      </style>${html}`;
    this.shadowRoot.querySelectorAll("input, select").forEach((el) => el.addEventListener("change", () => this._emit()));
  }

  _emit() {
    const config = { ...this._config };
    this.shadowRoot.querySelectorAll("[data-key]").forEach((el) => {
      const v = el.value.trim();
      if (v === "") delete config[el.dataset.key];
      else config[el.dataset.key] = el.dataset.num ? Number(v) : v;
    });
    this.shadowRoot.querySelectorAll("[data-bool]").forEach((el) => {
      if (el.checked) config[el.dataset.bool] = true;
      else delete config[el.dataset.bool];
    });
    const groups = new Set([...this.shadowRoot.querySelectorAll("[data-check]")].map((el) => el.dataset.check));
    groups.forEach((key) => {
      const boxes = [...this.shadowRoot.querySelectorAll(`[data-check="${key}"]`)];
      if (boxes.every((el) => el.checked)) delete config[key]; // tout coché = valeur par défaut
      else config[key] = boxes.filter((el) => el.checked).map((el) => el.value);
    });
    this._config = config;
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config } }));
  }
}

class MyBankEntryCardEditor extends MyBankSimpleEditor {
  async _loadOptions() {
    return { account_id: (await this._items("list_accounts")).filter((a) => !a.closed) };
  }

  _fields() {
    return [
      { key: "title", label: t("Titre (facultatif)") },
      { key: "account_id", label: t("Compte par défaut"), type: "select", number: true, empty: t("Premier compte") },
      { key: "fields", label: t("Champs affichés (le montant l'est toujours) :"), type: "checks", options: ENTRY_FIELDS,
        help: t("Un champ masqué reste pré-rempli depuis la dernière opération du tiers et enregistré ; la date est celle du jour.") },
    ];
  }
}

class MyBankBalanceCardEditor extends MyBankSimpleEditor {
  async _loadOptions() {
    return { account_id: (await this._items("list_accounts")).filter((a) => !a.closed) };
  }

  _fields() {
    return [
      { key: "title", label: t("Titre (facultatif)") },
      { key: "account_id", label: t("Compte"), type: "select", number: true, empty: t("Premier compte") },
    ];
  }
}

class MyBankShareCardEditor extends MyBankSimpleEditor {
  _render() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `<p style="color: var(--secondary-text-color); font-size: 13px;">${t("Aucun réglage : la carte affiche tous les comptes partagés.")}</p>`;
  }
}

class MyBankBudgetCardEditor extends MyBankSimpleEditor {
  async _loadOptions() {
    const budgets = await this._items("list_budgets");
    return { budget_id: budgets.map((b) => ({ id: b.id, name: `${b.name}${b.archived ? ` ${t("(archivé)")}` : ""}` })) };
  }

  _fields() {
    return [
      { key: "title", label: t("Titre (facultatif)") },
      { key: "budget_id", label: t("Budget"), type: "select", number: true, empty: t("Celui qui couvre le mois en cours") },
      { key: "period", label: t("Période"), type: "select", options: Object.entries(BUDGET_PERIODS).map(([id, name]) => ({ id, name })) },
      { key: "levels", label: t("Niveaux de rubriques affichés (1 = rubriques racines)"), type: "number", min: 1 },
      { key: "show_unbudgeted", label: t("Afficher aussi les rubriques hors budget (réalisé sans prévu)"), type: "bool" },
    ];
  }
}

// @@I18N-BEGIN@@ — généré par i18n/gen.py depuis i18n/dict.json (clé : texte français de la carte)
const I18N = {
  en: {
    " · encore {n} échéances": " · {n} left",
    "(a payé {paid} €, le moins du groupe)": "(paid {paid} €, the least in the group)",
    "(archivé)": "(archived)",
    "(clos)": "(closed)",
    "(inactif)": "(inactive)",
    "(inactive)|classe": "(inactive)",
    "(inactive)|rubrique": "(inactive)",
    "(le solde initial reste sur ce compte)": "(the opening balance stays on this account)",
    "(part de la rubrique)": "(category's share)",
    "(rattachées directement, pas celles des sous-éléments)": "(directly attached, not those of sub-items)",
    "(sans fin : prochaines échéances)": "(no end: next occurrences)",
    "(à un centime près)": "(to the nearest cent)",
    ", {n} échéances": ", {n} occurrences",
    "12 derniers mois": "Last 12 months",
    "1re échéance ({date}) inscrite dès l'enregistrement": "1st occurrence ({date}) entered on save",
    "1re échéance ({date}) inscrite le {entry}": "1st occurrence ({date}) entered on {entry}",
    "3 derniers mois": "Last 3 months",
    "A payé des dépenses : ne peut pas être retiré": "Has paid expenses: cannot be removed",
    "Abandonner la saisie en cours ?": "Discard the current entry?",
    "Abandonner les montants saisis non enregistrés ?": "Discard the unsaved amounts?",
    "Actif": "Active",
    "Active": "Active",
    "Active|classe": "Active",
    "Active|rubrique": "Active",
    "Adresse": "Address",
    "Afficher aussi les rubriques hors budget (réalisé sans prévu)": "Also show unbudgeted categories (actual without plan)",
    "Ajouter": "Add",
    "Ajouter la dépense": "Add the expense",
    "Ajouter un sous-élément": "Add a sub-item",
    "Annuler": "Cancel",
    "Année en cours": "Current year",
    "Antérieure": "Before start",
    "Après N échéances": "After N occurrences",
    "Archivé": "Archived",
    "Attention : « {target} » est de type {targetKind}, « {name} » de type {kind} (les suivis de budget changent).": "Warning: “{target}” is of type {targetKind}, “{name}” of type {kind} (budget tracking will change).",
    "Au": "To",
    "Aucun budget ne couvre le mois en cours.": "No budget covers the current month.",
    "Aucun budget. Un budget suit un compte : montants prévus par rubrique et par mois, puis réalisé et écarts.": "No budget. A budget follows one account: planned amounts per category and month, then actuals and variances.",
    "Aucun compte partagé en cours. Un compte partagé réunit les dépenses communes d'un groupe (vacances…) pour les équilibrer.": "No open shared account. A shared account gathers a group's common expenses (holidays…) to settle them.",
    "Aucun compte.": "No account.",
    "Aucun compte. Crée d'abord un compte dans l'onglet « Comptes ».": "No account. First create an account in the “Accounts” tab.",
    "Aucun mois du budget dans cette période.": "No month of the budget in this period.",
    "Aucun montant prévu ni réalisé.": "No planned or actual amount.",
    "Aucun réglage : la carte affiche tous les comptes partagés.": "No settings: the card shows all shared accounts.",
    "Aucun élément.": "No item.",
    "Aucune dépense pour l'instant.": "No expense yet.",
    "Aucune opération ne correspond aux critères.": "No transaction matches the filters.",
    "Aucune opération planifiée.": "No scheduled transaction.",
    "Aucune opération sur cette période.": "No transaction in this period.",
    "Aucune échéance dans les 30 prochains jours.": "Nothing due in the next 30 days.",
    "Aucune échéance à inscrire": "No occurrence to enter",
    "Autre": "Other",
    "Autre compte": "Other account",
    "Budget": "Budget",
    "Budget introuvable.": "Budget not found.",
    "Budget « {name} »": "Budget “{name}”",
    "Budgets": "Budgets",
    "Carte": "Card",
    "Celui qui couvre le mois en cours": "The one covering the current month",
    "Champs affichés (le montant l'est toujours) :": "Fields shown (the amount always is):",
    "Changer une date décale les suivantes": "Changing a date moves the following ones",
    "Chaque participant doit avoir un nom.": "Every participant needs a name.",
    "Chaque échéance doit avoir un montant positif (le sens est celui de l'opération planifiée).": "Every occurrence needs a positive amount (the direction is that of the scheduled transaction).",
    "Chargement…": "Loading…",
    "Choisir l'autre compte du virement.": "Choose the other account of the transfer.",
    "Choisir l'élément qui reçoit les opérations.": "Choose the item that receives the transactions.",
    "Classe": "Class",
    "Classes": "Classes",
    "Clôturer et équilibrer": "Close and settle",
    "Clôturer « {name} » ? Les dépenses seront figées et les remboursements définitifs (le compte pourra être rouvert).": "Close “{name}”? Expenses will be frozen and repayments final (the account can be reopened).",
    "Clôturé le {date}": "Closed on {date}",
    "Clôturés": "Closed",
    "Code postal": "Postcode",
    "Compte": "Account",
    "Compte clos": "Account closed",
    "Compte introuvable (capteur My Bank absent).": "Account not found (no My Bank sensor).",
    "Compte par défaut": "Default account",
    "Compte partagé": "Shared account",
    "Comptes": "Accounts",
    "Comptes partagés": "Shared accounts",
    "Comptes, opérations (pointage, ventilation, virements), échéancier, budgets, rubriques, classes et tiers — via My Bank API.": "Accounts, transactions (clearing, splits, transfers), scheduled transactions, budgets, categories, classes and payees — through My Bank API.",
    "Copier": "Copy",
    "Courant": "Checking",
    "Courses, restaurant…": "Groceries, restaurant…",
    "Critères": "Filters",
    "Critères ({n})": "Filters ({n})",
    "Créer": "Create",
    "Date": "Date",
    "Date du solde initial": "Opening balance date",
    "Dates de la règle": "Dates from the rule",
    "Dernière échéance au plus tard le": "Last occurrence no later than",
    "Dernière échéance dans les {n} jours": "Last occurrence within {n} days",
    "Deux participants portent le même nom.": "Two participants have the same name.",
    "Du": "From",
    "Du début du budget au mois en cours": "From the start of the budget to the current month",
    "Dé-rapprocher cette opération (elle reste pointée) ?": "Un-reconcile this transaction (it stays cleared)?",
    "Dé-rapprocher et dé-pointer cette opération ?": "Un-reconcile and un-clear this transaction?",
    "Dépense": "Expense",
    "Dépense de {amount} € enregistrée{who} ({account}, {date}).": "Expense of {amount} € saved{who} ({account}, {date}).",
    "Dépenses": "Expenses",
    "Dépenses ({n})": "Expenses ({n})",
    "Dépenses communes d'un groupe : qui paie la prochaine, qui doit combien à qui à la clôture.": "A group's shared expenses: who pays next, who owes how much to whom when closing.",
    "Déplacer": "Move",
    "Déplacer les {count} opération(s) de « {name} » vers « {target} » ?": "Move the {count} transaction(s) of “{name}” to “{target}”?",
    "Déplacer les {count} opération(s) de « {name} »{hint}, et ses planifications, vers :": "Move the {count} transaction(s) of “{name}”{hint}, and its scheduled transactions, to:",
    "Déplacer ses opérations vers…": "Move its transactions to…",
    "Déplier (montants sous-rubriques comprises)": "Expand (amounts include subcategories)",
    "E-mail": "Email",
    "Effacer": "Clear",
    "En cours": "Open",
    "Enregistrer": "Save",
    "Enregistrer la grille": "Save the grid",
    "Espèces": "Cash",
    "Fermer": "Close",
    "Fin": "End",
    "Il faut au moins deux participants.": "At least two participants are needed.",
    "Inactive : rien ne sera inscrit": "Inactive: nothing will be entered",
    "Inclure les opérations rapprochées (les soldes rapprochés des deux comptes changent)": "Include reconciled transactions (the reconciled balances of both accounts change)",
    "Indifférent": "Any",
    "Indiquer la première échéance et la fin": "Enter the first occurrence and the end",
    "Jamais": "Never",
    "Jours d'anticipation": "Days in advance",
    "Jusqu'à la fin du mois précédent": "Up to the end of last month",
    "L'échéancier « {label} » arrive à terme : dernière échéance le {date} ({when})": "The instalment plan “{label}” is ending: last instalment on {date} ({when})",
    "La planification a été enregistrée : vérifier ses montants (Échéances).": "The scheduled transaction was saved: check its amounts (Occurrences).",
    "La planification a été enregistrée mais laissée inactive : vérifier ses montants (Échéances) puis la réactiver.": "The scheduled transaction was saved but left inactive: check its amounts (Occurrences), then reactivate it.",
    "La planification « {label} » arrive à terme : dernière échéance le {date} ({when})": "The scheduled transaction “{label}” is ending: last occurrence on {date} ({when})",
    "Le mois en cours est hors du budget.": "The current month is outside the budget.",
    "Libellé": "Description",
    "Libellé / notes": "Description / notes",
    "Ligne": "Line",
    "Masquer cette alerte": "Hide this alert",
    "Mobile": "Mobile",
    "Mode": "Mode",
    "Mode de règlement": "Payment method",
    "Modifier": "Edit",
    "Mois en cours": "Current month",
    "Moins de champs": "Fewer fields",
    "Montant": "Amount",
    "Montant invalide (saisir un montant positif ; le type indique le sens).": "Invalid amount (enter a positive amount; the type gives the direction).",
    "Montant invalide (saisir un montant positif).": "Invalid amount (enter a positive amount).",
    "Montant invalide : « {value} »": "Invalid amount: “{value}”",
    "Montant max.": "Max. amount",
    "Montant min.": "Min. amount",
    "Montants et dates par échéance": "Amounts and dates per occurrence",
    "Montants positifs (le type donne le sens) ; ⇓ recopie un montant sur les échéances suivantes. Une date changée (trou dans l'échéancier, report) ne suit plus la règle ; « Dates de la règle » les rétablit toutes. Les échéances déjà saisies ne se modifient pas ici.": "Positive amounts (the type gives the direction); ⇓ copies an amount to the following occurrences. A changed date (gap in the plan, postponement) no longer follows the rule; “Dates from the rule” restores them all. Occurrences already entered cannot be changed here.",
    "Montants positifs, dans le sens de la rubrique (300 = 300 € de dépense prévus). ⇉ recopie le dernier montant saisi de la ligne sur les mois suivants. Une rubrique repliée (▸) affiche ses montants sous-rubriques comprises. Les lignes en majuscules totalisent chaque type ; « Total … » totalise une rubrique mère et ses sous-rubriques.": "Positive amounts, in the category's direction (300 = 300 € of planned spending). ⇉ copies the line's last amount to the following months. A collapsed category (▸) shows its amounts including subcategories. Upper-case lines total each type; “Total …” totals a parent category and its subcategories.",
    "My Bank": "My Bank",
    "My Bank — budget": "My Bank — budget",
    "My Bank — comptes partagés": "My Bank — shared accounts",
    "My Bank — saisie rapide": "My Bank — quick entry",
    "My Bank — soldes d'un compte": "My Bank — account balances",
    "Ne rien saisir d'office avant le": "Do not enter anything automatically before",
    "Niveaux de rubriques affichés (1 = rubriques racines)": "Category levels shown (1 = top-level categories)",
    "Nom": "Name",
    "Nom abrégé": "Short name",
    "Nom du nouveau budget": "Name of the new budget",
    "Nombre d'échéances": "Number of occurrences",
    "Nombre de mois": "Number of months",
    "Non": "No",
    "Non pointée": "Not cleared",
    "Non rapprochée": "Not reconciled",
    "Notes": "Notes",
    "Numéro": "Number",
    "N°": "No.",
    "N° de chèque": "Cheque number",
    "Opération": "Transaction",
    "Opération planifiée": "Scheduled transaction",
    "Opérations": "Transactions",
    "Opérations planifiées": "Scheduled transactions",
    "Oui": "Yes",
    "Par défaut : le tiers": "Default: the payee",
    "Parent": "Parent",
    "Part": "Share",
    "Partages": "Sharing",
    "Participant": "Participant",
    "Participants": "Participants",
    "Participants (toi compris), au moins deux": "Participants (including you), at least two",
    "Payé": "Paid",
    "Payé par": "Paid by",
    "Personne ne doit rien : chacun a payé sa part.": "Nobody owes anything: everyone paid their share.",
    "Plage de dates…": "Date range…",
    "Plage de mois…": "Month range…",
    "Pointé": "Cleared",
    "Pointée": "Cleared",
    "Pointée / rapprochée": "Cleared / reconciled",
    "Pour équilibrer si l'on clôturait maintenant": "To settle if closed now",
    "Premier compte": "First account",
    "Premier mois": "First month",
    "Première échéance": "First occurrence",
    "Prochaine dépense :": "Next expense:",
    "Prochaine dépense : {name}.": "Next expense: {name}.",
    "Prochaine échéance ({date}) inscrite dès l'enregistrement": "Next occurrence ({date}) entered on save",
    "Prochaine échéance ({date}) inscrite le {entry}": "Next occurrence ({date}) entered on {entry}",
    "Prénom": "First name",
    "Prévu": "Planned",
    "Période": "Period",
    "Périodique (montant fixe)": "Periodic (fixed amount)",
    "Rapproché": "Reconciled",
    "Rapproché :": "Reconciled:",
    "Rapprochée": "Reconciled",
    "Recette": "Income",
    "Recette de {amount} € enregistrée{who} ({account}, {date}).": "Income of {amount} € saved{who} ({account}, {date}).",
    "Recettes": "Income",
    "Rechercher…": "Search…",
    "Recopier ce montant sur les échéances suivantes": "Copy this amount to the following occurrences",
    "Recopier le dernier montant saisi sur les mois suivants": "Copy the last amount entered to the following months",
    "Remarque": "Notes",
    "Remboursements à faire": "Repayments to make",
    "Replier": "Collapse",
    "Reste à ventiler : {n}": "Left to split: {n}",
    "Retirer": "Remove",
    "Retirer la ligne": "Remove line",
    "Retour": "Back",
    "Rien de prévu ce mois-ci.": "Nothing planned this month.",
    "Rien de prévu sur la période.": "Nothing planned for the period.",
    "Rouvrir": "Reopen",
    "Rubrique": "Category",
    "Rubrique par défaut": "Default category",
    "Rubriques": "Categories",
    "Réalisation": "Progress",
    "Réalisé": "Actual",
    "Réalisé / prévu et barres de réalisation par rubrique, niveaux réglables.": "Actual / planned and progress bars per category, adjustable levels.",
    "Réinitialiser les critères": "Reset filters",
    "Rétablir": "Restore",
    "Saisi dans la grille": "Entered in the grid",
    "Saisie": "Entered",
    "Saisie automatique à l'échéance": "Enter automatically when due",
    "Saisie d'opérations : compte par défaut et champs affichés réglables, pré-remplissage par le tiers.": "Transaction entry: default account and visible fields can be set, pre-filled from the payee.",
    "Saisie manuelle : pas d'inscription automatique": "Manual entry: no automatic entry",
    "Saisie|vue": "Planning",
    "Saisir l'opération maintenant": "Enter the transaction now",
    "Sans rubrique": "Uncategorized",
    "Sans ventilation": "No split",
    "Sauter": "Skip",
    "Sauter cette échéance": "Skip this occurrence",
    "Sauter cette échéance (elle ne sera pas saisie) ?": "Skip this occurrence (it will not be entered)?",
    "Sautée": "Skipped",
    "Section inconnue.": "Unknown section.",
    "Solde": "Balance",
    "Solde :": "Balance:",
    "Solde = payé − part : positif, la personne doit recevoir ; négatif, elle doit verser.": "Balance = paid − share: positive, the person gets money back; negative, they must pay.",
    "Solde banque (pointé)": "Bank balance (cleared)",
    "Solde banque :": "Bank balance:",
    "Solde du compte sur la période": "Account balance over the period",
    "Solde initial": "Opening balance",
    "Solde prévisionnel": "Projected balance",
    "Solde prévisionnel (toutes opérations)": "Projected balance (all transactions)",
    "Solde prévisionnel :": "Projected balance:",
    "Solde prévisionnel, solde banque (pointé) et rapproché d'un compte.": "Projected, bank (cleared) and reconciled balance of an account.",
    "Solde prévu (recettes − dépenses + épargne)": "Planned balance (income − expenses + savings)",
    "Solde prévu (recettes − dépenses − épargne)": "Planned balance (income − expenses − savings)",
    "Sous-rubriques comprises": "Including subcategories",
    "Suivi": "Tracking",
    "Supprimer": "Delete",
    "Supprimer ce compte ?": "Delete this account?",
    "Supprimer ce tiers ?": "Delete this payee?",
    "Supprimer ce virement (les deux opérations) ?": "Delete this transfer (both transactions)?",
    "Supprimer cette classe ?": "Delete this class?",
    "Supprimer cette opération ?": "Delete this transaction?",
    "Supprimer cette rubrique ?": "Delete this category?",
    "Supprimer la dépense « {label} » de {amount} € ?": "Delete the expense “{label}” of {amount} €?",
    "Supprimer le budget « {name} » et tous ses montants ?": "Delete the budget “{name}” and all its amounts?",
    "Supprimer « {label} » ? Les opérations déjà saisies restent.": "Delete “{label}”? Transactions already entered are kept.",
    "Supprimer « {name} » ensuite": "Then delete “{name}”",
    "Supprimer « {name} », ses participants et ses {n} dépense(s) ?": "Delete “{name}”, its participants and its {n} expense(s)?",
    "Tableau de bord": "Dashboard",
    "Tiers": "Payees",
    "Tiers / autre compte": "Payee / other account",
    "Tiers|champ": "Payee",
    "Titre (facultatif)": "Title (optional)",
    "Total": "Total",
    "Total {name}": "Total {name}",
    "Total {total} € · part de chacun {share} €": "Total {total} € · each person's share {share} €",
    "Tous": "All",
    "Tous les": "Every",
    "Tous les ans": "Every year",
    "Tous les champs": "All fields",
    "Tous les jours": "Every day",
    "Tous les mois": "Every month",
    "Tous les trimestres": "Every quarter",
    "Tous les {n} ans": "Every {n} years",
    "Tous les {n} jours": "Every {n} days",
    "Tous les {n} mois": "Every {n} months",
    "Tous les {n} trimestres": "Every {n} quarters",
    "Tout déplier": "Expand all",
    "Tout replier": "Collapse all",
    "Toute la période": "Whole period",
    "Toutes": "All",
    "Toutes les rubriques": "All categories",
    "Toutes les semaines": "Every week",
    "Toutes les {n} semaines": "Every {n} weeks",
    "Type": "Type",
    "Type (dépense, recette, virement)": "Type (expense, income, transfer)",
    "Type (rubrique racine ; hérité sinon)": "Type (top-level category; inherited otherwise)",
    "Téléphone": "Phone",
    "Un champ masqué reste pré-rempli depuis la dernière opération du tiers et enregistré ; la date est celle du jour.": "A hidden field is still pre-filled from the payee's last transaction and saved; the date is today's.",
    "Un virement ne se ventile pas : choisir une seule rubrique.": "A transfer cannot be split: choose a single category.",
    "Un échéancier compte au plus {n} échéances : réduire la durée.": "An instalment plan has at most {n} occurrences: shorten the duration.",
    "Unité": "Unit",
    "Ventilation": "Split",
    "Ventilation complète": "Split complete",
    "Ventilation incomplète : chaque ligne doit avoir un montant.": "Incomplete split: every line needs an amount.",
    "Ventiler": "Split",
    "Ventilée ({n})": "Split ({n})",
    "Vers": "To",
    "Ville": "City",
    "Virement": "Transfer",
    "Virement de {amount} € enregistré : {from} → {to}.": "Transfer of {amount} € saved: {from} → {to}.",
    "Virement depuis…": "Transfer from…",
    "Virement vers…": "Transfer to…",
    "Virements": "Transfers",
    "Voir": "Show",
    "Voir les opérations de la rubrique (sous-rubriques comprises)": "Show the category's transactions (including subcategories)",
    "Voir ses échéances": "Show its occurrences",
    "Volets affichés par cette carte (décoche ceux dont tu n'as pas besoin sur ce dashboard) :": "Tabs shown by this card (untick those you don't need on this dashboard):",
    "Week-end à la mer": "Weekend at the seaside",
    "an(s)": "year(s)",
    "aujourd'hui": "today",
    "clôturé le {date}": "closed on {date}",
    "compte {id}": "account {id}",
    "dans {n} jours": "in {n} days",
    "de": "from",
    "demain": "tomorrow",
    "en retard": "overdue",
    "fin le {date}": "ends {date}",
    "hors budget": "not budgeted",
    "inactive": "inactive",
    "inscription auto le {date}": "auto entry on {date}",
    "jour(s)": "day(s)",
    "mois": "month(s)",
    "payé par {name}": "paid by {name}",
    "prochain": "next",
    "prochain : {name}": "next: {name}",
    "prochaine : {date}": "next: {date}",
    "saisie manuelle": "manual entry",
    "semaine(s)": "week(s)",
    "terminée": "finished",
    "trimestre(s)": "quarter(s)",
    "{actual} réalisés sur {planned} prévus": "{actual} actual of {planned} planned",
    "{amount} € payés par {name}.": "{amount} € paid by {name}.",
    "{base}, jusqu'au {date}": "{base}, until {date}",
    "{base}, {n} fois": "{base}, {n} times",
    "{done}/{total} générées": "{done}/{total} generated",
    "{from} verse à {to}": "{from} pays {to}",
    "{name} (copie)": "{name} (copy)",
    "{n} dépense(s)": "{n} expense(s)",
    "{n} opération(s) déplacée(s) de « {name} » vers « {target} ».": "{n} transaction(s) moved from “{name}” to “{target}”.",
    "{n} opération(s) et {s} planification(s) déplacée(s) de « {name} » vers « {target} ».": "{n} transaction(s) and {s} scheduled transaction(s) moved from “{name}” to “{target}”.",
    "{n} opération(s) sur {all} · total {total} €": "{n} of {all} transaction(s) · total {total} €",
    "{n} planification(s) arrivant à terme dans les {days} jours": "{n} scheduled transaction(s) ending within {days} days",
    "{n} échéance(s) · total {total} €": "{n} occurrence(s) · total {total} €",
    "{n} échéances au maximum : réduire la durée": "{n} occurrences at most: shorten the duration",
    "« {name} » a été supprimé.": "“{name}” was deleted.",
    "« {name} » n'a pas pu être supprimé : {error}": "“{name}” could not be deleted: {error}",
    "À une date": "On a date",
    "À venir": "Upcoming",
    "À venir (30 jours)": "Upcoming (30 days)",
    "Écart": "Variance",
    "Écart positif = favorable (moins dépensé, plus reçu ou épargné). Montants des rubriques parentes, sous-rubriques comprises. ▾ / ▸ replie ou déplie une rubrique.": "Positive variance = favourable (less spent, more received or saved). Parent category amounts include their subcategories. ▾ / ▸ collapses or expands a category.",
    "Échéance {n} : montant invalide (saisir un montant positif ; le type indique le sens).": "Occurrence {n}: invalid amount (enter a positive amount; the type gives the direction).",
    "Échéance {n} : sa date ({date}) précède celle de l'échéance {prev}.": "Occurrence {n}: its date ({date}) is before that of occurrence {prev}.",
    "Échéances": "Occurrences",
    "Échéances des 7 prochains jours": "Due in the next 7 days",
    "Échéancier": "Schedule",
    "Échéancier (montant par échéance)": "Instalment plan (amount per occurrence)",
    "Épargne": "Savings",
    "État": "Status",
    "à": "to",
    "échéancier": "instalment plan",
    "— (racine)": "— (top level)",
    "— choisir —": "— choose —",
  },
  de: {
    " · encore {n} échéances": " · noch {n}",
    "(a payé {paid} €, le moins du groupe)": "(hat {paid} € bezahlt, am wenigsten in der Gruppe)",
    "(archivé)": "(archiviert)",
    "(clos)": "(geschlossen)",
    "(inactif)": "(inaktiv)",
    "(inactive)|classe": "(inaktiv)",
    "(inactive)|rubrique": "(inaktiv)",
    "(le solde initial reste sur ce compte)": "(der Anfangssaldo bleibt auf diesem Konto)",
    "(part de la rubrique)": "(Anteil der Kategorie)",
    "(rattachées directement, pas celles des sous-éléments)": "(direkt zugeordnet, nicht die der Unterelemente)",
    "(sans fin : prochaines échéances)": "(ohne Ende: nächste Ausführungen)",
    "(à un centime près)": "(auf den Cent genau)",
    ", {n} échéances": ", {n} Ausführungen",
    "12 derniers mois": "Letzte 12 Monate",
    "1re échéance ({date}) inscrite dès l'enregistrement": "1. Ausführung ({date}) wird beim Speichern gebucht",
    "1re échéance ({date}) inscrite le {entry}": "1. Ausführung ({date}) wird am {entry} gebucht",
    "3 derniers mois": "Letzte 3 Monate",
    "A payé des dépenses : ne peut pas être retiré": "Hat Ausgaben bezahlt: kann nicht entfernt werden",
    "Abandonner la saisie en cours ?": "Aktuelle Eingabe verwerfen?",
    "Abandonner les montants saisis non enregistrés ?": "Nicht gespeicherte Beträge verwerfen?",
    "Actif": "Aktiv",
    "Active": "Aktiv",
    "Active|classe": "Aktiv",
    "Active|rubrique": "Aktiv",
    "Adresse": "Adresse",
    "Afficher aussi les rubriques hors budget (réalisé sans prévu)": "Auch nicht budgetierte Kategorien anzeigen (Ist ohne Plan)",
    "Ajouter": "Hinzufügen",
    "Ajouter la dépense": "Ausgabe hinzufügen",
    "Ajouter un sous-élément": "Unterelement hinzufügen",
    "Annuler": "Abbrechen",
    "Année en cours": "Aktuelles Jahr",
    "Antérieure": "Vor Beginn",
    "Après N échéances": "Nach N Ausführungen",
    "Archivé": "Archiviert",
    "Attention : « {target} » est de type {targetKind}, « {name} » de type {kind} (les suivis de budget changent).": "Achtung: „{target}“ ist vom Typ {targetKind}, „{name}“ vom Typ {kind} (die Budgetauswertung ändert sich).",
    "Au": "Bis",
    "Aucun budget ne couvre le mois en cours.": "Kein Budget deckt den aktuellen Monat ab.",
    "Aucun budget. Un budget suit un compte : montants prévus par rubrique et par mois, puis réalisé et écarts.": "Kein Budget. Ein Budget gehört zu einem Konto: geplante Beträge je Kategorie und Monat, dann Ist-Werte und Abweichungen.",
    "Aucun compte partagé en cours. Un compte partagé réunit les dépenses communes d'un groupe (vacances…) pour les équilibrer.": "Kein offenes geteiltes Konto. Ein geteiltes Konto sammelt die gemeinsamen Ausgaben einer Gruppe (Urlaub…), um sie auszugleichen.",
    "Aucun compte.": "Kein Konto.",
    "Aucun compte. Crée d'abord un compte dans l'onglet « Comptes ».": "Kein Konto. Lege zuerst ein Konto im Reiter „Konten“ an.",
    "Aucun mois du budget dans cette période.": "Kein Budgetmonat in diesem Zeitraum.",
    "Aucun montant prévu ni réalisé.": "Keine geplanten oder tatsächlichen Beträge.",
    "Aucun réglage : la carte affiche tous les comptes partagés.": "Keine Einstellungen: Die Karte zeigt alle geteilten Konten.",
    "Aucun élément.": "Keine Einträge.",
    "Aucune dépense pour l'instant.": "Noch keine Ausgaben.",
    "Aucune opération ne correspond aux critères.": "Keine Buchung entspricht den Filtern.",
    "Aucune opération planifiée.": "Kein Dauerauftrag.",
    "Aucune opération sur cette période.": "Keine Buchungen in diesem Zeitraum.",
    "Aucune échéance dans les 30 prochains jours.": "In den nächsten 30 Tagen ist nichts fällig.",
    "Aucune échéance à inscrire": "Keine Ausführung zu buchen",
    "Autre": "Sonstiges",
    "Autre compte": "Anderes Konto",
    "Budget": "Budget",
    "Budget introuvable.": "Budget nicht gefunden.",
    "Budget « {name} »": "Budget „{name}“",
    "Budgets": "Budgets",
    "Carte": "Karte",
    "Celui qui couvre le mois en cours": "Das für den aktuellen Monat",
    "Champs affichés (le montant l'est toujours) :": "Angezeigte Felder (der Betrag immer):",
    "Changer une date décale les suivantes": "Datumsänderung verschiebt die folgenden",
    "Chaque participant doit avoir un nom.": "Jeder Teilnehmer braucht einen Namen.",
    "Chaque échéance doit avoir un montant positif (le sens est celui de l'opération planifiée).": "Jede Ausführung braucht einen positiven Betrag (die Richtung ist die des Dauerauftrags).",
    "Chargement…": "Wird geladen…",
    "Choisir l'autre compte du virement.": "Das andere Konto der Umbuchung auswählen.",
    "Choisir l'élément qui reçoit les opérations.": "Das Ziel für die Buchungen auswählen.",
    "Classe": "Klasse",
    "Classes": "Klassen",
    "Clôturer et équilibrer": "Abschließen und ausgleichen",
    "Clôturer « {name} » ? Les dépenses seront figées et les remboursements définitifs (le compte pourra être rouvert).": "„{name}“ abschließen? Die Ausgaben werden eingefroren und die Rückzahlungen endgültig (das Konto kann wieder geöffnet werden).",
    "Clôturé le {date}": "Abgeschlossen am {date}",
    "Clôturés": "Abgeschlossen",
    "Code postal": "Postleitzahl",
    "Compte": "Konto",
    "Compte clos": "Konto geschlossen",
    "Compte introuvable (capteur My Bank absent).": "Konto nicht gefunden (kein My-Bank-Sensor).",
    "Compte par défaut": "Standardkonto",
    "Compte partagé": "Geteiltes Konto",
    "Comptes": "Konten",
    "Comptes partagés": "Geteilte Konten",
    "Comptes, opérations (pointage, ventilation, virements), échéancier, budgets, rubriques, classes et tiers — via My Bank API.": "Konten, Buchungen (Abgleich, Aufteilung, Umbuchungen), Daueraufträge, Budgets, Kategorien, Klassen und Empfänger — über My Bank API.",
    "Copier": "Kopieren",
    "Courant": "Girokonto",
    "Courses, restaurant…": "Einkäufe, Restaurant…",
    "Critères": "Filter",
    "Critères ({n})": "Filter ({n})",
    "Créer": "Anlegen",
    "Date": "Datum",
    "Date du solde initial": "Datum des Anfangssaldos",
    "Dates de la règle": "Daten laut Regel",
    "Dernière échéance au plus tard le": "Letzte Ausführung spätestens am",
    "Dernière échéance dans les {n} jours": "Letzte Ausführung innerhalb von {n} Tagen",
    "Deux participants portent le même nom.": "Zwei Teilnehmer haben denselben Namen.",
    "Du": "Von",
    "Du début du budget au mois en cours": "Vom Budgetbeginn bis zum aktuellen Monat",
    "Dé-rapprocher cette opération (elle reste pointée) ?": "Abstimmung dieser Buchung aufheben (sie bleibt abgeglichen)?",
    "Dé-rapprocher et dé-pointer cette opération ?": "Abstimmung und Abgleich dieser Buchung aufheben?",
    "Dépense": "Ausgabe",
    "Dépense de {amount} € enregistrée{who} ({account}, {date}).": "Ausgabe über {amount} € gespeichert{who} ({account}, {date}).",
    "Dépenses": "Ausgaben",
    "Dépenses ({n})": "Ausgaben ({n})",
    "Dépenses communes d'un groupe : qui paie la prochaine, qui doit combien à qui à la clôture.": "Gemeinsame Ausgaben einer Gruppe: wer als Nächstes zahlt, wer wem beim Abschluss wie viel schuldet.",
    "Déplacer": "Verschieben",
    "Déplacer les {count} opération(s) de « {name} » vers « {target} » ?": "Die {count} Buchung(en) von „{name}“ nach „{target}“ verschieben?",
    "Déplacer les {count} opération(s) de « {name} »{hint}, et ses planifications, vers :": "Die {count} Buchung(en) von „{name}“{hint} und die zugehörigen Daueraufträge verschieben nach:",
    "Déplacer ses opérations vers…": "Buchungen verschieben nach…",
    "Déplier (montants sous-rubriques comprises)": "Aufklappen (Beträge inkl. Unterkategorien)",
    "E-mail": "E-Mail",
    "Effacer": "Leeren",
    "En cours": "Offen",
    "Enregistrer": "Speichern",
    "Enregistrer la grille": "Tabelle speichern",
    "Espèces": "Bargeld",
    "Fermer": "Schließen",
    "Fin": "Ende",
    "Il faut au moins deux participants.": "Es braucht mindestens zwei Teilnehmer.",
    "Inactive : rien ne sera inscrit": "Inaktiv: es wird nichts gebucht",
    "Inclure les opérations rapprochées (les soldes rapprochés des deux comptes changent)": "Abgestimmte Buchungen einschließen (die abgestimmten Salden beider Konten ändern sich)",
    "Indifférent": "Egal",
    "Indiquer la première échéance et la fin": "Erste Ausführung und Ende angeben",
    "Jamais": "Nie",
    "Jours d'anticipation": "Tage im Voraus",
    "Jusqu'à la fin du mois précédent": "Bis Ende des Vormonats",
    "L'échéancier « {label} » arrive à terme : dernière échéance le {date} ({when})": "Der Ratenplan „{label}“ läuft aus: letzte Rate am {date} ({when})",
    "La planification a été enregistrée : vérifier ses montants (Échéances).": "Der Dauerauftrag wurde gespeichert: Beträge prüfen (Ausführungen).",
    "La planification a été enregistrée mais laissée inactive : vérifier ses montants (Échéances) puis la réactiver.": "Der Dauerauftrag wurde gespeichert, bleibt aber inaktiv: Beträge prüfen (Ausführungen) und ihn wieder aktivieren.",
    "La planification « {label} » arrive à terme : dernière échéance le {date} ({when})": "Der Dauerauftrag „{label}“ läuft aus: letzte Ausführung am {date} ({when})",
    "Le mois en cours est hors du budget.": "Der aktuelle Monat liegt außerhalb des Budgets.",
    "Libellé": "Buchungstext",
    "Libellé / notes": "Text / Notizen",
    "Ligne": "Zeile",
    "Masquer cette alerte": "Diesen Hinweis ausblenden",
    "Mobile": "Mobil",
    "Mode": "Modus",
    "Mode de règlement": "Zahlungsart",
    "Modifier": "Bearbeiten",
    "Mois en cours": "Aktueller Monat",
    "Moins de champs": "Weniger Felder",
    "Montant": "Betrag",
    "Montant invalide (saisir un montant positif ; le type indique le sens).": "Ungültiger Betrag (positiven Betrag eingeben; die Art bestimmt die Richtung).",
    "Montant invalide (saisir un montant positif).": "Ungültiger Betrag (positiven Betrag eingeben).",
    "Montant invalide : « {value} »": "Ungültiger Betrag: „{value}“",
    "Montant max.": "Höchstbetrag",
    "Montant min.": "Mindestbetrag",
    "Montants et dates par échéance": "Beträge und Daten je Ausführung",
    "Montants positifs (le type donne le sens) ; ⇓ recopie un montant sur les échéances suivantes. Une date changée (trou dans l'échéancier, report) ne suit plus la règle ; « Dates de la règle » les rétablit toutes. Les échéances déjà saisies ne se modifient pas ici.": "Positive Beträge (die Art bestimmt die Richtung); ⇓ überträgt einen Betrag auf die folgenden Ausführungen. Ein geändertes Datum (Lücke im Plan, Verschiebung) folgt nicht mehr der Regel; „Daten laut Regel“ stellt alle wieder her. Bereits gebuchte Ausführungen lassen sich hier nicht ändern.",
    "Montants positifs, dans le sens de la rubrique (300 = 300 € de dépense prévus). ⇉ recopie le dernier montant saisi de la ligne sur les mois suivants. Une rubrique repliée (▸) affiche ses montants sous-rubriques comprises. Les lignes en majuscules totalisent chaque type ; « Total … » totalise une rubrique mère et ses sous-rubriques.": "Positive Beträge in Richtung der Kategorie (300 = 300 € geplante Ausgaben). ⇉ überträgt den letzten Betrag der Zeile auf die folgenden Monate. Eine zugeklappte Kategorie (▸) zeigt ihre Beträge inkl. Unterkategorien. Zeilen in Großbuchstaben summieren je Art; „Summe …“ summiert eine übergeordnete Kategorie mit ihren Unterkategorien.",
    "My Bank": "My Bank",
    "My Bank — budget": "My Bank — Budget",
    "My Bank — comptes partagés": "My Bank — geteilte Konten",
    "My Bank — saisie rapide": "My Bank — Schnellerfassung",
    "My Bank — soldes d'un compte": "My Bank — Kontosalden",
    "Ne rien saisir d'office avant le": "Vor diesem Datum nichts automatisch buchen",
    "Niveaux de rubriques affichés (1 = rubriques racines)": "Angezeigte Kategorieebenen (1 = oberste Kategorien)",
    "Nom": "Name",
    "Nom abrégé": "Kurzname",
    "Nom du nouveau budget": "Name des neuen Budgets",
    "Nombre d'échéances": "Anzahl der Ausführungen",
    "Nombre de mois": "Anzahl Monate",
    "Non": "Nein",
    "Non pointée": "Nicht abgeglichen",
    "Non rapprochée": "Nicht abgestimmt",
    "Notes": "Notizen",
    "Numéro": "Nummer",
    "N°": "Nr.",
    "N° de chèque": "Schecknummer",
    "Opération": "Buchung",
    "Opération planifiée": "Dauerauftrag",
    "Opérations": "Buchungen",
    "Opérations planifiées": "Daueraufträge",
    "Oui": "Ja",
    "Par défaut : le tiers": "Standard: der Empfänger",
    "Parent": "Übergeordnet",
    "Part": "Anteil",
    "Partages": "Geteilte Ausgaben",
    "Participant": "Teilnehmer",
    "Participants": "Teilnehmer",
    "Participants (toi compris), au moins deux": "Teilnehmer (du eingeschlossen), mindestens zwei",
    "Payé": "Bezahlt",
    "Payé par": "Bezahlt von",
    "Personne ne doit rien : chacun a payé sa part.": "Niemand schuldet etwas: Jeder hat seinen Anteil bezahlt.",
    "Plage de dates…": "Zeitraum…",
    "Plage de mois…": "Monatsbereich…",
    "Pointé": "Abgeglichen",
    "Pointée": "Abgeglichen",
    "Pointée / rapprochée": "Abgeglichen / abgestimmt",
    "Pour équilibrer si l'on clôturait maintenant": "Ausgleich bei sofortigem Abschluss",
    "Premier compte": "Erstes Konto",
    "Premier mois": "Erster Monat",
    "Première échéance": "Erste Ausführung",
    "Prochaine dépense :": "Nächste Ausgabe:",
    "Prochaine dépense : {name}.": "Nächste Ausgabe: {name}.",
    "Prochaine échéance ({date}) inscrite dès l'enregistrement": "Nächste Ausführung ({date}) wird beim Speichern gebucht",
    "Prochaine échéance ({date}) inscrite le {entry}": "Nächste Ausführung ({date}) wird am {entry} gebucht",
    "Prénom": "Vorname",
    "Prévu": "Geplant",
    "Période": "Zeitraum",
    "Périodique (montant fixe)": "Periodisch (fester Betrag)",
    "Rapproché": "Abgestimmt",
    "Rapproché :": "Abgestimmt:",
    "Rapprochée": "Abgestimmt",
    "Recette": "Einnahme",
    "Recette de {amount} € enregistrée{who} ({account}, {date}).": "Einnahme über {amount} € gespeichert{who} ({account}, {date}).",
    "Recettes": "Einnahmen",
    "Rechercher…": "Suchen…",
    "Recopier ce montant sur les échéances suivantes": "Diesen Betrag auf die folgenden Ausführungen übertragen",
    "Recopier le dernier montant saisi sur les mois suivants": "Den zuletzt eingegebenen Betrag auf die folgenden Monate übertragen",
    "Remarque": "Bemerkung",
    "Remboursements à faire": "Fällige Rückzahlungen",
    "Replier": "Zuklappen",
    "Reste à ventiler : {n}": "Noch aufzuteilen: {n}",
    "Retirer": "Entfernen",
    "Retirer la ligne": "Zeile entfernen",
    "Retour": "Zurück",
    "Rien de prévu ce mois-ci.": "Für diesen Monat ist nichts geplant.",
    "Rien de prévu sur la période.": "Für den Zeitraum ist nichts geplant.",
    "Rouvrir": "Wieder öffnen",
    "Rubrique": "Kategorie",
    "Rubrique par défaut": "Standardkategorie",
    "Rubriques": "Kategorien",
    "Réalisation": "Fortschritt",
    "Réalisé": "Ist",
    "Réalisé / prévu et barres de réalisation par rubrique, niveaux réglables.": "Ist / Plan und Fortschrittsbalken je Kategorie, einstellbare Ebenen.",
    "Réinitialiser les critères": "Filter zurücksetzen",
    "Rétablir": "Wiederherstellen",
    "Saisi dans la grille": "In der Tabelle erfasst",
    "Saisie": "Gebucht",
    "Saisie automatique à l'échéance": "Bei Fälligkeit automatisch buchen",
    "Saisie d'opérations : compte par défaut et champs affichés réglables, pré-remplissage par le tiers.": "Buchungserfassung: Standardkonto und sichtbare Felder einstellbar, Vorbelegung anhand des Empfängers.",
    "Saisie manuelle : pas d'inscription automatique": "Manuelle Buchung: keine automatische Buchung",
    "Saisie|vue": "Planung",
    "Saisir l'opération maintenant": "Buchung jetzt erfassen",
    "Sans rubrique": "Ohne Kategorie",
    "Sans ventilation": "Ohne Aufteilung",
    "Sauter": "Überspringen",
    "Sauter cette échéance": "Diese Ausführung überspringen",
    "Sauter cette échéance (elle ne sera pas saisie) ?": "Diese Ausführung überspringen (sie wird nicht gebucht)?",
    "Sautée": "Übersprungen",
    "Section inconnue.": "Unbekannter Bereich.",
    "Solde": "Saldo",
    "Solde :": "Saldo:",
    "Solde = payé − part : positif, la personne doit recevoir ; négatif, elle doit verser.": "Saldo = bezahlt − Anteil: positiv, die Person bekommt Geld; negativ, sie muss zahlen.",
    "Solde banque (pointé)": "Banksaldo (abgeglichen)",
    "Solde banque :": "Banksaldo:",
    "Solde du compte sur la période": "Kontosaldo im Zeitraum",
    "Solde initial": "Anfangssaldo",
    "Solde prévisionnel": "Voraussichtlicher Saldo",
    "Solde prévisionnel (toutes opérations)": "Voraussichtlicher Saldo (alle Buchungen)",
    "Solde prévisionnel :": "Voraussichtlicher Saldo:",
    "Solde prévisionnel, solde banque (pointé) et rapproché d'un compte.": "Voraussichtlicher Saldo, Banksaldo (abgeglichen) und abgestimmter Saldo eines Kontos.",
    "Solde prévu (recettes − dépenses + épargne)": "Geplanter Saldo (Einnahmen − Ausgaben + Sparen)",
    "Solde prévu (recettes − dépenses − épargne)": "Geplanter Saldo (Einnahmen − Ausgaben − Sparen)",
    "Sous-rubriques comprises": "Inkl. Unterkategorien",
    "Suivi": "Auswertung",
    "Supprimer": "Löschen",
    "Supprimer ce compte ?": "Dieses Konto löschen?",
    "Supprimer ce tiers ?": "Diesen Empfänger löschen?",
    "Supprimer ce virement (les deux opérations) ?": "Diese Umbuchung löschen (beide Buchungen)?",
    "Supprimer cette classe ?": "Diese Klasse löschen?",
    "Supprimer cette opération ?": "Diese Buchung löschen?",
    "Supprimer cette rubrique ?": "Diese Kategorie löschen?",
    "Supprimer la dépense « {label} » de {amount} € ?": "Die Ausgabe „{label}“ über {amount} € löschen?",
    "Supprimer le budget « {name} » et tous ses montants ?": "Das Budget „{name}“ mit allen Beträgen löschen?",
    "Supprimer « {label} » ? Les opérations déjà saisies restent.": "„{label}“ löschen? Bereits erfasste Buchungen bleiben erhalten.",
    "Supprimer « {name} » ensuite": "„{name}“ danach löschen",
    "Supprimer « {name} », ses participants et ses {n} dépense(s) ?": "„{name}“ mit seinen Teilnehmern und {n} Ausgabe(n) löschen?",
    "Tableau de bord": "Übersicht",
    "Tiers": "Empfänger",
    "Tiers / autre compte": "Empfänger / anderes Konto",
    "Tiers|champ": "Empfänger",
    "Titre (facultatif)": "Titel (optional)",
    "Total": "Summe",
    "Total {name}": "Summe {name}",
    "Total {total} € · part de chacun {share} €": "Summe {total} € · Anteil pro Person {share} €",
    "Tous": "Alle",
    "Tous les": "Alle",
    "Tous les ans": "Jährlich",
    "Tous les champs": "Alle Felder",
    "Tous les jours": "Täglich",
    "Tous les mois": "Monatlich",
    "Tous les trimestres": "Vierteljährlich",
    "Tous les {n} ans": "Alle {n} Jahre",
    "Tous les {n} jours": "Alle {n} Tage",
    "Tous les {n} mois": "Alle {n} Monate",
    "Tous les {n} trimestres": "Alle {n} Quartale",
    "Tout déplier": "Alle aufklappen",
    "Tout replier": "Alle zuklappen",
    "Toute la période": "Gesamter Zeitraum",
    "Toutes": "Alle",
    "Toutes les rubriques": "Alle Kategorien",
    "Toutes les semaines": "Wöchentlich",
    "Toutes les {n} semaines": "Alle {n} Wochen",
    "Type": "Art",
    "Type (dépense, recette, virement)": "Art (Ausgabe, Einnahme, Umbuchung)",
    "Type (rubrique racine ; hérité sinon)": "Art (oberste Kategorie; sonst geerbt)",
    "Téléphone": "Telefon",
    "Un champ masqué reste pré-rempli depuis la dernière opération du tiers et enregistré ; la date est celle du jour.": "Ein ausgeblendetes Feld wird weiterhin aus der letzten Buchung des Empfängers vorausgefüllt und gespeichert; das Datum ist das heutige.",
    "Un virement ne se ventile pas : choisir une seule rubrique.": "Eine Umbuchung kann nicht aufgeteilt werden: eine einzige Kategorie wählen.",
    "Un échéancier compte au plus {n} échéances : réduire la durée.": "Ein Ratenplan hat höchstens {n} Ausführungen: Laufzeit verkürzen.",
    "Unité": "Einheit",
    "Ventilation": "Aufteilung",
    "Ventilation complète": "Aufteilung vollständig",
    "Ventilation incomplète : chaque ligne doit avoir un montant.": "Unvollständige Aufteilung: Jede Zeile braucht einen Betrag.",
    "Ventiler": "Aufteilen",
    "Ventilée ({n})": "Aufgeteilt ({n})",
    "Vers": "Nach",
    "Ville": "Ort",
    "Virement": "Umbuchung",
    "Virement de {amount} € enregistré : {from} → {to}.": "Umbuchung über {amount} € gespeichert: {from} → {to}.",
    "Virement depuis…": "Umbuchung von…",
    "Virement vers…": "Umbuchung auf…",
    "Virements": "Umbuchungen",
    "Voir": "Anzeigen",
    "Voir les opérations de la rubrique (sous-rubriques comprises)": "Buchungen der Kategorie anzeigen (inkl. Unterkategorien)",
    "Voir ses échéances": "Ausführungen anzeigen",
    "Volets affichés par cette carte (décoche ceux dont tu n'as pas besoin sur ce dashboard) :": "Von dieser Karte angezeigte Reiter (abwählen, was auf diesem Dashboard nicht gebraucht wird):",
    "Week-end à la mer": "Wochenende am Meer",
    "an(s)": "Jahr(e)",
    "aujourd'hui": "heute",
    "clôturé le {date}": "abgeschlossen am {date}",
    "compte {id}": "Konto {id}",
    "dans {n} jours": "in {n} Tagen",
    "de": "von",
    "demain": "morgen",
    "en retard": "überfällig",
    "fin le {date}": "endet am {date}",
    "hors budget": "nicht budgetiert",
    "inactive": "inaktiv",
    "inscription auto le {date}": "automatische Buchung am {date}",
    "jour(s)": "Tag(e)",
    "mois": "Monat(e)",
    "payé par {name}": "bezahlt von {name}",
    "prochain": "als Nächstes",
    "prochain : {name}": "als Nächstes: {name}",
    "prochaine : {date}": "nächste: {date}",
    "saisie manuelle": "manuelle Buchung",
    "semaine(s)": "Woche(n)",
    "terminée": "beendet",
    "trimestre(s)": "Quartal(e)",
    "{actual} réalisés sur {planned} prévus": "{actual} Ist von {planned} geplant",
    "{amount} € payés par {name}.": "{amount} € bezahlt von {name}.",
    "{base}, jusqu'au {date}": "{base}, bis {date}",
    "{base}, {n} fois": "{base}, {n}-mal",
    "{done}/{total} générées": "{done}/{total} erzeugt",
    "{from} verse à {to}": "{from} zahlt an {to}",
    "{name} (copie)": "{name} (Kopie)",
    "{n} dépense(s)": "{n} Ausgabe(n)",
    "{n} opération(s) déplacée(s) de « {name} » vers « {target} ».": "{n} Buchung(en) von „{name}“ nach „{target}“ verschoben.",
    "{n} opération(s) et {s} planification(s) déplacée(s) de « {name} » vers « {target} ».": "{n} Buchung(en) und {s} Dauerauftrag/-aufträge von „{name}“ nach „{target}“ verschoben.",
    "{n} opération(s) sur {all} · total {total} €": "{n} von {all} Buchung(en) · Summe {total} €",
    "{n} planification(s) arrivant à terme dans les {days} jours": "{n} Dauerauftrag/-aufträge endet/enden innerhalb von {days} Tagen",
    "{n} échéance(s) · total {total} €": "{n} Ausführung(en) · Summe {total} €",
    "{n} échéances au maximum : réduire la durée": "Höchstens {n} Ausführungen: Laufzeit verkürzen",
    "« {name} » a été supprimé.": "„{name}“ wurde gelöscht.",
    "« {name} » n'a pas pu être supprimé : {error}": "„{name}“ konnte nicht gelöscht werden: {error}",
    "À une date": "An einem Datum",
    "À venir": "Ausstehend",
    "À venir (30 jours)": "Demnächst (30 Tage)",
    "Écart": "Abweichung",
    "Écart positif = favorable (moins dépensé, plus reçu ou épargné). Montants des rubriques parentes, sous-rubriques comprises. ▾ / ▸ replie ou déplie une rubrique.": "Positive Abweichung = günstig (weniger ausgegeben, mehr erhalten oder gespart). Beträge übergeordneter Kategorien enthalten die Unterkategorien. ▾ / ▸ klappt eine Kategorie zu oder auf.",
    "Échéance {n} : montant invalide (saisir un montant positif ; le type indique le sens).": "Ausführung {n}: ungültiger Betrag (positiven Betrag eingeben; die Art bestimmt die Richtung).",
    "Échéance {n} : sa date ({date}) précède celle de l'échéance {prev}.": "Ausführung {n}: ihr Datum ({date}) liegt vor dem von Ausführung {prev}.",
    "Échéances": "Ausführungen",
    "Échéances des 7 prochains jours": "Fällig in den nächsten 7 Tagen",
    "Échéancier": "Daueraufträge",
    "Échéancier (montant par échéance)": "Ratenplan (Betrag je Rate)",
    "Épargne": "Sparen",
    "État": "Status",
    "à": "bis",
    "échéancier": "Ratenplan",
    "— (racine)": "— (oberste Ebene)",
    "— choisir —": "— auswählen —",
  },
};
// @@I18N-END@@
customElements.define("my-bank-card", MyBankCard);
customElements.define("my-bank-card-editor", MyBankCardEditor);
customElements.define("my-bank-share-card", MyBankShareCard);
customElements.define("my-bank-share-card-editor", MyBankShareCardEditor);
customElements.define("my-bank-entry-card", MyBankEntryCard);
customElements.define("my-bank-entry-card-editor", MyBankEntryCardEditor);
customElements.define("my-bank-balance-card", MyBankBalanceCard);
customElements.define("my-bank-balance-card-editor", MyBankBalanceCardEditor);
customElements.define("my-bank-budget-card", MyBankBudgetCard);
customElements.define("my-bank-budget-card-editor", MyBankBudgetCardEditor);

window.customCards = window.customCards || [];
// Sélecteur de cartes : textes traduits à l'affichage du sélecteur (getters).
const pickerCard = (type, name, description) => ({ type, get name() { return t(name); }, get description() { return t(description); } });
window.customCards.push(
  pickerCard("my-bank-card", "My Bank", "Comptes, opérations (pointage, ventilation, virements), échéancier, budgets, rubriques, classes et tiers — via My Bank API."),
  pickerCard("my-bank-entry-card", "My Bank — saisie rapide", "Saisie d'opérations : compte par défaut et champs affichés réglables, pré-remplissage par le tiers."),
  pickerCard("my-bank-balance-card", "My Bank — soldes d'un compte", "Solde prévisionnel, solde banque (pointé) et rapproché d'un compte."),
  pickerCard("my-bank-share-card", "My Bank — comptes partagés", "Dépenses communes d'un groupe : qui paie la prochaine, qui doit combien à qui à la clôture."),
  pickerCard("my-bank-budget-card", "My Bank — budget", "Réalisé / prévu et barres de réalisation par rubrique, niveaux réglables."),
);
