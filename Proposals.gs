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

/** Stable key for a proposed transfer line, used to preserve state across re-runs. */
function proposalKey_(style, donorWid, recipWid) { return style + '|' + donorWid + '|' + recipWid; }

function isDoneStatus_(s) { return /CREATED|DRY RUN|SHIPPED|RECEIVED|LOGGED/i.test(String(s || '')); }

/**
 * Expand ranked moves into per-transfer rows and write them to the sheet.
 * MERGE, not overwrite: any line already Approved or done (LOGGED/CREATED/…) keeps that state
 * on a re-run — so you never re-approve, and logged history persists even if the engine no
 * longer proposes that line.
 */
function writeProposals_(moves) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET.PROPOSALS) || ss.insertSheet(SHEET.PROPOSALS);

  // Snapshot prior state by key.
  var prior = {};
  if (sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, PROPOSAL_HEADERS.length).getValues().forEach(function (r) {
      var key = proposalKey_(r[COL.STYLE - 1], r[COL.DONOR_WH - 1], r[COL.RECIP_WH - 1]);
      prior[key] = { approve: r[COL.APPROVE - 1] === true, status: r[COL.STATUS - 1],
        transferId: r[COL.TRANSFER_ID - 1], updated: r[COL.UPDATED - 1], notes: r[COL.NOTES - 1], row: r };
    });
  }

  sh.clear();
  sh.getRange(1, 1, 1, PROPOSAL_HEADERS.length).setValues([PROPOSAL_HEADERS])
    .setFontWeight('bold').setBackground('#111111').setFontColor('#ffffff');
  sh.setFrozenRows(1);

  var rows = [], seen = {}, preserved = 0;
  moves.forEach(function (m, idx) {
    var rank = idx + 1;
    (m.donors || []).forEach(function (d) {
      var key = proposalKey_(m.style, d.wid, m.recip_wid);
      seen[key] = true;
      var p = prior[key];
      if (p && (p.approve || isDoneStatus_(p.status))) preserved++;
      var flags = [];
      if (m.force) flags.push('FORCE EMPTY');
      if (!m.has_thr) flags.push('CONFIRM — NO THRESHOLD');
      rows.push([
        p ? p.approve : false, rank, m.force ? 'Force-empty' : 'Regular', m.style,
        d.name, d.wid, m.recipient, m.recip_wid, m.rank_gap, d.rank, m.recip_rank,
        m.recip_run, m.recip_final, d.units, flags.join(' · '),
        p ? p.transferId : '', p ? statusValue_(p.status) : statusValue_(),
        p ? p.updated : '', p ? p.notes : ''
      ]);
    });
  });

  // Persist prior Approved/logged lines the engine no longer proposes.
  Object.keys(prior).forEach(function (key) {
    if (seen[key]) return;
    var p = prior[key];
    if (p.approve || isDoneStatus_(p.status)) { rows.push(p.row); preserved++; }
  });

  if (rows.length) {
    sh.getRange(2, 1, rows.length, PROPOSAL_HEADERS.length).setValues(rows);
    sh.getRange(2, COL.APPROVE, rows.length, 1).insertCheckboxes();
    sh.getRange(2, COL.RUN_NOW, rows.length, 2).setNumberFormat('0%');
  }
  sh.autoResizeColumns(1, PROPOSAL_HEADERS.length);
  formatFlagRows_(sh, rows.length);

  Log.info('Wrote ' + rows.length + ' proposal rows (preserved ' + preserved + ' already approved/logged).');
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
