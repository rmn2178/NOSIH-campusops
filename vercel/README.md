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
- Check the feed, open a ticket's comments page, and file one test report.
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
