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
  var confirmMsg = approved.length + ' approved line(s), consolidated into one transfer + email per donor→recipient pair.' +
    (noThr ? ('\n' + noThr + ' are to stores with NO threshold set — approving confirms those stores want the style.') : '') +
    '\n\nBrightpearl writes are ' + (live ? 'ENABLED — this will create real transfers and zero thresholds.' : 'DISABLED (dry run) — nothing will be written.') +
    '\n\nProceed?';
  if (ui_().alert('Execute approved transfers', confirmMsg, ui_().ButtonSet.OK_CANCEL) !== ui_().Button.OK) return;
  var r = executeApprovedCore_();
  ui_().alert('Done', r.summary, ui_().ButtonSet.OK);
}

/**
 * Headless execute (no UI) — used by the menu wrapper AND the web dashboard.
 * CONSOLIDATES approved lines by donor→recipient: ONE transfer + ONE email draft + one CSV
 * block per store pair. Pass {donorWid, recipWid} to run a SINGLE pair (per-group button).
 * Returns { summary, created, skipped, drafts, csv }.
 */
function executeApprovedCore_(opts) {
  opts = opts || {};
  var approved = readApprovedRows_();
  if (opts.donorWid && opts.recipWid) {
    approved = approved.filter(function (r) {
      return String(r.donorWid) === String(opts.donorWid) && String(r.recipWid) === String(opts.recipWid);
    });
  }
  if (!approved.length) return { summary: 'Nothing approved to execute.', created: 0, skipped: 0, drafts: 0, csv: '' };
  var live = writesEnabled_();

  var pairs = buildApprovedPairs_(approved);
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd');
  var mdate = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d');
  var receiving = [], trackerRows = [], csvRows = [];
  var created = 0, skipped = 0, drafts = 0;

  pairs.forEach(function (p) {
    if (!p.items.length) {
      p.rows.forEach(function (row) { markRow_(row.rowIndex, { status: 'SKIPPED — no live stock', notes: 'Donor holds 0 available at execution.' }); });
      skipped++;
      return;
    }
    var reference = 'PURGE-PRIORITY-REALLOC-' + p.donorWid + 'to' + p.recipWid + '-' + stamp;
    var result;
    try {
      result = BP.createStockTransfer(p.donorWid, p.recipWid, reference,
        p.items.map(function (it) { return { productId: it.productId, quantity: it.quantity }; }));
    } catch (e) {
      p.rows.forEach(function (row) { markRow_(row.rowIndex, { status: 'ERROR', notes: String(e.message || e) }); });
      Log.error('Transfer failed ' + p.donorWid + '->' + p.recipWid + ': ' + e);
      return;
    }
    var tid = result.stockTransferId || (result.dryRun ? 'DRY-RUN' : '');
    p.rows.forEach(function (row) {
      markRow_(row.rowIndex, { transferId: tid, status: result.dryRun ? 'DRY RUN' : 'CREATED',
        notes: reference + (result.goodsOutNoteIds && result.goodsOutNoteIds.length ? (' · GON ' + result.goodsOutNoteIds.join(',')) : '') });
    });
    created++;

    p.items.forEach(function (it) {
      try { BP.zeroReorderLevel(p.donorWid, it.productId); }
      catch (e) { Log.warn('zeroReorderLevel failed wh ' + p.donorWid + ' pid ' + it.productId + ': ' + e); }
    });

    // ONE email DRAFT for THIS from→to group (blank To — a person adds the address and sends).
    if (createPairDraft_(p, tid)) drafts++;

    // CSV block for the group.
    csvRows.push(['', p.donorName, p.recipientName, 'realloc-' + storeCode_(p.recipientName) + '-' + mdate]);
    p.items.forEach(function (it) { csvRows.push([it.sku, it.quantity, '', '']); });

    var units = p.items.reduce(function (a, it) { return a + it.quantity; }, 0);
    var styleLabel = Object.keys(p.styles).join(', ');
    receiving.push([new Date(), tid, styleLabel, p.donorName, p.recipientName, units, reference, p.force ? 'FORCE' : '']);
    trackerRows.push([new Date(), tid, styleLabel, p.donorName, p.donorWid, p.recipientName, p.recipWid, units,
      (result.goodsOutNoteIds || []).join(','), 'CREATED', new Date(), 0, p.force ? 'FORCE' : 'REGULAR']);
  });

  appendReceiving_(receiving);
  appendTracker_(trackerRows);
  if (csvRows.length) writeTransferCsv_(csvRows);
  var csvText = csvRows.map(function (r) { return r.map(csvCell_).join(','); }).join('\r\n');
  var summary = (live ? 'Created' : 'Dry-run created') + ' ' + created + ' transfer(s) (one per store pair), skipped ' + skipped +
    '. Email drafts (Gmail ▸ Drafts): ' + drafts + '. CSV: ' + (csvRows.length ? 'ready' : 'none') + '.';
  Log.info(summary);
  return { summary: summary, created: created, skipped: skipped, drafts: drafts, csv: csvText };
}

