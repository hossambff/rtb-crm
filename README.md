# Roundtable Sales OS (rtb-crm)

AI-native sales operating system for **RTB Digital (Roundtable)**. It covers:

- **Five sales pipelines:** publisher network development (MUU-based), enterprise media partnerships, the sports network, Roundtable 100 and TheStreet sponsorships.
- **Inbox and call intelligence:** Gmail, Calendar, Granola, Zoom and uploaded transcripts.
- **"Nothing Slips" engine:** proactive alerts that escalate when follow-ups are missed.
- **Roundtable Copilot:** an in-app assistant.
- **Lead Scout:** finds target publishers and enriches executive contacts through Apify.
- **Program modules:** proposals, onboarding, revenue, commissions and analytics.

- Product spec: [`docs/PRD.md`](docs/PRD.md)
- Engineering conventions: [`docs/ENGINEERING.md`](docs/ENGINEERING.md)
- Deployment: [`docs/DEPLOY.md`](docs/DEPLOY.md)

## Stack
- Next.js 16 (App Router, Server Actions)
- TypeScript
- Tailwind v4
- Drizzle ORM on Supabase Postgres (schema `rso`)
- Better Auth (Google, domain-restricted)
- AI SDK 7 via Vercel AI Gateway
- Recharts
- dnd-kit

## Local development
Requires Node 22+.

```bash
cp .env.example .env.local   # then fill in values
npm ci
npm run db:migrate && npm run db:seed
npm run dev
```

Set `ALLOW_DEV_LOGIN=true` locally to use the seeded developer accounts (see `scripts/seed.ts`). Email/password sign-in never works in production builds.

## Quality gates
```bash
npm run check    # route typegen + tsc, eslint (0 warnings), vitest
```
