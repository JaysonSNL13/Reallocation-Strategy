/**
 * Menu.gs — the spreadsheet UI, setup prompts, and trigger installation.
 * Adds a "Reallocation" menu when the sheet opens.
 */

function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('Reallocation')
    .addItem('1 ▸ Run weekly proposal', 'menuRunWeekly')
    .addItem('2 ▸ Execute approved transfers', 'executeApprovedTransfers')
    .addItem('3 ▸ Run tracker now', 'runTracker')
    .addSeparator()
    .addSubMenu(ui.createMenu('Setup')
      .addItem('Initialize tabs', 'initSheets')
      .addItem('Set data source (sheet / bigquery)', 'promptSetDataSource')
      .addItem('Set source workbook id', 'promptSetSourceId')
      .addItem('Describe source workbook', 'describeSource')
      .addItem('Set Brightpearl credentials', 'promptSetBrightpearl')
      .addItem('Set BigQuery billing project', 'promptSetBqProject')
      .addItem('Set Receiving / dry-run emails', 'promptSetEmails')
      .addItem('Toggle Brightpearl WRITES (dry run ↔ live)', 'promptToggleWrites')
      .addItem('Install weekly + tracker triggers', 'installTriggers')
      .addItem('Show current status', 'showStatus'))
    .addToUi();
}

function menuRunWeekly() {
  var r = runWeeklyProposal();
  SpreadsheetApp.getUi().alert('Weekly proposal ready',
    r.rows + ' transfer rows written to "' + SHEET.PROPOSALS + '". Review, tick Approve, then run "Execute approved transfers".',
    SpreadsheetApp.getUi().ButtonSet.OK);
}

// ---- Setup prompts ----------------------------------------------------------

function promptSetBrightpearl() {
  var ui = SpreadsheetApp.getUi();
  var base = ui.prompt('Brightpearl base URL', 'e.g. https://use1.brightpearlconnect.com/public-api/stateandliberty', ui.ButtonSet.OK_CANCEL);
  if (base.getSelectedButton() !== ui.Button.OK) return;
  var ref = ui.prompt('brightpearl-app-ref', ui.ButtonSet.OK_CANCEL);
  if (ref.getSelectedButton() !== ui.Button.OK) return;
  var tok = ui.prompt('brightpearl-account-token', ui.ButtonSet.OK_CANCEL);
  if (tok.getSelectedButton() !== ui.Button.OK) return;
  props_().setProperties({
    BP_BASE_URL: base.getResponseText().trim(),
    BP_APP_REF: ref.getResponseText().trim(),
    BP_ACCOUNT_TOKEN: tok.getResponseText().trim()
  }, false);
  ui.alert('Saved. Brightpearl writes remain OFF until you toggle them.');
}

function promptSetDataSource() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.alert('Data source', 'Read ranking input from the Store Dashboard SHEET? (No = BigQuery mirror)', ui.ButtonSet.YES_NO);
  props_().setProperty(PROP.DATA_SOURCE, resp === ui.Button.YES ? 'sheet' : 'bigquery');
  ui.alert('Data source set to: ' + dataSource_());
}

function promptSetSourceId() {
  var ui = SpreadsheetApp.getUi();
  var p = ui.prompt('Source workbook id', 'The "Store Dashboard for WebApp" spreadsheet id (from its URL).', ui.ButtonSet.OK_CANCEL);
  if (p.getSelectedButton() !== ui.Button.OK) return;
  props_().setProperty(PROP.SOURCE_SPREADSHEET_ID, p.getResponseText().trim());
  ui.alert('Saved.');
}

/** Read the source workbook and dump each tab's name + header row to the Run Log. */
function describeSource() {
  var ss = openSource_();
  Log.info('Describing source workbook: ' + ss.getName());
  ss.getSheets().forEach(function (sh) {
    var vals = sh.getDataRange().getValues();
    var hdr = '';
    for (var i = 0; i < Math.min(6, vals.length); i++) {
      var row = vals[i].filter(function (c) { return c !== '' && c !== null; });
      if (row.length >= 2) { hdr = vals[i].join(' | '); break; }
    }
    Log.info('TAB "' + sh.getName() + '" (' + sh.getLastRow() + ' rows): ' + hdr.slice(0, 300));
  });
  SpreadsheetApp.getUi().alert('Source described', 'Tab names + headers written to the "' + SHEET.RUN_LOG + '" tab.', SpreadsheetApp.getUi().ButtonSet.OK);
}

