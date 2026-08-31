# Switching between local and cloud Supabase

This project can run against two different Supabase backends: a Docker
stack on your own machine ("local"), or a hosted Supabase project
("cloud"). Which one you're on is controlled by two independent things:

1. **Where the frontend points** — set in `.env.local`.
2. **Where the Supabase CLI points** — set by `npx supabase link` /
   `npx supabase unlink`, and consumed by `db push`, `db pull`,
   `config push`, `secrets set`, etc.

These are independent on purpose: you can have the app running against
one backend while the CLI is linked to a different one. Keep track of
both, or you'll end up editing a database you didn't mean to touch.

Everything below assumes the local stack is Docker-based (`npx supabase
start`) and the cloud project is whatever's configured in your Supabase
Dashboard.

---

## 1. The frontend — `.env.local` (project root)

Not tracked by git (`*.local` in `.gitignore`). Vite reads this file and
inlines the two `VITE_`-prefixed values into the browser bundle —
`src/lib/supabaseClient.js` never hardcodes an environment.

| Variable | Local value | Cloud value |
|---|---|---|
| `VITE_SUPABASE_URL` | `http://127.0.0.1:54321` | `https://<project-ref>.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | the fixed local dev key from `npx supabase status` | the project's publishable key, from Dashboard → Project Settings → API |

**To switch:** edit these two lines, then restart `npm run dev` (Vite
only reads `.env.local` at startup, not on hot reload).

---

## 2. The CLI link — no file, just CLI state

The CLI tracks which cloud project it's linked to in
`supabase/.temp/project-ref` (gitignored, machine-local). This is what
`db push`, `db pull`, `config push`, and `secrets set` act on — **not**
what the running app talks to.

```bash
# Point the CLI at a cloud project (interactive login required once):
npx supabase link --project-ref <project-ref>

# Stop the CLI from targeting any cloud project:
npx supabase unlink
```

Sanity-check which project you're linked to before running anything
that writes to a remote database:

```bash
npx supabase projects list
```

**Local-only commands** (refuse to run, or don't make sense, without a
link): `db push`, `db pull`, `config push`, `secrets set/list/unset`.
**Local-only commands** (only ever touch your own Docker Postgres):
`db reset`, `start`, `stop`, `status`.

---

## 3. Backend config — `supabase/config.toml`

Tracked in git — shared by everyone. Most of it (`[db]`, `[auth]`,
`[auth.external.*]`, `[edge_runtime]`, `[db.seed]`) only governs the
**local** Docker stack when you run `npx supabase start`. It does
**not** automatically apply to a cloud project.

To make a linked cloud project match this file, push it explicitly:

```bash
npx supabase config push
```

Two settings worth knowing before you do that:

- `site_url` / `additional_redirect_urls` are currently set to
  `localhost:5173` / `127.0.0.1:5173` for local dev. Pushing this file
  as-is to a cloud project would break its redirect allow-list — check
  these match your deployed frontend's URL before pushing to cloud.
- `[auth.external.google]` / `[auth.external.azure]` read credentials
  via `env(...)` from `supabase/.env` (see §4). `config push` only
  pushes the *shape* of the config; the actual secret values still need
  to exist wherever the push is reading its env from.

---

## 4. Secrets — `supabase/.env` (never committed)

Gitignored, machine-local, never pushed by `git`. Holds OAuth provider
credentials and Edge Function secrets (Bolagsverket, currently):

```
SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID=...
SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET=...
SUPABASE_AUTH_EXTERNAL_AZURE_CLIENT_ID=...
SUPABASE_AUTH_EXTERNAL_AZURE_SECRET=...
BOLAGSVERKET_CLIENT_ID=...
BOLAGSVERKET_CLIENT_SECRET=...
```

**Local:** `npx supabase start` reads this file directly to resolve the
`env(...)` references in `config.toml`. Editing it requires a restart
(`npx supabase stop && npx supabase start`) — these are read once at
container start, not on reload.

**Cloud:** this file is never read by a hosted project. The equivalent
values must be set through the Dashboard or CLI, targeting whichever
project is currently linked:

```bash
# Edge Function secrets (e.g. Bolagsverket credentials):
npx supabase secrets set BOLAGSVERKET_CLIENT_ID=... BOLAGSVERKET_CLIENT_SECRET=...

# OAuth provider credentials: Dashboard → Authentication → Providers
# (not exposed via `secrets set` — that command is for Edge Function
# secrets specifically, not auth provider config).
```

---

## 5. Data — migrations run everywhere, `seed.sql` runs nowhere but local

`supabase/migrations/*.sql` are schema and apply identically to either
backend:

```bash
npx supabase db push     # apply pending local migrations to the linked cloud project
npx supabase db reset    # rebuild the LOCAL database from scratch: migrations + seed.sql
```

`supabase/seed.sql` is data, not schema — it's wired into
`[db.seed]` in `config.toml`, and that block is only honored by
`db reset`, which only ever touches your local Docker Postgres. There is
no equivalent "reseed" step for a cloud project — `db push` never runs
`seed.sql`. If a cloud project needs the same fixture rows, insert them
by hand (Studio, or `psql` against the cloud connection string).

---

## Quick reference: what to touch to go each direction

**Cloud → local:**
1. `.env.local` → point at `http://127.0.0.1:54321` + the local publishable key.
2. `npx supabase unlink` (optional, but avoids accidentally running a `push`/`secrets` command against the cloud project).
3. `npx supabase start`, then `npx supabase db reset` if migrations/seed haven't been applied to this machine's Docker volume yet.
4. Fill in `supabase/.env` with OAuth + Bolagsverket credentials, restart the stack.

**Local → cloud:**
1. `npx supabase link --project-ref <project-ref>`.
2. `npx supabase db push` to apply migrations.
3. `npx supabase config push` — after checking `site_url` / redirect URLs are correct for the deployed frontend, not local dev.
4. Set OAuth providers via the Dashboard and Edge Function secrets via `npx supabase secrets set`.
5. Manually insert any fixture rows the cloud project needs (`seed.sql` never runs there).
6. `.env.local` → point at `https://<project-ref>.supabase.co` + the cloud publishable key.
