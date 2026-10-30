# NOSIH — Intelligent Campus Operations Platform

NOSIH turns natural-language facility reports into audited, resource-aware work: a complaint becomes
a categorised work order in one database transaction, the campus digital twin changes with it, staff
and parts are dispatched by deterministic rules, conflicts are blocked at the storage layer, and every
privileged action is attributable.

Two React portals sit on Supabase (Postgres 17 + Auth + Realtime + Storage). All business logic is SQL;
the AI runs inside Postgres against an OpenAI-compatible model. The Python service is a seed and
verification toolkit, not a runtime dependency.

---

## 1. Repository map

```
apps/
  admin-twin-portal/        3D campus command centre (React 19 + Vite + three.js)
  complaint-portal/         student/faculty feed, intake and clarification (React 19 + Vite)
packages/
  supabase-client/          shared typed client: auth, RPC wrappers, realtime
services/nosih-api/         Python seed generator, migrations runner, verification scripts
supabase/
  migrations/               schema, RLS, RPCs, AI, identity, live clock, bookings (0001–0017)
  functions/                optional Edge Functions (email webhook, SLA tick) — not required
docs/screenshots/           reference captures
README.md  Makefile  docker-compose.yml
```

### Admin portal

| Path | Role |
|---|---|
| `src/App.tsx` | restore session, role → workspace access map, workspace switch |
| `src/workspaces/TwinWorkspace.tsx` | 3D twin host, clock scrubber, floor explode, inspector |
| `src/components/twin3d/CampusCanvas3D.tsx` | scene, lighting, tower slabs, camera rig |
| `src/components/twin3d/ClassroomNode3D.tsx` | one space: state colour, fault glow, labels |
| `src/components/twin3d/SpaceInspectorDrawer.tsx` | live space detail (periods hidden for canteens/bots) |
| `src/components/twin3d/campusLayout.ts` | deterministic 123-space campus coordinates |
| `src/workspaces/WorkOrderDispatchBoard.tsx` | ranked technicians, assignment, relocation |
| `src/workspaces/InventoryProcurementView.tsx` | stock, reservations, purchase requests, approvals |
| `src/workspaces/SlaEscalationMonitor.tsx` | clocks, warnings, breaches, tier chain |
| `src/workspaces/TimetableWorkspace.tsx` | 2,700-slot timetable inspection + validation |
| `src/workspaces/ModerationQueueView.tsx` | held complaints, rewrites, identity vault |
| `src/workspaces/ExternalIntegrationsConsole.tsx` | simulated inbox + notification log |
| `src/workspaces/AuditChainLedgerView.tsx` | append-only audit stream |
| `src/workspaces/IncidentCorrelationDesk.tsx` | correlated incidents |
| `src/workspaces/AnalyticsWorkspace.tsx` | pipeline, SLA, utilisation, shortages, recurrence |
| `src/components/layout/AppShell.tsx` | navigation, live badge, clock, role labels |
| `src/components/layout/AssistantDock.tsx` | workspace-aware twin assistant |
| `src/api/client.ts` | thin typed API over `@nosih/supabase-client` |
| `src/store/` | `authStore` (session/profile), `portalStore` (workspace, clock, notices) |
| `src/hooks/useTwinSocket.ts` | Supabase Realtime subscription for twin refresh |

### Complaint portal

| Path | Role |
|---|---|
| `src/pages/CampusFeedPage.tsx` | live approved reports, filters, affected votes |
| `src/pages/NewComplaintPage.tsx` | space picker, description, photo, submit |
| `src/components/AiFirstResponseCard.tsx` | classification result + clarification questions |
| `src/components/AssistantPanel.tsx` | grounded Q&A over the live twin |
| `src/components/ComplaintCard.tsx`, `CommentThreadDrawer`, `ModerationRewriteModal` | thread UI |
| `src/api/client.ts` | Edge Function first, SQL RPC fallback, same shape |

### Shared client

`packages/supabase-client` exposes the browser client (publishable key only), auth helpers and typed
wrappers for every RPC used by the portals, including `aiChat`, `chatIntake`, `analyticsOverview`.

### Python service

| Path | Purpose |
|---|---|
| `app/seed/seed_campus.py` | fictional campus generator (rooms, assets, classes, slots) |
| `app/engines/*` | legacy rule engines kept for reference; runtime rules live in SQL |
| `app/routers/*` | legacy FastAPI surface (not used by the portals) |
| `scripts/apply_sql_file.py` | apply one migration with autocommit |
| `scripts/load_ai_secrets.py` | push provider keys into Supabase Vault |
| `scripts/realistic_timetable.py` | idempotent 2,700-slot rebuild (subjects, teachers, labs) |
| `scripts/unique_student_identities.py` | unique student codes, names, class and department |
| `scripts/verify_*.py` | runnable PASS checks (see §9) |

---

## 2. Runtime request flow

