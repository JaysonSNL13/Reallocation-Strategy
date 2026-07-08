/**
 * Util.gs — logging + small shared helpers.
 * Log writes to Stackdriver (console) and, when a spreadsheet is bound, appends to the
 * "Run Log" tab so Jayson can see what the weekly run did without opening the editor.
 */
var Log = (function () {
  function stamp_() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'); }

  function toSheet_(level, msg) {
    try {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      if (!ss) return;
      var sh = ss.getSheetByName(SHEET.RUN_LOG);
      if (!sh) { sh = ss.insertSheet(SHEET.RUN_LOG); sh.appendRow(['Time', 'Level', 'Message']); }
      sh.appendRow([stamp_(), level, String(msg)]);
    } catch (e) { /* logging must never throw */ }
  }

  function line_(level, args) {
    var msg = Array.prototype.slice.call(args).map(function (a) {
      return (typeof a === 'object') ? JSON.stringify(a) : String(a);
    }).join(' ');
    console.log('[' + level + '] ' + msg);
    if (level !== 'DEBUG') toSheet_(level, msg);
    return msg;
  }

  return {
    debug: function () { return line_('DEBUG', arguments); },
    info:  function () { return line_('INFO', arguments); },
    warn:  function () { return line_('WARN', arguments); },
    error: function () { return line_('ERROR', arguments); }
  };
})();

/** first char of a size token 'Blazer|40' / 'Pant|32' -> garment class. */
function tokGarment_(tok) { return String(tok).charAt(0) === 'B' ? 'Blazer' : 'Pant'; }

/** Given a set/array of size tokens, return {b, p} = fraction of full blazer/pant run held. */
function runFractions_(toks, blzFull, pntFull) {
  var b = 0, p = 0, seen = {};
  (toks || []).forEach(function (t) {
    if (seen[t]) return; seen[t] = true;
    if (tokGarment_(t) === 'Blazer') b++; else p++;
  });
  return {
    b: blzFull > 0 ? b / blzFull : 1,
    p: pntFull > 0 ? p / pntFull : 1
  };
}

function toBool_(v) { return v === true || v === 'true' || v === 1 || v === '1'; }
function num_(v) { return Number(v || 0); }
