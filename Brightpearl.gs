/**
 * Brightpearl.gs — thin Brightpearl REST client.
 *
 * Mirrors the purge tool's client: two-call stock transfer (create + external-transfer)
 * and the guarded reorderLevel-0 write. Every write is gated by writesEnabled_() so the
 * whole engine runs read-only until Jayson flips BP_WRITES_ENABLED = true.
 *
 * Rate limits: Brightpearl throttles hard. We keep it sequential with a small delay and
 * retry on 429/503 with backoff.
 */

var BP = (function () {

  function baseUrl_() { return requireProp_(PROP.BP_BASE_URL).replace(/\/+$/, ''); }

  function headers_() {
    return {
      'brightpearl-app-ref': requireProp_(PROP.BP_APP_REF),
      'brightpearl-account-token': requireProp_(PROP.BP_ACCOUNT_TOKEN),
      'Content-Type': 'application/json'
    };
  }

  var MIN_GAP_MS = 350;          // ~3 req/s
  var _lastCallAt = 0;

  function throttle_() {
    var now = Date.now();
    var wait = MIN_GAP_MS - (now - _lastCallAt);
    if (wait > 0) Utilities.sleep(wait);
    _lastCallAt = Date.now();
  }

  /** Core request with retry. `method` GET/POST/PUT. Returns parsed JSON (or {} on 204). */
  function request_(method, path, body, opts) {
    opts = opts || {};
    var url = /^https?:/.test(path) ? path : baseUrl_() + path;
    var params = {
      method: method,
      headers: headers_(),
      muteHttpExceptions: true,
      contentType: 'application/json'
    };
    if (body !== undefined && body !== null) params.payload = JSON.stringify(body);

    var maxAttempts = 5;
    for (var attempt = 1; attempt <= maxAttempts; attempt++) {
      throttle_();
      var res = UrlFetchApp.fetch(url, params);
      var code = res.getResponseCode();
      var text = res.getContentText();

      if (code === 429 || code === 503) {
        var backoff = Math.min(8000, 500 * Math.pow(2, attempt));
        Log.warn('Brightpearl ' + code + ' on ' + method + ' ' + path + ' — retry ' + attempt + ' in ' + backoff + 'ms');
        Utilities.sleep(backoff);
        continue;
      }
      if (code >= 200 && code < 300) {
        if (!text) return {};
        try { return JSON.parse(text); } catch (e) { return {}; }
      }
      throw new Error('Brightpearl ' + method + ' ' + path + ' -> ' + code + ' ' + text);
    }
    throw new Error('Brightpearl ' + method + ' ' + path + ' failed after ' + maxAttempts + ' attempts (rate limited).');
  }

  // ---- Reads ---------------------------------------------------------------

  /**
   * Live availability for a set of productIds.
   * Returns { productId: { warehouseId: {onHand, allocated, inTransit, inStock, available} } }.
   * available = max(onHand - allocated, 0).
   */
  function getAvailability(productIds) {
    var ids = dedupeSortNumeric_(productIds);
    var out = {};
    var CHUNK = 100; // keep URLs sane
    for (var i = 0; i < ids.length; i += CHUNK) {
      var slice = ids.slice(i, i + CHUNK);
      var json = request_('GET', '/warehouse-service/product-availability/' + slice.join(','));
      var resp = (json && json.response) || {};
      Object.keys(resp).forEach(function (pid) {
        var whs = (resp[pid] && resp[pid].warehouses) || {};
        var m = {};
        Object.keys(whs).forEach(function (wid) {
          var w = whs[wid] || {};
          var onHand = Number(w.onHand || 0);
          var allocated = Number(w.allocated || 0);
          m[String(wid)] = {
            onHand: onHand,
            allocated: allocated,
            inTransit: Number(w.inTransit || 0),
            inStock: Number(w.inStock || 0),
            available: Math.max(onHand - allocated, 0)
          };
        });
        out[String(pid)] = m;
      });
    }
    return out;
  }

  function getProduct(productId) {
    var json = request_('GET', '/product-service/product/' + productId);
    var r = (json.response && json.response[0]) || null;
    return r;
  }

  function getProductGroup(groupId) {
    var json = request_('GET', '/product-service/product-group/' + groupId);
    return (json.response && json.response[0]) || null;
  }

  /** Current warehouse-product record (has reorderLevel, reorderQuantity, ...). */
  function getWarehouseProduct(warehouseId, productId) {
    var json = request_('GET', '/warehouse-service/warehouse/' + warehouseId + '/product/' + productId);
    return (json.response) || null;
  }

  function getStockTransfer(id) {
    var json = request_('GET', '/warehouse-service/stock-transfer/' + id);
    return (json.response) || null;
  }

  /**
   * Unified movement feed for shipped vs received. typed 'GO' (goods-out) / 'GI' (goods-in).
   * Returns raw response.results with the accompanying metadata.columns for mapping.
   */
  function goodsMovementSearch(query) {
    var qs = Object.keys(query || {}).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(query[k]);
    }).join('&');
    return request_('GET', '/warehouse-service/goods-movement-search' + (qs ? '?' + qs : ''));
  }

  // ---- Writes (guarded) ----------------------------------------------------

  /**
   * Create a store-to-store stock transfer. Same two POSTs the purge tool does, but the
   * target is a seller store instead of the DC.
   *   1) create the transfer shell (carries the PURGE-PRIORITY reference)
   *   2) attach the transferred products (returns goods-out note ids)
   * Returns { stockTransferId, goodsOutNoteIds, dryRun }.
   */
  function createStockTransfer(donorWarehouseId, targetWarehouseId, reference, transferredProducts) {
    if (!transferredProducts || !transferredProducts.length) {
      throw new Error('createStockTransfer: no transferredProducts for ' + donorWarehouseId + '->' + targetWarehouseId);
    }
    if (!writesEnabled_()) {
      Log.info('[DRY RUN] would create transfer ' + donorWarehouseId + '->' + targetWarehouseId +
        ' ref="' + reference + '" items=' + transferredProducts.length);
      return { stockTransferId: null, goodsOutNoteIds: [], dryRun: true };
    }
    var createBody = { targetWarehouseId: Number(targetWarehouseId), reference: reference };
    var created = request_('POST', '/warehouse-service/warehouse/' + donorWarehouseId + '/stock-transfer', createBody);
    var stockTransferId = created && created.response;

    var extBody = {
      targetWarehouseId: Number(targetWarehouseId),
      stockTransferId: Number(stockTransferId),
      transferredProducts: transferredProducts.map(function (p) {
        return { productId: Number(p.productId), quantity: Number(p.quantity) };
      })
    };
    var ext = request_('POST', '/warehouse-service/warehouse/' + donorWarehouseId + '/external-transfer', extBody);
    var goodsOutNoteIds = normalizeIds_(ext && ext.response);
    return { stockTransferId: stockTransferId, goodsOutNoteIds: goodsOutNoteIds, dryRun: false };
  }

  /**
   * Zero a dead store's reorderLevel for a product so it won't be topped back up.
   * Reads the current record first so reorderQuantity is preserved.
   */
  function zeroReorderLevel(warehouseId, productId) {
    var current = null;
    try { current = getWarehouseProduct(warehouseId, productId); } catch (e) { /* fall through */ }
    var keepQty = (current && current.reorderQuantity != null) ? Number(current.reorderQuantity) : 0;
    var priorLevel = (current && current.reorderLevel != null) ? Number(current.reorderLevel) : null;

    if (!writesEnabled_()) {
      Log.info('[DRY RUN] would set reorderLevel=0 (was ' + priorLevel + ', keep qty ' + keepQty +
        ') for wh ' + warehouseId + ' product ' + productId);
      return { dryRun: true, priorLevel: priorLevel };
    }
    request_('PUT', '/warehouse-service/warehouse/' + warehouseId + '/product/' + productId,
      { reorderLevel: 0, reorderQuantity: keepQty });
    return { dryRun: false, priorLevel: priorLevel };
  }

  // ---- utils ---------------------------------------------------------------

  function dedupeSortNumeric_(ids) {
    var set = {};
    (ids || []).forEach(function (x) { if (x !== null && x !== undefined && x !== '') set[String(x)] = true; });
    return Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
  }

  function normalizeIds_(resp) {
    if (resp == null) return [];
    if (Array.isArray(resp)) return resp;
    if (typeof resp === 'object') return Object.keys(resp).map(function (k) { return resp[k]; });
    return [resp];
  }

  return {
    getAvailability: getAvailability,
    getProduct: getProduct,
    getProductGroup: getProductGroup,
    getWarehouseProduct: getWarehouseProduct,
    getStockTransfer: getStockTransfer,
    goodsMovementSearch: goodsMovementSearch,
    createStockTransfer: createStockTransfer,
    zeroReorderLevel: zeroReorderLevel
  };
})();
