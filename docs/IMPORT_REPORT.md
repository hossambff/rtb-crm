# Import reconciliation report

Generated 2026-09-30T00:50:27.571Z by `scripts/import-spreadsheets.ts` (verification **dry run** against the imported database — nothing written by this run).

## Import batches in the database (one per source file; roll back from /import/history)

| File | Batch | Status | Rows | Accounts +/~ | Deals +/~ | Contacts +/~ | Notes | Metrics | Splits | Dupes merged | Migrations | Placeholders | Unmapped | Skipped |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RTB Global Sales Pipeline 9.29.26 [DRAFT] v7 (ranked by MUU).xlsx | `ca828bcb` | completed | 2336 | 2082/0 | 1695/0 | 1063/0 | 594 | 2052 | 934 | 219 | 23 | 13 | 0 | 12 |
| RTB Global Sales Pipeline 9.29.26 [DRAFT].xlsx | `9162e51d` | completed | 0 | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Chris & Will - Roundtable_Master_Pipeline (1).xlsx | `ab97e94f` | completed | 140 | 76/26 | 83/56 | 11/1 | 19 | 31 | 141 | 4 | 0 | 2 | 0 | 0 |
| RTB Sites & RTB100 Pipeline (Top 100 list + Media sites_ Crypto, Blockchain, Finance, AI, Politics, Military).xlsx | `70404ba2` | failed | 12163 | 6477/914 | 1448/2015 | 2570/416 | 1386 | 3536 | 2150 | 833 | 0 | 1 | 0 | 0 |
| RTB Sites & RTB100 Pipeline (Top 100 list + Media sites_ Crypto, Blockchain, Finance, AI, Politics, Military).xlsx | `dbead3c3` | completed | 12163 | 0/890 | 9/2011 | 4/416 | 14 | 0 | 14 | 0 | 0 | 0 | 0 | 0 |
| Duplicate repair (post-import) | `cdc52757` | completed | 0 | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| RTB Global Sales Pipeline 9.29.26 [DRAFT] v7 (ranked by MUU).xlsx | `39a3cdbe` | completed | 2312 | 1/1 | 2/0 | 0/0 | 1 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| RTB Global Sales Pipeline 9.29.26 [DRAFT].xlsx | `3eae183c` | completed | 0 | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Chris & Will - Roundtable_Master_Pipeline (1).xlsx | `713ad82d` | completed | 140 | 1/2 | 2/3 | 0/0 | 0 | 0 | 3 | 0 | 0 | 0 | 0 | 0 |
| RTB Sites & RTB100 Pipeline (Top 100 list + Media sites_ Crypto, Blockchain, Finance, AI, Politics, Military).xlsx | `1247cb4b` | completed | 12163 | 55/0 | 13/0 | 2/0 | 24 | 0 | 15 | 8 | 0 | 0 | 0 | 0 |
| Duplicate repair (post-import) | `1fc5f247` | completed | 0 | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Duplicate repair (post-import) | `38447af9` | completed | 0 | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| RTB Global Sales Pipeline 9.29.26 [DRAFT] v7 (ranked by MUU).xlsx | `bcfd348f` | completed | 2312 | 0/1 | 0/0 | 0/0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| RTB Sites & RTB100 Pipeline (Top 100 list + Media sites_ Crypto, Blockchain, Finance, AI, Politics, Military).xlsx | `3f4234e3` | completed | 12163 | 0/1 | 0/0 | 0/0 | 5 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| RTB Global Sales Pipeline 9.29.26 [DRAFT] v7 (ranked by MUU).xlsx | `bda107e1` | completed | 2312 | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| RTB Sites & RTB100 Pipeline (Top 100 list + Media sites_ Crypto, Blockchain, Finance, AI, Politics, Military).xlsx | `065bf918` | completed | 12163 | 0/1 | 0/0 | 0/0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

_+ = created, ~ = updated (existing record, empty fields filled / stage advanced). “Dupes merged” = rows that collapsed into a record created earlier in the same batch._

> **Batch `70404ba2` (RTB Sites & RTB100 Pipeline (Top 100 list + Media sites_ Crypto, Blockchain, Finance, AI, Politics, Military).xlsx) failed** during its first flush (a same-name account claimed a domain another row already owned — fixed in the engine). Its inserts were kept and adopted by the next, completed run of the same file (which only filled gaps). Because the failed batch never wrote its import_records, its 6477 accounts / 1448 deals are **not** covered by one-click rollback; they can be attached to that batch with an INSERT … SELECT on created_at (see final report of the import agent).

Later batches of the same file are idempotent re-runs after matching fixes; “Duplicate repair (post-import)” batches merged same-name duplicates and moved mis-attached R100/ADS deals (all reversible):

