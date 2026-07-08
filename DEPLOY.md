# Deploy guide

The engine is Google Apps Script bound to a Google Sheet, hosted in this GitHub repo and
pushed with [clasp](https://github.com/google/clasp). Everything runs in Google's cloud —
there is no server to manage.

## 1. One-time local setup (to push code from this repo)

```bash
npm install                 # installs clasp locally
npx clasp login             # authorize clasp with the Google account that will own the script
```

Create the container Sheet + script, or bind to an existing one:

```bash
# NEW: creates a Sheet and a bound script, prints a scriptId
npx clasp create --type sheets --title "Suit Reallocation" --rootDir .
```

Then copy `.clasp.json.example` to `.clasp.json` and paste the `scriptId` (clasp may have
written `.clasp.json` for you — just confirm `rootDir` is `.` and `fileExtension` is `gs`).
`.clasp.json` is git-ignored because it's machine-local.

Push the code:

```bash
npx clasp push
npx clasp open        # opens the script editor
```

> The repo is set up so `clasp push` uploads `appsscript.json` + every `*.gs` file and
> ignores the docs (see `.claspignore`).

## 2. Data source — the Store Dashboard workbook (default)

The engine reads its ranking input from the **"Store Dashboard for WebApp"** Google Sheet
(the `SourceSheet.gs` adapter). Set it up via **Reallocation ▸ Setup**:

- **Set data source** → choose **sheet** (default).
- **Set source workbook id** → paste the Store Dashboard workbook id.
- **Share the source workbook** with the Google account running the script (Viewer is enough).
- **Describe source workbook** → dumps each tab name + header row to the Run Log, so you can
  confirm the adapter is reading the tabs it expects (LOC ID, ALL SKU, INV, L30, L180,
  Optimal Stock, PO On Order). If any tab/column was renamed, adjust the `SRC` map at the top
  of `SourceSheet.gs`.

The adapter recomputes the same fields the old BigQuery query produced: 180-day sales ranks
(L180), the 30-day dead signal (L30), on-hand + in-transit size runs (INV), DC coverage with
the >2-units rule (INV "Ann Arbor"), the 14-day PO gate (PO On Order), and the no-threshold
flag (Optimal Stock). Joins go through the **LOC ID** tab (all name columns → warehouse id).

### Optional: BigQuery instead

If you'd rather rank off the mirror, set data source to **bigquery**, enable the BigQuery
advanced service (already declared in `appsscript.json`), confirm the linked GCP project can
query `loyal-manifest-415122.loyal_manifest_brightpearl_live`, and set the billing project via
**Set BigQuery billing project**.

## 3. Credentials (Script Properties — never in code)

Open the bound Sheet, then use the **Reallocation ▸ Setup** menu:

- **Set Brightpearl credentials** → base URL, `brightpearl-app-ref`, `brightpearl-account-token`.
  - Prod base: `https://use1.brightpearlconnect.com/public-api/stateandliberty`
  - Sandbox: `…/stateandlibertysandbox` (recommended for first live-write test)
- **Set BigQuery billing project** → your GCP project id.
- **Set Receiving / dry-run emails** → Receiving address + your own address for dry-run previews.
- **Initialize tabs** → creates the tabs and the Store Emails sheet.
- **Install weekly + tracker triggers** → Mon 6am proposal + tracker every 6h.

Token scopes needed: `warehouse-service` (product-availability; create stock-transfer +
external-transfer; read/write `warehouse/{wid}/product/{pid}` reorderLevel; read
stock-transfer + goods-movement), `product-service` (product/{id}), `order-service`
(read, if you later rank off order-search instead of the mirror).

## 4. Store emails

Fill the **Store Emails** tab: `Store name | Warehouse id | Email`. The warehouse id is what
matches; name is a fallback. Donors without an address are logged, not silently skipped.

## 5. Dry run first (default)

`BP_WRITES_ENABLED` starts **off**. Run **Reallocation ▸ 1 ▸ Run weekly proposal**, review the
**Proposed Transfers** tab, tick a couple of rows, and run **2 ▸ Execute approved transfers**.
In dry run it logs exactly what it *would* do and sends pull-list previews to your
`DRY_RUN_EMAIL`. Nothing hits Brightpearl.

## 6. Confirm the two live-Brightpearl caveats

Before flipping writes live, verify on a sandbox / one real transfer:

1. **Store as `targetWarehouseId`.** Today's purge transfers target the DC; ours target a
   seller store. It's the same `external-transfer` object — just confirm both warehouses
   allow a store-to-store transfer and the two POSTs succeed.
2. **Shipped/received fields.** `Tracker.transferShipState_()` reads defensively and falls
   back to `goods-movement-search`. Run one transfer through and confirm it flips to SHIPPED
   then RECEIVED; adjust the field checks in `Tracker.gs` if your account labels differ.

## 7. Go live

**Reallocation ▸ Setup ▸ Toggle Brightpearl WRITES** → LIVE. From then on the weekly trigger
posts proposals every Monday; you approve; execution and tracking run themselves.

## Note on the one intentional query change

The live tool injected sales from a hand-set pull (`UNNEST([...])`). Since the goal is live
data, `Queries.gs` replaces only that CTE with a real mirror query: 180-day units from
shipped, non-transfer goods-out notes, per (store, style). If you'd rather rank off Brightpearl
`order-service` order-search (`orderTypeId=1`) directly, swap `_salesCte_()` — the rest of the
query is unchanged from what you've been running.
