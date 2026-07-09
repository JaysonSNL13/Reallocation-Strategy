/**
 * Config.gs — all tunables and secrets access for the suit reallocation engine.
 *
 * Secrets (Brightpearl token, billing project) live in Script Properties, never in
 * source. Set them once via the "Reallocation ▸ Setup ▸ Set credentials" menu, or in
 * Project Settings ▸ Script Properties. See DEPLOY.md.
 *
 * The engine numbers below mirror the spec (Part A) and the live tool's queries. Do not
 * change them without re-reading Reallocation_Engine_Build_Spec.md — they define the
 * business logic Jayson asked us to keep faithful.
 */

// ---- Script Property keys ---------------------------------------------------
const PROP = {
  BP_BASE_URL: 'BP_BASE_URL',           // https://use1.brightpearlconnect.com/public-api/stateandliberty
  BP_APP_REF: 'BP_APP_REF',             // brightpearl-app-ref header
  BP_ACCOUNT_TOKEN: 'BP_ACCOUNT_TOKEN', // brightpearl-account-token header
  BP_WRITES_ENABLED: 'BP_WRITES_ENABLED', // "true" to allow writes; anything else = dry run
  BQ_BILLING_PROJECT: 'BQ_BILLING_PROJECT', // GCP project that pays for the query jobs
  RECEIVING_EMAIL: 'RECEIVING_EMAIL',   // where the PURGE-PRIORITY expedite list goes
  EMAIL_BCC: 'EMAIL_BCC',               // optional: BCC on every store pull-list email
  DRY_RUN_EMAIL: 'DRY_RUN_EMAIL',       // if set, ALL store emails route here instead (safe testing)
  DATA_SOURCE: 'DATA_SOURCE',           // 'sheet' (default) or 'bigquery'
  SOURCE_SPREADSHEET_ID: 'SOURCE_SPREADSHEET_ID', // the "Store Dashboard for WebApp" workbook id
  DEMO_MODE: 'DEMO_MODE'                // 'true' (default): Create just moves rows to Log, no email/Brightpearl
};

// Where the engine reads its ranking input from. Defaults to the Store Dashboard workbook.
function dataSource_() { return String(getProp_(PROP.DATA_SOURCE, 'sheet')).toLowerCase(); }

/**
 * Demo mode (default ON). When on, "Create transfer/email" only moves approved rows to Log —
 * it does NOT create Brightpearl transfers or Gmail drafts. Devs set DEMO_MODE = false to
 * turn on the real transfer + email actions.
 */
function demoMode_() { return String(getProp_(PROP.DEMO_MODE, 'true')).toLowerCase() !== 'false'; }

// ---- BigQuery mirror --------------------------------------------------------
const BQ = {
  DATA_PROJECT: 'loyal-manifest-415122',
  DATASET: 'loyal_manifest_brightpearl_live'
};

// ---- Brightpearl ------------------------------------------------------------
const DC_WAREHOUSE_ID = '2';                 // Ann Arbor DC — fulfillment, excluded from sell-through
const DC_WAREHOUSE_NAME = 'Ann Arbor';       // how the DC appears in the INV tab's Warehouse column (vs "Ann Arbor POS" = the store)

// Store name -> short code, for the transfer-CSV reference (realloc-<CODE>-<M/D>).
const STORE_CODES = {
  'Alexandria POS': 'ALX', 'Ann Arbor POS': 'AA', 'Basecamp POS': 'BC', 'Bellevue POS': 'BELL',
  'Birmingham POS': 'BHAM', 'Boston POS': 'BOS', 'Century City POS': 'CC', 'Charleston POS': 'CHS',
  'Chicago POS': 'CHI', 'Cincinnati POS': 'CINC', 'Cleveland POS': 'CLE', 'Columbus POS': 'CLB',
  'DC POS': 'DC', 'Dallas POS': 'DAL', 'Dedham POS': 'DED', 'Denver POS': 'DEN', 'Flatiron POS': 'FLAT',
  'Fort Lauderdale POS': 'FLL', 'Greenhills POS': 'GH', 'Greenville POS': 'GV', 'Greenwich POS': 'GW',
  'Houston POS': 'HOU', 'Indianapolis POS': 'IND', 'Kansas City POS': 'KC', 'La Jolla POS': 'LJ',
  'Lynnfield POS': 'LYN', 'Manhattan Beach POS': 'MB', 'Miami POS': 'MIA', 'Milwaukee POS': 'MKE',
  'Minneapolis POS': 'MIN', 'Nashville POS': 'NASH', 'New York POS': 'NY', 'Newport Beach POS': 'NPB',
  'Oakville StateandLiberty': 'OAK', 'Philadelphia POS': 'PHI', 'Pittsburgh POS': 'PIT',
  'Roseville POS': 'ROSE', 'Salt Lake City POS': 'SLC', 'Scottsdale POS': 'SCOT', 'Tampa POS': 'TPA',
  'Toronto State and Liberty': 'TNT', 'Walnut Creek POS': 'WC', 'Westport POS': 'WES'
};

