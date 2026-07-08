/**
 * Queries.gs — the BigQuery SQL that defines the engine's input data.
 *
 * The candidate query (buildCandidateQuery) is ported VERBATIM from the live tool's
 * Q_CAND, with exactly ONE deliberate change: the old tool injected the sales numbers
 * from a hand-set data pull via `UNNEST([...])`. Because we are rebuilding on LIVE data,
 * that injected CTE is replaced by a real mirror sales CTE (SALES_CTE) computed from
 * shipped, non-transfer goods-out notes over the ranking window (180 days). Everything
 * else — style parsing, the 16-size model, run math, warehouse eligibility (DC size counts
 * only if >2 units), the PO-within-14-days flag, the top-10 / bottom-10 role split — is
 * unchanged from the tool Jayson has been running.
 *
 * `s30` is the historical column name from the tool; here it carries SALES_WINDOW_DAYS
 * (180d) units, which is the ranking signal. The 30-day dead signal is a separate query
 * (Q_DEAD30) used only by the force-empty pass.
 *
 * Tables live in loyal-manifest-415122.loyal_manifest_brightpearl_live (+ Retool for the
 * threshold mirror). Kept fully-qualified, exactly as the live tool references them.
 */

// prod + ps + psale + msrp + fr  (verbatim from Q_CAND, lines 267–271 of the tool)
const _CAND_HEAD = `
WITH prod AS (SELECT product_id, sku, CASE WHEN STARTS_WITH(sku,'SL-BLAZER') THEN 'Blazer' ELSE 'Pant' END garment, SAFE_CAST(REGEXP_EXTRACT(sku, r'-([0-9]+)[A-Z]*$') AS INT64) size_num, SAFE_CAST(pricelist_usa_retail AS FLOAT64) retail, TRIM(REGEXP_REPLACE(REGEXP_REPLACE(productname, r'\\s*-\\s*[0-9]+[A-Za-z ]*$',''), r'^Athletic Fit Stretch (Blazer|Suit Pants)\\s*-\\s*','')) style FROM \`loyal-manifest-415122.loyal_manifest_brightpearl_live.products\` WHERE status='LIVE' AND NOT ENDS_WITH(sku,'-C') AND (productname LIKE 'Athletic Fit Stretch Blazer - %' OR productname LIKE 'Athletic Fit Stretch Suit Pants - %') AND NOT LOWER(productname) LIKE '%short%'),
ps AS (SELECT *, IF(garment='Blazer', size_num, size_num+8) set_size FROM prod WHERE size_num IS NOT NULL AND ((garment='Blazer' AND size_num IN (36,38,40,42,44,46,48)) OR (garment='Pant' AND size_num IN (29,30,31,32,33,34,36,38,40)))),
psale AS (SELECT product_id, TRIM(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(productname, r'\\s*-\\s*[0-9]+[A-Za-z ]*$',''), r'\\s*-\\s*Short\\s*$',''), r'^Athletic Fit Stretch (Blazer|Suit Pants)\\s*-\\s*','')) style FROM \`loyal-manifest-415122.loyal_manifest_brightpearl_live.products\` WHERE status='LIVE' AND NOT ENDS_WITH(sku,'-C') AND (productname LIKE 'Athletic Fit Stretch Blazer - %' OR productname LIKE 'Athletic Fit Stretch Suit Pants - %')),
msrp AS (SELECT style, COALESCE(MAX(IF(garment='Blazer',retail,NULL)),0) blz_msrp, COALESCE(MAX(IF(garment='Pant',retail,NULL)),0) pnt_msrp, MAX(IF(garment='Blazer',retail,NULL))+COALESCE(MAX(IF(garment='Pant',retail,NULL)),0) suit_msrp FROM ps GROUP BY style),
fr AS (SELECT style, COUNT(DISTINCT CONCAT(garment,CAST(size_num AS STRING))) full_run, COUNT(DISTINCT IF(garment='Blazer',size_num,NULL)) blz_full, COUNT(DISTINCT IF(garment='Pant',size_num,NULL)) pnt_full FROM ps GROUP BY 1),`;

