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
  migrations/               schema, RLS, RPCs, AI, identity, live clock, bookings (0001–0057)
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
| `src/workspaces/WorkOrderDispatchBoard.tsx` | ranked technicians, assignment, relocation, clickable assignee names |
| `src/components/modals/StaffProfileModal.tsx` | full staff record: identity, shift, clearance, load, job history, priced repairs |
| `src/workspaces/InventoryProcurementView.tsx` | stock, reservations, purchase requests, approvals |
| `src/workspaces/SlaEscalationMonitor.tsx` | clocks, warnings, breaches, tier chain |
| `src/workspaces/TimetableWorkspace.tsx` | 2,700-slot timetable inspection + validation |
| `src/workspaces/ModerationQueueView.tsx` | held complaints, rewrites, identity vault |
| `src/workspaces/ExternalIntegrationsConsole.tsx` | simulated inbox + notification log |
| `src/workspaces/AuditChainLedgerView.tsx` | append-only audit stream |
| `src/workspaces/IncidentCorrelationDesk.tsx` | correlated incidents |
| `src/workspaces/ScenarioLab.tsx` | replayable water-leak / power-fault disruptions |
| `src/workspaces/PulsePanel.tsx` | campus pulse status, Run now, Pause, cadence, auto-heal, revert |
| `src/workspaces/AnalyticsWorkspace.tsx` | pipeline, SLA, utilisation, shortages, recurrence |
| `src/components/layout/AppShell.tsx` | navigation, live badge, clock, role labels |
| `src/components/layout/AssistantDock.tsx` | workspace-aware twin assistant |
| `src/api/client.ts` | thin typed API over `@nosih/supabase-client` |
| `src/store/` | `authStore` (session/profile), `portalStore` (workspace, clock, notices) |
| `src/hooks/useTwinSocket.ts` | Supabase Realtime subscription for twin refresh |

### Complaint portal

| Path | Role |
|---|---|
| `src/pages/CampusFeedPage.tsx` | live approved reports, filters, affected votes, comment-count handoff |
| `src/pages/ComplaintDetailPage.tsx` | full ticket record with the live community thread and comment composer |
| `src/pages/NewComplaintPage.tsx` | space picker, description, photo, submit |
| `src/pages/RoomBookingPage.tsx` | faculty room calendar, live availability, booking, own bookings |
| `src/components/AiFirstResponseCard.tsx` | classification result + clarification questions |
| `src/components/AssistantPanel.tsx` | grounded Q&A over the live twin |
| `src/components/ComplaintCard.tsx`, `CommentThread`, `ModerationRewriteModal` | thread UI |
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
| `scripts/seed_role_logins.py` | Supabase auth seats for department managers plus a demo faculty/lab-staff set (`--all` for every staff profile) |
| `scripts/f10_curate_demo.sql` | curated live state: three faults (classroom, lab bench, bill bot), the rest repaired |
| `scripts/f11_demo_bookings.sql` | realistic faculty bookings for the coming week, exams moved to weekdays, area officers appointed |
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

## 3. Data model (37 tables)

**Campus** — `buildings` (5), `floors` (15), `distribution_boards` (30), `rooms` (90), `labs` (20),
`canteens` (5), `bill_bots` (8), `assets` (2,748), `departments` (6).

**Academic** — `student_classes` (90), `timetable_slots` (2,700), `exams` (24 seeded), `users` (5,375:
5,175 students with `student_code`, 120 faculty, 40 lab staff, 30 technicians, 6 department managers,
4 command administrators), `department_spaces` (172 department → space pairs derived from the timetable).

**People** — `staff_profiles` (190, skills, risk clearance, shift, load), `users` (auth-linked when a
login exists).

**Operations** — `complaints` (90+), `complaint_comments`, `complaint_votes`, `identity_vault`,
`work_orders`, `incidents`, `maintenance_history` (71, latest repairs from the live queue),
`part_reservations`, `inventory_items` (30 SKUs), `purchase_requests` (25), `repair_approvals`,
`room_bookings`, `resource_locks`.