/** Short code for a store name; falls back to a derived code if not mapped. */
function storeCode_(name) {
  if (STORE_CODES[name]) return STORE_CODES[name];
  return String(name || '').replace(/\bPOS\b/i, '').replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase() || 'STORE';
}
// Not real retail stores / bad mirror data. Never donors or recipients.
const EXCLUDED_WAREHOUSES = ['2', '16', '17', '21', '29', '37', '42', '43', '44', '49'];

// ---- Size model -------------------------------------------------------------
const BLAZER_SIZES = [36, 38, 40, 42, 44, 46, 48];              // 7 sizes; SHORT blazers excluded
const PANT_SIZES  = [29, 30, 31, 32, 33, 34, 36, 38, 40];       // 9 sizes
const BLAZER_FULL = BLAZER_SIZES.length;                        // 7
const PANT_FULL   = PANT_SIZES.length;                          // 9
// "Money" sizes — always treated as in-play even if the store's run is otherwise full.
const MONEY_BLAZER = [40, 42, 44];
const MONEY_PANT   = [32, 33, 34];

// ---- Engine tunables (Part A) ----------------------------------------------
const ENGINE = {
  SALES_WINDOW_DAYS: 180,        // ranking signal
  DEAD_WINDOW_DAYS: 30,          // force-empty "dead" detection (0 sales in 30d)
  RECIP_TOP_N: 10,               // recipient must be a top-10 seller of the style
  DONOR_BOTTOM_N: 10,            // donors drawn from bottom-10 sellers (deadest first)
  MAX_DONORS: 3,                 // max donors per recipient
  RUN_TARGET: 0.5,               // post-transfer: >=50% of blazer AND pant sizes
  DC_INSTOCK_MIN_UNITS: 2,       // a DC size counts as in-stock only if > 2 units
  PO_LANDING_DAYS: 14,           // skip styles with a PO landing within 14 days
  FORCE_EMPTY_TOP_SOLD_MIN: 20,  // force-empty only for proven sellers (top store >=20 units/180d)
  FORCE_EMPTY_MIN_NEW_SIZES: 2,  // force-empty recipient must gain >=2 brand-new sizes
  RECIP_MIN_STYLE_S30: 5         // Q_CAND recipients require style 30d sales >= 5 (live-tool parity)
};

// ---- Sheet tab names --------------------------------------------------------
const SHEET = {
  PROPOSALS: 'Proposed Transfers',
  APPROVAL_HELP: 'How to Approve',
  TRACKER: 'Tracker',
  RECEIVING: 'Receiving Priority',
  STORE_EMAILS: 'Store Emails',   // store name/warehouse id -> email address
  RUN_LOG: 'Run Log',
  TRANSFER_CSV: 'Transfer CSV',
  SETTINGS: 'Settings'
};

// ---- Helpers ----------------------------------------------------------------
function props_() { return PropertiesService.getScriptProperties(); }

function getProp_(key, fallback) {
  const v = props_().getProperty(key);
  return (v === null || v === undefined || v === '') ? (fallback === undefined ? null : fallback) : v;
}

/** Master write kill-switch. Defaults to OFF (dry run) unless explicitly "true". */
function writesEnabled_() {
  return String(getProp_(PROP.BP_WRITES_ENABLED, 'false')).toLowerCase() === 'true';
}

/** True only when all Brightpearl credentials are present. Used to choose live vs preview. */
function bpConfigured_() {
  return !!(getProp_(PROP.BP_BASE_URL) && getProp_(PROP.BP_APP_REF) && getProp_(PROP.BP_ACCOUNT_TOKEN));
}

function bqBillingProject_() {
  return getProp_(PROP.BQ_BILLING_PROJECT, BQ.DATA_PROJECT);
}

function requireProp_(key) {
  const v = getProp_(key);
  if (!v) throw new Error('Missing Script Property: ' + key + ' (set it via Reallocation ▸ Setup).');
  return v;
}
