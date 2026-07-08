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