```
Browser (publishable key)
   │  supabase.rpc(...)
   ▼
PostgREST  ──►  SECURITY DEFINER RPC  ──►  tables (RLS still applies to reads)
                        │
                        ├── pg_net / http  ──►  LLM provider (key in Vault)
                        ├── pg_cron        ──►  clock tick, SLA sweep, AI retries
                        └── audit_logs     ──►  every allow/reject decision
```

The browser never holds a service key. Reads go through RLS; writes go through RPCs that resolve the
actor from `auth.uid()`.

---

## 3. Data model (33 tables)

**Campus** — `buildings` (5), `floors` (15), `distribution_boards` (30), `rooms` (90), `labs` (20),
`canteens` (5), `bill_bots` (8), `assets` (2,748), `departments` (6).

**Academic** — `student_classes` (90), `timetable_slots` (2,700), `exams` (24 seeded), `users` (5,351:
5,175 students with `student_code`, 120 faculty, 40 lab staff, 12 technicians, admins).

**People** — `staff_profiles` (172, skills, risk clearance, shift, load), `users` (auth-linked when a
login exists).

**Operations** — `complaints` (84), `complaint_comments`, `complaint_votes`, `identity_vault`,
`work_orders` (63), `incidents`, `maintenance_history` (50), `part_reservations`, `inventory_items`
(30 SKUs), `purchase_requests` (25), `repair_approvals`, `room_bookings`, `resource_locks`.

**Time** — `sla_clocks` (63, one per work order), `campus_clock_state` (live IST period).

**Governance** — `audit_logs` (164), `notification_logs`, `ai_jobs`, `ai_chat_messages`.

Each room owns 22 assets; every space is addressable by a canonical code (`C4-03`, `LAB-OOPS-02`,
`CAN-05`, `BOT-03`), so a natural-language report resolves to exactly one twin node.

---

## 4. SQL function catalogue

**Intake** — `rpc_submit_complaint`, `rpc_supplement_complaint`, `rpc_confirm_affected`,
`rpc_list_complaints`, `rpc_get_complaint`, `rpc_post_comment`, `nosih_complaint_json`.
**Read models** — `rpc_twin_overview`, `rpc_get_space_twin_inspector`, `rpc_my_profile`,
`rpc_search_directory`, `rpc_set_clock`, `rpc_set_clock_mode`.
**Dispatch** — `rpc_rank_staff_for_work_order` (five gates, transparent score),
`rpc_assign_or_rebalance_staff`, `rpc_trigger_staff_shift_change`, `rpc_claim_resource_lock`,
`rpc_release_resource_lock`.
**Scheduling** — `rpc_get_room_relocation_candidates`, `rpc_execute_room_relocation`,
`rpc_create_booking`, `rpc_cancel_booking`, `rpc_list_bookings`.
**Stock & money** — `rpc_parts_preflight`, `rpc_reserve_parts_for_work_order`, `rpc_purchase_preflight`,
`rpc_decide_purchase_request`, `rpc_receive_purchase_request_stock`, `rpc_approve_repair`,
`rpc_complete_work_order`, `rpc_update_complaint_status`.
**Time** — `rpc_tick_sla_clocks`, `nosih_clock_sync`.
**AI** — `rpc_ai_chat`, `rpc_ai_chat_history`, `rpc_chat_intake`, `nosih_ai_run_intake`,
`nosih_apply_complaint_ai`, `nosih_hold_complaint`, `nosih_ai_moderate_text`, `nosih_ai_analyse_complaint`.
**Analytics** — `rpc_analytics_overview`.
**Identity** — `rpc_seal_identity_in_vault`, `rpc_break_glass_unseal_identity`, `rpc_verify_audit_chain`,
`nosih_actor_email/role/id`, `nosih_append_audit`.

Every function is `SECURITY DEFINER` with a pinned `search_path`; internals (LLM, vault, queue) are not
granted to `authenticated`.

---

## 5. Roles and separation of duties

Student/Faculty submit and read; Lab Staff are operational readers; Maintenance completes and reserves
parts; Department Manager reads their domain and approves up to ₹10,000; Incident Manager dispatches,
relocates and moderates; Facilities Administrator dispatches, books, approves up to ₹10,000; Procurement
Approver approves up to ₹100,000 and receives stock; System Administrator owns break-glass.

Enforced invariants: actor resolved from session (forged emails are ignored), no self-approval, no
work-order-assignee approval, dual approval above ₹100,000, override requires ≥20 characters plus a
distinct counter-signer, break-glass requires a ≥25-character justification and writes an audit row.

---

## 6. Complaint pipeline

