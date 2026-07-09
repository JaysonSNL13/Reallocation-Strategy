/* ===================== Config.gs ===================== */
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
  SOURCE_SPREADSHEET_ID: 'SOURCE_SPREADSHEET_ID' // the "Store Dashboard for WebApp" workbook id
};

// Where the engine reads its ranking input from. Defaults to the Store Dashboard workbook.
function dataSource_() { return String(getProp_(PROP.DATA_SOURCE, 'sheet')).toLowerCase(); }

// ---- BigQuery mirror --------------------------------------------------------
const BQ = {
  DATA_PROJECT: 'loyal-manifest-415122',
  DATASET: 'loyal_manifest_brightpearl_live'
};

// ---- Brightpearl ------------------------------------------------------------
const DC_WAREHOUSE_ID = '2';                 // Ann Arbor DC — fulfillment, excluded from sell-through
const DC_WAREHOUSE_NAME = 'Ann Arbor';       // how the DC appears in the INV tab's Warehouse column (vs "Ann Arbor POS" = the store)
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

function bqBillingProject_() {
  return getProp_(PROP.BQ_BILLING_PROJECT, BQ.DATA_PROJECT);
}

function requireProp_(key) {
  const v = getProp_(key);
  if (!v) throw new Error('Missing Script Property: ' + key + ' (set it via Reallocation ▸ Setup).');
  return v;
}
/* ===================== Util.gs ===================== */
/**
 * Util.gs — logging + small shared helpers.
 * Log writes to Stackdriver (console) and, when a spreadsheet is bound, appends to the
 * "Run Log" tab so Jayson can see what the weekly run did without opening the editor.
 */
var Log = (function () {
  function stamp_() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'); }

  function toSheet_(level, msg) {
    try {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      if (!ss) return;
      var sh = ss.getSheetByName(SHEET.RUN_LOG);
      if (!sh) { sh = ss.insertSheet(SHEET.RUN_LOG); sh.appendRow(['Time', 'Level', 'Message']); }
      sh.appendRow([stamp_(), level, String(msg)]);
    } catch (e) { /* logging must never throw */ }
  }

  function line_(level, args) {
    var msg = Array.prototype.slice.call(args).map(function (a) {
      return (typeof a === 'object') ? JSON.stringify(a) : String(a);
    }).join(' ');
    console.log('[' + level + '] ' + msg);
    if (level !== 'DEBUG') toSheet_(level, msg);
    return msg;
  }

  return {
    debug: function () { return line_('DEBUG', arguments); },
    info:  function () { return line_('INFO', arguments); },
    warn:  function () { return line_('WARN', arguments); },
    error: function () { return line_('ERROR', arguments); }
  };
})();

/** first char of a size token 'Blazer|40' / 'Pant|32' -> garment class. */
function tokGarment_(tok) { return String(tok).charAt(0) === 'B' ? 'Blazer' : 'Pant'; }

/** Given a set/array of size tokens, return {b, p} = fraction of full blazer/pant run held. */
function runFractions_(toks, blzFull, pntFull) {
  var b = 0, p = 0, seen = {};
  (toks || []).forEach(function (t) {
    if (seen[t]) return; seen[t] = true;
    if (tokGarment_(t) === 'Blazer') b++; else p++;
  });
  return {
    b: blzFull > 0 ? b / blzFull : 1,
    p: pntFull > 0 ? p / pntFull : 1
  };
}

function toBool_(v) { return v === true || v === 'true' || v === 1 || v === '1'; }
function num_(v) { return Number(v || 0); }
/* ===================== Brightpearl.gs ===================== */
/**
 * Brightpearl.gs — thin Brightpearl REST client.
 *
 * Mirrors the purge tool's client: two-call stock transfer (create + external-transfer)
 * and the guarded reorderLevel-0 write. Every write is gated by writesEnabled_() so the
 * whole engine runs read-only until Jayson flips BP_WRITES_ENABLED = true.
 *
 * Rate limits: Brightpearl throttles hard. We keep it sequential with a small delay and
 * retry on 429/503 with backoff.
 */

var BP = (function () {

  function baseUrl_() { return requireProp_(PROP.BP_BASE_URL).replace(/\/+$/, ''); }

  function headers_() {
    return {
      'brightpearl-app-ref': requireProp_(PROP.BP_APP_REF),
      'brightpearl-account-token': requireProp_(PROP.BP_ACCOUNT_TOKEN),
      'Content-Type': 'application/json'
    };
  }

  var MIN_GAP_MS = 350;          // ~3 req/s
  var _lastCallAt = 0;

  function throttle_() {
    var now = Date.now();
    var wait = MIN_GAP_MS - (now - _lastCallAt);
    if (wait > 0) Utilities.sleep(wait);
    _lastCallAt = Date.now();
  }

  /** Core request with retry. `method` GET/POST/PUT. Returns parsed JSON (or {} on 204). */
  function request_(method, path, body, opts) {
    opts = opts || {};
    var url = /^https?:/.test(path) ? path : baseUrl_() + path;
    var params = {
      method: method,
      headers: headers_(),
      muteHttpExceptions: true,
      contentType: 'application/json'
    };
    if (body !== undefined && body !== null) params.payload = JSON.stringify(body);

    var maxAttempts = 5;
    for (var attempt = 1; attempt <= maxAttempts; attempt++) {
      throttle_();
      var res = UrlFetchApp.fetch(url, params);
      var code = res.getResponseCode();
      var text = res.getContentText();

      if (code === 429 || code === 503) {
        var backoff = Math.min(8000, 500 * Math.pow(2, attempt));
        Log.warn('Brightpearl ' + code + ' on ' + method + ' ' + path + ' — retry ' + attempt + ' in ' + backoff + 'ms');
        Utilities.sleep(backoff);
        continue;
      }
      if (code >= 200 && code < 300) {
        if (!text) return {};
        try { return JSON.parse(text); } catch (e) { return {}; }
      }
      throw new Error('Brightpearl ' + method + ' ' + path + ' -> ' + code + ' ' + text);
    }
    throw new Error('Brightpearl ' + method + ' ' + path + ' failed after ' + maxAttempts + ' attempts (rate limited).');
  }

  // ---- Reads ---------------------------------------------------------------

  /**
   * Live availability for a set of productIds.
   * Returns { productId: { warehouseId: {onHand, allocated, inTransit, inStock, available} } }.
   * available = max(onHand - allocated, 0).
   */
  function getAvailability(productIds) {
    var ids = dedupeSortNumeric_(productIds);
    var out = {};
    var CHUNK = 100; // keep URLs sane
    for (var i = 0; i < ids.length; i += CHUNK) {
      var slice = ids.slice(i, i + CHUNK);
      var json = request_('GET', '/warehouse-service/product-availability/' + slice.join(','));
      var resp = (json && json.response) || {};
      Object.keys(resp).forEach(function (pid) {
        var whs = (resp[pid] && resp[pid].warehouses) || {};
        var m = {};
        Object.keys(whs).forEach(function (wid) {
          var w = whs[wid] || {};
          var onHand = Number(w.onHand || 0);
          var allocated = Number(w.allocated || 0);
          m[String(wid)] = {
            onHand: onHand,
            allocated: allocated,
            inTransit: Number(w.inTransit || 0),
            inStock: Number(w.inStock || 0),
            available: Math.max(onHand - allocated, 0)
          };
        });
        out[String(pid)] = m;
      });
    }
    return out;
  }

  function getProduct(productId) {
    var json = request_('GET', '/product-service/product/' + productId);
    var r = (json.response && json.response[0]) || null;
    return r;
  }

  function getProductGroup(groupId) {
    var json = request_('GET', '/product-service/product-group/' + groupId);
    return (json.response && json.response[0]) || null;
  }

  /** Current warehouse-product record (has reorderLevel, reorderQuantity, ...). */
  function getWarehouseProduct(warehouseId, productId) {
    var json = request_('GET', '/warehouse-service/warehouse/' + warehouseId + '/product/' + productId);
    return (json.response) || null;
  }

  function getStockTransfer(id) {
    var json = request_('GET', '/warehouse-service/stock-transfer/' + id);
    return (json.response) || null;
  }

  /**
   * Unified movement feed for shipped vs received. typed 'GO' (goods-out) / 'GI' (goods-in).
   * Returns raw response.results with the accompanying metadata.columns for mapping.
   */
  function goodsMovementSearch(query) {
    var qs = Object.keys(query || {}).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(query[k]);
    }).join('&');
    return request_('GET', '/warehouse-service/goods-movement-search' + (qs ? '?' + qs : ''));
  }

  // ---- Writes (guarded) ----------------------------------------------------

  /**
   * Create a store-to-store stock transfer. Same two POSTs the purge tool does, but the
   * target is a seller store instead of the DC.
   *   1) create the transfer shell (carries the PURGE-PRIORITY reference)
   *   2) attach the transferred products (returns goods-out note ids)
   * Returns { stockTransferId, goodsOutNoteIds, dryRun }.
   */
  function createStockTransfer(donorWarehouseId, targetWarehouseId, reference, transferredProducts) {
    if (!transferredProducts || !transferredProducts.length) {
      throw new Error('createStockTransfer: no transferredProducts for ' + donorWarehouseId + '->' + targetWarehouseId);
    }
    if (!writesEnabled_()) {
      Log.info('[DRY RUN] would create transfer ' + donorWarehouseId + '->' + targetWarehouseId +
        ' ref="' + reference + '" items=' + transferredProducts.length);
      return { stockTransferId: null, goodsOutNoteIds: [], dryRun: true };
    }
    var createBody = { targetWarehouseId: Number(targetWarehouseId), reference: reference };
    var created = request_('POST', '/warehouse-service/warehouse/' + donorWarehouseId + '/stock-transfer', createBody);
    var stockTransferId = created && created.response;

    var extBody = {
      targetWarehouseId: Number(targetWarehouseId),
      stockTransferId: Number(stockTransferId),
      transferredProducts: transferredProducts.map(function (p) {
        return { productId: Number(p.productId), quantity: Number(p.quantity) };
      })
    };
    var ext = request_('POST', '/warehouse-service/warehouse/' + donorWarehouseId + '/external-transfer', extBody);
    var goodsOutNoteIds = normalizeIds_(ext && ext.response);
    return { stockTransferId: stockTransferId, goodsOutNoteIds: goodsOutNoteIds, dryRun: false };
  }

  /**
   * Zero a dead store's reorderLevel for a product so it won't be topped back up.
   * Reads the current record first so reorderQuantity is preserved.
   */
  function zeroReorderLevel(warehouseId, productId) {
    var current = null;
    try { current = getWarehouseProduct(warehouseId, productId); } catch (e) { /* fall through */ }
    var keepQty = (current && current.reorderQuantity != null) ? Number(current.reorderQuantity) : 0;
    var priorLevel = (current && current.reorderLevel != null) ? Number(current.reorderLevel) : null;

    if (!writesEnabled_()) {
      Log.info('[DRY RUN] would set reorderLevel=0 (was ' + priorLevel + ', keep qty ' + keepQty +
        ') for wh ' + warehouseId + ' product ' + productId);
      return { dryRun: true, priorLevel: priorLevel };
    }
    request_('PUT', '/warehouse-service/warehouse/' + warehouseId + '/product/' + productId,
      { reorderLevel: 0, reorderQuantity: keepQty });
    return { dryRun: false, priorLevel: priorLevel };
  }

  // ---- utils ---------------------------------------------------------------

  function dedupeSortNumeric_(ids) {
    var set = {};
    (ids || []).forEach(function (x) { if (x !== null && x !== undefined && x !== '') set[String(x)] = true; });
    return Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
  }

  function normalizeIds_(resp) {
    if (resp == null) return [];
    if (Array.isArray(resp)) return resp;
    if (typeof resp === 'object') return Object.keys(resp).map(function (k) { return resp[k]; });
    return [resp];
  }

  return {
    getAvailability: getAvailability,
    getProduct: getProduct,
    getProductGroup: getProductGroup,
    getWarehouseProduct: getWarehouseProduct,
    getStockTransfer: getStockTransfer,
    goodsMovementSearch: goodsMovementSearch,
    createStockTransfer: createStockTransfer,
    zeroReorderLevel: zeroReorderLevel
  };
})();
/* ===================== Queries.gs ===================== */
/**
 * Queries.gs — the BigQuery SQL that defines the engine's input data.
 *
 * The candidate query (buildCandidateQuery) is ported VERBATIM from the live tool's
 * Q_CAND, with exactly ONE deliberate change: the old tool injected the sales numbers
 * from a hand-set data pull via `UNNEST([...])`. Because we are rebuilding on LIVE data,
 * that injected CTE is replaced by a real mirror sales CTE (SALES_CTE) computed from
 * shipped, non-transfer goods-out notes over the ranking window (180 days). Everything
 * else — style parsing, the 16-size model, run math, warehouse eligibility (DC size counts
 * only if >2 units), the PO-within-14-days flag, the top-10 / bottom-10 role split — is
 * unchanged from the tool Jayson has been running.
 *
 * `s30` is the historical column name from the tool; here it carries SALES_WINDOW_DAYS
 * (180d) units, which is the ranking signal. The 30-day dead signal is a separate query
 * (Q_DEAD30) used only by the force-empty pass.
 *
 * Tables live in loyal-manifest-415122.loyal_manifest_brightpearl_live (+ Retool for the
 * threshold mirror). Kept fully-qualified, exactly as the live tool references them.
 */