// REPLACEMENT for the tool's injected sales UNNEST — real 180d mirror sales.
function _salesCte_(windowDays) {
  return `
sales AS (
  SELECT CAST(n.warehouseid AS STRING) wid, p.style, SUM(r.quantity) s30
  FROM \`loyal-manifest-415122.loyal_manifest_brightpearl_live.bp_goods_out_note\` n
  JOIN \`loyal-manifest-415122.loyal_manifest_brightpearl_live.bp_goods_out_orderrow\` r ON r.goodsnoteoutid=n.goodsnoteoutid
  JOIN psale p ON p.product_id=r.productid
  WHERE n.transfer=FALSE AND n.status_shipped=TRUE
    AND DATE(n.status_shippedon) >= DATE_SUB(CURRENT_DATE(), INTERVAL ${windowDays} DAY)
  GROUP BY 1,2
),`;
}

// av .. cand .. final SELECT  (verbatim from Q_CAND, lines 273–299 of the tool)
const _CAND_TAIL = `
av AS (SELECT CAST(a.warehouse AS STRING) wid, p.style, p.garment, p.size_num, p.set_size, SUM(a.availability_onhand) oh, SUM(SAFE_CAST(a.intransit AS INT64)) it FROM \`loyal-manifest-415122.loyal_manifest_brightpearl_live.availability\` a JOIN ps p ON p.product_id=a.product_id WHERE a.warehouse NOT IN ('2','16','17','21','29','37','42','43','44','49') GROUP BY 1,2,3,4,5 HAVING SUM(a.availability_onhand)>0 OR SUM(SAFE_CAST(a.intransit AS INT64))>0),
agg AS (SELECT wid, style, SUM(oh) units, COUNT(DISTINCT IF(oh>0,CONCAT(garment,CAST(size_num AS STRING)),NULL)) sizes_oh, COUNT(DISTINCT CONCAT(garment,CAST(size_num AS STRING))) sizes_eff, SUM(IF(garment='Blazer',oh,0)) blz, SUM(IF(garment='Pant',oh,0)) pnt, COUNT(DISTINCT IF(garment='Blazer',CAST(size_num AS STRING),NULL)) blz_eff, COUNT(DISTINCT IF(garment='Pant',CAST(size_num AS STRING),NULL)) pnt_eff FROM av GROUP BY 1,2),
pairs AS (SELECT wid, style, COUNT(*) cp FROM (SELECT wid, style, set_size FROM av WHERE oh>0 GROUP BY 1,2,3 HAVING COUNT(DISTINCT garment)=2) GROUP BY 1,2),
base AS (SELECT COALESCE(ag.wid,sa.wid) wid, COALESCE(ag.style,sa.style) style, COALESCE(sa.s30,0) sold, COALESCE(ag.units,0) units, COALESCE(ag.sizes_oh,0) sizes_oh, COALESCE(ag.sizes_eff,0) sizes_eff, COALESCE(ag.blz,0) blz, COALESCE(ag.pnt,0) pnt, COALESCE(ag.blz_eff,0) blz_eff, COALESCE(ag.pnt_eff,0) pnt_eff, COALESCE(pr.cp,0) cp FROM agg ag FULL JOIN sales sa ON sa.wid=ag.wid AND sa.style=ag.style LEFT JOIN pairs pr ON pr.wid=COALESCE(ag.wid,sa.wid) AND pr.style=COALESCE(ag.style,sa.style)),
ranked AS (SELECT b.*, f.full_run, ROUND(b.sizes_oh/f.full_run,2) run_oh, ROUND(b.sizes_eff/f.full_run,2) run_eff, ROUND(b.blz_eff/NULLIF(f.blz_full,0),2) blz_run, ROUND(b.pnt_eff/NULLIF(f.pnt_full,0),2) pnt_run, ROW_NUMBER() OVER(PARTITION BY b.style ORDER BY b.sold DESC, b.wid) top_rank, ROW_NUMBER() OVER(PARTITION BY b.style ORDER BY IF(b.units>0,0,1), b.sold ASC, b.wid) bot_rank FROM base b JOIN fr f ON f.style=b.style),
ssoh AS (SELECT wid, style, ARRAY_AGG(CONCAT(garment,'|',CAST(size_num AS STRING))) toks FROM av WHERE oh>0 GROUP BY 1,2),
sseff AS (SELECT wid, style, ARRAY_AGG(CONCAT(garment,'|',CAST(size_num AS STRING))) toks FROM av GROUP BY 1,2),
thr AS (SELECT CAST(w2.warehouseid AS STRING) wid, pp.style FROM \`loyal-manifest-415122.Retool.SCMProject_Threshold_New\` t JOIN prod pp ON pp.sku=t.sku JOIN \`loyal-manifest-415122.loyal_manifest_brightpearl_live.bpwarehouse\` w2 ON w2.name=t.warehouse_name WHERE SAFE_CAST(t.reorder_level AS INT64)>=1 GROUP BY 1,2),
whs AS (SELECT p.style, SUM(a.availability_onhand) wh_oh FROM \`loyal-manifest-415122.loyal_manifest_brightpearl_live.availability\` a JOIN ps p ON p.product_id=a.product_id WHERE a.warehouse='2' GROUP BY 1),
whsz AS (SELECT p.style, COUNT(DISTINCT CONCAT(p.garment,CAST(p.size_num AS STRING))) wh_avail, COUNT(DISTINCT IF(p.garment='Blazer',p.size_num,NULL)) wh_blz, COUNT(DISTINCT IF(p.garment='Pant',p.size_num,NULL)) wh_pnt FROM \`loyal-manifest-415122.loyal_manifest_brightpearl_live.availability\` a JOIN ps p ON p.product_id=a.product_id WHERE a.warehouse='2' AND a.availability_onhand>2 GROUP BY 1),
whpo AS (SELECT p.style, SUM(SAFE_CAST(pp.rows_quantity AS FLOAT64)) po_qty, MIN(DATE(pp.delivery_date)) po_eta FROM \`loyal-manifest-415122.loyal_manifest_brightpearl_live.bp_po\` pp JOIN ps p ON p.product_id=pp.rows_productid WHERE DATE(pp.delivery_date)>=CURRENT_DATE() AND UPPER(COALESCE(pp.ref,'')) NOT LIKE '%TOPS%' GROUP BY 1),
cand AS (
  SELECT 'recip' role, r0.wid, r0.style, r0.sold, r0.run_eff run, r0.run_oh, r0.full_run, r0.units, r0.blz, r0.pnt, r0.cp, IF(EXISTS(SELECT 1 FROM thr WHERE thr.wid=r0.wid AND thr.style=r0.style),1,0) has_thr, r0.top_rank srank, (COALESCE(r0.blz_run,1)<0.5 OR COALESCE(r0.pnt_run,1)<0.5) felig, ROW_NUMBER() OVER(PARTITION BY r0.style ORDER BY r0.sold DESC, r0.wid) rk FROM ranked r0 WHERE r0.top_rank<=10 AND r0.sold>=1
  UNION ALL
  SELECT 'donor' role, wid, style, sold, run_oh run, run_oh, full_run, units, blz, pnt, cp, 0 has_thr, top_rank srank, false felig, ROW_NUMBER() OVER(PARTITION BY style ORDER BY run_oh DESC, sold ASC, wid) rk FROM ranked WHERE bot_rank<=10 AND units>0
)
SELECT c.role, CAST(c.wid AS STRING) wid, w.name, c.style, c.sold, c.run, c.run_oh, c.full_run, c.units, c.blz, c.pnt, c.cp, c.has_thr, c.srank, c.rk, c.felig, CAST(ROUND(c.blz*m.blz_msrp + c.pnt*m.pnt_msrp) AS INT64) esi, CAST(m.blz_msrp AS INT64) blz_msrp, CAST(m.pnt_msrp AS INT64) pnt_msrp, IF(c.role='recip', se.toks, so.toks) toks, COALESCE(whs.wh_oh,0) wh_oh, COALESCE(whsz.wh_avail,0) wh_avail, COALESCE(whsz.wh_blz,0) wh_blz, COALESCE(whsz.wh_pnt,0) wh_pnt, COALESCE(ff.blz_full,0) blz_full, COALESCE(ff.pnt_full,0) pnt_full, CAST(COALESCE(whpo.po_qty,0) AS INT64) wh_po, whpo.po_eta, (whpo.po_eta IS NOT NULL AND whpo.po_eta <= DATE_ADD(CURRENT_DATE(), INTERVAL 14 DAY)) po_within14
FROM cand c
JOIN \`loyal-manifest-415122.loyal_manifest_brightpearl_live.bpwarehouse\` w ON CAST(w.warehouseid AS STRING)=c.wid
LEFT JOIN msrp m ON m.style=c.style
LEFT JOIN fr ff ON ff.style=c.style
LEFT JOIN ssoh so ON so.wid=c.wid AND so.style=c.style
LEFT JOIN sseff se ON se.wid=c.wid AND se.style=c.style
LEFT JOIN whs ON whs.style=c.style
LEFT JOIN whsz ON whsz.style=c.style
LEFT JOIN whpo ON whpo.style=c.style
ORDER BY c.style, c.role, c.rk`;