**Time** — `sla_clocks` (69, one per work order), `campus_clock_state` (live IST period).

**Governance** — `audit_logs` (201), `notification_logs`, `ai_jobs`, `ai_chat_messages`.

**Simulation** — `scenario_runs` (2), `simulation_config` (single row: enabled, cadence, open-fault cap,
auto-heal window), `simulation_events` (one ledger row per pulse injection: template, facility, prior
asset states, ticket/work-order/SLA links, ACTIVE → COMPLETED/REVERTED).

Each room owns 22 assets; every space is addressable by a canonical code (`C4-03`, `LAB-OOPS-02`,
`CAN-05`, `BOT-03`), so a natural-language report resolves to exactly one twin node.

---

## 4. SQL function catalogue

**Intake** — `rpc_submit_complaint`, `rpc_supplement_complaint`, `rpc_confirm_affected`,
`rpc_list_complaints`, `rpc_get_complaint`, `rpc_post_comment`, `nosih_complaint_json`.
**Read models** — `rpc_twin_overview`, `rpc_get_space_twin_inspector`, `rpc_my_profile`,
`rpc_search_directory`, `rpc_set_clock`, `rpc_set_clock_mode`.
**Dispatch** — `rpc_rank_staff_for_work_order` (five gates, transparent score),
`rpc_assign_or_rebalance_staff`, `rpc_trigger_staff_shift_change`, `rpc_workforce_summary`,
`rpc_get_staff_profile`, `rpc_claim_resource_lock`, `rpc_release_resource_lock`.
**Scheduling** — `rpc_get_room_relocation_candidates`, `rpc_execute_room_relocation`,
`rpc_create_booking`, `rpc_cancel_booking`, `rpc_list_bookings`, `rpc_get_room_occupancy`,
`nosih_booking_conflicts`, `nosih_booking_alternatives`, `rpc_bookable_rooms`, `rpc_my_bookings`, `nosih_booking_role_allowed`, `rpc_set_class_strength`.
**SLA** — `rpc_sla_matrix`, `rpc_sla_board`, `rpc_sla_compliance`, `rpc_sla_pause_clock`,
`rpc_sla_resume_clock`, `nosih_sla_snapshot`, `nosih_sla_policy_for`, `nosih_sla_operating_minutes`,
`nosih_sla_working_minutes`, `nosih_sla_calendar`, `nosih_sla_scope_visible`.
**Stock & money** — `rpc_parts_preflight`, `rpc_reserve_parts_for_work_order`, `rpc_purchase_preflight`,
`rpc_decide_purchase_request`, `rpc_receive_purchase_request_stock`, `rpc_approve_repair`,
`rpc_complete_work_order`, `rpc_update_complaint_status`.
**Time** — `rpc_tick_sla_clocks`, `nosih_clock_sync`.
**AI** — `rpc_ai_chat`, `rpc_ai_chat_history`, `rpc_chat_intake`, `nosih_ai_run_intake`,
`nosih_apply_complaint_ai`, `nosih_hold_complaint`, `nosih_ai_moderate_text`, `nosih_ai_analyse_complaint`.
**Analytics** — `rpc_analytics_overview`.
**Simulation** — `rpc_run_scenario`, `rpc_reset_scenario`, `rpc_list_scenarios`, `rpc_pulse_tick`,
`rpc_pulse_status`, `rpc_pulse_configure`, `rpc_pulse_run_now`, `rpc_pulse_revert`,
`nosih_pulse_inject`, `nosih_pulse_heal`.
**Identity** — `rpc_seal_identity_in_vault`, `rpc_break_glass_unseal_identity`, `rpc_verify_audit_chain`,
`nosih_actor_email/role/id`, `nosih_append_audit`.

