# NOSIH Complaint Portal — standalone Vercel bundle

This folder is a self-contained copy of `apps/complaint-portal` plus the shared
`@nosih/supabase-client` package. It does **not** depend on the monorepo, so it
can be uploaded to Vercel as its own project. Node is pinned to `26.x` in
`engines` because Vercel has retired Node 20.

## Run it locally

```bash
cd vercel
npm install
npm run dev        # http://localhost:5180
npm run build      # dist/
npm run preview    # serves dist/ on 5180
```

The normal monorepo portal stays on `http://localhost:5173`; this copy uses
port 5180 so both can run at the same time.

## Live AI — no API key in Vercel

The assistant and comment moderation are server-side. The browser calls
`rpc_ai_chat`, `rpc_chat_intake` and `rpc_post_comment`; Postgres reaches the
Groq key pool in Supabase Vault (`ai_api_keys`) and returns the answer/verdict.
That is why this bundle needs only the two publishable variables. Adding
`XAI_API_KEY` to Vercel would expose an unused secret and is never required.

To prove the model path before a demo, run from the repository:

```bash
cd services/nosih-api
.venv/Scripts/python.exe scripts/verify_ai_keys.py
.venv/Scripts/python.exe scripts/verify_comment_ai.py
.venv/Scripts/python.exe scripts/verify_chat.py
```

All three must print `ALL PASS` / `13/13 passed`. The assistant reply carries an
`engine` field (`llm` when the live model answered).

## Environment variables

Copy `.env.example` to `.env` for local work (already done here) and set the
same two variables in the Vercel project:

| Variable | Value |
|---|---|
| `VITE_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_...` |

Only the **publishable** key belongs in a browser bundle. Never put the
service-role/secret key in Vercel or any `VITE_` variable. `.env` is
gitignored; `.env.example` is the committed template.

## Deploy to Vercel

Dashboard route:

1. Create a new Vercel project and upload/import this `vercel` folder as the
   project root.
2. Framework preset: **Vite**. Build command: `npm run build`. Output: `dist`.
3. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` for Production,
   Preview and Development.
4. Deploy, then open `https://<project>.vercel.app/login`.

CLI route:

```bash
cd vercel
npx vercel login
npx vercel            # preview
npx vercel --prod     # production
```

`vercel.json` adds the SPA rewrite used by `/feed`, `/complaints/new` and
`/complaints/:id`, plus immutable caching for hashed assets under `/assets`.

## After deploy

- Sign in once on the Vercel domain; Supabase sessions are per-origin.
- The feed opens on **Active reports**: C1-02 (front-row fan and light), BOT-03
  (bill bot rerouted to BOT-04) and LAB-PHYS-04 (bench 14). Resolved history is
  one status filter away.
- Check the feed, open a ticket's comments page, and file one test report.
- After changing this folder, redeploy so the production domain picks up the
  new build.
- Supabase browser access uses RLS and the publishable key; no CORS change is
  normally needed because the API is called directly over HTTPS.

## Demo accounts

The login screen itself states the demo password (`Nosih@2026`). Useful
accounts:

| Role | Email |
|---|---|
| Student | `aids1a01@nosih.edu.in` |
| Facilities admin | `facilities@nosih.edu.in` |
| System admin | `sysadmin@nosih.edu.in` |
| Department manager | `hod.cse@nosih.edu.in` |

Before sharing a public URL, rotate the seeded password and remove or disable
the demo accounts. The password is present in the repository history and on
the login screen, so it must not protect anything real.

## Keeping the copy current

This is a deployment snapshot. After changing `apps/complaint-portal`, re-copy
`src/`, `index.html`, `package.json` and the config files, then
`npm install && npm run build` here. The CI job `Standalone Vercel bundle`
builds this folder on every push so a broken copy cannot ship unnoticed.