// prod + ps + psale + msrp + fr  (verbatim from Q_CAND, lines 267–271 of the tool)
const _CAND_HEAD = `
WITH prod AS (SELECT product_id, sku, CASE WHEN STARTS_WITH(sku,'SL-BLAZER') THEN 'Blazer' ELSE 'Pant' END garment, SAFE_CAST(REGEXP_EXTRACT(sku, r'-([0-9]+)[A-Z]*$') AS INT64) size_num, SAFE_CAST(pricelist_usa_retail AS FLOAT64) retail, TRIM(REGEXP_REPLACE(REGEXP_REPLACE(productname, r'\\s*-\\s*[0-9]+[A-Za-z ]*$',''), r'^Athletic Fit Stretch (Blazer|Suit Pants)\\s*-\\s*','')) style FROM \`loyal-manifest-415122.loyal_manifest_brightpearl_live.products\` WHERE status='LIVE' AND NOT ENDS_WITH(sku,'-C') AND (productname LIKE 'Athletic Fit Stretch Blazer - %' OR productname LIKE 'Athletic Fit Stretch Suit Pants - %') AND NOT LOWER(productname) LIKE '%short%'),
ps AS (SELECT *, IF(garment='Blazer', size_num, size_num+8) set_size FROM prod WHERE size_num IS NOT NULL AND ((garment='Blazer' AND size_num IN (36,38,40,42,44,46,48)) OR (garment='Pant' AND size_num IN (29,30,31,32,33,34,36,38,40)))),
psale AS (SELECT product_id, TRIM(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(productname, r'\\s*-\\s*[0-9]+[A-Za-z ]*$',''), r'\\s*-\\s*Short\\s*$',''), r'^Athletic Fit Stretch (Blazer|Suit Pants)\\s*-\\s*','')) style FROM \`loyal-manifest-415122.loyal_manifest_brightpearl_live.products\` WHERE status='LIVE' AND NOT ENDS_WITH(sku,'-C') AND (productname LIKE 'Athletic Fit Stretch Blazer - %' OR productname LIKE 'Athletic Fit Stretch Suit Pants - %')),
msrp AS (SELECT style, COALESCE(MAX(IF(garment='Blazer',retail,NULL)),0) blz_msrp, COALESCE(MAX(IF(garment='Pant',retail,NULL)),0) pnt_msrp, MAX(IF(garment='Blazer',retail,NULL))+COALESCE(MAX(IF(garment='Pant',retail,NULL)),0) suit_msrp FROM ps GROUP BY style),
fr AS (SELECT style, COUNT(DISTINCT CONCAT(garment,CAST(size_num AS STRING))) full_run, COUNT(DISTINCT IF(garment='Blazer',size_num,NULL)) blz_full, COUNT(DISTINCT IF(garment='Pant',size_num,NULL)) pnt_full FROM ps GROUP BY 1),`;

// REPLACEMENT for the tool's injected sales UNNEST — real 180d mirror sales.
function _salesCte_(windowDays) {
  return `
sales AS (
  SELECT CAST(n.warehouseid AS STRING) wid, p.style, SUM(r.quantity) s30
  FROM \`loyal-manifest-415122.loyal_manifest_brightpearl_live.bp_goods_out_note\` n
  JOIN \`loyal-manifest-415122.loyal_manifest_brightpearl_live.bp_goods_out_orderrow\` r ON r.goodsnoteoutid=n.goodsnoteoutid
  JOIN psale p ON p.product_id=r.productid
  WHERE n.transfer=FALSE AND n.status_shipped=TRUE
    AND DATE(n.status_shippedon) >= DATE_SUB(CURRENT_DATE(), INTERVAL ${windowDays} DAY)
  GROUP BY 1,2
),`;
}

// av .. cand .. final SELECT  (verbatim from Q_CAND, lines 273–299 of the tool)
const _CAND_TAIL = `
av AS (SELECT CAST(a.warehouse AS STRING) wid, p.style, p.garment, p.size_num, p.set_size, SUM(a.availability_onhand) oh, SUM(SAFE_CAST(a.intransit AS INT64)) it FROM \`loyal-manifest-415122.loyal_manifest_brightpearl_live.availability\` a JOIN ps p ON p.product_id=a.product_id WHERE a.warehouse NOT IN ('2','16','17','21','29','37','42','43','44','49') GROUP BY 1,2,3,4,5 HAVING SUM(a.availability_onhand)>0 OR SUM(SAFE_CAST(a.intransit AS INT64))>0),
agg AS (SELECT wid, style, SUM(oh) units, COUNT(DISTINCT IF(oh>0,CONCAT(garment,CAST(size_num AS STRING)),NULL)) sizes_oh, COUNT(DISTINCT CONCAT(garment,CAST(size_num AS STRING))) sizes_eff, SUM(IF(garment='Blazer',oh,0)) blz, SUM(IF(garment='Pant',oh,0)) pnt, COUNT(DISTINCT IF(garment='Blazer',CAST(size_num AS STRING),NULL)) blz_eff, COUNT(DISTINCT IF(garment='Pant',CAST(size_num AS STRING),NULL)) pnt_eff FROM av GROUP BY 1,2),
pairs AS (SELECT wid, style, COUNT(*) cp FROM (SELECT wid, style, set_size FROM av WHERE oh>0 GROUP BY 1,2,3 HAVING COUNT(DISTINCT garment)=2) GROUP BY 1,2),
base AS (SELECT COALESCE(ag.wid,sa.wid) wid, COALESCE(ag.style,sa.style) style, COALESCE(sa.s30,0) sold, COALESCE(ag.units,0) units, COALESCE(ag.sizes_oh,0) sizes_oh, COALESCE(ag.sizes_eff,0) sizes_eff, COALESCE(ag.blz,0) blz, COALESCE(ag.pnt,0) pnt, COALESCE(ag.blz_eff,0) blz_eff, COALESCE(ag.pnt_eff,0) pnt_eff, COALESCE(pr.cp,0) cp FROM agg ag FULL JOIN sales sa ON sa.wid=ag.wid AND sa.style=ag.style LEFT JOIN pairs pr ON pr.wid=COALESCE(ag.wid,sa.wid) AND pr.style=COALESCE(ag.style,sa.style)),
ranked AS (SELECT b.*, f.full_run, ROUND(b.sizes_oh/f.full_run,2) run_oh, ROUND(b.sizes_eff/f.full_run,2) run_eff, ROUND(b.blz_eff/NULLIF(f.blz_full,0),2) blz_run, ROUND(b.pnt_eff/NULLIF(f.pnt_full,0),2) pnt_run, ROW_NUMBER() OVER(PARTITION BY b.style ORDER BY b.sold DESC, b.wid) top_rank, ROW_NUMBER() OVER(PARTITION BY b.style ORDER BY IF(b.units>0,0,1), b.sold ASC, b.wid) bot_rank FROM base b JOIN fr f ON f.style=b.style),
ssoh AS (SELECT wid, style, ARRAY_AGG(CONCAT(garment,'|',CAST(size_num AS STRING))) toks FROM av WHERE oh>0 GROUP BY 1,2),
sseff AS (SELECT wid, style, ARRAY_AGG(CONCAT(garment,'|',CAST(size_num AS STRING))) toks FROM av GROUP BY 1,2),
thr AS (SELECT CAST(w2.warehouseid AS STRING) wid, pp.style FROM \`loyal-manifest-415122.Retool.SCMProject_Threshold_New\` t JOIN prod pp ON pp.sku=t.sku JOIN \`loyal-manifest-415122.loyal_manifest_brightpearl_live.bpwarehouse\` w2 ON w2.name=t.warehouse_name WHERE SAFE_CAST(t.reorder_level AS INT64)>=1 GROUP BY 1,2),
whs AS (SELECT p.style, SUM(a.availability_onhand) wh_oh FROM \`loyal-manifest-415122.loyal_manifest_brightpearl_live.availability\` a JOIN ps p ON p.product_id=a.product_id WHERE a.warehouse='2' GROUP BY 1),
whsz AS (SELECT p.style, COUNT(DISTINCT CONCAT(p.garment,CAST(p.size_num AS STRING))) wh_avail, COUNT(DISTINCT IF(p.garment='Blazer',p.size_num,NULL)) wh_blz, COUNT(DISTINCT IF(p.garment='Pant',p.size_num,NULL)) wh_pnt FROM \`loyal-manifest-415122.loyal_manifest_brightpearl_live.availability\` a JOIN ps p ON p.product_id=a.product_id WHERE a.warehouse='2' AND a.availability_onhand>2 GROUP BY 1),
whpo AS (SELECT p.style, SUM(SAFE_CAST(pp.rows_quantity AS FLOAT64)) po_qty, MIN(DATE(pp.delivery_date)) po_eta FROM \`loyal-manifest-415122.loyal_manifest_brightpearl_live.bp_po\` pp JOIN ps p ON p.product_id=pp.rows_productid WHERE DATE(pp.delivery_date)>=CURRENT_DATE() AND UPPER(COALESCE(pp.ref,'')) NOT LIKE '%TOPS%' GROUP BY 1),
cand AS (
  SELECT 'recip' role, r0.wid, r0.style, r0.sold, r0.run_eff run, r0.run_oh, r0.full_run, r0.units, r0.blz, r0.pnt, r0.cp, IF(EXISTS(SELECT 1 FROM thr WHERE thr.wid=r0.wid AND thr.style=r0.style),1,0) has_thr, r0.top_rank srank, (COALESCE(r0.blz_run,1)<0.5 OR COALESCE(r0.pnt_run,1)<0.5) felig, ROW_NUMBER() OVER(PARTITION BY r0.style ORDER BY r0.sold DESC, r0.wid) rk FROM ranked r0 WHERE r0.top_rank<=10 AND r0.sold>=1
  UNION ALL
  SELECT 'donor' role, wid, style, sold, run_oh run, run_oh, full_run, units, blz, pnt, cp, 0 has_thr, top_rank srank, false felig, ROW_NUMBER() OVER(PARTITION BY style ORDER BY run_oh DESC, sold ASC, wid) rk FROM ranked WHERE bot_rank<=10 AND units>0
)
SELECT c.role, CAST(c.wid AS STRING) wid, w.name, c.style, c.sold, c.run, c.run_oh, c.full_run, c.units, c.blz, c.pnt, c.cp, c.has_thr, c.srank, c.rk, c.felig, CAST(ROUND(c.blz*m.blz_msrp + c.pnt*m.pnt_msrp) AS INT64) esi, CAST(m.blz_msrp AS INT64) blz_msrp, CAST(m.pnt_msrp AS INT64) pnt_msrp, IF(c.role='recip', se.toks, so.toks) toks, COALESCE(whs.wh_oh,0) wh_oh, COALESCE(whsz.wh_avail,0) wh_avail, COALESCE(whsz.wh_blz,0) wh_blz, COALESCE(whsz.wh_pnt,0) wh_pnt, COALESCE(ff.blz_full,0) blz_full, COALESCE(ff.pnt_full,0) pnt_full, CAST(COALESCE(whpo.po_qty,0) AS INT64) wh_po, whpo.po_eta, (whpo.po_eta IS NOT NULL AND whpo.po_eta <= DATE_ADD(CURRENT_DATE(), INTERVAL 14 DAY)) po_within14
FROM cand c
JOIN \`loyal-manifest-415122.loyal_manifest_brightpearl_live.bpwarehouse\` w ON CAST(w.warehouseid AS STRING)=c.wid
LEFT JOIN msrp m ON m.style=c.style
LEFT JOIN fr ff ON ff.style=c.style
LEFT JOIN ssoh so ON so.wid=c.wid AND so.style=c.style
LEFT JOIN sseff se ON se.wid=c.wid AND se.style=c.style
LEFT JOIN whs ON whs.style=c.style
LEFT JOIN whsz ON whsz.style=c.style
LEFT JOIN whpo ON whpo.style=c.style
ORDER BY c.style, c.role, c.rk`;

/** Full candidate query (recipient + donor rows, one per style/store) for the engine. */
function buildCandidateQuery(windowDays) {
  return _CAND_HEAD + _salesCte_(windowDays || ENGINE.SALES_WINDOW_DAYS) + _CAND_TAIL;
}

