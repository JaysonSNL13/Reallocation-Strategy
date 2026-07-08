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
