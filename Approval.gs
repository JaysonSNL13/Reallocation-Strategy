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