- `cdc52757` dealsMoved 3, dealsMerged 55, fieldsCleared 3, accountsMerged 54
- `1fc5f247` dealsMoved 3, dealsMerged 19, fieldsCleared 3, accountsMerged 56
- `38447af9` dealsMoved 0, dealsMerged 0, fieldsCleared 0, accountsMerged 4

## Re-run check (this dry run)

Idempotency: re-running the migration against the imported database should create nothing new.

| File | Batch | Status | Rows | Accounts +/~ | Deals +/~ | Contacts +/~ | Notes | Metrics | Splits | Dupes merged | Migrations | Placeholders | Unmapped | Skipped |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RTB Global Sales Pipeline 9.29.26 [DRAFT] v7 (ranked by MUU).xlsx | `2bd40798` | dry run | 2312 | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| RTB Global Sales Pipeline 9.29.26 [DRAFT].xlsx | `75f71df2` | dry run | 0 | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Chris & Will - Roundtable_Master_Pipeline (1).xlsx | `067d8210` | dry run | 140 | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| RTB Sites & RTB100 Pipeline (Top 100 list + Media sites_ Crypto, Blockchain, Finance, AI, Politics, Military).xlsx | `8689492d` | dry run | 12163 | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Rows by sheet

| File | Sheet | Source rows | Records | With deal | Skipped |
|---|---|---:|---:|---:|---:|
| RTB Global Sales Pipeline 9.29.26 [DRAFT | Strategic | 29 | 29 | 29 | 0 |
| RTB Global Sales Pipeline 9.29.26 [DRAFT | Pipeline Master (+Contacts & Notes, DRAFT status) | 1654 | 1654 | 1654 | 0 |
| RTB Global Sales Pipeline 9.29.26 [DRAFT | Sports | 149 | 147 | 147 | 0 |
| RTB Global Sales Pipeline 9.29.26 [DRAFT | TechFinance | 40 | 39 | 39 | 0 |
| RTB Global Sales Pipeline 9.29.26 [DRAFT | NewsPolitics | 12 | 12 | 12 | 0 |
| RTB Global Sales Pipeline 9.29.26 [DRAFT | RTB 100 | 31 | 28 | 28 | 0 |
| RTB Global Sales Pipeline 9.29.26 [DRAFT | Removed (off model) | 380 | 380 | 0 | 0 |
| RTB Global Sales Pipeline 9.29.26 [DRAFT | MigrationPrio | 24 | 23 | 0 | 0 |
| RTB Global Sales Pipeline 9.29.26 [DRAFT | Pipeline Master (DRAFT, not in v7) | 2031 | 0 | 0 | 0 |
| Chris & Will - Roundtable_Master_Pipelin | TheStreet | 25 | 25 | 25 | 0 |
| Chris & Will - Roundtable_Master_Pipelin | NetDev | 82 | 34 | 34 | 0 |
| Chris & Will - Roundtable_Master_Pipelin | RTB 100 | 83 | 81 | 81 | 0 |
| RTB Sites & RTB100 Pipeline (Top 100 lis | NetDev Active Deal Tracking | 53 | 51 | 51 | 0 |
| RTB Sites & RTB100 Pipeline (Top 100 lis | NetDev CLEANED Pipeline | 3166 | 3164 | 2681 | 0 |
| RTB Sites & RTB100 Pipeline (Top 100 lis | NetDev Spanish Targets | 503 | 503 | 503 | 0 |
| RTB Sites & RTB100 Pipeline (Top 100 lis | NETDEV Pipeline | 1489 | 1411 | 980 | 23 |
| RTB Sites & RTB100 Pipeline (Top 100 lis | New Target List | 438 | 428 | 38 | 0 |
| RTB Sites & RTB100 Pipeline (Top 100 lis | RTB 100 MASTER | 6299 | 6289 | 861 | 0 |
| RTB Sites & RTB100 Pipeline (Top 100 lis | RTB 100 Editorial Outreach | 341 | 317 | 313 | 0 |
| RTB Sites & RTB100 Pipeline (Top 100 lis | RTB100 Interviews | 11 | 9 | 9 | 2 |

## Deals by pipeline / stage (database after import)

| Pipeline | Stage | Deals | MUU | $ (annualized/contract) |
|---|---|---:|---:|---:|
| NET | Target | 738 | 2,551,220,160 | — |
| NET | Outreach | 281 | 856,265,128 | — |
| NET | In Comms | 22 | 57,915,741 | — |
| NET | Warming Up | 6 | 9,227,400 | — |
| NET | Hot | 14 | 17,362,339 | — |
| NET | Demo / Beta Review | 4 | 5,700,000 | — |
| NET | Migrating | 7 | 3,293,600 | — |
| NET | On Hold | 16 | 18,248,626 | — |
| NET | Cold / Nurture | 970 | 1,594,267,889 | — |
| ENT | In Comms | 4 | 198,302,492 | — |
| ENT | Negotiation | 10 | 765,865,598 | — |
| ENT | Contract | 1 | 100,000,000 | — |
| ENT | On Hold | 1 | 17,200,000 | — |
| SPT | Target | 1 | 3,148,000 | — |
| SPT | Outreach | 18 | 12,119,773 | — |
| SPT | In Comms | 18 | 21,645,736 | — |
| SPT | Warming Up | 3 | 43,652,000 | — |
| SPT | Hot | 108 | 63,926,744 | — |
| SPT | Cold / Nurture | 1 | 487,000 | — |
| R100 | Target | 222 | 0 | — |
| R100 | Outreach | 593 | 0 | — |
| R100 | Warming Up | 45 | 0 | — |
| R100 | Hot | 11 | 0 | — |
| R100 | Relationship already | 20 | 0 | — |
| R100 | Onboarding (Profile setup) | 2 | 0 | — |
| R100 | Profile Activated | 4 | 0 | — |
| R100 | Made First Post (Live) | 26 | 0 | — |
| R100 | Cold – keep comms | 7 | 0 | — |
| ADS | Warm Deal | 14 | 0 | $1,102,500 |
| ADS | Negotiation | 2 | 0 | $110,000 |
| ADS | Verbal | 1 | 0 | $100,000 |
| ADS | Signed LOI | 1 | 0 | $200,000 |
| ADS | Current Client | 7 | 0 | $1,150,000 |

## Deals by owner (primary owner; splits in deal_splits)

| Owner | Pipeline | Deals |
|---|---|---:|
| (unassigned) | ENT | 5 |
| (unassigned) | NET | 209 |
| (unassigned) | R100 | 1 |
| (unassigned) | SPT | 3 |
| Andres (placeholder) | ENT | 2 |
| Andres (placeholder) | NET | 317 |
| Andres (placeholder) | SPT | 2 |
| Casey (placeholder) | ENT | 1 |
| Casey (placeholder) | NET | 241 |
| Casey (placeholder) | R100 | 50 |
| Chris (placeholder) | ADS | 25 |
| Chris (placeholder) | NET | 36 |
| Chris (placeholder) | R100 | 36 |
| Daniel (placeholder) | NET | 435 |
| Erik (placeholder) | ENT | 2 |
| Erik (placeholder) | NET | 476 |
| Erik (placeholder) | R100 | 678 |
| Kade (placeholder) | SPT | 8 |
| Kevin (placeholder) | ENT | 1 |
| Kevin (placeholder) | NET | 342 |
| Kevin (placeholder) | R100 | 108 |
| Liz (placeholder) | NET | 1 |
| Mariah (placeholder) | R100 | 57 |
| Mehab (placeholder) | ENT | 5 |
| Mehab (placeholder) | NET | 1 |
| SW (placeholder) | SPT | 135 |
| Yousef (placeholder) | SPT | 1 |

## Totals

- **accounts**: 8,579
- **disqualified**: 374
- **restricted accounts**: 2
- **contacts**: 3,651
- **deals**: 3,178
- **overrides pending**: 147
- **splits**: 3,263
- **notes**: 2,043
- **metrics**: 5,619
- **migrations**: 23
- **dup domains**: 0
- **placeholders**: 17

## Validation vs Chris & Will “Summary” tab (AT-10)

| Metric | Summary count | CRM count | Summary value | CRM value |
|---|---:|---:|---:|---:|
| TheStreet — active deals closing | 4 | 4 | $410,000 | $410,000 |
| TheStreet — current client annualized | 7 | 7 | $1,150,000 | $1,150,000 |
| TheStreet — upcoming current-client collections | — | 7 | $260,000 | $260,000 |
| TheStreet — warm deals in negotiation | 14 | 14 | $1,102,500 | $1,102,500 |
| NetDev (C&W rows) — migrating | 4 | 4 | 2,200,000 | 2,150,000 |
| NetDev (C&W rows) — call set / hot (+demo/contract) | 4 | 9 | 16,053,400 | 18,400,000 |
| NetDev (C&W rows) — warming up | 5 | 4 | 8,732,200 | 9,099,880 |
| NetDev (C&W rows) — on hold | 21 | 17 | 36,628,400 | 35,448,626 |
| NetDev (C&W rows) — total | 34 | 34 | 63,614,000 | 65,098,506 |
| RTB100 — live accounts | 24 | 30 | — | — |
| RTB100 — made first post | 18 | 26 | — | — |
| RTB100 — profile activated | 6 | 4 | — | — |
| RTB100 — hot | 5 | 11 | — | — |
| RTB100 — warming up | 40 | 45 | — | — |
| RTB100 — cold, keep comms | 12 | 7 | — | — |

**Reconciling items**

- CRM stages are the *most advanced* status across every source (e.g. a C&W “On Hold” publisher that the DRAFT/v7 or RTB Sites tabs show as “Hot” lands in Hot), so bucket counts can move between rows while the C&W row total stays equal.
- NetDev MUU sums use each deal's MUU, which is filled from the highest-priority source first (Strategic > Active > Pipeline); C&W 8/19 figures only fill gaps.
- RTB100 counts cover every R100 deal (C&W + v7 activation tracker + RTB Sites MASTER/Editorial), not just the C&W tab; extra live accounts come from the activation tracker and MASTER sheet.

## Unmapped status values

_None — every status cell mapped to a stage or was classified as a date / email / URL / note._

## Non-status values found in status columns (routed to notes / last contacted)

- date: 2026-08-12 × 5
- date: 2026-08-20 × 3
- date: 2026-08-24 × 3
- date: 2026-09-09 × 3
- date: 2026-09-14 × 3
- date: 2026-08-17 × 2
- date: 2026-08-31 × 2
- date: 2026-09-04 × 2
- date: 2026-09-21 × 2
- date: 2026-08-05 × 1
- date: 2026-08-10 × 1
- date: 2026-08-25 × 1
- date: 2026-09-02 × 1
- note: Revisit: too small / no contacts / not independent / wrong c × 1

## Unmatched / special rows

- **MigrationPrio** — Naor: status “No Migration” — no project created
- **RTB100 Interviews** — Root Insurance (Alex Timm): no matching R100 deal
- **RTB100 Interviews** — CEO (Yoni Assia): no matching R100 deal

## Skipped rows (23)

- NETDEV Pipeline: no name / domain × 23

## Team tab vs placeholder users

| Person | Team tab | Placeholder employment type |
|---|---|---|
| Chris Smith | SVP Strategic Partnerships, $10k per month retainer | retainer |
| Will Heckman | SVP Sales, $10k per month retainer | retainer |
| Kevin Glaittli | Intern, hourly | hourly |
| Andres Simbeck | Intern, hourly | hourly |
| Casey Bohrer | Intern, hourly | hourly |
| Erik Lew | commission only sales | commission |
| Ben Johnson | commission only sales | commission |
| Mariah Crom | commission only sales | commission |
| Daniel Alecio | commission only sales | commission |

Placeholder users are `<first>.placeholder@roundtable.invalid`, role viewer, banned (cannot sign in). Claim them with `claimPlaceholder()` (src/lib/accounts/placeholders.ts) once the real user signs in. Example: kevin.placeholder@roundtable.invalid.

## Notes & decisions

- Pipeline Master: DRAFT granular status used for 1544 rows (tier fallback for the rest); 147 probability overrides imported as pending approval (“Imported: per J. Heckman 29 Sep 2026”).
- DRAFT Pipeline Master: 2031 rows; statuses/overrides joined into v7 rows; 379 rows are in v7 “Removed (off model)” (not re-added); 0 rows absent from v7 imported here.
- RTB 100 MASTER: 5428 rows had no status / outreach evidence → imported as target accounts (with contacts) but no R100 deal; rows with a status, a date, “Relationship already” or “outreach sent” became R100 deals.
- Re-run check (dry) — duplicate repair would change: 0 same-name accounts merged, 0 R100/ADS deals moved off same-name publishers, 0 duplicate deals folded (batch “Duplicate repair (post-import)”, reversible).
- Pipeline routing: Arena Group (Paradium.AI) → ENT **restricted**; the PRD's named enterprise groups (NY Post, Reach plc, Baltimore Sun, Sinclair, GB News, HT Media) and any Strategic / Active / Closed row with ≥ 10M MUU (D7) → ENT; Sports rows → SPT; everything else → NET. The same account keeps the same pipeline across tabs (C&W NetDev rows that are ENT in v7 merge into the ENT deal and are counted in the NetDev validation rows above).
- NetDev “Monthly visits” (CLEANED, Spanish, NETDEV Pipeline, and v7 rows sourced from “NetDev Pipeline”) are stored as audience metric **visits**; MUU is derived as visits ÷ 2.5 and flagged *estimate*. Blue MUU cells in v7 are stored as “BFF research estimate”.
- Every imported deal: tag `imported`, next step from the sheet or “Review imported deal”, due import date + 7 days, source = sheet name.
- Removed (off model) accounts are lifecycle *disqualified* (reason in notes/customFields) and do not get early-stage deals from other list tabs.