/** 30-day dead signal: units per (wid, style) shipped in-store in the last 30 days. */
function buildDead30Query(windowDays) {
  var d = windowDays || ENGINE.DEAD_WINDOW_DAYS;
  return `
WITH psale AS (SELECT product_id, TRIM(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(productname, r'\\s*-\\s*[0-9]+[A-Za-z ]*$',''), r'\\s*-\\s*Short\\s*$',''), r'^Athletic Fit Stretch (Blazer|Suit Pants)\\s*-\\s*','')) style FROM \`loyal-manifest-415122.loyal_manifest_brightpearl_live.products\` WHERE status='LIVE' AND NOT ENDS_WITH(sku,'-C') AND (productname LIKE 'Athletic Fit Stretch Blazer - %' OR productname LIKE 'Athletic Fit Stretch Suit Pants - %'))
SELECT CAST(n.warehouseid AS STRING) wid, p.style, SUM(r.quantity) units
FROM \`loyal-manifest-415122.loyal_manifest_brightpearl_live.bp_goods_out_note\` n
JOIN \`loyal-manifest-415122.loyal_manifest_brightpearl_live.bp_goods_out_orderrow\` r ON r.goodsnoteoutid=n.goodsnoteoutid
JOIN psale p ON p.product_id=r.productid
WHERE n.transfer=FALSE AND n.status_shipped=TRUE
  AND DATE(n.status_shippedon) >= DATE_SUB(CURRENT_DATE(), INTERVAL ${d} DAY)
GROUP BY 1,2`;
}

/**
 * Product map for a set of styles — product_id, sku, garment, size for every in-scope
 * size. Used at approval time to turn "donor ships everything it holds of this style"
 * into concrete SKU/productId pull lists (then confirmed against LIVE availability).
 * __STYLES__ is replaced with a comma-separated list of quoted style names.
 */
