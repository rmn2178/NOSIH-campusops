# NOSIH Campus Operations Platform

An intelligent campus operations platform for a fictional 6-department college: natural-language
reports become work orders, the campus digital twin mutates in the same transaction, staff and parts
are dispatched by deterministic rules, and every privileged action is audited.

Live stack: Supabase Postgres 17 (schema, RLS, 40+ RPCs, pg_cron, pg_net), a React admin twin portal
(3D campus) and a React complaint portal, both talking to Supabase directly with the publishable key.

## Architecture

| Layer | What lives there |
|---|---|
| `supabase/migrations/0001–0016` | 27-table schema, RLS, audit, RPCs, in-database AI, identity binding, live clock, bookings, analytics |
| `apps/admin-twin-portal` | Digital twin (3D), dispatch, inventory/procurement, SLA, moderation, timetable, audit, integrations, AI assistant |
| `apps/complaint-portal` | Feed, complaint form, clarification card, comments, AI assistant |
| `packages/supabase-client` | Typed RPC wrappers shared by both portals |
| `services/nosih-api` | Seed generator, verification scripts (Python). Runtime logic lives in Postgres |
| `supabase/functions` | Optional Edge Functions (email webhook, SLA tick). Not required; AI runs in-database |

AI: an OpenAI-compatible model (Groq `openai/gpt-oss-120b`, or x.ai Grok if an `xai-…` key is supplied)
runs from inside Postgres via the `http` extension, with the key in Supabase Vault. Permissions, stock,
scheduling and approval rules are deterministic SQL — the model only extracts, categorises, summarises
and moderates.

## Roles (backend-enforced)

| Role | Can |
|---|---|
| STUDENT / FACULTY | submit complaints, comment, vote, read the feed, chat intake |
| LAB_STAFF | lab-side reads |
| MAINTENANCE | complete assigned work orders, reserve parts |
| DEPARTMENT_MANAGER | department reads, first-level purchase approval up to ₹10,000 |
| INCIDENT_MANAGER | assign staff, relocate classes, moderate, set clock |
| FACILITIES_ADMIN | dispatch, bookings, procurement, completions, approvals up to ₹10,000 |
| PROCUREMENT_APPROVER | approvals up to ₹100,000, dual approval, stock receipt |
| SYSTEM_ADMIN | everything, plus break-glass identity unseal with justification |

Identity is resolved from the signed-in session (`nosih_actor_role`), never from an email parameter.
Separation of duties: no self-approval, no assignee-approval, dual approval above ₹100,000, overrides
need a ≥20-character justification plus a distinct counter-signer.

## Workflows

### 1. Intake and enrichment (single transaction)
`rpc_submit_complaint(payload)` → resolves the actor, validates the space, normalises target assets to
real asset codes, applies the deterministic safety override, detects duplicates (trigram > 0.45 or
embedding absent), inserts the complaint, seals anonymous identity in the vault, calls the LLM through
`nosih_ai_run_intake`, applies `nosih_apply_complaint_ai` (category, urgency, skill, risk, assets,
questions), creates the work order and SLA clock, updates room/asset state, correlates incidents, and
returns the first response. If the LLM is unreachable the complaint still commits and a queued retry
runs from pg_cron.

Chat intake: `rpc_chat_intake(messages, portal, space, confirm=false)` returns a draft; `confirm=true`
creates the complaint through the same pipeline. Email: the admin console simulates an inbox event and
the optional `inbound-email-webhook` Edge Function provides the real endpoint.

Clarification: `missing_info_questions` are returned with the first response; `rpc_supplement_complaint`
stores answers and re-runs enrichment.

### 2. Assignment
`rpc_rank_staff_for_work_order` applies five hard gates (skill, risk clearance, shift, capacity,
resource lock) then scores `2·skill + 3·priority_fit − 1.5·active_jobs − 0.8·block_distance − cost/200 + 1.5·urgency`.
`rpc_assign_or_rebalance_staff` requires a held staff lock and rejects gate failures.
`rpc_trigger_staff_shift_change` reassigns every open order when a technician goes off shift.

