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
