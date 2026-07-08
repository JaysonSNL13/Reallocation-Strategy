# Sheet schema

The bound Google Sheet is both the database and Jayson's approval surface. Tabs are created
by **Reallocation ▸ Setup ▸ Initialize tabs**.

## Proposed Transfers  (the review + approval surface)

One row per **donor → recipient** transfer (a recipient fed by several donors = several rows
sharing a Rank). Jayson ticks **Approve** to authorize a row.

| Col | Field | Notes |
|---|---|---|
| A | Approve | checkbox — tick to authorize (this is the gate) |
| B | Rank | 1 = highest value; shared across a recipient's donor rows |
| C | Type | Regular / Force-empty |
| D | Style | e.g. "Heathered Navy" |
| E | Donor store | store shipping out |
| F | Donor WH | Brightpearl warehouse id (source) |
| G | Recipient store | store receiving |
| H | Recip WH | Brightpearl warehouse id (target) |
| I | Rank gap | deadest-donor sales rank − recipient sales rank |
| J | Donor sales rank | 180-day rank (higher = deader) |
| K | Recip sales rank | 180-day rank (1 = best seller) |
| L | Recip run now | % of the size run held before the move |
| M | Recip run after | % after the move (must be ≥50/50 to appear) |
| N | Units (mirror) | donor's holding per the mirror (live qty confirmed at execution) |
| O | Flags | `FORCE EMPTY`, `CONFIRM — NO THRESHOLD` |
| P | Transfer ID | filled on execution |
| Q | Status | PROPOSED → CREATED/DRY RUN → SHIPPED → RECEIVED (or SKIPPED/ERROR) |
| R | Last update | timestamp |
| S | Notes | reference tag, goods-out note ids, errors |

Rows flagged **CONFIRM — NO THRESHOLD** are recipients with no active threshold for the
style. Per the plan, ticking Approve on those confirms the store actually wants the style
before we ship.

## Store Emails  (you fill this in)

| Store name | Warehouse id | Email |
|---|---|---|

Warehouse id is the match key; name is a fallback. Used for pull-list + nudge emails.

## Tracker  (auto)

`Created · Transfer ID · Style · Donor · Donor WH · Recipient · Recip WH · Units · GoodsOut IDs
· Status · Last check · Nudges · Type`. The tracker trigger updates Status and bumps Nudges
after 48h unshipped.

## Receiving Priority  (auto)

`Created · Transfer ID · Style · Donor · Recipient · Units · Reference (PURGE-PRIORITY) · Type`
— the list Receiving uses to expedite inbound boxes.

## Run Log  (auto)

`Time · Level · Message` — what each weekly run / execution / tracker pass did.