function buildStyleProductsQuery(styleList) {
  var quoted = (styleList || []).map(function (s) { return "'" + String(s).replace(/'/g, "\\'") + "'"; }).join(',');
  return `
WITH prod AS (SELECT product_id, sku, CASE WHEN STARTS_WITH(sku,'SL-BLAZER') THEN 'Blazer' ELSE 'Pant' END garment, SAFE_CAST(REGEXP_EXTRACT(sku, r'-([0-9]+)[A-Z]*$') AS INT64) size_num, TRIM(REGEXP_REPLACE(REGEXP_REPLACE(productname, r'\\s*-\\s*[0-9]+[A-Za-z ]*$',''), r'^Athletic Fit Stretch (Blazer|Suit Pants)\\s*-\\s*','')) style FROM \`loyal-manifest-415122.loyal_manifest_brightpearl_live.products\` WHERE status='LIVE' AND NOT ENDS_WITH(sku,'-C') AND (productname LIKE 'Athletic Fit Stretch Blazer - %' OR productname LIKE 'Athletic Fit Stretch Suit Pants - %') AND NOT LOWER(productname) LIKE '%short%')
SELECT CAST(product_id AS STRING) product_id, sku, garment, size_num, style FROM prod
WHERE size_num IS NOT NULL AND style IN (${quoted})
  AND ((garment='Blazer' AND size_num IN (36,38,40,42,44,46,48)) OR (garment='Pant' AND size_num IN (29,30,31,32,33,34,36,38,40)))`;
}
/* ===================== BigQuery.gs ===================== */
/**
 * BigQuery.gs — run queries against the Brightpearl mirror via the BigQuery advanced
 * service and return plain row objects. Billing project = Script Property
 * BQ_BILLING_PROJECT (defaults to the data project).
 */

/** Run standard-SQL, page through all results, return array of {colName: value}. */
function bqQuery_(sql) {
  var projectId = bqBillingProject_();
  var req = { query: sql, useLegacySql: false, timeoutMs: 120000 };
  var resp = BigQuery.Jobs.query(req, projectId);
  var jobId = resp.jobReference.jobId;
  var location = resp.jobReference.location;

  // Poll until the job completes.
  var guard = 0;
  while (!resp.jobComplete && guard++ < 60) {
    Utilities.sleep(1000);
    resp = BigQuery.Jobs.getQueryResults(projectId, jobId, { location: location, timeoutMs: 120000 });
  }
  if (!resp.jobComplete) throw new Error('BigQuery job did not complete: ' + jobId);

  var fields = (resp.schema && resp.schema.fields) ? resp.schema.fields.map(function (f) { return f.name; }) : [];
  var rows = resp.rows || [];
  var pageToken = resp.pageToken;
  while (pageToken) {
    var more = BigQuery.Jobs.getQueryResults(projectId, jobId, { location: location, pageToken: pageToken });
    rows = rows.concat(more.rows || []);
    pageToken = more.pageToken;
  }

  return rows.map(function (r) {
    var o = {};
    (r.f || []).forEach(function (cell, i) { o[fields[i]] = (cell ? cell.v : null); });
    return o;
  });
}

/**
 * Candidate rows for the engine, shaped for matchSuits().
 * `toks` comes back from BigQuery as a REPEATED field: an array of {v: 'Blazer|40'}.
 */
function fetchCandidates_() {
  var raw = bqQuery_(buildCandidateQuery(ENGINE.SALES_WINDOW_DAYS));
  return raw.map(function (c) {
    return {
      role: c.role,
      wid: String(c.wid),
      name: c.name,
      style: c.style,
      sold: num_(c.sold),
      run: num_(c.run),
      run_oh: num_(c.run_oh),
      full_run: num_(c.full_run),
      units: num_(c.units),
      blz: num_(c.blz),
      pnt: num_(c.pnt),
      cp: num_(c.cp),
      has_thr: num_(c.has_thr),
      srank: num_(c.srank),
      rk: num_(c.rk),
      felig: toBool_(c.felig),
      esi: num_(c.esi),
      blz_msrp: num_(c.blz_msrp),
      pnt_msrp: num_(c.pnt_msrp),
      toks: unpackRepeated_(c.toks),
      wh_oh: num_(c.wh_oh),
      wh_avail: num_(c.wh_avail),
      wh_blz: num_(c.wh_blz),
      wh_pnt: num_(c.wh_pnt),
      blz_full: num_(c.blz_full),
      pnt_full: num_(c.pnt_full),
      wh_po: num_(c.wh_po),
      po_eta: c.po_eta || null,
      po_within14: toBool_(c.po_within14)
    };
  });
}

/** Set of "wid|style" that had > 0 in-store sales in the last 30 days (i.e. NOT dead). */
function fetchAlive30_() {
  var rows = bqQuery_(buildDead30Query(ENGINE.DEAD_WINDOW_DAYS));
  var alive = {};
  rows.forEach(function (r) { if (num_(r.units) > 0) alive[String(r.wid) + '|' + r.style] = true; });
  return alive;
}

/** Product map for approval-time pull lists: { style: [{product_id, sku, garment, size}] }. */
function fetchStyleProducts_(styles) {
  if (!styles || !styles.length) return {};
  var rows = bqQuery_(buildStyleProductsQuery(styles));
  var byStyle = {};
  rows.forEach(function (r) {
    var s = r.style;
    (byStyle[s] = byStyle[s] || []).push({
      product_id: String(r.product_id),
      sku: r.sku,
      garment: r.garment,
      size: num_(r.size_num)
    });
  });
  return byStyle;
}

/** BigQuery REPEATED cell -> flat array of strings. */
function unpackRepeated_(cell) {
  if (cell == null) return [];
  if (Array.isArray(cell)) return cell.map(function (x) { return (x && x.v !== undefined) ? x.v : x; });
  return [];
}
/* ===================== SourceSheet.gs ===================== */
/**
 * SourceSheet.gs — read the engine's ranking input from the "Store Dashboard for WebApp"
 * Google Sheet instead of BigQuery, and recompute exactly the fields Q_CAND produced so the
 * output drops into runEngine_() unchanged.
 *
 * Tabs used (verified 2026-07-08):
 *   LOC ID        STORE NAME | Shopify Name | Threshold Name | LOC ID        (name -> warehouse id)
 *   ALL SKU       Parent Name | Product Type | SKU | Barcode | Size          (product dimension)
 *   INV           Product ID | SKU | Product Name | Warehouse | ... On hand | In Transit ...
 *   L180 / L30    Product variant SKU | POS location | Net items sold        (sales windows)
 *   Optimal Stock Location Name | SKU ID | Optimal Stock                     (thresholds)
 *   PO On Order   ... Order row SKU | Ref | ... ETA                          (DC POs, 14-day gate)
 *
 * The workbook has no MSRP, so ESI is 0 here — fine, ESI is deprecated and ranking is rank-gap.
 * Store names differ per tab (STORE NAME vs Shopify Name vs Threshold Name); we map ALL of
 * them to LOC ID, so any tab's location string resolves to a warehouse id.
 */

// Tab names + header aliases (edit here if a tab/column is renamed).
const SRC = {
  ID: { tab: 'LOC ID', mustContain: 'LOC ID',
        name: ['STORE NAME'], name2: ['Shopify Name'], name3: ['Threshold Name'], id: ['LOC ID'] },
  INV: { tab: 'INV', mustContain: 'Product ID',
         pid: ['Product ID'], sku: ['SKU'], pname: ['Product Name'], wh: ['Warehouse'],
         onhand: ['Sum of On hand', 'On hand'], intransit: ['Sum of In Transit', 'In Transit'] },
  SALES180: { tab: 'L180', mustContain: 'Net items sold',
              sku: ['Product variant SKU', 'SKU'], loc: ['POS location', 'Location'], units: ['Net items sold'] },
  SALES30: { tab: 'L30', mustContain: 'Net items sold',
             sku: ['Product variant SKU', 'SKU'], loc: ['POS location', 'Location'], units: ['Net items sold'] },
  OPT: { tab: 'Optimal Stock', mustContain: 'Optimal Stock',
         loc: ['Location Name'], sku: ['SKU ID', 'SKU'], qty: ['Optimal Stock'] },
  PO: { tab: 'PO On Order', mustContain: 'Order row',
        sku: ['Order row SKU', 'SKU'], ref: ['Ref'], eta: ['ETA', 'EXF DATE', 'Current EXF'], pname: ['Parent Name'] }
};

function openSource_() { return SpreadsheetApp.openById(requireProp_(PROP.SOURCE_SPREADSHEET_ID)); }
function norm_(s) { return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' '); }

/** Read a tab into {headers:[...], rows:[[...]]}, auto-finding the header row. */
function readTab_(ss, tab, mustContain) {
  var sh = ss.getSheetByName(tab);
  if (!sh) throw new Error('Source tab not found: "' + tab + '"');
  var values = sh.getDataRange().getValues();
  var target = norm_(mustContain);
  var hr = 0;
  for (var i = 0; i < Math.min(6, values.length); i++) {
    if (values[i].some(function (c) { return norm_(c).indexOf(target) >= 0; })) { hr = i; break; }
  }
  return { headers: values[hr], rows: values.slice(hr + 1) };
}

/** Column index for the first matching alias (exact, then contains). -1 if none. */
function colOf_(headers, aliases) {
  var normed = headers.map(norm_);
  for (var a = 0; a < aliases.length; a++) {
    var t = norm_(aliases[a]);
    var i = normed.indexOf(t);
    if (i >= 0) return i;
  }
  for (var a2 = 0; a2 < aliases.length; a2++) {
    var t2 = norm_(aliases[a2]);
    for (var j = 0; j < normed.length; j++) if (normed[j].indexOf(t2) >= 0) return j;
  }
  return -1;
}

// ---- Product dimension + style parsing -------------------------------------

/** Parse a full product name -> {garment, style, size} or null if not an in-scope suit. */
function parseSuitName_(productName) {
  var s = String(productName || '').trim();
  if (!s || /short/i.test(s)) return null;
  var garment;
  if (/^athletic fit stretch blazer\b/i.test(s)) garment = 'Blazer';
  else if (/^athletic fit stretch suit pants\b/i.test(s)) garment = 'Pant';
  else return null;
  var size = null;
  var m = s.match(/-\s*([0-9]+)\s*[A-Za-z ]*$/);
  if (m) size = parseInt(m[1], 10);
  if (size == null) return null;
  var inScope = (garment === 'Blazer') ? BLAZER_SIZES.indexOf(size) >= 0 : PANT_SIZES.indexOf(size) >= 0;
  if (!inScope) return null;
  var style = s.replace(/\s*-\s*[0-9]+[A-Za-z ]*$/, '')
    .replace(/^Athletic Fit Stretch (Blazer|Suit Pants)\s*-\s*/i, '').trim();
  return { garment: garment, style: style, size: size };
}

/** Parse from ALL SKU (Parent Name has no size; size is a separate column). */
function parseSuitParent_(parentName, sizeVal) {
  var p = String(parentName || '').trim();
  if (!p || /short/i.test(p)) return null;
  var garment;
  if (/^athletic fit stretch blazer\b/i.test(p)) garment = 'Blazer';
  else if (/^athletic fit stretch suit pants\b/i.test(p)) garment = 'Pant';
  else return null;
  var size = parseInt(String(sizeVal).match(/[0-9]+/) ? String(sizeVal).match(/[0-9]+/)[0] : '', 10);
  if (!size && size !== 0) return null;
  var inScope = (garment === 'Blazer') ? BLAZER_SIZES.indexOf(size) >= 0 : PANT_SIZES.indexOf(size) >= 0;
  if (!inScope) return null;
  var style = p.replace(/^Athletic Fit Stretch (Blazer|Suit Pants)\s*-\s*/i, '').trim();
  return { garment: garment, style: style, size: size };
}

/** Build {byPid, bySku, styleFull:{style:{blz:Set,pnt:Set}}} from INV (+ ALL SKU fallback). */
function buildDimension_(ss) {
  var byPid = {}, bySku = {}, styleFull = {};
  function note(style, garment, size) {
    var sf = styleFull[style] || (styleFull[style] = { blz: {}, pnt: {} });
    if (garment === 'Blazer') sf.blz[size] = true; else sf.pnt[size] = true;
  }
  // INV = authoritative for productId + full name.
  var inv = readTab_(ss, SRC.INV.tab, SRC.INV.mustContain);
  var iPid = colOf_(inv.headers, SRC.INV.pid), iSku = colOf_(inv.headers, SRC.INV.sku), iPn = colOf_(inv.headers, SRC.INV.pname);
  inv.rows.forEach(function (r) {
    var d = parseSuitName_(r[iPn]); if (!d) return;
    var pid = String(r[iPid] || '').trim(), sku = String(r[iSku] || '').trim();
    if (pid && !byPid[pid]) byPid[pid] = { product_id: pid, sku: sku, style: d.style, garment: d.garment, size: d.size };
    if (sku && !bySku[sku]) bySku[sku] = { product_id: pid, sku: sku, style: d.style, garment: d.garment, size: d.size };
    note(d.style, d.garment, d.size);
  });
  // ALL SKU fills any SKU not present in INV (sales SKUs with no current stock).
  try {
    var all = readTab_(ss, 'ALL SKU', 'SKU');
    var aSku = colOf_(all.headers, ['SKU']), aParent = colOf_(all.headers, ['Parent Name']), aSize = colOf_(all.headers, ['Size']);
    if (aSku >= 0 && aParent >= 0) {
      all.rows.forEach(function (r) {
        var sku = String(r[aSku] || '').trim(); if (!sku || bySku[sku]) return;
        var d = parseSuitParent_(r[aParent], aSize >= 0 ? r[aSize] : '');
        if (!d) return;
        bySku[sku] = { product_id: '', sku: sku, style: d.style, garment: d.garment, size: d.size };
        note(d.style, d.garment, d.size);
      });
    }
  } catch (e) { Log.warn('ALL SKU dimension fallback skipped: ' + e); }

  return { byPid: byPid, bySku: bySku, styleFull: styleFull };
}

// ---- LOC ID crosswalk ------------------------------------------------------

function buildLocMap_(ss) {
  var t = readTab_(ss, SRC.ID.tab, SRC.ID.mustContain);
  var cName = colOf_(t.headers, SRC.ID.name), cN2 = colOf_(t.headers, SRC.ID.name2),
      cN3 = colOf_(t.headers, SRC.ID.name3), cId = colOf_(t.headers, SRC.ID.id);
  var nameToId = {}, idToName = {};
  t.rows.forEach(function (r) {
    var id = String(r[cId] || '').trim(); if (!id) return;
    [cName, cN2, cN3].forEach(function (c) { if (c >= 0 && r[c] !== '') nameToId[norm_(r[c])] = id; });
    if (cName >= 0 && r[cName] !== '' && !idToName[id]) idToName[id] = String(r[cName]).trim();
  });
  // Ensure the DC resolves even if it's not a named row.
  nameToId[norm_(DC_WAREHOUSE_NAME)] = DC_WAREHOUSE_ID;
  if (!idToName[DC_WAREHOUSE_ID]) idToName[DC_WAREHOUSE_ID] = DC_WAREHOUSE_NAME;
  return { nameToId: nameToId, idToName: idToName };
}

// ---- Sales + thresholds + PO ------------------------------------------------

/** Aggregate a sales tab to { "wid|style": units } (retail stores only). */
function aggregateSales_(ss, cfg, dim, loc) {
  var t = readTab_(ss, cfg.tab, cfg.mustContain);
  var cSku = colOf_(t.headers, cfg.sku), cLoc = colOf_(t.headers, cfg.loc), cU = colOf_(t.headers, cfg.units);
  var out = {};
  t.rows.forEach(function (r) {
    var sku = String(r[cSku] || '').trim(); var d = dim.bySku[sku]; if (!d) return;
    var wid = loc.nameToId[norm_(r[cLoc])]; if (!wid || EXCLUDED_WAREHOUSES.indexOf(wid) >= 0) return;
    var k = wid + '|' + d.style;
    out[k] = (out[k] || 0) + num_(r[cU]);
  });
  return out;
}

/** Styles with an inbound DC PO landing within PO_LANDING_DAYS (excludes TOPS refs). */
function buildPoWithin14_(ss, dim) {
  var within = {};
  try {
    var t = readTab_(ss, SRC.PO.tab, SRC.PO.mustContain);
    var cSku = colOf_(t.headers, SRC.PO.sku), cRef = colOf_(t.headers, SRC.PO.ref),
        cEta = colOf_(t.headers, SRC.PO.eta), cPn = colOf_(t.headers, SRC.PO.pname);
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var limit = new Date(today.getTime() + ENGINE.PO_LANDING_DAYS * 864e5);
    t.rows.forEach(function (r) {
      if (cRef >= 0 && /tops/i.test(String(r[cRef] || ''))) return;
      var d = dim.bySku[String(r[cSku] || '').trim()];
      if (!d && cPn >= 0) d = parseSuitParent_(r[cPn], ''); // fall back to parent name
      if (!d) return;
      var eta = parseDate_(r[cEta]); if (!eta) return;
      if (eta >= today && eta <= limit) within[d.style] = true;
    });
  } catch (e) { Log.warn('PO On Order gate skipped: ' + e); }
  return within;
}

/** Set of "wid|style" where the store has an Optimal Stock (threshold) > 0. */
function buildHasThr_(ss, dim, loc) {
  var has = {};
  try {
    var t = readTab_(ss, SRC.OPT.tab, SRC.OPT.mustContain);
    var cLoc = colOf_(t.headers, SRC.OPT.loc), cSku = colOf_(t.headers, SRC.OPT.sku), cQ = colOf_(t.headers, SRC.OPT.qty);
    t.rows.forEach(function (r) {
      if (num_(r[cQ]) <= 0) return;
      var d = dim.bySku[String(r[cSku] || '').trim()]; if (!d) return;
      var wid = loc.nameToId[norm_(r[cLoc])]; if (!wid) return;
      has[wid + '|' + d.style] = true;
    });
  } catch (e) { Log.warn('Optimal Stock threshold read skipped: ' + e); }
  return has;
}

function parseDate_(v) {
  if (v instanceof Date) return v;
  if (v == null || v === '') return null;
  var d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

// ---- The main build (mirrors Q_CAND) ---------------------------------------

function fetchCandidatesFromSheet_() {
  var ss = openSource_();
  var loc = buildLocMap_(ss);
  var dim = buildDimension_(ss);

  // Inventory by (wid|style): on-hand + in-transit size sets and unit sums; DC coverage by style.
  var store = {};   // key wid|style -> record
  var dc = {};      // style -> { oh, blz:{}, pnt:{} }  (sizes with on-hand > DC_INSTOCK_MIN_UNITS)
  function rec_(wid, style) {
    var k = wid + '|' + style;
    return store[k] || (store[k] = { wid: wid, style: style, unitsOnHand: 0, blzUnits: 0, pntUnits: 0,
      ssoh: {}, sseff: {}, blzOn: {}, pntOn: {}, blzEff: {}, pntEff: {} });
  }

  var inv = readTab_(ss, SRC.INV.tab, SRC.INV.mustContain);
  var iPid = colOf_(inv.headers, SRC.INV.pid), iPn = colOf_(inv.headers, SRC.INV.pname),
      iWh = colOf_(inv.headers, SRC.INV.wh), iOh = colOf_(inv.headers, SRC.INV.onhand), iIt = colOf_(inv.headers, SRC.INV.intransit);
  var dcNorm = norm_(DC_WAREHOUSE_NAME);

  inv.rows.forEach(function (r) {
    var d = dim.byPid[String(r[iPid] || '').trim()] || parseSuitName_(r[iPn]);
    if (!d) return;
    var oh = num_(r[iOh]), it = num_(r[iIt]);
    var whName = norm_(r[iWh]);
    var tok = d.garment + '|' + d.size;

    if (whName === dcNorm) {
      var e = dc[d.style] || (dc[d.style] = { oh: 0, blz: {}, pnt: {} });
      e.oh += oh;
      if (oh > ENGINE.DC_INSTOCK_MIN_UNITS) { if (d.garment === 'Blazer') e.blz[d.size] = true; else e.pnt[d.size] = true; }
      return;
    }
    var wid = loc.nameToId[whName];
    if (!wid || EXCLUDED_WAREHOUSES.indexOf(wid) >= 0) return;
    var rc = rec_(wid, d.style);
    if (oh > 0) {
      rc.ssoh[tok] = 1; rc.unitsOnHand += oh;
      if (d.garment === 'Blazer') { rc.blzOn[d.size] = 1; rc.blzUnits += oh; } else { rc.pntOn[d.size] = 1; rc.pntUnits += oh; }
    }
    if (oh > 0 || it > 0) { rc.sseff[tok] = 1; if (d.garment === 'Blazer') rc.blzEff[d.size] = 1; else rc.pntEff[d.size] = 1; }
  });

  var sold = aggregateSales_(ss, SRC.SALES180, dim, loc);
  var hasThr = buildHasThr_(ss, dim, loc);
  var poWithin14 = buildPoWithin14_(ss, dim);

  // Assemble per-style store universe (inventory OR sales), then rank + emit roles.
  var byStyle = {}; // style -> { wid -> rec }
  Object.keys(store).forEach(function (k) {
    var rc = store[k]; (byStyle[rc.style] = byStyle[rc.style] || {})[rc.wid] = rc;
  });
  Object.keys(sold).forEach(function (k) {
    var parts = k.split('|'); var wid = parts[0], style = parts.slice(1).join('|');
    var m = (byStyle[style] = byStyle[style] || {});
    if (!m[wid]) m[wid] = rec_(wid, style); // sales-only store, zero inventory
  });

  var cands = [];
  Object.keys(byStyle).forEach(function (style) {
    var sf = dim.styleFull[style] || { blz: {}, pnt: {} };
    var blzFull = Object.keys(sf.blz).length || BLAZER_FULL;
    var pntFull = Object.keys(sf.pnt).length || PANT_FULL;
    var fullRun = blzFull + pntFull;
    var e = dc[style] || { oh: 0, blz: {}, pnt: {} };
    var whBlz = Object.keys(e.blz).length, whPnt = Object.keys(e.pnt).length;
    var poFlag = !!poWithin14[style];

    var recs = Object.keys(byStyle[style]).map(function (wid) {
      var rc = byStyle[style][wid];
      var sizesOh = Object.keys(rc.blzOn).length + Object.keys(rc.pntOn).length;
      var sizesEff = Object.keys(rc.blzEff).length + Object.keys(rc.pntEff).length;
      return {
        wid: wid, name: loc.idToName[wid] || wid, style: style,
        sold: num_(sold[wid + '|' + style]), units: rc.unitsOnHand,
        blz: rc.blzUnits, pnt: rc.pntUnits,
        sizesOh: sizesOh, sizesEff: sizesEff,
        blzEff: Object.keys(rc.blzEff).length, pntEff: Object.keys(rc.pntEff).length,
        run_oh: fullRun ? sizesOh / fullRun : 0, run_eff: fullRun ? sizesEff / fullRun : 0,
        blz_run: blzFull ? Object.keys(rc.blzEff).length / blzFull : 1,
        pnt_run: pntFull ? Object.keys(rc.pntEff).length / pntFull : 1,
        ssoh: Object.keys(rc.ssoh), sseff: Object.keys(rc.sseff),
        has_thr: hasThr[wid + '|' + style] ? 1 : 0
      };
    });

    // Ranks across the style universe (mirror Q_CAND ranked).
    var byTop = recs.slice().sort(function (a, b) { return (b.sold - a.sold) || (a.wid < b.wid ? -1 : 1); });
    byTop.forEach(function (r, i) { r.top_rank = i + 1; });
    var byBot = recs.slice().sort(function (a, b) {
      return ((a.units > 0 ? 0 : 1) - (b.units > 0 ? 0 : 1)) || (a.sold - b.sold) || (a.wid < b.wid ? -1 : 1);
    });
    byBot.forEach(function (r, i) { r.bot_rank = i + 1; });

    recs.forEach(function (r) {
      var common = {
        wid: r.wid, name: r.name, style: style, sold: r.sold, full_run: fullRun, units: r.units,
        blz: r.blz, pnt: r.pnt, cp: 0, srank: r.top_rank, rk: 0, esi: 0, blz_msrp: 0, pnt_msrp: 0,
        wh_oh: e.oh, wh_avail: whBlz + whPnt, wh_blz: whBlz, wh_pnt: whPnt,
        blz_full: blzFull, pnt_full: pntFull, wh_po: 0, po_eta: null, po_within14: poFlag
      };
      // Recipient role: top-10 seller with sold>=1.
      if (r.top_rank <= ENGINE.RECIP_TOP_N && r.sold >= 1) {
        cands.push(Object.assign({}, common, {
          role: 'recip', run: r.run_eff, run_oh: r.run_oh, toks: r.sseff, has_thr: r.has_thr,
          felig: (r.blz_run < ENGINE.RUN_TARGET || r.pnt_run < ENGINE.RUN_TARGET)
        }));
      }
      // Donor role: bottom-10 seller holding stock.
      if (r.bot_rank <= ENGINE.DONOR_BOTTOM_N && r.units > 0) {
        cands.push(Object.assign({}, common, {
          role: 'donor', run: r.run_oh, run_oh: r.run_oh, toks: r.ssoh, has_thr: 0, felig: false
        }));
      }
    });
  });

  Log.info('Sheet source: built ' + cands.length + ' candidate rows across ' + Object.keys(byStyle).length + ' styles.');
  return cands;
}

function fetchAlive30FromSheet_() {
  var ss = openSource_();
  var loc = buildLocMap_(ss);
  var dim = buildDimension_(ss);
  var sold = aggregateSales_(ss, SRC.SALES30, dim, loc);
  var alive = {};
  Object.keys(sold).forEach(function (k) { if (sold[k] > 0) alive[k] = true; });
  return alive;
}

function fetchStyleProductsFromSheet_(styles) {
  var want = {}; (styles || []).forEach(function (s) { want[s] = true; });
  var ss = openSource_();
  var dim = buildDimension_(ss);
  var byStyle = {};
  Object.keys(dim.byPid).forEach(function (pid) {
    var d = dim.byPid[pid]; if (!want[d.style] || !d.product_id) return;
    (byStyle[d.style] = byStyle[d.style] || []).push({ product_id: d.product_id, sku: d.sku, garment: d.garment, size: d.size });
  });
  return byStyle;
}

// ---- Source router (used by Weekly.gs / Actions.gs) ------------------------

function getCandidates_()   { return dataSource_() === 'bigquery' ? fetchCandidates_()   : fetchCandidatesFromSheet_(); }
function getAlive30_()      { return dataSource_() === 'bigquery' ? fetchAlive30_()      : fetchAlive30FromSheet_(); }
function getStyleProducts_(styles) { return dataSource_() === 'bigquery' ? fetchStyleProducts_(styles) : fetchStyleProductsFromSheet_(styles); }
/* ===================== Engine.gs ===================== */
/**
 * Engine.gs — the reallocation logic (spec Part A). Faithful port of the live tool's
 * matchSuits() + moveGap()/movePriority(). This is the part Jayson asked us to keep exact.
 *
 * Per style:
 *   recipients = top-10 sellers (sold>=1) whose run is broken (felig: <50% blazer OR pant)
 *   donors     = bottom-10 sellers holding stock, sorted DEADEST first
 *
 * For each eligible recipient (deadest-first donor matching):
 *   - skip if the DC covers >=50% of BOTH blazer AND pant sizes (it can replenish itself)
 *   - skip if a PO for the style lands within 14 days
 *   - pull from up to 3 donors, each must add >=1 new size, aiming for >=50% of both garments
 *   - POST-TRANSFER GATE: recipient must end with >=50% blazer AND >=50% pant sizes, else drop
 *   - REDUNDANCY TRIM: drop any donor not needed to clear the 50/50 bar (least-dead first)
 *
 * Force-empty pass (proven sellers only): push a fully-dead store (0 sales/30d) up to a top
 * seller that gains >=2 brand-new sizes and still clears the 50/50 gate.
 *
 * Ranking (spec): regular transfers by RANK GAP (deadest donor's sales rank − recipient's
 * sales rank; bigger = more valuable). Force-empties grouped after, most-broken recipient
 * run first, then gap. The tool's old ESI dollar sort is NOT used for ordering.
 */

/** Full engine run. Returns an ordered array of move objects (highest value first). */
function runEngine_(cands, alive30) {
  var moves = matchSuits_(cands, alive30);
  moves.forEach(function (m) {
    m.rank_gap = moveGap_(m);
    m.priority = movePriority_(m);
  });
  moves.sort(function (a, b) { return b.priority - a.priority; });
  return moves;
}

/** Rank gap = (deadest donor's sales rank) − (recipient's sales rank). */
function moveGap_(x) {
  var dr = 0;
  (x.donors || []).forEach(function (d) { var rr = num_(d.rank); if (rr > dr) dr = rr; });
  return dr - num_(x.recip_rank);
}

/** Priority key: regulars 1000+gap (kept above force-empties); force = brokenness then gap. */
function movePriority_(x) {
  var g = moveGap_(x);
  if (!x.force) return 1000 + g;
  var broken = 1 - num_(x.recip_run);
  return broken * 100 + g * 0.1;
}

function isDead30_(wid, style, alive30) { return !alive30[String(wid) + '|' + style]; }

function matchSuits_(cands, alive30) {
  var byStyle = {};
  (cands || []).forEach(function (c) {
    var st = c.style;
    if (!byStyle[st]) byStyle[st] = { recips: [], dons: [] };
    var toks = Array.isArray(c.toks) ? c.toks.map(String) : [];
    var o = {
      wid: String(c.wid), name: c.name, style: st, sold: num_(c.sold), run: num_(c.run),
      full: num_(c.full_run), units: num_(c.units), blz: num_(c.blz), pnt: num_(c.pnt),
      cp: num_(c.cp), esi: num_(c.esi), has_thr: (num_(c.has_thr) === 1), rank: num_(c.srank),
      felig: toBool_(c.felig), toks: toks, wh_oh: num_(c.wh_oh), wh_avail: num_(c.wh_avail),
      wh_blz: num_(c.wh_blz), wh_pnt: num_(c.wh_pnt), blz_full: num_(c.blz_full),
      pnt_full: num_(c.pnt_full), wh_po: num_(c.wh_po), wh_eta: c.po_eta || null,
      wh_soon: toBool_(c.po_within14), blz_msrp: num_(c.blz_msrp), pnt_msrp: num_(c.pnt_msrp)
    };
    if (c.role === 'recip') byStyle[st].recips.push(o); else byStyle[st].dons.push(o);
  });

  var moves = [];

  Object.keys(byStyle).forEach(function (st) {
    var recips = byStyle[st].recips, dons = byStyle[st].dons;
    recips.sort(function (a, b) { return (b.sold - a.sold) || (a.wid < b.wid ? -1 : 1); });
    dons.sort(function (a, b) { return (a.sold - b.sold) || (b.run - a.run) || (a.wid < b.wid ? -1 : 1); });

    var used = dons.map(function () { return false; });
    var mainServed = {};
    var mrecips = recips.filter(function (r) { return r.felig; });

    mrecips.forEach(function (r) {
      // WH covers >=50% of BOTH garments -> it can replenish -> not a store-transfer candidate.
      if ((r.wh_blz >= r.blz_full * 0.5) && (r.wh_pnt >= r.pnt_full * 0.5)) return;
      if (r.wh_soon) return; // PO due at the DC within 14 days

      var full = r.full || 1;
      var bf = num_(r.blz_full), pf = num_(r.pnt_full);
      var grun = function (hv) {
        var b = 0, p = 0;
        Object.keys(hv).forEach(function (t) { if (t.charAt(0) === 'B') b++; else p++; });
        return { b: (bf > 0 ? b / bf : 1), p: (pf > 0 ? p / pf : 1) };
      };

      var hv = {}; r.toks.forEach(function (t) { hv[t] = 1; });

      // Deadest-first: pull from up to 3 donors adding new sizes, aiming for >=50% both garments.
      var picks = [], pickIdx = [];
      for (var i = 0; i < dons.length && picks.length < ENGINE.MAX_DONORS; i++) {
        if (used[i]) continue;
        var add = 0;
        dons[i].toks.forEach(function (t) { if (!hv[t]) add++; });
        if (add >= 1) {
          picks.push(dons[i]); pickIdx.push(i);
          dons[i].toks.forEach(function (t) { hv[t] = 1; });
          var g = grun(hv);
          if (g.b >= ENGINE.RUN_TARGET && g.p >= ENGINE.RUN_TARGET) break;
        }
      }

      var fin = grun(hv);
      // Post-transfer gate.
      if (!picks.length || fin.b < ENGINE.RUN_TARGET || fin.p < ENGINE.RUN_TARGET) return;

      // Redundancy trim (remove least-dead redundant donor first; keep deadest essential).
      var k = picks.length - 1;
      while (k >= 0) {
        var test = {}; r.toks.forEach(function (t) { test[t] = 1; });
        picks.forEach(function (p, m) { if (m !== k) p.toks.forEach(function (t) { test[t] = 1; }); });
        var gt = grun(test);
        if (gt.b >= ENGINE.RUN_TARGET && gt.p >= ENGINE.RUN_TARGET) { picks.splice(k, 1); pickIdx.splice(k, 1); }
        k--;
      }

      hv = {}; r.toks.forEach(function (t) { hv[t] = 1; });
      picks.forEach(function (p) { p.toks.forEach(function (t) { hv[t] = 1; }); });
      var run = Object.keys(hv).length / full;
      pickIdx.forEach(function (ix) { used[ix] = true; });

      // ESI (legacy display only): retail of BRAND-NEW sizes the recipient gains.
      var blzP = num_(r.blz_msrp), pntP = num_(r.pnt_msrp), cov = {};
      r.toks.forEach(function (t) { cov[t] = 1; });
      picks.forEach(function (p) {
        var e = 0;
        p.toks.forEach(function (t) { if (!cov[t]) { cov[t] = 1; e += (t.charAt(0) === 'B' ? blzP : pntP); } });
        p._esi = e;
      });

      var donors = picks.map(function (d) {
        return { wid: d.wid, name: d.name, sold: d.sold, rank: d.rank, units: d.units, blz: d.blz, pnt: d.pnt, run: d.run, esi: d._esi || 0 };
      });
      var uTot = 0, eTot = 0;
      donors.forEach(function (d) { uTot += d.units; eTot += d.esi; });

      mainServed[r.wid] = true;
      moves.push({
        style: st, recipient: r.name, recip_wid: r.wid, recip_sold: r.sold, recip_rank: r.rank,
        recip_run: r.run, full_run: r.full, has_thr: r.has_thr, recip_final: Math.round(run * 100) / 100,
        donors: donors, units: uTot, esi: eTot, partners: donors.map(function (d) { return d.wid; }),
        force: false, wh_oh: r.wh_oh, wh_po: r.wh_po, wh_eta: r.wh_eta, wh_fill: (r.wh_oh > 0 || r.wh_po > 0)
      });
    });

    // ---- Force-empty pass ---------------------------------------------------
    var topSold = 0; recips.forEach(function (r) { if (r.sold > topSold) topSold = r.sold; });
    var _s0 = recips[0];
    var whElig = !!_s0 && ((_s0.wh_blz < _s0.blz_full * 0.5) || (_s0.wh_pnt < _s0.pnt_full * 0.5)) && !_s0.wh_soon;

    if (topSold >= ENGINE.FORCE_EMPTY_TOP_SOLD_MIN && whElig) {
      var rsort = recips.slice().sort(function (a, b) { return (b.sold - a.sold) || (a.wid < b.wid ? -1 : 1); });
      var fserved = {};
      for (var di = 0; di < dons.length; di++) {
        if (used[di] || !isDead30_(dons[di].wid, st, alive30)) continue;
        var dd = dons[di], chosen = null;
        for (var ri = 0; ri < rsort.length; ri++) {
          var fr = rsort[ri];
          if (fserved[fr.wid] || mainServed[fr.wid]) continue;
          var hh = {}; fr.toks.forEach(function (t) { hh[t] = 1; });
          var nw = 0; dd.toks.forEach(function (t) { if (!hh[t]) nw++; });
          if (nw >= ENGINE.FORCE_EMPTY_MIN_NEW_SIZES) {
            var tt = {}; fr.toks.forEach(function (t) { tt[t] = 1; }); dd.toks.forEach(function (t) { tt[t] = 1; });
            var tb = 0, tp = 0; Object.keys(tt).forEach(function (t) { if (t.charAt(0) === 'B') tb++; else tp++; });
            var _bf = num_(fr.blz_full), _pf = num_(fr.pnt_full);
            if ((_bf > 0 ? tb / _bf : 1) >= ENGINE.RUN_TARGET && (_pf > 0 ? tp / _pf : 1) >= ENGINE.RUN_TARGET) { chosen = fr; break; }
          }
        }
        if (!chosen) continue;
        used[di] = true; fserved[chosen.wid] = true;
        var hv2 = {}; chosen.toks.forEach(function (t) { hv2[t] = 1; });
        var bP = num_(chosen.blz_msrp), pP = num_(chosen.pnt_msrp), fe = 0;
        dd.toks.forEach(function (t) { if (!hv2[t]) { hv2[t] = 1; fe += (t.charAt(0) === 'B' ? bP : pP); } });
        var frun = Object.keys(hv2).length / (chosen.full || 1);
        var fdonors = [{ wid: dd.wid, name: dd.name, sold: dd.sold, rank: dd.rank, units: dd.units, blz: dd.blz, pnt: dd.pnt, run: dd.run, esi: fe }];
        moves.push({
          style: st, recipient: chosen.name, recip_wid: chosen.wid, recip_sold: chosen.sold, recip_rank: chosen.rank,
          recip_run: chosen.run, full_run: chosen.full, has_thr: chosen.has_thr, recip_final: Math.round(frun * 100) / 100,
          donors: fdonors, units: dd.units, esi: fe, partners: [dd.wid], force: true,
          wh_oh: chosen.wh_oh, wh_po: chosen.wh_po, wh_eta: chosen.wh_eta, wh_fill: false
        });
      }
    }
  });

  return moves;
}
/* ===================== Proposals.gs ===================== */
/**
 * Proposals.gs — write the ranked transfer list to the "Proposed Transfers" tab.
 *
 * The approval UNIT is one donor -> recipient transfer (that is one Brightpearl transfer).
 * A recipient fed by multiple donors becomes multiple rows that share a rank/gap. Jayson
 * approves per row by ticking the Approve checkbox.
 */

// Column layout (1-based). Keep in sync with readApprovedRows_() and Actions.
const COL = {
  APPROVE: 1,   // checkbox
  RANK: 2,
  TYPE: 3,
  STYLE: 4,
  DONOR: 5,
  DONOR_WH: 6,
  RECIPIENT: 7,
  RECIP_WH: 8,
  GAP: 9,
  DONOR_RANK: 10,
  RECIP_RANK: 11,
  RUN_NOW: 12,
  RUN_AFTER: 13,
  UNITS: 14,
  FLAGS: 15,
  TRANSFER_ID: 16,
  STATUS: 17,
  UPDATED: 18,
  NOTES: 19
};
const PROPOSAL_HEADERS = [
  'Approve', 'Rank', 'Type', 'Style', 'Donor store', 'Donor WH', 'Recipient store', 'Recip WH',
  'Rank gap', 'Donor sales rank', 'Recip sales rank', 'Recip run now', 'Recip run after',
  'Units (mirror)', 'Flags', 'Transfer ID', 'Status', 'Last update', 'Notes'
];

function statusValue_(s) { return s || 'PROPOSED'; }

/** Expand ranked moves into per-transfer rows and write them to the sheet. */
function writeProposals_(moves) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET.PROPOSALS) || ss.insertSheet(SHEET.PROPOSALS);
  sh.clear();
  sh.getRange(1, 1, 1, PROPOSAL_HEADERS.length).setValues([PROPOSAL_HEADERS])
    .setFontWeight('bold').setBackground('#111111').setFontColor('#ffffff');
  sh.setFrozenRows(1);

  var rows = [];
  moves.forEach(function (m, idx) {
    var rank = idx + 1;
    (m.donors || []).forEach(function (d) {
      var flags = [];
      if (m.force) flags.push('FORCE EMPTY');
      if (!m.has_thr) flags.push('CONFIRM — NO THRESHOLD');
      rows.push([
        false,                                  // Approve
        rank,                                   // Rank (shared across a recipient's donors)
        m.force ? 'Force-empty' : 'Regular',    // Type
        m.style,                                // Style
        d.name, d.wid,                          // Donor store / WH
        m.recipient, m.recip_wid,               // Recipient store / WH
        m.rank_gap,                             // Rank gap
        d.rank,                                 // Donor sales rank
        m.recip_rank,                           // Recip sales rank
        m.recip_run,                            // Recip run now
        m.recip_final,                          // Recip run after
        d.units,                                // donor holding (mirror)
        flags.join(' · '),                      // Flags
        '',                                     // Transfer ID
        statusValue_(),                         // Status
        '',                                     // Last update
        ''                                      // Notes
      ]);
    });
  });

  if (rows.length) {
    sh.getRange(2, 1, rows.length, PROPOSAL_HEADERS.length).setValues(rows);
    // Approve column as checkboxes.
    sh.getRange(2, COL.APPROVE, rows.length, 1).insertCheckboxes();
    // Percent format for run columns.
    sh.getRange(2, COL.RUN_NOW, rows.length, 2).setNumberFormat('0%');
  }

  // Cosmetics.
  sh.autoResizeColumns(1, PROPOSAL_HEADERS.length);
  sh.getRange(1, 1, sh.getMaxRows(), PROPOSAL_HEADERS.length).setVerticalAlignment('middle');
  formatFlagRows_(sh, rows.length);

  Log.info('Wrote ' + rows.length + ' proposed transfers across ' + moves.length + ' recipient moves.');
  return rows.length;
}

/** Tint force-empty / no-threshold rows so they stand out for review. */
function formatFlagRows_(sh, n) {
  for (var i = 0; i < n; i++) {
    var flags = String(sh.getRange(2 + i, COL.FLAGS).getValue() || '');
    if (flags.indexOf('NO THRESHOLD') >= 0) {
      sh.getRange(2 + i, 1, 1, PROPOSAL_HEADERS.length).setBackground('#fcf8ef');
    } else if (flags.indexOf('FORCE EMPTY') >= 0) {
      sh.getRange(2 + i, 1, 1, PROPOSAL_HEADERS.length).setBackground('#fbeceb');
    }
  }
}
/* ===================== Approval.gs ===================== */
/**
 * Approval.gs — read Jayson's per-row approvals from the Proposed Transfers tab.
 * Jayson is the only gate. A row is "approved" when its Approve checkbox is ticked AND it
 * hasn't already been created in Brightpearl.
 */

/** Return {rowIndex, ...fields} for every ticked, not-yet-created row. */
function readApprovedRows_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET.PROPOSALS);
  if (!sh) throw new Error('No "' + SHEET.PROPOSALS + '" tab. Run the weekly proposal first.');
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, PROPOSAL_HEADERS.length).getValues();

  var approved = [];
  values.forEach(function (r, i) {
    var isApproved = r[COL.APPROVE - 1] === true;
    var status = String(r[COL.STATUS - 1] || '');
    var alreadyDone = /CREATED|SHIPPED|RECEIVED/i.test(status);
    if (isApproved && !alreadyDone) {
      approved.push({
        rowIndex: 2 + i,
        type: r[COL.TYPE - 1],
        style: r[COL.STYLE - 1],
        donorName: r[COL.DONOR - 1],
        donorWid: String(r[COL.DONOR_WH - 1]),
        recipientName: r[COL.RECIPIENT - 1],
        recipWid: String(r[COL.RECIP_WH - 1]),
        force: String(r[COL.TYPE - 1]).toLowerCase().indexOf('force') >= 0,
        flags: String(r[COL.FLAGS - 1] || '')
      });
    }
  });
  return approved;
}