/** Full candidate query (recipient + donor rows, one per style/store) for the engine. */
function buildCandidateQuery(windowDays) {
  return _CAND_HEAD + _salesCte_(windowDays || ENGINE.SALES_WINDOW_DAYS) + _CAND_TAIL;
}

/** 30-day dead signal: units per (wid, style) shipped in-store in the last 30 days. */
function buildDead30Query(windowDays) {
  var d = windowDays || ENGINE.DEAD_WINDOW_DAYS;
  return `
WITH psale AS (SELECT product_id, TRIM(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(productname, r'\\s*-\\s*[0-9]+[A-Za-z ]*$',''), r'\\s*-\\s*Short\\s*$',''), r'^Athletic Fit Stretch (Blazer|Suit Pants)\\s*-\\s*','')) style FROM \`loyal-manifest-415122.loyal_manifest_brightpearl_live.products\` WHERE status='LIVE' AND NOT ENDS_WITH(sku,'-C') AND (productname LIKE 'Athletic Fit Stretch Blazer - %' OR productname LIKE 'Athletic Fit Stretch Suit Pants - %'))
SELECT CAST(n.warehouseid AS STRING) wid, p.style, SUM(r.quantity) units
FROM \`loyal-manifest-415122.loyal_manifest_brightpearl_live.bp_goods_out_note\` n
JOIN \`loyal-manifest-415122.loyal_manifest_brightpearl_live.bp_goods_out_orderrow\` r ON r.goodsnoteoutid=n.goodsnoteoutid
JOIN psale p ON p.product_id=r.productid
WHERE n.transfer=FALSE AND n.status_shipped=TRUE
  AND DATE(n.status_shippedon) >= DATE_SUB(CURRENT_DATE(), INTERVAL ${d} DAY)
GROUP BY 1,2`;
}

