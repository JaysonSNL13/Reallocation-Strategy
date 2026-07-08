/**
 * Engine.gs — the reallocation logic (spec Part A). Faithful port of the live tool's
 * matchSuits() + moveGap()/movePriority(). This is the part Jayson asked us to keep exact.
 *
 * Per style:
 *   recipients = top-10 sellers (sold>=1) whose run is broken (felig: <50% blazer OR pant)
 *   donors     = bottom-10 sellers holding stock, sorted DEADEST first
 *
 * For each eligible recipient (deadest-first donor matching):
 *   - skip if the DC covers >=50% of BOTH blazer AND pant sizes (it can replenish itself)
 *   - skip if a PO for the style lands within 14 days
 *   - pull from up to 3 donors, each must add >=1 new size, aiming for >=50% of both garments
 *   - POST-TRANSFER GATE: recipient must end with >=50% blazer AND >=50% pant sizes, else drop
 *   - REDUNDANCY TRIM: drop any donor not needed to clear the 50/50 bar (least-dead first)
 *
 * Force-empty pass (proven sellers only): push a fully-dead store (0 sales/30d) up to a top
 * seller that gains >=2 brand-new sizes and still clears the 50/50 gate.
 *
 * Ranking (spec): regular transfers by RANK GAP (deadest donor's sales rank − recipient's
 * sales rank; bigger = more valuable). Force-empties grouped after, most-broken recipient
 * run first, then gap. The tool's old ESI dollar sort is NOT used for ordering.
 */

/** Full engine run. Returns an ordered array of move objects (highest value first). */
function runEngine_(cands, alive30) {
  var moves = matchSuits_(cands, alive30);
  moves.forEach(function (m) {
    m.rank_gap = moveGap_(m);
    m.priority = movePriority_(m);
  });
  moves.sort(function (a, b) { return b.priority - a.priority; });
  return moves;
}

/** Rank gap = (deadest donor's sales rank) − (recipient's sales rank). */
function moveGap_(x) {
  var dr = 0;
  (x.donors || []).forEach(function (d) { var rr = num_(d.rank); if (rr > dr) dr = rr; });
  return dr - num_(x.recip_rank);
}

/** Priority key: regulars 1000+gap (kept above force-empties); force = brokenness then gap. */
function movePriority_(x) {
  var g = moveGap_(x);
  if (!x.force) return 1000 + g;
  var broken = 1 - num_(x.recip_run);
  return broken * 100 + g * 0.1;
}

function isDead30_(wid, style, alive30) { return !alive30[String(wid) + '|' + style]; }