function promptSetBqProject() {
  var ui = SpreadsheetApp.getUi();
  var p = ui.prompt('BigQuery billing project', 'GCP project id that pays for query jobs (has access to ' + BQ.DATA_PROJECT + ')', ui.ButtonSet.OK_CANCEL);
  if (p.getSelectedButton() !== ui.Button.OK) return;
  props_().setProperty(PROP.BQ_BILLING_PROJECT, p.getResponseText().trim());
  ui.alert('Saved.');
}

function promptSetEmails() {
  var ui = SpreadsheetApp.getUi();
  var recv = ui.prompt('Receiving team email', 'Where the PURGE-PRIORITY expedite list is shared (optional).', ui.ButtonSet.OK_CANCEL);
  if (recv.getSelectedButton() !== ui.Button.OK) return;
  var dry = ui.prompt('Dry-run preview email', 'While writes are OFF, all store emails go here instead (use your own address).', ui.ButtonSet.OK_CANCEL);
  if (dry.getSelectedButton() !== ui.Button.OK) return;
  props_().setProperties({ RECEIVING_EMAIL: recv.getResponseText().trim(), DRY_RUN_EMAIL: dry.getResponseText().trim() }, false);
  ui.alert('Saved.');
}

function promptToggleWrites() {
  var ui = SpreadsheetApp.getUi();
  var now = writesEnabled_();
  var resp = ui.alert('Brightpearl writes',
    'Writes are currently ' + (now ? 'LIVE' : 'OFF (dry run)') + '.\n\nSwitch to ' + (now ? 'OFF (dry run)' : 'LIVE') + '?',
    ui.ButtonSet.YES_NO);
  if (resp !== ui.Button.YES) return;
  props_().setProperty(PROP.BP_WRITES_ENABLED, now ? 'false' : 'true');
  ui.alert('Brightpearl writes are now ' + (now ? 'OFF (dry run)' : 'LIVE') + '.');
}

function showStatus() {
  var ui = SpreadsheetApp.getUi();
  var lines = [
    'Data source: ' + dataSource_() + (dataSource_() === 'sheet' ? (' (' + (getProp_(PROP.SOURCE_SPREADSHEET_ID) ? 'workbook set' : 'NO workbook id set') + ')') : ''),
    'Brightpearl writes: ' + (writesEnabled_() ? 'LIVE' : 'OFF (dry run)'),
    'BP base URL: ' + (getProp_(PROP.BP_BASE_URL) || '(not set)'),
    'BP app-ref set: ' + (getProp_(PROP.BP_APP_REF) ? 'yes' : 'no'),
    'BP token set: ' + (getProp_(PROP.BP_ACCOUNT_TOKEN) ? 'yes' : 'no'),
    'BQ billing project: ' + bqBillingProject_(),
    'Receiving email: ' + (getProp_(PROP.RECEIVING_EMAIL) || '(not set)'),
    'Dry-run email: ' + (getProp_(PROP.DRY_RUN_EMAIL) || '(not set)'),
    'Sales window: ' + ENGINE.SALES_WINDOW_DAYS + 'd · dead window: ' + ENGINE.DEAD_WINDOW_DAYS + 'd'
  ];
  ui.alert('Reallocation status', lines.join('\n'), ui.ButtonSet.OK);
}

// ---- Tabs + triggers --------------------------------------------------------

function initSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  [SHEET.PROPOSALS, SHEET.TRACKER, SHEET.RECEIVING, SHEET.STORE_EMAILS, SHEET.RUN_LOG].forEach(function (name) {
    if (!ss.getSheetByName(name)) ss.insertSheet(name);
  });
  var se = ss.getSheetByName(SHEET.STORE_EMAILS);
  if (se.getLastRow() === 0) {
    se.appendRow(['Store name', 'Warehouse id', 'Email']);
    se.getRange(1, 1, 1, 3).setFontWeight('bold');
  }
  SpreadsheetApp.getUi().alert('Tabs ready. Fill in "' + SHEET.STORE_EMAILS + '" with each store\'s address.');
}

function installTriggers() {
  // Clear our existing triggers first.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'runWeeklyProposal' || fn === 'runTracker') ScriptApp.deleteTrigger(t);
  });
  // Weekly proposal — Monday 6am.
  ScriptApp.newTrigger('runWeeklyProposal').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(6).create();
  // Tracker — every 6 hours (catches the 48h window promptly).
  ScriptApp.newTrigger('runTracker').timeBased().everyHours(6).create();
  SpreadsheetApp.getUi().alert('Triggers installed: weekly proposal (Mon 6am) + tracker (every 6h).');
}
