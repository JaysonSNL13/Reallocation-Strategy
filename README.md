# Suit Reallocation Engine

Store-to-store suit reallocation for State & Liberty, rebuilt on live data as a repeatable **weekly, one-approval** engine.

It finds dead suit inventory sitting in stores that aren't selling it and moves it **directly, store-to-store, through Brightpearl** into stores that are selling it and stocked out — no DC round-trip, not OneBeat. Jayson is the single approval gate: nothing writes to Brightpearl until he ticks a row.

## How it runs, end to end

1. **Weekly pull + engine (read-only).** A timed trigger reads inventory, 180-day + 30-day sales, thresholds, and the store↔warehouse / product↔style maps — from the **Store Dashboard workbook** by default (`SourceSheet.gs`), or the BigQuery mirror — runs the engine, and writes a ranked list of proposed transfers to the **Proposed Transfers** tab.
2. **Review + approve.** Jayson ticks the **Approve** checkbox on the rows he wants. That's the only gate.
3. **Execute (on approval).** For each approved donor→recipient transfer the engine:
   - reads **live** Brightpearl availability (never ships stock that just sold),
   - creates the Brightpearl **store-to-store transfer**, tagged `PURGE-PRIORITY`,
   - **emails the donor store** its exact pull list,
   - **zeros the donor's `reorderLevel`** for those SKUs so the stock doesn't flow right back.
4. **Track (48h loop).** A tracker trigger watches each transfer; if a store hasn't purged within 48h it re-nudges them, and the **Receiving Priority** tab hands Receiving the `PURGE-PRIORITY` numbers to expedite.

## The engine (spec Part A — kept faithful)

- **Eligibility:** only styles where the **Ann Arbor DC (wh 2) is stocked out** — holds <50% of blazer **or** pant sizes (a size counts only if **>2 units**) — **and** no PO landing **within 14 days**.
- **Recipient:** a **top-10 seller** of the style (sold ≥1) that's missing **>50% of blazer or pant sizes**.
- **Donor:** from the **bottom-10 sellers**, **deadest first**, each adding ≥1 new size, **max 3** per recipient; ships everything it holds.
- **Post-transfer guardrail:** the recipient must end with **≥50% blazer AND ≥50% pant sizes**, else the move is dropped.
- **Redundancy trim:** drop any donor not needed to clear 50/50 (least-dead first).
- **Force-empty:** for proven sellers (top store ≥20 units/180d), push a fully dead store (0 sales/30d) to a top seller that gains ≥2 brand-new sizes and still clears 50/50.
- **Ranking:** **rank gap** = (deadest donor's sales rank − recipient's sales rank); bigger = higher value. Force-empties grouped after, most-broken run first. *(The old ESI dollar figure is deprecated and not used for ordering.)*

The logic in `Engine.gs` is a line-for-line port of the live tool's `matchSuits` + `moveGap`/`movePriority`. The BigQuery input query in `Queries.gs` is the tool's `Q_CAND` verbatim, with the single change that hand-injected sales are replaced by a real 180-day mirror sales CTE (see `DEPLOY.md`).

## Files

| File | Role |
|---|---|
| `Config.gs` | Tunables, warehouse exclusions, size model, Script-Property keys, write kill-switch |
| `Brightpearl.gs` | Brightpearl REST client (availability, transfers, reorderLevel, status) |
| `SourceSheet.gs` | **Default source** — reads the Store Dashboard workbook tabs, recomputes the engine's candidate fields, joins via LOC ID |
| `Queries.gs` | Verbatim BigQuery SQL (alternative source: candidate query, 30-day dead, style products) |
| `BigQuery.gs` | Runs the queries, returns typed rows (alternative source) |
| `Engine.gs` | The reallocation logic + rank-gap ranking (spec Part A) |
| `Proposals.gs` | Writes the ranked transfer list to the sheet |
| `Approval.gs` | Reads Jayson's per-row approvals |
| `Actions.gs` | On approval: live read → create transfer → zero threshold → email/receiving/tracker |
| `Email.gs` | Per-donor pull-list emails |
| `Tracker.gs` | 48-hour loop, re-nudge, receiving priority |
| `Weekly.gs` | Weekly orchestration (pull → engine → proposals) |
| `Menu.gs` | Spreadsheet menu, setup prompts, trigger install |
| `Util.gs` | Logging + shared helpers |

## Safety

`BP_WRITES_ENABLED` defaults to **off**. In dry run the whole thing works end to end but **creates nothing** in Brightpearl and sends store emails only to your `DRY_RUN_EMAIL` preview address. Flip to live from **Reallocation ▸ Setup ▸ Toggle Brightpearl WRITES** only when you're ready.

See **`DEPLOY.md`** to stand it up and **`SHEET_SCHEMA.md`** for the tab layout.