Every function is `SECURITY DEFINER` with a pinned `search_path`; internals (LLM, vault, queue) are not
granted to `authenticated`.

---

## 5. Roles and separation of duties

Student/Faculty submit and read; Lab Staff are operational readers; Maintenance completes and reserves
parts; Department Manager reads their department's work orders, SLA clocks and purchase requests and
approves up to ₹10,000 only for their own department; Incident Manager dispatches, relocates and
moderates; Facilities Administrator dispatches, books, approves up to ₹10,000; Procurement Approver
approves up to ₹100,000 and receives stock; System Administrator owns break-glass. Students report
faults, follow a ticket and read the campus feed; they have no booking system at all — no `/bookings`
route, no nav entry, and no booking RPC accepts a student session.

Department scope is derived from `department_spaces` (the spaces a department actually teaches in),
not from a hand-maintained list. Facilities, incident, procurement and system roles stay campus-wide.
The audit ledger and the user directory remain closed to department managers even though `is_admin()`
admits them to command-portal actions.

Enforced invariants: actor resolved from session (forged emails are ignored), no self-approval, no
work-order-assignee approval, no cross-department manager approval, dual approval above ₹100,000,
override requires ≥20 characters plus a distinct counter-signer, break-glass requires a ≥25-character
justification and writes an audit row.

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

**Comments** — every comment is moderated by the same model inside `rpc_post_comment`: factual
frustration is published, a personal insult returns a polite rewrite the author can post in one click,
and threats are withheld. The verdict and rewrite come from Groq via the Vault key; a keyword fallback
only applies when the provider is unreachable.

Asset suggestions are guarded: the model can only mark equipment the report actually mentions.

---

## 6b. The SLA system

A campus SLA is a policy, so it lives in the database and both portals read it.

**The matrix** (`sla_policies`) gives every priority two deadlines - a response deadline and a
resolution deadline - plus the service that owns it and the 24x7 carve-out:

| Priority | Service | Response | Resolution | Basis |
|---|---|---|---|---|
| P1 Critical | Campus Facilities & Safety | 30 min | 4 h | 24×7 clock |
| P1 Critical (SAFETY_FIRE) | Campus Facilities & Safety | 15 min | 2 h | 24×7 clock |
| P2 Urgent | Campus IT | 2 working h | 8 working h | working hours |
| P2 Urgent (IT_AV) | Campus IT | 1 working h | 4 working h | working hours |
| P3 Standard | Campus Maintenance | 4 working h | 48 working h | working hours |
| P4 Low | Campus Administration | 24 working h | 5 working days | working hours |

**The calendar** (`sla_calendar_days`) decides when the clock runs: 09:00-15:00 IST on teaching days,
a longer 08:00-16:00 window during exam week, and no clock at all on weekends, the Diwali vacation,
the semester break or Founders Day. `nosih_sla_operating_minutes()` counts only the minutes the campus
was open, so a request raised on a Friday evening is not late on Monday morning. A 24x7 service
accrues the wall clock instead.

**The engine** (`rpc_tick_sla_clocks`, every minute) keeps four promises. The response clock stops at
the first staff reply. Half the resolution time is a milestone that tells the officer and the head of
department; 75% is a warning; 100% is a breach that raises the escalation tier and notifies the
chain. A breached critical request is handed to the next ranked officer. Asking the reporter for more
details pauses the clock; the answer restarts it. Staff can pause and restart a clock by hand
(`rpc_sla_pause_clock`, `rpc_sla_resume_clock`) with five allowed reasons, and a student cannot.

**The read models** are `rpc_sla_matrix()` (the policy and the calendar), `rpc_sla_board()` (every live
clock with its officer, its head of department and its countdown) and `rpc_sla_compliance(days)` (the
percentage of SLAs met per department, per priority and per service). The complaint portal renders the
per-ticket snapshot `nosih_sla_snapshot()` as a colour-coded badge, a live countdown and a milestone
track; the admin console renders the matrix, the live clocks and the compliance report. A student sees
the badge on their own ticket but cannot read the board or the compliance report.