function matchSuits_(cands, alive30) {
  var byStyle = {};
  (cands || []).forEach(function (c) {
    var st = c.style;
    if (!byStyle[st]) byStyle[st] = { recips: [], dons: [] };
    var toks = Array.isArray(c.toks) ? c.toks.map(String) : [];
    var o = {
      wid: String(c.wid), name: c.name, style: st, sold: num_(c.sold), run: num_(c.run),
      full: num_(c.full_run), units: num_(c.units), blz: num_(c.blz), pnt: num_(c.pnt),
      cp: num_(c.cp), esi: num_(c.esi), has_thr: (num_(c.has_thr) === 1), rank: num_(c.srank),
      felig: toBool_(c.felig), toks: toks, wh_oh: num_(c.wh_oh), wh_avail: num_(c.wh_avail),
      wh_blz: num_(c.wh_blz), wh_pnt: num_(c.wh_pnt), blz_full: num_(c.blz_full),
      pnt_full: num_(c.pnt_full), wh_po: num_(c.wh_po), wh_eta: c.po_eta || null,
      wh_soon: toBool_(c.po_within14), blz_msrp: num_(c.blz_msrp), pnt_msrp: num_(c.pnt_msrp)
    };
    if (c.role === 'recip') byStyle[st].recips.push(o); else byStyle[st].dons.push(o);
  });

  var moves = [];

  Object.keys(byStyle).forEach(function (st) {
    var recips = byStyle[st].recips, dons = byStyle[st].dons;
    recips.sort(function (a, b) { return (b.sold - a.sold) || (a.wid < b.wid ? -1 : 1); });
    dons.sort(function (a, b) { return (a.sold - b.sold) || (b.run - a.run) || (a.wid < b.wid ? -1 : 1); });

    var used = dons.map(function () { return false; });
    var mainServed = {};
    var mrecips = recips.filter(function (r) { return r.felig; });

    mrecips.forEach(function (r) {
      // WH covers >=50% of BOTH garments -> it can replenish -> not a store-transfer candidate.
      if ((r.wh_blz >= r.blz_full * 0.5) && (r.wh_pnt >= r.pnt_full * 0.5)) return;
      if (r.wh_soon) return; // PO due at the DC within 14 days

      var full = r.full || 1;
      var bf = num_(r.blz_full), pf = num_(r.pnt_full);
      var grun = function (hv) {
        var b = 0, p = 0;
        Object.keys(hv).forEach(function (t) { if (t.charAt(0) === 'B') b++; else p++; });
        return { b: (bf > 0 ? b / bf : 1), p: (pf > 0 ? p / pf : 1) };
      };

      var hv = {}; r.toks.forEach(function (t) { hv[t] = 1; });

      // Deadest-first: pull from up to 3 donors adding new sizes, aiming for >=50% both garments.
      var picks = [], pickIdx = [];
      for (var i = 0; i < dons.length && picks.length < ENGINE.MAX_DONORS; i++) {
        if (used[i]) continue;
        var add = 0;
        dons[i].toks.forEach(function (t) { if (!hv[t]) add++; });
        if (add >= 1) {
          picks.push(dons[i]); pickIdx.push(i);
          dons[i].toks.forEach(function (t) { hv[t] = 1; });
          var g = grun(hv);
          if (g.b >= ENGINE.RUN_TARGET && g.p >= ENGINE.RUN_TARGET) break;
        }
      }

      var fin = grun(hv);
      // Post-transfer gate.
      if (!picks.length || fin.b < ENGINE.RUN_TARGET || fin.p < ENGINE.RUN_TARGET) return;

      // Redundancy trim (remove least-dead redundant donor first; keep deadest essential).
      var k = picks.length - 1;
      while (k >= 0) {
        var test = {}; r.toks.forEach(function (t) { test[t] = 1; });
        picks.forEach(function (p, m) { if (m !== k) p.toks.forEach(function (t) { test[t] = 1; }); });
        var gt = grun(test);
        if (gt.b >= ENGINE.RUN_TARGET && gt.p >= ENGINE.RUN_TARGET) { picks.splice(k, 1); pickIdx.splice(k, 1); }
        k--;
      }

      hv = {}; r.toks.forEach(function (t) { hv[t] = 1; });
      picks.forEach(function (p) { p.toks.forEach(function (t) { hv[t] = 1; }); });
      var run = Object.keys(hv).length / full;
      pickIdx.forEach(function (ix) { used[ix] = true; });

      // ESI (legacy display only): retail of BRAND-NEW sizes the recipient gains.
      var blzP = num_(r.blz_msrp), pntP = num_(r.pnt_msrp), cov = {};
      r.toks.forEach(function (t) { cov[t] = 1; });
      picks.forEach(function (p) {
        var e = 0;
        p.toks.forEach(function (t) { if (!cov[t]) { cov[t] = 1; e += (t.charAt(0) === 'B' ? blzP : pntP); } });
        p._esi = e;
      });

      var donors = picks.map(function (d) {
        return { wid: d.wid, name: d.name, sold: d.sold, rank: d.rank, units: d.units, blz: d.blz, pnt: d.pnt, run: d.run, esi: d._esi || 0 };
      });
      var uTot = 0, eTot = 0;
      donors.forEach(function (d) { uTot += d.units; eTot += d.esi; });

      mainServed[r.wid] = true;
      moves.push({
        style: st, recipient: r.name, recip_wid: r.wid, recip_sold: r.sold, recip_rank: r.rank,
        recip_run: r.run, full_run: r.full, has_thr: r.has_thr, recip_final: Math.round(run * 100) / 100,
        donors: donors, units: uTot, esi: eTot, partners: donors.map(function (d) { return d.wid; }),
        force: false, wh_oh: r.wh_oh, wh_po: r.wh_po, wh_eta: r.wh_eta, wh_fill: (r.wh_oh > 0 || r.wh_po > 0)
      });
    });

    // ---- Force-empty pass ---------------------------------------------------
    var topSold = 0; recips.forEach(function (r) { if (r.sold > topSold) topSold = r.sold; });
    var _s0 = recips[0];
    var whElig = !!_s0 && ((_s0.wh_blz < _s0.blz_full * 0.5) || (_s0.wh_pnt < _s0.pnt_full * 0.5)) && !_s0.wh_soon;

    if (topSold >= ENGINE.FORCE_EMPTY_TOP_SOLD_MIN && whElig) {
      var rsort = recips.slice().sort(function (a, b) { return (b.sold - a.sold) || (a.wid < b.wid ? -1 : 1); });
      var fserved = {};
      for (var di = 0; di < dons.length; di++) {
        if (used[di] || !isDead30_(dons[di].wid, st, alive30)) continue;
        var dd = dons[di], chosen = null;
        for (var ri = 0; ri < rsort.length; ri++) {
          var fr = rsort[ri];
          if (fserved[fr.wid] || mainServed[fr.wid]) continue;
          var hh = {}; fr.toks.forEach(function (t) { hh[t] = 1; });
          var nw = 0; dd.toks.forEach(function (t) { if (!hh[t]) nw++; });
          if (nw >= ENGINE.FORCE_EMPTY_MIN_NEW_SIZES) {
            var tt = {}; fr.toks.forEach(function (t) { tt[t] = 1; }); dd.toks.forEach(function (t) { tt[t] = 1; });
            var tb = 0, tp = 0; Object.keys(tt).forEach(function (t) { if (t.charAt(0) === 'B') tb++; else tp++; });
            var _bf = num_(fr.blz_full), _pf = num_(fr.pnt_full);
            if ((_bf > 0 ? tb / _bf : 1) >= ENGINE.RUN_TARGET && (_pf > 0 ? tp / _pf : 1) >= ENGINE.RUN_TARGET) { chosen = fr; break; }
          }
        }
        if (!chosen) continue;
        used[di] = true; fserved[chosen.wid] = true;
        var hv2 = {}; chosen.toks.forEach(function (t) { hv2[t] = 1; });
        var bP = num_(chosen.blz_msrp), pP = num_(chosen.pnt_msrp), fe = 0;
        dd.toks.forEach(function (t) { if (!hv2[t]) { hv2[t] = 1; fe += (t.charAt(0) === 'B' ? bP : pP); } });
        var frun = Object.keys(hv2).length / (chosen.full || 1);
        var fdonors = [{ wid: dd.wid, name: dd.name, sold: dd.sold, rank: dd.rank, units: dd.units, blz: dd.blz, pnt: dd.pnt, run: dd.run, esi: fe }];
        moves.push({
          style: st, recipient: chosen.name, recip_wid: chosen.wid, recip_sold: chosen.sold, recip_rank: chosen.rank,
          recip_run: chosen.run, full_run: chosen.full, has_thr: chosen.has_thr, recip_final: Math.round(frun * 100) / 100,
          donors: fdonors, units: dd.units, esi: fe, partners: [dd.wid], force: true,
          wh_oh: chosen.wh_oh, wh_po: chosen.wh_po, wh_eta: chosen.wh_eta, wh_fill: false
        });
      }
    }
  });

  return moves;
}