/** Write status/transfer-id back to a proposal row after an action. */
function markRow_(rowIndex, fields) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET.PROPOSALS);
  if (fields.transferId !== undefined) sh.getRange(rowIndex, COL.TRANSFER_ID).setValue(fields.transferId);
  if (fields.status !== undefined) sh.getRange(rowIndex, COL.STATUS).setValue(fields.status);
  if (fields.notes !== undefined) sh.getRange(rowIndex, COL.NOTES).setValue(fields.notes);
  sh.getRange(rowIndex, COL.UPDATED).setValue(new Date());
}

/**
 * Guard: recipient rows flagged "CONFIRM — NO THRESHOLD" need Jayson to confirm the store
 * actually wants the style before we ship. We treat the Approve tick as that confirmation,
 * but surface a count so nothing slips through silently.
 */
function countNoThresholdApprovals_(approvedRows) {
  return approvedRows.filter(function (r) { return r.flags.indexOf('NO THRESHOLD') >= 0; }).length;
}
/* ===================== Actions.gs ===================== */
/**
 * Actions.gs — fired when Jayson runs "Execute approved transfers".
 *
 * Per approved donor->recipient row:
 *   1. Read LIVE Brightpearl availability for the style (never ship stock that just sold).
 *   2. Build the pull list = everything the donor still holds of that style (available>0).
 *   3. Create the store-to-store transfer, tagged PURGE-PRIORITY.
 *   4. Zero the donor's reorderLevel for each shipped SKU (so it won't refill).
 * Then: one pull-list email per donor, feed Receiving the priority transfer numbers, and
 * seed the 48-hour Tracker.
 *
 * Everything Brightpearl-side is gated by BP_WRITES_ENABLED (dry run by default).
 */