/**
 * Product map for a set of styles — product_id, sku, garment, size for every in-scope
 * size. Used at approval time to turn "donor ships everything it holds of this style"
 * into concrete SKU/productId pull lists (then confirmed against LIVE availability).
 * __STYLES__ is replaced with a comma-separated list of quoted style names.
 */
function buildStyleProductsQuery(styleList) {
  var quoted = (styleList || []).map(function (s) { return "'" + String(s).replace(/'/g, "\\'") + "'"; }).join(',');
  return `
WITH prod AS (SELECT product_id, sku, CASE WHEN STARTS_WITH(sku,'SL-BLAZER') THEN 'Blazer' ELSE 'Pant' END garment, SAFE_CAST(REGEXP_EXTRACT(sku, r'-([0-9]+)[A-Z]*$') AS INT64) size_num, TRIM(REGEXP_REPLACE(REGEXP_REPLACE(productname, r'\\s*-\\s*[0-9]+[A-Za-z ]*$',''), r'^Athletic Fit Stretch (Blazer|Suit Pants)\\s*-\\s*','')) style FROM \`loyal-manifest-415122.loyal_manifest_brightpearl_live.products\` WHERE status='LIVE' AND NOT ENDS_WITH(sku,'-C') AND (productname LIKE 'Athletic Fit Stretch Blazer - %' OR productname LIKE 'Athletic Fit Stretch Suit Pants - %') AND NOT LOWER(productname) LIKE '%short%')
SELECT CAST(product_id AS STRING) product_id, sku, garment, size_num, style FROM prod
WHERE size_num IS NOT NULL AND style IN (${quoted})
  AND ((garment='Blazer' AND size_num IN (36,38,40,42,44,46,48)) OR (garment='Pant' AND size_num IN (29,30,31,32,33,34,36,38,40)))`;
}