/**
 * Group approved rows into donor→recipient pairs, each with its live pull-list items (SKU+qty).
 * Availability = live Brightpearl if a token is set, else the workbook on-hand.
 */
function buildApprovedPairs_(approved) {
  var styles = uniq_(approved.map(function (a) { return a.style; }));
  var styleProducts = getStyleProducts_(styles);
  var allPids = [];
  styles.forEach(function (s) { (styleProducts[s] || []).forEach(function (p) { allPids.push(p.product_id); }); });
  var avail = bpConfigured_() ? BP.getAvailability(uniq_(allPids)) : getSheetAvailability_(styles);

  var byKey = {};
  approved.forEach(function (row) {
    var k = row.donorWid + '|' + row.recipWid;
    var p = byKey[k] || (byKey[k] = { donorWid: row.donorWid, donorName: row.donorName, recipWid: row.recipWid,
      recipientName: row.recipientName, force: false, rows: [], styles: {} });
    p.rows.push(row); p.styles[row.style] = true; if (row.force) p.force = true;
  });

  return Object.keys(byKey).map(function (k) {
    var p = byKey[k];
    var items = [];
    Object.keys(p.styles).forEach(function (style) {
      (styleProducts[style] || []).forEach(function (prod) {
        var a = (avail[prod.product_id] && avail[prod.product_id][p.donorWid]) || null;
        var qty = a ? a.available : 0;
        if (qty > 0) items.push({ productId: prod.product_id, sku: prod.sku, garment: prod.garment, size: prod.size, style: style, quantity: qty });
      });
    });
    p.items = items;
    return p;
  });
}

/** Create ONE Gmail draft (blank To) for a donor→recipient group. Returns true if made. */
function createPairDraft_(p, tid) {
  var items = p.items.map(function (it) {
    return { recipientName: p.recipientName, style: it.style, garment: it.garment, size: it.size, sku: it.sku, qty: it.quantity, transferId: tid };
  });
  var mail = buildPullListEmail_(p.donorName, items, false);
  var units = p.items.reduce(function (a, it) { return a + it.quantity; }, 0);
  var subject = 'Suit reallocation — ' + p.donorName + ' → ' + p.recipientName + ' (' + units + ' unit' + (units === 1 ? '' : 's') + ')';
  GmailApp.createDraft('', subject, 'This email requires HTML.', { htmlBody: mail.html, name: 'S&L Reallocation' });
  Log.info('Draft created (no recipient): ' + p.donorName + ' → ' + p.recipientName);
  return true;
}

/** Build the transfer-list CSV from currently-approved rows WITHOUT creating transfers/emails. */
function exportApprovedCsv_() {
  var approved = readApprovedRows_();
  if (!approved.length) return '';
  var pairs = buildApprovedPairs_(approved);
  var mdate = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d');
  var csvRows = [];
  pairs.forEach(function (p) {
    if (!p.items.length) return;
    csvRows.push(['', p.donorName, p.recipientName, 'realloc-' + storeCode_(p.recipientName) + '-' + mdate]);
    p.items.forEach(function (it) { csvRows.push([it.sku, it.quantity, '', '']); });
  });
  if (csvRows.length) writeTransferCsv_(csvRows);
  return csvRows.map(function (r) { return r.map(csvCell_).join(','); }).join('\r\n');
}

/** CSV-escape a cell (quote if it contains comma/quote/newline). */
function csvCell_(v) {
  var s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Write the transfer-list rows (A–D) to the Transfer CSV tab (overwrites each run). */
function writeTransferCsv_(rows) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET.TRANSFER_CSV) || ss.insertSheet(SHEET.TRANSFER_CSV);
  sh.clear();
  if (rows.length) sh.getRange(1, 1, rows.length, 4).setValues(rows);
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

/**
 * DEMO create — moves approved lines to Log (status LOGGED) with NO Brightpearl transfer and
 * NO email. Used while DEMO_MODE is on so the flow can be tested/handed to devs. Pass
 * {donorWid, recipWid} to log just one from→to group.
 */
function demoLogApproved_(opts) {
  opts = opts || {};
  var approved = readApprovedRows_();
  if (opts.donorWid && opts.recipWid) {
    approved = approved.filter(function (r) { return String(r.donorWid) === String(opts.donorWid) && String(r.recipWid) === String(opts.recipWid); });
  }
  if (!approved.length) return { summary: 'Nothing approved to log.', created: 0, skipped: 0, drafts: 0, csv: '' };
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  approved.forEach(function (row) {
    markRow_(row.rowIndex, { transferId: 'DEMO', status: 'LOGGED', notes: 'Demo — logged ' + stamp + ' (no transfer/email created)' });
  });
  Log.info('DEMO: logged ' + approved.length + ' approved line(s) — no transfer/email created.');
  return { summary: 'Demo: moved ' + approved.length + ' line(s) to Log. No transfer or email created.', created: approved.length, skipped: 0, drafts: 0, csv: '' };
}