### 3. Parts and shortages
`rpc_reserve_parts_for_work_order` is all-or-nothing: any shortage sets the work order to
`BLOCKED_PARTS`, pauses the SLA clock, paints the space `BLOCKED_PARTS`, and raises one purchase
request per missing SKU. Receiving stock flips the work order back to `IN_PROGRESS` and unpauses the clock.

### 4. Approvals
`rpc_purchase_preflight` exposes the checks; `rpc_decide_purchase_request` revalidates them at execution
(role limit, budget, no self-approval, no assignee conflict), supports dual approval and audited overrides.

### 5. Room bookings
`room_bookings` carries an exclusion constraint `(space_code =, tstzrange &&) where status='ACTIVE'`, so
double booking is impossible at the storage layer. `rpc_create_booking` returns `DOUBLE_BOOKED` with three
healthy alternatives; `rpc_cancel_booking` frees the slot; `rpc_list_bookings` lists the active board.
Relocation (`rpc_execute_room_relocation`) protects the same invariant for affected classes and notifies
the class advisor.

### 6. SLA, escalation, notifications
`rpc_tick_sla_clocks` runs every minute via pg_cron. It syncs the campus clock to IST wall time
(09:00–15:00), accrues active minutes per clock, emits a 75% warning and then tiered breach
notifications (`maintenance → incident → facilities → principal`) written to `notification_logs`
(the simulated delivery service shown in the integrations console).

### 7. Digital twin
Every accepted complaint, hold, completion, part reservation and relocation recomputes room/lab state
through shared helpers, so the 3D twin, feed, inspector and assistant always read one authoritative state.
The timetable drives live occupancy: 120 faculty, 20 per department, 2,700 slots, one lab per class per
day, no double-booked teacher, and a consistent teacher per subject per section.

### 8. Analytics
`rpc_analytics_overview(days)` returns open requests, status/category mix, duplicates merged, active
incidents, SLA compliance, utilisation (spaces, technicians, bookings), stock shortages, recurring
faults and the procurement funnel.

## Disruption scenarios

| Scenario | How to run | Expected |
|---|---|---|
| Exam room unavailable | submit a fault in the exam room, open relocation | candidates ranked with reasons, advisor notified, twin FAULTY→HEALTHY after repair |
| Critical part out of stock | reserve a part with insufficient stock | zero partial reservations, `BLOCKED_PARTS`, SLA paused, auto purchase request; receive stock resumes |
| Technician unavailable | end a shift with open jobs | orders rebalanced, reassignment counter and audit row |
| Wi-Fi outage / mass reports | submit near-duplicate reports | one parent, merges counted once, incident correlation when ≥2 rooms on a board |

## Verification

```bash
python services/nosih-api/scripts/verify_identity.py        # RBAC forgery must be rejected
python services/nosih-api/scripts/verify_complaint_flow.py  # intake → WO → SLA → twin, rolled back
python services/nosih-api/scripts/verify_live_twin.py       # occupancy shifts P3→P4
python services/nosih-api/scripts/verify_all.py             # 10-task suite
python services/nosih-api/scripts/realistic_timetable.py    # rebuild timetable (idempotent)
```

All suites print `ALL PASS`. The complaint flow proves: ticket issued, PLUMBING/HIGH, AI applied, work
order `PENDING_ASSIGNMENT`, SLA 30/240 running, room FAULTY, clarifying questions, reporter vote, and no
equipment falsely flagged.

## Local setup

1. `npm install` and `npm run dev:complaint` / `npm run dev:admin`.
2. Portal env: `VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY` (never the secret key).
3. Server secrets live in Supabase Vault (`xai_api_key`, optional `llm_model`) and are loaded with
   `python services/nosih-api/scripts/load_ai_secrets.py` from the gitignored `supabase/functions/.env`.
4. Migrations are applied with `python services/nosih-api/scripts/apply_sql_file.py <file>`.

## Known gaps

- Analytics, bookings and chat intake are fully enforced in the database but only chat has a portal
  entry point; the analytics and booking workspaces are not yet mounted in the admin UI.
- Costly-repair approval (above a repair threshold) is not implemented; only purchases are gated.
- Notification delivery is simulated in `notification_logs` (status `SENT`), with no retry worker.
- Edge Functions are optional and not deployed; scheduled work runs through pg_cron instead.
