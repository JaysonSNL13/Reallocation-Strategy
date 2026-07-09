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
 * Headless execute (no UI) — used by the menu wrapper AND the web dashboard button.
 * CONSOLIDATES approved lines by donor→recipient so ONE transfer and ONE email cover every
 * approved style for that store pair. Returns { summary, created, skipped, drafts }.
 */
function executeApprovedCore_() {
  var approved = readApprovedRows_();
  if (!approved.length) return { summary: 'Nothing approved to execute.', created: 0, skipped: 0, drafts: 0 };
  var live = writesEnabled_();

  var styles = uniq_(approved.map(function (a) { return a.style; }));
  var styleProducts = getStyleProducts_(styles);
  var allPids = [];
  styles.forEach(function (s) { (styleProducts[s] || []).forEach(function (p) { allPids.push(p.product_id); }); });
  var usingLive = bpConfigured_();
  var avail = usingLive ? BP.getAvailability(uniq_(allPids)) : getSheetAvailability_(styles);
  Log.info('Execute using ' + (usingLive ? 'LIVE Brightpearl availability' : 'PREVIEW availability from the workbook') + '.');

  // Consolidate approved lines by donor→recipient pair.
  var pairs = {};
  approved.forEach(function (row) {
    var k = row.donorWid + '|' + row.recipWid;
    var p = pairs[k] || (pairs[k] = { donorWid: row.donorWid, donorName: row.donorName, recipWid: row.recipWid,
      recipientName: row.recipientName, force: false, rows: [], styles: {} });
    p.rows.push(row); p.styles[row.style] = true; if (row.force) p.force = true;
  });

  var byDonor = {}, receiving = [], trackerRows = [], csvRows = [];
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd');
  var mdate = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d');
  var created = 0, skipped = 0;

  Object.keys(pairs).forEach(function (k) {
    var p = pairs[k];
    var items = [];
    Object.keys(p.styles).forEach(function (style) {
      (styleProducts[style] || []).forEach(function (prod) {
        var a = (avail[prod.product_id] && avail[prod.product_id][p.donorWid]) || null;
        var qty = a ? a.available : 0;
        if (qty > 0) items.push({ productId: prod.product_id, sku: prod.sku, garment: prod.garment, size: prod.size, style: style, quantity: qty });
      });
    });

    if (!items.length) {
      p.rows.forEach(function (row) { markRow_(row.rowIndex, { status: 'SKIPPED — no live stock', notes: 'Donor holds 0 available at execution.' }); });
      skipped++;
      return;
    }

    var reference = 'PURGE-PRIORITY-REALLOC-' + p.donorWid + 'to' + p.recipWid + '-' + stamp;
    var result;
    try {
      result = BP.createStockTransfer(p.donorWid, p.recipWid, reference,
        items.map(function (it) { return { productId: it.productId, quantity: it.quantity }; }));
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

    items.forEach(function (it) {
      try { BP.zeroReorderLevel(p.donorWid, it.productId); }
      catch (e) { Log.warn('zeroReorderLevel failed wh ' + p.donorWid + ' pid ' + it.productId + ': ' + e); }
    });

    var d = byDonor[p.donorWid] || (byDonor[p.donorWid] = { name: p.donorName, items: [] });
    items.forEach(function (it) {
      d.items.push({ recipientName: p.recipientName, style: it.style, garment: it.garment, size: it.size, sku: it.sku, qty: it.quantity, transferId: tid });
    });

    var units = items.reduce(function (a, it) { return a + it.quantity; }, 0);
    var styleLabel = Object.keys(p.styles).join(', ');
    receiving.push([new Date(), tid, styleLabel, p.donorName, p.recipientName, units, reference, p.force ? 'FORCE' : '']);
    trackerRows.push([new Date(), tid, styleLabel, p.donorName, p.donorWid, p.recipientName, p.recipWid, units,
      (result.goodsOutNoteIds || []).join(','), 'CREATED', new Date(), 0, p.force ? 'FORCE' : 'REGULAR']);

    // Zipline transfer-list CSV block: header row (blank A, From=donor in B, To=recipient in C,
    // ref in D), then one SKU/qty row each (C and D blank — location/ref not repeated).
    var csvRef = 'realloc-' + storeCode_(p.recipientName) + '-' + mdate;
    csvRows.push(['', p.donorName, p.recipientName, csvRef]);
    items.forEach(function (it) { csvRows.push([it.sku, it.quantity, '', '']); });
  });

  var emailReport = sendStorePullLists_(byDonor);
  appendReceiving_(receiving);
  appendTracker_(trackerRows);

  var drafts = emailReport.filter(function (r) { return r.drafted; }).length;
  if (csvRows.length) writeTransferCsv_(csvRows);
  var csvText = csvRows.map(function (r) { return r.map(csvCell_).join(','); }).join('\r\n');
  var summary = (live ? 'Created' : 'Dry-run created') + ' ' + created + ' consolidated transfer(s), skipped ' + skipped +
    '. Email drafts: ' + drafts + '. Transfer-list CSV: ' + (csvRows.length ? 'ready to download' : 'none') + '.';
  Log.info(summary);
  return { summary: summary, created: created, skipped: skipped, drafts: drafts, csv: csvText };
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