function executeApprovedTransfers() {
  var approved = readApprovedRows_();
  if (!approved.length) {
    ui_().alert('Nothing to execute', 'No rows are ticked "Approve" (or they are already created).', ui_().ButtonSet.OK);
    return;
  }

  var live = writesEnabled_();
  var noThr = countNoThresholdApprovals_(approved);
  var confirmMsg = approved.length + ' transfer(s) approved.' +
    (noThr ? ('\n' + noThr + ' are to stores with NO threshold set — approving confirms those stores want the style.') : '') +
    '\n\nBrightpearl writes are ' + (live ? 'ENABLED — this will create real transfers and zero thresholds.' : 'DISABLED (dry run) — nothing will be written.') +
    '\n\nProceed?';
  var resp = ui_().alert('Execute approved transfers', confirmMsg, ui_().ButtonSet.OK_CANCEL);
  if (resp !== ui_().Button.OK) return;

  // Product map for all approved styles (for pull lists), fetched once.
  var styles = uniq_(approved.map(function (a) { return a.style; }));
  var styleProducts = getStyleProducts_(styles);

  // Live availability for all in-scope productIds.
  var allPids = [];
  styles.forEach(function (s) { (styleProducts[s] || []).forEach(function (p) { allPids.push(p.product_id); }); });
  var avail = BP.getAvailability(uniq_(allPids));

  var byDonor = {};        // donorWid -> {name, items:[...]}
  var receiving = [];      // rows for Receiving Priority
  var trackerRows = [];    // rows for Tracker
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd');
  var created = 0, skipped = 0;

  approved.forEach(function (row) {
    var prods = styleProducts[row.style] || [];
    // Everything the donor still holds of this style, live.
    var items = [];
    prods.forEach(function (p) {
      var a = (avail[p.product_id] && avail[p.product_id][row.donorWid]) || null;
      var qty = a ? a.available : 0;
      if (qty > 0) items.push({ productId: p.product_id, sku: p.sku, garment: p.garment, size: p.size, quantity: qty });
    });

    if (!items.length) {
      markRow_(row.rowIndex, { status: 'SKIPPED — no live stock', notes: 'Donor holds 0 available at approval time.' });
      skipped++;
      return;
    }

    var reference = 'PURGE-PRIORITY-REALLOC-' + slug_(row.style) + '-' + row.donorWid + 'to' + row.recipWid + '-' + stamp;
    var result;
    try {
      result = BP.createStockTransfer(row.donorWid, row.recipWid,
        reference, items.map(function (it) { return { productId: it.productId, quantity: it.quantity }; }));
    } catch (e) {
      markRow_(row.rowIndex, { status: 'ERROR', notes: String(e.message || e) });
      Log.error('Transfer failed ' + row.donorWid + '->' + row.recipWid + ' ' + row.style + ': ' + e);
      return;
    }

    var tid = result.stockTransferId || (result.dryRun ? 'DRY-RUN' : '');
    markRow_(row.rowIndex, {
      transferId: tid,
      status: result.dryRun ? 'DRY RUN' : 'CREATED',
      notes: reference + (result.goodsOutNoteIds && result.goodsOutNoteIds.length ? (' · GON ' + result.goodsOutNoteIds.join(',')) : '')
    });
    created++;

    // Zero the donor's reorderLevel for each shipped SKU.
    items.forEach(function (it) {
      try { BP.zeroReorderLevel(row.donorWid, it.productId); }
      catch (e) { Log.warn('zeroReorderLevel failed wh ' + row.donorWid + ' pid ' + it.productId + ': ' + e); }
    });

    // Accumulate donor email.
    var d = byDonor[row.donorWid] || (byDonor[row.donorWid] = { name: row.donorName, items: [] });
    items.forEach(function (it) {
      d.items.push({ recipientName: row.recipientName, style: row.style, garment: it.garment, size: it.size, sku: it.sku, qty: it.quantity, transferId: tid });
    });

    // Receiving + tracker.
    var units = items.reduce(function (a, it) { return a + it.quantity; }, 0);
    receiving.push([new Date(), tid, row.style, row.donorName, row.recipientName, units, reference, row.force ? 'FORCE' : '']);
    trackerRows.push([new Date(), tid, row.style, row.donorName, row.donorWid, row.recipientName, row.recipWid, units,
      (result.goodsOutNoteIds || []).join(','), 'CREATED', new Date(), 0, row.force ? 'FORCE' : 'REGULAR']);
  });

  var emailReport = sendStorePullLists_(byDonor);
  appendReceiving_(receiving);
  appendTracker_(trackerRows);

  var summary = (live ? 'Created' : 'Dry-run created') + ' ' + created + ' transfer(s), skipped ' + skipped +
    '. Emails: ' + emailReport.filter(function (r) { return r.sent; }).length + ' sent/preview.';
  Log.info(summary);
  ui_().alert('Done', summary, ui_().ButtonSet.OK);
}

