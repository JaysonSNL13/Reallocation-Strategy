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