**The scope** follows the rest of the platform: a department manager opens the console and finds only
the clocks, the compliance figures and the pause control of their own department, while the campus
roles keep the full view. A student is refused everything except their own ticket.

## 7. Workflows

**Assignment** — five hard gates (skill, risk clearance, shift/leave, capacity, active lock) then a
score of skill, priority, workload, distance and SLA urgency. Leaving shift auto-rebalances open work.
The maintenance workforce is thirty technicians across ELECTRICAL, IT_AV, HVAC, PLUMBING, CARPENTRY and
LAB_SUPPORT — 28 on shift, one deliberately off shift and one on leave so the gates stay visible — and
the dispatch workspace strips the live roster (on shift, available, per-skill) above the queue.

**Parts** — all-or-nothing reservation. Any shortage moves the order to `BLOCKED_PARTS`, pauses the
clock, paints the space and raises a purchase request per missing SKU. Receipt resumes the order.
Completion consumes reservations and decrements stock exactly once.

**Approvals** — purchase preflight is revalidated in the decision RPC; costly repairs above ₹25,000
require `rpc_approve_repair` before completion.

**Bookings** — `room_bookings` carries a GiST exclusion constraint on `(space_code, tstzrange)`, so
double booking fails in storage. Before that, the RPC checks live timetable sessions and exams, rejects
over-capacity classes, refuses unhealthy rooms, and returns three genuinely free alternatives. Cancelling
is owner-only (or Facilities/System admin, or a Department Manager in the owner's department) and
idempotent; a client `request_key` makes network retries safe. The twin inspector mounts the calendar:
six period cells show class/exam/booking occupancy, the form books a window, conflicts list the owner and
one-click alternatives, and active bookings can be cancelled in place.

**Relocation** — ranks healthy, unoccupied, unlocked rooms by building/floor proximity, refuses
smart-board-less rooms, rewrites the timetable slot, notifies the class advisor.

**Scenarios** — the dispatch workspace carries a replayable lab with two disruptions: a water leak in a
live classroom and a lab power fault. Each run creates a real complaint, work order and SLA clock,
damages the twin, and records the exact prior room/asset state. Runs are idempotent and can be reverted
to their pre-run state, so the same demo can be delivered twice.

**Campus pulse** — a pg_cron heartbeat (`nosih-campus-pulse`, every minute) keeps the campus alive
between demos. On its cadence (default 15 minutes, at most 3 open simulated faults, auto-heal off by
default) it injects a real fault through the unmodified intake pipeline: weighted sampling across
canteen appliances, bill-dispatch bots, labs and classrooms, meal-window and class-hour description
templates, random active student reporters with 35% anonymous submissions. Each injection records the
prior twin state in `simulation_events`, so it can be reverted exactly — complaint resolved, work order
cancelled, SLA paused, assets and bot paper/queue restored. An optional auto-heal window auto-assigns a
qualified on-shift technician and completes the repair once a work order ages past the threshold.
Privileged admins control everything from the dispatch panel (Run now, Pause, cadence, auto-heal,
Revert); other roles see nothing.

**SLA** — a minute cron syncs the IST clock and accrues active minutes, emits 75% warnings and tiered
breach notifications, and pauses clocks for parts. Resolving a complaint or completing its work order
closes the clock; reopening the complaint reopens the work order and the clock from "now"; the cron
skips closed clocks and defensively closes any clock whose work order is already finished.
`rpc_set_class_strength` changes a class size and revalidates every timetable slot and future booking,
reporting every room that is now too small.

**Twin** — every accepted write recomputes space state; the 3D node for a faulted room glows red, shows
the ticket and pulses; the feed, inspector and assistant read the same source. Colour follows fault
materiality, not wording: safety overrides, smart boards, lab workstations and canteen appliances are
**major** (red, pulsing), while single manageable faults — one fan, one LED, a socket — glow **light
orange** and the legend names them *Manageable*. Water meeting electrics is a hazard, not a manageable
fault: the replayable leak scenario floods fans and flickering lights, so its room stays red. The model
refines category, skill and dispatch priority, but materiality decides the colour: a fault whose targets
are all standard assets is never escalated to major by model urgency alone.

**Asset records** — selecting any asset in the twin opens its full service record: installed age, spare
SKU, 30-day failure count, health score, open work order, lifetime downtime and cost. Each previous
repair shows the date, work order, fault, action, technician, parts consumed, parts cost, labour cost and
total, linked to the complaint that raised it. A `BEFORE INSERT` trigger prices every new maintenance row
from its reservations and the technician's hourly rate; billed downtime is clamped to 24 hours, so a
backlogged ticket cannot bill months of labour. The same panel exports the whole history as CSV.
Searching a room code now prefers an exact match over another room's zero-index alias.

**Analytics** — one RPC returns pipeline counts, SLA mix, utilisation, shortages, recurring faults and
the procurement funnel.

---

## 8. Notifications, integrations, AI

- `notification_logs` is the simulated delivery service surfaced in the integrations console.
- The email console simulates an inbox event through the real intake pipeline; the optional
  `inbound-email-webhook` function resolves the sender, submits with `source_channel = EMAIL_INBOX`
  and logs an acknowledgement. The DB pipeline is verified; the HTTP route needs
  `INBOUND_EMAIL_SECRET` installed on the project (`supabase secrets set`).
- The assistant (`rpc_ai_chat`) is grounded in a twin snapshot: totals, unhealthy spaces, focus space
  assets, open work orders, incidents, SLA state and staff on shift. It refuses to invent data.
- Chat intake (`rpc_chat_intake`) is mounted as an Ask/Report toggle. Report mode extracts the room,
  canonical category and urgency, asks up to two clarifying questions, suggests the reporter's home
  room when the message names none, and files only after confirmation — returning the ticket, the
  merged parent (if deduplicated) and the work order.

---

## 9. Verification

| Script | Asserts |
|---|---|
| `verify_identity.py` | forged admin email rejected for approve/assign/complete/relocate |
| `verify_complaint_flow.py` | intake → AI → work order → SLA → twin → audit, rolled back |
| `verify_live_twin.py` | occupancy moves between periods; timetable consistency |
| `verify_all.py` | bookings, analytics, chat, completion guard, Department Manager |
| `verify_booking.py` | class/exam conflicts, double booking, capacity, ownership, idempotency, audit |
| `verify_repairs.py` | repair gate, approval, parts consumption, clock coverage, exams |
| `verify_allocation.py` | ranking fields, lock gate, assignment, lock consumption, workload |
| `verify_dispatch_guard.py` | caller-aware locks, stale assignment, rank RBAC, self-only claims |
| `verify_chat_intake.py` | draft extraction (including an explicit room code without the model), missing-room refusal, CHAT ticket + WO, merge link, sign-in gate |
| `verify_email_intake.py` | EMAIL_INBOX channel, reporter binding, ack log, merge without a second WO |
| `verify_scenarios.py` | RBAC, leak/power runs, idempotency, reset, exact asset restoration |
| `verify_pulse.py` | cron schedule, paused/cooldown/cap gates, all four facility families forced through the real pipeline, assign→parts→completion→twin restore with priced repair, auto-heal, per-event revert, race-proof document numbers, RBAC |
| `verify_seed_realism.py` | 36 distinct staff surnames per role with bounded repeats, 50 priced repairs spread over the last 90 days |
| `verify_twin_severity.py` | single-fan fault stays manageable/orange, smart board and safety faults go major/red, mixed complaints resolve in the right order, pulse follows the rubric, no failed asset outlives its complaint |
| `verify_workforce.py` | 30 technicians with unique names, every skill staffed, every open job ranks ≥2 and auto-assigns within capacity, off-shift/leave/capacity/clearance gates, summary RBAC |
| `verify_staff_profile.py` | roster of 30 with identity and load, profile stats reconcile with the database, capped job/repair lists, unknown code 404, student denial |
| `verify_sla_integrity.py` | close/freeze on completion, reopen without double counts, defensive tick, strength revalidation |
| `verify_asset_history.py` | 50 priced repairs, parts/labour/total reconciliation, 24-hour downtime cap (a backdated 90-day ticket bills 1,440 min), open work order, empty record, RBAC and trigger pricing |
| `verify_comment_ai.py` | Groq endpoint/model, model verdicts for a fair complaint and an insult, rewrite returned on the real comment RPC, held row kept out of the feed |
| `verify_demo_curation.py` | demo gate: exactly three live tickets, C1-02 carries only the front-row fan and light, one lab bench, one bill bot rerouted to BOT-04, the rest repaired with history, feed defaults to active |
| `verify_officer_booking.py` | every request gets an area officer (gates, area, audit), leave hands the job over, faculty booking accepted, double booking and class and capacity refused, retries idempotent, every booking RPC refuses a student, a technician may book |
| `verify_sla_system.py` | the SLA matrix and its category overrides, the operating calendar (weekend, holiday, after hours, 24x7), a request born with the right deadlines, the tick, the half-time milestone, the warning, the breach and the hand-over, the response clock, pause and resume, the board and the compliance report, a student refused, a department manager kept inside their own department |
| `verify_portal_booking.py` | the browser contract over HTTP: faculty sign-in, room calendar, own bookings, a real booking and its release, officers in the feed, a student sign-in refused by every booking endpoint |
| `verify_ai_keys.py` | multi-key pool, Groq routing, key material and the raw HTTP helper denied to browser roles, successive model calls succeed while rotating keys |
| `verify_rbac_matrix.py` | 8 role sign-ins, department-scoped work orders/SLA/PRs, audit and directory lockdown, forged-email denial, cross-department approval, self-approval |
| `verify_chat.py` | question reaches the model, grounded codes, multi-turn, ownership guard |
| `realistic_timetable.py` | rebuilds slots; reports collisions, load, labs |
| `unique_student_identities.py` | unique names and `STU-…` codes per student |

All print `ALL PASS` on the live project.

Every script resolves `services/nosih-api/.env` from its own location, so it behaves the same whether
launched from the repository root, from `services/nosih-api`, or from CI (they previously needed the
service directory *and* an exported `DATABASE_URL`).

### Continuous integration

`.github/workflows/ci.yml` runs on every push to `main`, every pull request, and on demand:

| Job | What it proves |
|---|---|
| `web` | `npm ci`, TypeScript typecheck for both portals, production build |
| `api` | API unit tests, offline 27-table seed and SHA-256 audit chain (`verify_phase1.py`) |
| `live` | manual only: runs `verify_all.py`, `verify_demo_curation.py`, `verify_officer_booking.py`, `verify_sla_system.py` and `verify_portal_booking.py` against the project when the `DATABASE_URL` secret exists |

The live job is read/write but rolls every mutation back; add `DATABASE_URL` as a repository secret to
enable it. Without the secret the job passes with a notice instead of failing.

---

## 10. Operations

- Portal speed: the profile and the last feed snapshot paint from storage before the network
  refresh; secondary pages and every admin workspace are lazy chunks (the sign-in gate no longer
  downloads three.js or recharts); the Vite config preconnects to `VITE_SUPABASE_URL` and an
  expired token now returns the shell to the sign-in gate instead of leaving panels on silent 401s.
- Migrations `0001–0050` are applied in order with `apply_sql_file.py`; each is idempotent. The
  community feed defaults to `ACTIVE` reports; resolved history stays one filter away. The curated
  demo state (`scripts/f10_curate_demo.sql`) leaves three live tickets, each with a seeded
  conversation: C1-02 (front-row fan and light), LAB-PHYS-04 (bench 14) and BOT-03 (thermal head,
  rerouted to BOT-04). Every other ticket is repaired, every other fixture is operational, and the
  twin shows exactly three major faults.
- Officer appointment (migration `0048`): a work order is owned the moment it is created, whatever
  channel raised it. `nosih_rank_officers` applies the hard gates (skill, risk clearance, shift,
  leave, capacity, resource lock) and then the area of the request, the officer's load and the SLA
  urgency; the trigger appoints the winner, writes an `APPOINT_OFFICER` audit row and updates the
  workload. `rpc_set_staff_availability` moves the job to the next ranked officer when a technician
  goes on leave or off shift. The complaint payload carries the officer, so both portals name the
  person who owns the fault.
- Faculty room booking in the complaint portal: `/bookings` is visible to faculty and staff only.
  `rpc_bookable_rooms(date)` returns every healthy room with its capacity and a six-period grid
  built from the live timetable, the exam calendar and the booking register; `rpc_my_bookings()`
  returns the signed-in user's own bookings. The server re-checks class, exam, booking, capacity and
  window rules, and a request key makes a retried booking land on the same record.
- Students have no booking system (migration `0051`). The nav entry, the feed shortcut and the
  `/bookings` route are closed to a student, and the server agrees: `rpc_bookable_rooms`,
  `rpc_my_bookings`, `rpc_list_bookings` and `rpc_get_room_occupancy` refuse a student session with
  `42501`, while `rpc_create_booking` and `rpc_cancel_booking` answer `FORBIDDEN`. The write gate
  is one rule for everybody else — `nosih_booking_role_allowed` allows any active role that is not a
  student, so a technician or a lab assistant may book a room and cancel their own booking, while
  cancelling somebody else's still needs the owner, the owner's department manager or an
  administrator.
- The SLA engine (migrations `0053`-`0056`) replaced the hardcoded urgency-to-minutes expression with
  a policy matrix, a campus operating calendar and a clock that counts only the time the campus was
  open. Existing clocks were re-based onto the calendar, and the response deadline was backfilled from
  the recorded repair times, so the history and the new requests are read on the same basis.
- Migration `0057` puts the SLA console inside the department scope that the rest of the platform
  already follows: a department manager reads and pauses only the clocks of their own department,
  because the board, the compliance report and the pause control are `SECURITY DEFINER` functions and
  would otherwise walk past the row level security on the tables.
- The exam schedule joins row level security in migration `0052` — it was the last table without it,
  so a student could read the whole campus exam grid straight from the table. The grid is a
  scheduling table, so it follows the booking rule: staff read it, students do not. The booking
  read models are security definer and still see every row.
- Document numbers (tickets, work orders, incidents) draw from one monotonic sequence with unique
  indexes, so the campus pulse cron can never collide with an interactive session — before migration
  `0034` a concurrent tick and submit could mint the same work-order number and price a repair at zero.
- Vault secrets: `ai_api_keys` (JSON pool of Groq `gsk_` / x.ai `xai-` keys), legacy `xai_api_key`,
  optional `llm_model`, `nosih_vault_secret` for anonymous identities. Every model call starts at the
  next key (round-robin) and retries the rest on 401/403/408/409/429 or 5xx, so one exhausted quota
  does not take the assistant down. Rotate or extend the pool with `scripts/set_ai_key.py`, which
  accepts one or more keys without echo and never writes them to disk.
- pg_cron jobs: `nosih-clock-tick` every minute (clock + SLA), `nosih-ai-maintenance` every minute,
  `nosih-campus-pulse` every minute (cadence-gated injections and optional auto-heal).
- Pulse templates carry their own category, urgency, skill and clearance (migration `0041`), and the
  model is skipped for `SIMULATION` rows: a scripted fan is always manageable, while canteen, smart
  board, workstation and bill-bot faults stay major. Real intake still runs the model.
- Seed realism polish (already applied to the live project): `f4_diversify_names.sql` reassigns
  faculty/lab-staff surnames across a 36-name pool, `f4_history_spread.sql` spreads the 50 priced
  maintenance records across the last 90 days, and `f8_heal_orphan_assets.sql` restores failed
  assets left behind by reverted demo runs. `f11_demo_bookings.sql` moves the seeded exams to
  weekdays, fills the coming week with realistic faculty bookings (capstone reviews, viva
  preparation, an accreditation visit, placement panels) that never collide with a class, an exam
  or another booking, and appoints the area officers for the three live faults.
- Real edge cases: outside 09:00–15:00 IST the clock pins to P1; weekends freeze; scrubbing sets the
  clock to MANUAL until `rpc_set_clock_mode('LIVE')`.
- Rotate any key or access token pasted into a chat.

---

## 11. Known gaps

- Incidents and reservations have no persistent demo rows; bookings and complaints are created live.
- `INBOUND_EMAIL_SECRET` is not installed on the project, so the live webhook route is not exercised;
  the email pipeline is verified directly (`verify_email_intake.py`).
- All six department managers have auth seats; only one faculty member per department and one lab
  staff are seeded by default (`seed_role_logins.py --all` provisions the rest).
- Repair approvals above ₹25,000 remain with Facilities/Procurement/System roles; department managers
  approve purchase requests, not repair sign-off.
- Notification delivery is simulated (`SENT` rows) with no retry worker.
- `services/nosih-api/app/engines` duplicates rules that now live in SQL; keep as reference only.

---

## 12. Local setup

```bash
npm install
npm run dev:complaint      # http://localhost:5173
npm run dev:admin          # http://localhost:5174
```

Portal env: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`. Server secrets stay in Vault.
Every seeded account shares the demo password printed on the login screen (`Nosih@2026`). Rotate it
and disable the demo accounts before exposing a public deployment.

Run `services/nosih-api/scripts/list_logins.py` for the live inventory (role, email, name and
whether an auth seat exists). The seeded seats that are ready to sign in:

| Role | Sign-in | Note |
|---|---|---|
| Student | `aids1a01@nosih.edu.in` | no booking system, no `/bookings` route |
| Student | `aids2a01@nosih.edu.in`, `mech1a01@nosih.edu.in`, … | roll 01 of every class, 90 students seated |
| Faculty | `fac001@nosih.edu.in` | room booking, class strength, own bookings |
| Faculty | `fac016@`, `fac031@`, `fac046@`, `fac061@`, `fac076@` | one per department, 6 seated of 120 |
| Lab staff | `labstf001@nosih.edu.in` | operational reader |
| Department manager | `hod.cse@nosih.edu.in` | `hod.aids@`, `hod.aiml@`, `hod.cyber@`, `hod.ece@`, `hod.mech@` |
| Facilities admin | `facilities@nosih.edu.in` | dispatch, bookings, ₹10,000 approvals |
| Incident manager | `incident@nosih.edu.in` | dispatch, relocation, moderation |
| Procurement approver | `procurement@nosih.edu.in` | ₹100,000 approvals, stock receipt |
| System admin | `sysadmin@nosih.edu.in` | break-glass |
| Maintenance | `maint01@nosih.edu.in` … `maint12@nosih.edu.in` | technicians, 12 seated of 30 |

`seed_role_logins.py --all` seats every remaining non-student profile; `seed_student_auth.py` seats
the roll-01 student of every class.

`vercel/` is a self-contained copy of the complaint portal for upload to Vercel. It has its own
`package.json`, lockfile, env template and `vercel.json`, runs on port 5180, and is built by CI;
deployment steps are in `vercel/README.md`.