// ---- Receiving Priority + Tracker append helpers ---------------------------

function appendReceiving_(rows) {
  if (!rows.length) return;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET.RECEIVING) || ss.insertSheet(SHEET.RECEIVING);
  if (sh.getLastRow() === 0) {
    sh.appendRow(['Created', 'Transfer ID', 'Style', 'Donor', 'Recipient', 'Units', 'Reference (PURGE-PRIORITY)', 'Type']);
    sh.getRange(1, 1, 1, 8).setFontWeight('bold');
  }
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

function appendTracker_(rows) {
  if (!rows.length) return;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET.TRACKER) || ss.insertSheet(SHEET.TRACKER);
  if (sh.getLastRow() === 0) {
    sh.appendRow(TRACKER_HEADERS);
    sh.getRange(1, 1, 1, TRACKER_HEADERS.length).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

// ---- small utils -----------------------------------------------------------
function uniq_(a) { var s = {}; (a || []).forEach(function (x) { s[x] = true; }); return Object.keys(s); }
function slug_(s) { return String(s).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function ui_() { return SpreadsheetApp.getUi(); }
/* ===================== Email.gs ===================== */
/**
 * Email.gs — build and send each donor store its pull list (what to box up).
 *
 * Store addresses come from the "Store Emails" tab (Store name | Warehouse id | Email).
 * Safety: when BP_WRITES_ENABLED is off (dry run), emails do NOT go to stores. If the
 * DRY_RUN_EMAIL property is set, a preview is sent there instead; otherwise emails are
 * only logged. This keeps the store-facing side aligned with the Brightpearl write gate.
 */

function storeEmailMap_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET.STORE_EMAILS);
  var map = {};
  if (!sh || sh.getLastRow() < 2) return map;
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues();
  rows.forEach(function (r) {
    var name = String(r[0] || '').trim();
    var wid = String(r[1] || '').trim();
    var email = String(r[2] || '').trim();
    if (!email) return;
    if (wid) map['wid:' + wid] = email;
    if (name) map['name:' + name.toLowerCase()] = email;
  });
  return map;
}

function resolveStoreEmail_(map, donorWid, donorName) {
  return map['wid:' + String(donorWid)] || map['name:' + String(donorName || '').toLowerCase()] || null;
}

/** items: [{recipientName, style, garment, size, sku, qty, transferId}] */
function buildPullListEmail_(donorName, items, dryRun) {
  var total = items.reduce(function (a, it) { return a + Number(it.qty || 0); }, 0);
  var subject = (dryRun ? '[PREVIEW] ' : '') + 'Suit reallocation — pull list for ' + donorName +
    ' (' + total + ' unit' + (total === 1 ? '' : 's') + ')';

  // group by recipient for readability
  var byRecip = {};
  items.forEach(function (it) { (byRecip[it.recipientName] = byRecip[it.recipientName] || []).push(it); });

  var rowsHtml = '';
  Object.keys(byRecip).sort().forEach(function (recip) {
    rowsHtml += '<tr><td colspan="5" style="background:#f4f4f2;font-weight:700;padding:8px 10px;border-top:2px solid #111;">Ship to: ' +
      escapeHtml_(recip) + '</td></tr>';
    byRecip[recip].sort(function (a, b) { return String(a.sku).localeCompare(String(b.sku)); }).forEach(function (it) {
      rowsHtml += '<tr>' +
        td_(escapeHtml_(it.style)) +
        td_(escapeHtml_(it.garment)) +
        td_(escapeHtml_(String(it.size))) +
        td_('<code>' + escapeHtml_(it.sku) + '</code>') +
        td_('<b>' + Number(it.qty) + '</b>', 'right') +
        '</tr>';
    });
  });

  var html =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111;max-width:640px;">' +
    '<p>Hi ' + escapeHtml_(donorName) + ' team,</p>' +
    '<p>Please <b>pull and box the following suit stock for transfer</b>. These are moving store-to-store to locations that are selling them and stocked out. ' +
    'Transfers are already created in Brightpearl and tagged <b>PURGE-PRIORITY</b>. Please purge within 48 hours.</p>' +
    '<table style="border-collapse:collapse;width:100%;font-size:13px;">' +
    '<tr>' + th_('Style') + th_('Garment') + th_('Size') + th_('SKU') + th_('Qty', 'right') + '</tr>' +
    rowsHtml +
    '</table>' +
    '<p style="margin-top:14px;">Total: <b>' + total + '</b> units. Reply here if anything can\'t be located so we can adjust.</p>' +
    '<p>Thanks,<br>SCM / Reallocation</p>' +
    (dryRun ? '<p style="color:#b7791f;font-size:12px;">(Preview only — Brightpearl writes are disabled, this was not sent to the store.)</p>' : '') +
    '</div>';

  return { subject: subject, html: html };
}

function th_(t, align) { return '<th style="text-align:' + (align || 'left') + ';padding:7px 10px;border-bottom:1px solid #111;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#555;">' + t + '</th>'; }
function td_(t, align) { return '<td style="text-align:' + (align || 'left') + ';padding:6px 10px;border-bottom:1px solid #e5e5e5;">' + t + '</td>'; }
function escapeHtml_(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

/**
 * Send one pull-list email per donor.
 * byDonor: { donorWid: { name, items:[...] } }
 * Returns a report array for logging.
 */
function sendStorePullLists_(byDonor) {
  var live = writesEnabled_();
  var dryEmail = getProp_(PROP.DRY_RUN_EMAIL);
  var bcc = getProp_(PROP.EMAIL_BCC);
  var map = storeEmailMap_();
  var report = [];

  Object.keys(byDonor).forEach(function (wid) {
    var donor = byDonor[wid];
    var mail = buildPullListEmail_(donor.name, donor.items, !live);
    var to = live ? resolveStoreEmail_(map, wid, donor.name) : dryEmail;

    if (!to) {
      var why = live ? ('no email on file for ' + donor.name + ' (add it to "' + SHEET.STORE_EMAILS + '")')
                     : 'dry run and no DRY_RUN_EMAIL set';
      report.push({ donor: donor.name, sent: false, reason: why });
      Log.warn('Pull-list not sent: ' + why);
      return;
    }
    var opts = { htmlBody: mail.html, name: 'S&L Reallocation' };
    if (bcc && live) opts.bcc = bcc;
    GmailApp.sendEmail(to, mail.subject, 'This email requires HTML.', opts);
    report.push({ donor: donor.name, sent: true, to: to, units: donor.items.reduce(function (a, i) { return a + i.qty; }, 0) });
    Log.info('Pull-list ' + (live ? 'sent' : 'preview') + ' to ' + to + ' for ' + donor.name);
  });
  return report;
}
/* ===================== Tracker.gs ===================== */
/**
 * Tracker.gs — the 48-hour loop.
 *
 * Runs on a timed trigger. For each open transfer it checks Brightpearl shipment state.
 * If a donor hasn't purged (transfer not shipped) within 48h, it re-nudges that store and
 * bumps a counter. Received transfers are closed out. The Receiving Priority tab already
 * holds the PURGE-PRIORITY numbers for the receiving desk to expedite.
 *
 * NOTE (confirm on live Brightpearl): the exact shipped/received fields on stock-transfer
 * vs. goods-movement can vary by account config. transferShipState_() reads defensively and
 * falls back to goods-movement-search. Validate against one real transfer before trusting
 * auto-close — see DEPLOY.md.
 */

const TRACKER_HEADERS = ['Created', 'Transfer ID', 'Style', 'Donor', 'Donor WH', 'Recipient',
  'Recip WH', 'Units', 'GoodsOut IDs', 'Status', 'Last check', 'Nudges', 'Type'];
const TCOL = { CREATED: 1, TID: 2, STYLE: 3, DONOR: 4, DONOR_WH: 5, RECIPIENT: 6, RECIP_WH: 7, UNITS: 8, GON: 9, STATUS: 10, LAST: 11, NUDGES: 12, TYPE: 13 };
const NUDGE_AFTER_HOURS = 48;
const MAX_NUDGES = 3;

function runTracker() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET.TRACKER);
  if (!sh || sh.getLastRow() < 2) { Log.info('Tracker: nothing open.'); return; }
  var last = sh.getLastRow();
  var data = sh.getRange(2, 1, last - 1, TRACKER_HEADERS.length).getValues();

  var now = new Date();
  var nudgeByDonor = {};
  var checked = 0, shipped = 0, received = 0, nudged = 0;

  data.forEach(function (r, i) {
    var rowIdx = 2 + i;
    var status = String(r[TCOL.STATUS - 1] || '');
    var tid = r[TCOL.TID - 1];
    if (/RECEIVED|CLOSED/i.test(status)) return;
    if (!tid || String(tid).indexOf('DRY') === 0) return; // dry-run rows have no real transfer

    checked++;
    var gon = String(r[TCOL.GON - 1] || '').split(',').filter(String);
    var state = transferShipState_(tid, gon);

    if (state.received) {
      sh.getRange(rowIdx, TCOL.STATUS).setValue('RECEIVED');
      sh.getRange(rowIdx, TCOL.LAST).setValue(now);
      received++;
      return;
    }
    if (state.shipped) {
      if (!/SHIPPED/i.test(status)) shipped++;
      sh.getRange(rowIdx, TCOL.STATUS).setValue('SHIPPED');
      sh.getRange(rowIdx, TCOL.LAST).setValue(now);
      return;
    }

    // Not shipped yet — nudge if past 48h and under the cap.
    var created = new Date(r[TCOL.CREATED - 1]);
    var hrs = (now - created) / 36e5;
    var nudges = Number(r[TCOL.NUDGES - 1] || 0);
    sh.getRange(rowIdx, TCOL.LAST).setValue(now);

    if (hrs >= NUDGE_AFTER_HOURS && nudges < MAX_NUDGES) {
      var wid = String(r[TCOL.DONOR_WH - 1]);
      var d = nudgeByDonor[wid] || (nudgeByDonor[wid] = { name: r[TCOL.DONOR - 1], lines: [] });
      d.lines.push({ style: r[TCOL.STYLE - 1], recipient: r[TCOL.RECIPIENT - 1], units: r[TCOL.UNITS - 1], tid: tid });
      sh.getRange(rowIdx, TCOL.NUDGES).setValue(nudges + 1);
      nudged++;
    }
  });

  if (Object.keys(nudgeByDonor).length) sendNudges_(nudgeByDonor);
  Log.info('Tracker: checked ' + checked + ', shipped ' + shipped + ', received ' + received + ', nudged ' + nudged + '.');
}

/** Best-effort shipped/received detection. Confirm field names on live Brightpearl. */
function transferShipState_(transferId, gonIds) {
  var out = { shipped: false, received: false };
  try {
    var t = BP.getStockTransfer(transferId);
    if (t) {
      var s = JSON.stringify(t).toLowerCase();
      if (/"received"|goodsin|"complete"/.test(s)) out.received = true;
      if (/"shipped"|goodsout|"dispatched"/.test(s)) out.shipped = true;
    }
  } catch (e) { Log.warn('getStockTransfer ' + transferId + ': ' + e); }

  // Fallback: goods-movement feed for definitive GO (shipped) / GI (received).
  try {
    var mv = BP.goodsMovementSearch({ stockTransferId: transferId });
    var results = (mv && mv.response && mv.response.results) || [];
    results.forEach(function (row) {
      var joined = String(row).toUpperCase();
      if (joined.indexOf('GI') >= 0) out.received = true;
      else if (joined.indexOf('GO') >= 0) out.shipped = true;
    });
  } catch (e) { /* movement search optional */ }

  return out;
}

