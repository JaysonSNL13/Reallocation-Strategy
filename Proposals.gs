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
