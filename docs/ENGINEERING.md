# Engineering guide — Roundtable Sales OS (rtb-crm)

Read this before writing code. The product spec is `docs/PRD.md` (copy of "PRD - Roundtable Sales OS.md" v1.2).
Next.js here is **v16** — APIs differ from older versions; consult `node_modules/next/dist/docs/` (see AGENTS.md).

## Toolchain
- Node 22: prefix every command with `export PATH=$HOME/.nvm/versions/node/v22.23.3/bin:$PATH &&`.
- Checks (all must pass before you finish): `./node_modules/.bin/tsc --noEmit`, `./node_modules/.bin/eslint src --max-warnings=0`,
  `./node_modules/.bin/vitest run`. Run `./node_modules/.bin/next typegen` first if route types (PageProps<"/x">) complain.
- Do **not** run `next build` or `next dev` in parallel with other agents unless told to (port 3000 is taken by the lead's dev server).

## Stack
Next.js 16 App Router (RSC + Server Actions), TypeScript strict, Tailwind v4 (tokens in `src/app/globals.css`),
Drizzle ORM + postgres-js → Supabase Postgres (schema `rso`, role `rso_app`), Better Auth (Google OAuth, admin plugin),
AI SDK 7 via Vercel AI Gateway (`src/lib/ai.ts`), Radix primitives, dnd-kit, TanStack Table, Recharts, cmdk, sonner, zod v4.

## Layout
```
src/app/(auth)/…            sign-in, pending
src/app/(app)/<module>/…     authenticated pages (layout enforces requireUser)
src/app/api/<…>/route.ts     route handlers (webhooks, cron, search, file upload)
src/components/ui/…          design-system primitives (Button, Input, Card, Badge/StatusBadge, Dialog, Tabs, misc)
src/components/<module>/…    module components
src/lib/<module>/…           module server logic (queries.ts, actions.ts, service.ts)
src/db/schema.ts             THE schema (single file). src/db/index.ts = db client (server-only)
scripts/                     CLI (migrate, seed, import) — use scripts/_db.ts, never src/db/index.ts
```

## Database rules
- The schema is designed to cover the whole PRD. **Do not edit `src/db/schema.ts` or generate migrations** in a feature
  branch. If you truly need a column, prefer existing `jsonb` fields (`customFields`, `metadata`, `analysis`, `r100`, `config`).
  If still needed, list the exact change under "Schema requests" in your final report; the lead applies it centrally.
- Money in **cents** (bigint `…Cents`), audiences as integers, probabilities 0..1, percents 0..100 unless named `…Pct` (0..1 for revSharePct).
- Always filter soft-deleted rows (`deletedAt is null`) for accounts/contacts/deals.

## Security rules (non-negotiable)
1. Every page: `const user = await requireUser()` (layout already does it, but pages that load data must still call it
   to get `user`). Every server action: wrap with `action(schema, handler)` from `src/lib/actions.ts`.
2. Every read of deals uses `dealAccessWhere(user, "view")`; accounts/contacts use `ownedEntityWhere(...)`.
   Every write calls `assertCan(user, module, action)` and checks the record is `inScope(...)`.
   Deal module for a pipeline key: `dealModule(key)`.
3. Restricted (MNPI) records: respect `restricted` + `canSeeRestricted`. Never leak them via search, AI, exports, analytics.
4. Field-level security: hide `isFieldHidden(role, "deal", field)` fields server-side (strip before sending to client).
5. Audit every mutation of business data with `audit({ actorId, action, entity, entityId, before, after })`.
6. Never log secrets or tokens. API keys stored in DB are encrypted with `encryptSecret` (src/lib/crypto.ts).
7. Untrusted content (emails, transcripts, web pages) passed to AI must be wrapped with `untrusted(label, text)`.
   AI output never triggers external sends or deletions without an explicit user click.
8. Route handlers for cron must check `Authorization: Bearer ${process.env.CRON_SECRET}`; webhooks must verify signatures.

## AI rules
- Use `aiObject` / `aiText` from `src/lib/ai.ts` (logs to agent_runs, uses configurable models).
- Always implement a deterministic **fallback** when `aiAvailable()` is false or the call throws — features must work
  (degraded) without AI. Mark results with an `engine: "ai:<model>" | "heuristic"` field.
- Free-tier gateway models available now: `google/gemini-2.5-flash` (fast), `openai/gpt-5-mini` (strong).

## UI rules (PRD §16A)
- Dark only. Backgrounds `bg-bg` / `bg-surface-1` / `bg-surface-2`; borders `border-border`; text `text-fg` (headings),
  `text-body`, `text-secondary`, `text-muted`. Headings/hero numbers `font-display` (Playfair Display); UI Work Sans.
- Monochrome chrome. Color ONLY for charts (`src/lib/palette.ts`: VIZ, PIPELINE_COLORS, SEQ_BLUE), status
  (`StatusBadge` = color + icon + label), and scores. Pipeline identity = `ColorTick`.
- Primary button = white (`variant="primary"`), secondary = outlined. No shadows. Hairline borders. Transitions ≤200ms.
- Charts (Recharts): thin bars w/ 4px radius, 2px lines, 2px surface gaps, grid `#1A1A1A`, axis ticks `#828282` 12px,
  tooltips on hover, legend for ≥2 series, never text in series colors, never dual axes, max 8 categorical series.
- Every list has an empty state (`EmptyState`) and loading state; forms show field errors; toasts via `sonner`.
- Numbers: `fmtNumber/fmtUsd/fmtPct/fmtDate/fmtRelative` from `src/lib/format.ts`; tabular figures (`tabular`).
- Accessible: labels on inputs, aria-labels on icon buttons, keyboard reachable dialogs/menus.
- Responsive to 375px (read + quick actions).

## Conventions
- Server Components by default; client components only for interactivity. Data loading in `src/lib/<module>/queries.ts`
  (server-only), mutations in `src/lib/<module>/actions.ts` (`"use server"` + `action()` wrapper), then `revalidatePath`.
- Next 16: `params`/`searchParams` are Promises; typed helpers `PageProps<"/route/[id]">`, `LayoutProps<…>`.
- No new dependencies unless essential; if you add one, justify it in your report.
- Write vitest unit tests for pure logic (scoring, parsing, rule evaluation, commission math) under `src/**/__tests__`.

## Test accounts (local dev only; email/password disabled in production)
Seeded by `scripts/seed.ts` (password in that file): dev.superadmin@, dev.exec@, dev.svp@, dev.sdr@, dev.intern@,
dev.commission@ (roundtable.io) and dev.finance@blockchainff.com.
