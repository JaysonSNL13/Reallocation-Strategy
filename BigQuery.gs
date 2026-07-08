/**
 * BigQuery.gs — run queries against the Brightpearl mirror via the BigQuery advanced
 * service and return plain row objects. Billing project = Script Property
 * BQ_BILLING_PROJECT (defaults to the data project).
 */

/** Run standard-SQL, page through all results, return array of {colName: value}. */
function bqQuery_(sql) {
  var projectId = bqBillingProject_();
  var req = { query: sql, useLegacySql: false, timeoutMs: 120000 };
  var resp = BigQuery.Jobs.query(req, projectId);
  var jobId = resp.jobReference.jobId;
  var location = resp.jobReference.location;

  // Poll until the job completes.
  var guard = 0;
  while (!resp.jobComplete && guard++ < 60) {
    Utilities.sleep(1000);
    resp = BigQuery.Jobs.getQueryResults(projectId, jobId, { location: location, timeoutMs: 120000 });
  }
  if (!resp.jobComplete) throw new Error('BigQuery job did not complete: ' + jobId);

  var fields = (resp.schema && resp.schema.fields) ? resp.schema.fields.map(function (f) { return f.name; }) : [];
  var rows = resp.rows || [];
  var pageToken = resp.pageToken;
  while (pageToken) {
    var more = BigQuery.Jobs.getQueryResults(projectId, jobId, { location: location, pageToken: pageToken });
    rows = rows.concat(more.rows || []);
    pageToken = more.pageToken;
  }

  return rows.map(function (r) {
    var o = {};
    (r.f || []).forEach(function (cell, i) { o[fields[i]] = (cell ? cell.v : null); });
    return o;
  });
}

/**
 * Candidate rows for the engine, shaped for matchSuits().
 * `toks` comes back from BigQuery as a REPEATED field: an array of {v: 'Blazer|40'}.
 */
function fetchCandidates_() {
  var raw = bqQuery_(buildCandidateQuery(ENGINE.SALES_WINDOW_DAYS));
  return raw.map(function (c) {
    return {
      role: c.role,
      wid: String(c.wid),
      name: c.name,
      style: c.style,
      sold: num_(c.sold),
      run: num_(c.run),
      run_oh: num_(c.run_oh),
      full_run: num_(c.full_run),
      units: num_(c.units),
      blz: num_(c.blz),
      pnt: num_(c.pnt),
      cp: num_(c.cp),
      has_thr: num_(c.has_thr),
      srank: num_(c.srank),
      rk: num_(c.rk),
      felig: toBool_(c.felig),
      esi: num_(c.esi),
      blz_msrp: num_(c.blz_msrp),
      pnt_msrp: num_(c.pnt_msrp),
      toks: unpackRepeated_(c.toks),
      wh_oh: num_(c.wh_oh),
      wh_avail: num_(c.wh_avail),
      wh_blz: num_(c.wh_blz),
      wh_pnt: num_(c.wh_pnt),
      blz_full: num_(c.blz_full),
      pnt_full: num_(c.pnt_full),
      wh_po: num_(c.wh_po),
      po_eta: c.po_eta || null,
      po_within14: toBool_(c.po_within14)
    };
  });
}

/** Set of "wid|style" that had > 0 in-store sales in the last 30 days (i.e. NOT dead). */
function fetchAlive30_() {
  var rows = bqQuery_(buildDead30Query(ENGINE.DEAD_WINDOW_DAYS));
  var alive = {};
  rows.forEach(function (r) { if (num_(r.units) > 0) alive[String(r.wid) + '|' + r.style] = true; });
  return alive;
}

/** Product map for approval-time pull lists: { style: [{product_id, sku, garment, size}] }. */
function fetchStyleProducts_(styles) {
  if (!styles || !styles.length) return {};
  var rows = bqQuery_(buildStyleProductsQuery(styles));
  var byStyle = {};
  rows.forEach(function (r) {
    var s = r.style;
    (byStyle[s] = byStyle[s] || []).push({
      product_id: String(r.product_id),
      sku: r.sku,
      garment: r.garment,
      size: num_(r.size_num)
    });
  });
  return byStyle;
}

/** BigQuery REPEATED cell -> flat array of strings. */
function unpackRepeated_(cell) {
  if (cell == null) return [];
  if (Array.isArray(cell)) return cell.map(function (x) { return (x && x.v !== undefined) ? x.v : x; });
  return [];
}