1. `rpc_submit_complaint` resolves the user, validates the space, and normalises assets to real codes.
2. Deterministic safety override: sparks/smoke/fire/shock/water near electrics → `SAFETY_FIRE/CRITICAL`.
3. Duplicate detection (same space, 24 h, trigram similarity > 0.45) → merge or new ticket.
4. Anonymous reporters are sealed with pgcrypto into `identity_vault`; only break-glass can unseal.
5. `nosih_ai_run_intake` calls the model synchronously and `nosih_apply_complaint_ai` writes category,
   urgency, skill, risk, assets, questions and audit — in the same transaction as the complaint.
6. A work order and SLA clock are created, room/asset visual state changes, incidents correlate.
7. If the provider is unreachable the complaint still commits, a job is queued and pg_cron retries.
8. `missing_info_questions` return with the first response; supplements re-run enrichment.

Asset suggestions are guarded: the model can only mark equipment the report actually mentions.

---

## 7. Workflows

**Assignment** — five hard gates (skill, risk clearance, shift/leave, capacity, active lock) then a
score of skill, priority, workload, distance and SLA urgency. Leaving shift auto-rebalances open work.

**Parts** — all-or-nothing reservation. Any shortage moves the order to `BLOCKED_PARTS`, pauses the
clock, paints the space and raises a purchase request per missing SKU. Receipt resumes the order.
Completion consumes reservations and decrements stock exactly once.

**Approvals** — purchase preflight is revalidated in the decision RPC; costly repairs above ₹25,000
require `rpc_approve_repair` before completion.

**Bookings** — `room_bookings` carries a GiST exclusion constraint on `(space_code, tstzrange)`, so
double booking fails in storage. The RPC returns `DOUBLE_BOOKED` with three healthy alternatives.

**Relocation** — ranks healthy, unoccupied, unlocked rooms by building/floor proximity, refuses
smart-board-less rooms, rewrites the timetable slot, notifies the class advisor.

**SLA** — a minute cron syncs the IST clock, accrues active minutes, emits 75% warnings and tiered
breach notifications, and pauses clocks for parts or completion states.

**Twin** — every accepted write recomputes space state; the 3D node for a faulted room glows red, shows
the ticket and pulses; the feed, inspector and assistant read the same source.

**Analytics** — one RPC returns pipeline counts, SLA mix, utilisation, shortages, recurring faults and
the procurement funnel.

---

## 8. Notifications, integrations, AI

- `notification_logs` is the simulated delivery service surfaced in the integrations console.
- The email console simulates an inbox event through the real intake pipeline; the optional
  `inbound-email-webhook` function provides the HTTP endpoint.
- The assistant (`rpc_ai_chat`) is grounded in a twin snapshot: totals, unhealthy spaces, focus space
  assets, open work orders, incidents, SLA state and staff on shift. It refuses to invent data.
- Chat intake (`rpc_chat_intake`) extracts a draft fault from a conversation and creates it on confirm.

---

## 9. Verification

| Script | Asserts |
|---|---|
| `verify_identity.py` | forged admin email rejected for approve/assign/complete/relocate |
| `verify_complaint_flow.py` | intake → AI → work order → SLA → twin → audit, rolled back |
| `verify_live_twin.py` | occupancy moves between periods; timetable consistency |
| `verify_all.py` | bookings, analytics, chat, completion guard, Department Manager |
| `verify_repairs.py` | repair gate, approval, parts consumption, clock coverage, exams |
| `realistic_timetable.py` | rebuilds slots; reports collisions, load, labs |
| `unique_student_identities.py` | unique names and `STU-…` codes per student |

All print `ALL PASS` on the live project.

---

## 10. Operations

- Migrations `0001–0017` are applied in order with `apply_sql_file.py`; each is idempotent.
- Vault secrets: `xai_api_key` (Groq `gsk_` keys auto-route to Groq, `xai-` to x.ai), optional
  `llm_model`, `nosih_vault_secret` for anonymous identities.
- pg_cron jobs: `nosih-clock-tick` every minute (clock + SLA), `nosih-ai-maintenance` every minute.
- Real edge cases: outside 09:00–15:00 IST the clock pins to P1; weekends freeze; scrubbing sets the
  clock to MANUAL until `rpc_set_clock_mode('LIVE')`.
- Rotate any key or access token pasted into a chat.

---

## 11. Known gaps

- Booking panel and chat "create complaint" are enforced in SQL but not mounted in the UI.
- Incidents, reservations and bookings have no persistent demo rows (verification rolls back).
- Department Managers read campus-wide; department-scoped RLS is not implemented.
- Notification delivery is simulated (`SENT` rows) with no retry worker.
- Faculty and lab staff have no login accounts.
- `services/nosih-api/app/engines` duplicates rules that now live in SQL; keep as reference only.

---

## 12. Local setup

```bash
npm install
npm run dev:complaint      # http://localhost:5173
npm run dev:admin          # http://localhost:5174
```

Portal env: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`. Server secrets stay in Vault.
Sign in with a seeded student (`aids1a01@nosih.edu.in`) or an admin account; the seeded password is
managed outside the repository.
