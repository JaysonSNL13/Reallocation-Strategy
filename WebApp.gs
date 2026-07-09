/**
 * WebApp.gs — serves the HTML dashboard (a replica of the original suit-reallocation tool)
 * as an Apps Script web app, backed by the live "Proposed Transfers" tab.
 *
 * Deploy: Apps Script editor ▸ Deploy ▸ New deployment ▸ Web app.
 *   - Execute as: Me
 *   - Who has access: keep it restricted (Only myself, or your Workspace domain) — the page
 *     shows internal reallocation data. Don't set "Anyone" unless you intend it public.
 * The returned URL renders the dashboard; the page calls the functions below via
 * google.script.run.
 */

function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('Dashboard')
    .setTitle('Suit Reallocation')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Read the Proposed Transfers tab and return everything the dashboard needs to render. */
function getProposalsData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET.PROPOSALS);
  var out = { asOf: '', rows: [], stats: { transfers: 0, units: 0, donors: 0, recipients: 0, forceEmpties: 0, approved: 0 } };
  if (!sh || sh.getLastRow() < 2) return out;

  var values = sh.getRange(2, 1, sh.getLastRow() - 1, PROPOSAL_HEADERS.length).getValues();
  var donorSet = {}, recipSet = {}, units = 0, fe = 0, approved = 0;

  values.forEach(function (r, i) {
    var force = String(r[COL.TYPE - 1]).toLowerCase().indexOf('force') >= 0;
    var isApproved = r[COL.APPROVE - 1] === true;
    var flags = String(r[COL.FLAGS - 1] || '');
    var row = {
      rowIndex: 2 + i,
      approve: isApproved,
      rank: r[COL.RANK - 1],
      type: r[COL.TYPE - 1],
      force: force,
      style: r[COL.STYLE - 1],
      donor: r[COL.DONOR - 1],
      donorWid: r[COL.DONOR_WH - 1],
      recipient: r[COL.RECIPIENT - 1],
      recipWid: r[COL.RECIP_WH - 1],
      gap: r[COL.GAP - 1],
      donorRank: r[COL.DONOR_RANK - 1],
      recipRank: r[COL.RECIP_RANK - 1],
      runNow: r[COL.RUN_NOW - 1],
      runAfter: r[COL.RUN_AFTER - 1],
      units: r[COL.UNITS - 1],
      flags: flags,
      noThreshold: flags.indexOf('NO THRESHOLD') >= 0,
      status: r[COL.STATUS - 1],
      transferId: r[COL.TRANSFER_ID - 1]
    };
    out.rows.push(row);
    donorSet[row.donorWid] = true;
    recipSet[row.recipWid] = true;
    units += Number(row.units || 0);
    if (force) fe++;
    if (isApproved) approved++;
  });

  out.stats = {
    transfers: values.length,
    units: units,
    donors: Object.keys(donorSet).length,
    recipients: Object.keys(recipSet).length,
    forceEmpties: fe,
    approved: approved
  };
  out.asOf = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMM d, yyyy h:mm a');
  out.writesLive = writesEnabled_();
  out.bpConfigured = bpConfigured_();
  return out;
}

/** Toggle the Approve checkbox for a row from the dashboard. Returns the new stats. */
function webSetApprove(rowIndex, value) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET.PROPOSALS);
  sh.getRange(Number(rowIndex), COL.APPROVE).setValue(value === true);
  SpreadsheetApp.flush();
  return getProposalsData();
}

/**
 * Run the weekly proposal from the dashboard (rebuilds the list). Headless — no UI alerts.
 * Returns the refreshed data.
 */
function webRunProposal() {
  runWeeklyProposal();
  return getProposalsData();
}

/** Create transfers + email drafts for all approved lines (consolidated per store pair). */
function webExecuteApproved() {
  var r = executeApprovedCore_();
  var data = getProposalsData();
  data.execMessage = r.summary;
  return data;
}
