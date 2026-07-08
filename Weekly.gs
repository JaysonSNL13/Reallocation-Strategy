/**
 * Weekly.gs — the once-a-week pull + engine + proposal write.
 * This is READ-ONLY against Brightpearl (it only queries the BigQuery mirror). It never
 * writes anything to Brightpearl — that only happens later, on Jayson's approval, via
 * executeApprovedTransfers().
 */

function runWeeklyProposal() {
  var t0 = Date.now();
  Log.info('Weekly run started.');

  var cands = getCandidates_();
  Log.info('Fetched ' + cands.length + ' candidate rows from source (' + dataSource_() + ').');

  var alive30 = getAlive30_();
  var moves = runEngine_(cands, alive30);
  Log.info('Engine produced ' + moves.length + ' recipient moves (' +
    moves.filter(function (m) { return m.force; }).length + ' force-empty).');

  var nRows = writeProposals_(moves);
  writeRunLogSummary_(moves, nRows, Date.now() - t0);

  return { moves: moves.length, rows: nRows };
}

function writeRunLogSummary_(moves, nRows, ms) {
  var donorSet = {}, recipSet = {}, units = 0;
  moves.forEach(function (m) {
    recipSet[m.recip_wid] = true;
    (m.donors || []).forEach(function (d) { donorSet[d.wid] = true; units += Number(d.units || 0); });
  });
  Log.info('Weekly summary: ' + nRows + ' transfers, ' +
    Object.keys(donorSet).length + ' donor stores, ' +
    Object.keys(recipSet).length + ' recipient stores, ~' + units + ' units, ' +
    (ms / 1000).toFixed(1) + 's. Writes ' + (writesEnabled_() ? 'ENABLED' : 'DISABLED (dry run)') + '.');
}