function sendNudges_(byDonor) {
  var live = writesEnabled_();
  var dryEmail = getProp_(PROP.DRY_RUN_EMAIL);
  var map = storeEmailMap_();

  Object.keys(byDonor).forEach(function (wid) {
    var d = byDonor[wid];
    var to = live ? resolveStoreEmail_(map, wid, d.name) : dryEmail;
    var rows = d.lines.map(function (l) {
      return '<tr>' + td_(escapeHtml_(l.style)) + td_(escapeHtml_(l.recipient)) +
        td_(String(l.units), 'right') + td_('#' + escapeHtml_(String(l.tid))) + '</tr>';
    }).join('');
    var html = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#111;max-width:640px;">' +
      '<p>Hi ' + escapeHtml_(d.name) + ' team,</p>' +
      '<p><b>Reminder:</b> the following PURGE-PRIORITY transfers were created more than 48 hours ago and are not yet shipped. ' +
      'Please box and purge today.</p>' +
      '<table style="border-collapse:collapse;width:100%;font-size:13px;"><tr>' +
      th_('Style') + th_('Ship to') + th_('Units', 'right') + th_('Transfer') + '</tr>' + rows + '</table>' +
      '<p>Thanks,<br>SCM / Reallocation</p></div>';
    var subject = (live ? '' : '[PREVIEW] ') + 'Reminder — please purge suit transfers (' + d.lines.length + ')';
    if (!to) { Log.warn('Nudge not sent for ' + d.name + ' (no address / dry run).'); return; }
    GmailApp.sendEmail(to, subject, 'This email requires HTML.', { htmlBody: html, name: 'S&L Reallocation' });
    Log.info('Nudge ' + (live ? 'sent' : 'preview') + ' to ' + to + ' for ' + d.name);
  });
}
/* ===================== Weekly.gs ===================== */
/**
 * Weekly.gs — the once-a-week pull + engine + proposal write.
 * This is READ-ONLY against Brightpearl (it only queries the BigQuery mirror). It never
 * writes anything to Brightpearl — that only happens later, on Jayson's approval, via
 * executeApprovedTransfers().
 */

function runWeeklyProposal() {
  var t0 = Date.now();
  Log.info('Weekly run started.');

  var cands = getCandidates_();
  Log.info('Fetched ' + cands.length + ' candidate rows from source (' + dataSource_() + ').');

  var alive30 = getAlive30_();
  var moves = runEngine_(cands, alive30);
  Log.info('Engine produced ' + moves.length + ' recipient moves (' +
    moves.filter(function (m) { return m.force; }).length + ' force-empty).');

  var nRows = writeProposals_(moves);
  writeRunLogSummary_(moves, nRows, Date.now() - t0);

  return { moves: moves.length, rows: nRows };
}

function writeRunLogSummary_(moves, nRows, ms) {
  var donorSet = {}, recipSet = {}, units = 0;
  moves.forEach(function (m) {
    recipSet[m.recip_wid] = true;
    (m.donors || []).forEach(function (d) { donorSet[d.wid] = true; units += Number(d.units || 0); });
  });
  Log.info('Weekly summary: ' + nRows + ' transfers, ' +
    Object.keys(donorSet).length + ' donor stores, ' +
    Object.keys(recipSet).length + ' recipient stores, ~' + units + ' units, ' +
    (ms / 1000).toFixed(1) + 's. Writes ' + (writesEnabled_() ? 'ENABLED' : 'DISABLED (dry run)') + '.');
}
/* ===================== Menu.gs ===================== */
/**
 * Menu.gs — the spreadsheet UI, setup prompts, and trigger installation.
 * Adds a "Reallocation" menu when the sheet opens.
 */

function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('Reallocation')
    .addItem('1 ▸ Run weekly proposal', 'menuRunWeekly')
    .addItem('2 ▸ Execute approved transfers', 'executeApprovedTransfers')
    .addItem('3 ▸ Run tracker now', 'runTracker')
    .addSeparator()
    .addSubMenu(ui.createMenu('Setup')
      .addItem('Initialize tabs', 'initSheets')
      .addItem('Set data source (sheet / bigquery)', 'promptSetDataSource')
      .addItem('Set source workbook id', 'promptSetSourceId')
      .addItem('Describe source workbook', 'describeSource')
      .addItem('Set Brightpearl credentials', 'promptSetBrightpearl')
      .addItem('Set BigQuery billing project', 'promptSetBqProject')
      .addItem('Set Receiving / dry-run emails', 'promptSetEmails')
      .addItem('Toggle Brightpearl WRITES (dry run ↔ live)', 'promptToggleWrites')
      .addItem('Install weekly + tracker triggers', 'installTriggers')
      .addItem('Show current status', 'showStatus'))
    .addToUi();
}

function menuRunWeekly() {
  var r = runWeeklyProposal();
  SpreadsheetApp.getUi().alert('Weekly proposal ready',
    r.rows + ' transfer rows written to "' + SHEET.PROPOSALS + '". Review, tick Approve, then run "Execute approved transfers".',
    SpreadsheetApp.getUi().ButtonSet.OK);
}

// ---- Setup prompts ----------------------------------------------------------

function promptSetBrightpearl() {
  var ui = SpreadsheetApp.getUi();
  var base = ui.prompt('Brightpearl base URL', 'e.g. https://use1.brightpearlconnect.com/public-api/stateandliberty', ui.ButtonSet.OK_CANCEL);
  if (base.getSelectedButton() !== ui.Button.OK) return;
  var ref = ui.prompt('brightpearl-app-ref', ui.ButtonSet.OK_CANCEL);
  if (ref.getSelectedButton() !== ui.Button.OK) return;
  var tok = ui.prompt('brightpearl-account-token', ui.ButtonSet.OK_CANCEL);
  if (tok.getSelectedButton() !== ui.Button.OK) return;
  props_().setProperties({
    BP_BASE_URL: base.getResponseText().trim(),
    BP_APP_REF: ref.getResponseText().trim(),
    BP_ACCOUNT_TOKEN: tok.getResponseText().trim()
  }, false);
  ui.alert('Saved. Brightpearl writes remain OFF until you toggle them.');
}

function promptSetDataSource() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.alert('Data source', 'Read ranking input from the Store Dashboard SHEET? (No = BigQuery mirror)', ui.ButtonSet.YES_NO);
  props_().setProperty(PROP.DATA_SOURCE, resp === ui.Button.YES ? 'sheet' : 'bigquery');
  ui.alert('Data source set to: ' + dataSource_());
}

function promptSetSourceId() {
  var ui = SpreadsheetApp.getUi();
  var p = ui.prompt('Source workbook id', 'The "Store Dashboard for WebApp" spreadsheet id (from its URL).', ui.ButtonSet.OK_CANCEL);
  if (p.getSelectedButton() !== ui.Button.OK) return;
  props_().setProperty(PROP.SOURCE_SPREADSHEET_ID, p.getResponseText().trim());
  ui.alert('Saved.');
}

/** Read the source workbook and dump each tab's name + header row to the Run Log. */
function describeSource() {
  var ss = openSource_();
  Log.info('Describing source workbook: ' + ss.getName());
  ss.getSheets().forEach(function (sh) {
    var vals = sh.getDataRange().getValues();
    var hdr = '';
    for (var i = 0; i < Math.min(6, vals.length); i++) {
      var row = vals[i].filter(function (c) { return c !== '' && c !== null; });
      if (row.length >= 2) { hdr = vals[i].join(' | '); break; }
    }
    Log.info('TAB "' + sh.getName() + '" (' + sh.getLastRow() + ' rows): ' + hdr.slice(0, 300));
  });
  SpreadsheetApp.getUi().alert('Source described', 'Tab names + headers written to the "' + SHEET.RUN_LOG + '" tab.', SpreadsheetApp.getUi().ButtonSet.OK);
}

function promptSetBqProject() {
  var ui = SpreadsheetApp.getUi();
  var p = ui.prompt('BigQuery billing project', 'GCP project id that pays for query jobs (has access to ' + BQ.DATA_PROJECT + ')', ui.ButtonSet.OK_CANCEL);
  if (p.getSelectedButton() !== ui.Button.OK) return;
  props_().setProperty(PROP.BQ_BILLING_PROJECT, p.getResponseText().trim());
  ui.alert('Saved.');
}

function promptSetEmails() {
  var ui = SpreadsheetApp.getUi();
  var recv = ui.prompt('Receiving team email', 'Where the PURGE-PRIORITY expedite list is shared (optional).', ui.ButtonSet.OK_CANCEL);
  if (recv.getSelectedButton() !== ui.Button.OK) return;
  var dry = ui.prompt('Dry-run preview email', 'While writes are OFF, all store emails go here instead (use your own address).', ui.ButtonSet.OK_CANCEL);
  if (dry.getSelectedButton() !== ui.Button.OK) return;
  props_().setProperties({ RECEIVING_EMAIL: recv.getResponseText().trim(), DRY_RUN_EMAIL: dry.getResponseText().trim() }, false);
  ui.alert('Saved.');
}

function promptToggleWrites() {
  var ui = SpreadsheetApp.getUi();
  var now = writesEnabled_();
  var resp = ui.alert('Brightpearl writes',
    'Writes are currently ' + (now ? 'LIVE' : 'OFF (dry run)') + '.\n\nSwitch to ' + (now ? 'OFF (dry run)' : 'LIVE') + '?',
    ui.ButtonSet.YES_NO);
  if (resp !== ui.Button.YES) return;
  props_().setProperty(PROP.BP_WRITES_ENABLED, now ? 'false' : 'true');
  ui.alert('Brightpearl writes are now ' + (now ? 'OFF (dry run)' : 'LIVE') + '.');
}

function showStatus() {
  var ui = SpreadsheetApp.getUi();
  var lines = [
    'Data source: ' + dataSource_() + (dataSource_() === 'sheet' ? (' (' + (getProp_(PROP.SOURCE_SPREADSHEET_ID) ? 'workbook set' : 'NO workbook id set') + ')') : ''),
    'Brightpearl writes: ' + (writesEnabled_() ? 'LIVE' : 'OFF (dry run)'),
    'BP base URL: ' + (getProp_(PROP.BP_BASE_URL) || '(not set)'),
    'BP app-ref set: ' + (getProp_(PROP.BP_APP_REF) ? 'yes' : 'no'),
    'BP token set: ' + (getProp_(PROP.BP_ACCOUNT_TOKEN) ? 'yes' : 'no'),
    'BQ billing project: ' + bqBillingProject_(),
    'Receiving email: ' + (getProp_(PROP.RECEIVING_EMAIL) || '(not set)'),
    'Dry-run email: ' + (getProp_(PROP.DRY_RUN_EMAIL) || '(not set)'),
    'Sales window: ' + ENGINE.SALES_WINDOW_DAYS + 'd · dead window: ' + ENGINE.DEAD_WINDOW_DAYS + 'd'
  ];
  ui.alert('Reallocation status', lines.join('\n'), ui.ButtonSet.OK);
}

// ---- Tabs + triggers --------------------------------------------------------

function initSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  [SHEET.PROPOSALS, SHEET.TRACKER, SHEET.RECEIVING, SHEET.STORE_EMAILS, SHEET.RUN_LOG].forEach(function (name) {
    if (!ss.getSheetByName(name)) ss.insertSheet(name);
  });
  var se = ss.getSheetByName(SHEET.STORE_EMAILS);
  if (se.getLastRow() === 0) {
    se.appendRow(['Store name', 'Warehouse id', 'Email']);
    se.getRange(1, 1, 1, 3).setFontWeight('bold');
  }
  SpreadsheetApp.getUi().alert('Tabs ready. Fill in "' + SHEET.STORE_EMAILS + '" with each store\'s address.');
}

function installTriggers() {
  // Clear our existing triggers first.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'runWeeklyProposal' || fn === 'runTracker') ScriptApp.deleteTrigger(t);
  });
  // Weekly proposal — Monday 6am.
  ScriptApp.newTrigger('runWeeklyProposal').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(6).create();
  // Tracker — every 6 hours (catches the 48h window promptly).
  ScriptApp.newTrigger('runTracker').timeBased().everyHours(6).create();
  SpreadsheetApp.getUi().alert('Triggers installed: weekly proposal (Mon 6am) + tracker (every 6h).');
}
