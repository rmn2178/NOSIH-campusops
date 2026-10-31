-- Curated live demo state: one classroom with two faulty fixtures (C1-02),
-- one laboratory bench (LAB-PHYS-04) and one bill bot (BOT-03). Every other
-- live ticket is repaired, every other fixture is operational, and the
-- bill-bot queue is rerouted to BOT-04. Idempotent: safe to re-run before a
-- demo without creating duplicate tickets, work orders or history rows.

-- 1. C1-02 -----------------------------------------------------------------
-- The report is about the front-row fan and light. The other eight fans were
-- tested clean and never formed part of this fault.
update public.complaints
   set ai_extracted_json = jsonb_set(
         ai_extracted_json::jsonb,
         '{target_assets}',
         '[{"asset_code": "FAN-C1-02-01", "asset_type": "CEILING_FAN", "slot_index": 1},
           {"asset_code": "LED-C1-02-01", "asset_type": "LED_LIGHT", "slot_index": 1}]'::jsonb
       )::text,
       updated_at = now()
 where ticket_number = 'CMP-2026-0978';

update public.work_orders
   set target_asset_codes_json = '["FAN-C1-02-01","LED-C1-02-01"]'
 where complaint_id = (select id from public.complaints where ticket_number = 'CMP-2026-0978');

update public.assets
   set status = 'OK'
 where parent_space_code = 'C1-02'
   and asset_code not in ('FAN-C1-02-01', 'LED-C1-02-01');

-- 2. Repair every other live ticket ----------------------------------------
update public.complaints c
   set status = 'RESOLVED',
       updated_at = v.done
  from (values
    ('CMP-2026-0302', timestamptz '2026-10-30 12:40:00+00'),
    ('CMP-2026-0085', timestamptz '2026-10-30 09:15:00+00'),
    ('CMP-2026-0081', timestamptz '2026-10-30 13:05:00+00')
  ) v(ticket, done)
 where c.ticket_number = v.ticket;

update public.work_orders w
   set status = 'COMPLETED',
       assigned_staff_code = coalesce(w.assigned_staff_code, v.tech),
       completed_at = v.done,
       estimated_cost_inr = v.cost
  from (values
    ('CMP-2026-0302', 'MAINT-02', timestamptz '2026-10-30 12:40:00+00', 2400::numeric),
    ('CMP-2026-0085', 'MAINT-12', timestamptz '2026-10-30 09:15:00+00', 1800::numeric),
    ('CMP-2026-0081', 'MAINT-17', timestamptz '2026-10-30 13:05:00+00', 3200::numeric)
  ) v(ticket, tech, done, cost)
  join public.complaints c on c.ticket_number = v.ticket
 where w.complaint_id = c.id;

update public.sla_clocks sc
   set is_paused = true,
       closed_at = w.completed_at,
       closed_reason = 'COMPLETED',
       breach_state = 'HEALTHY'
  from public.work_orders w
  join public.complaints c on c.id = w.complaint_id
 where sc.target_type = 'WORK_ORDER'
   and sc.target_id = w.id
   and c.ticket_number in ('CMP-2026-0302', 'CMP-2026-0085', 'CMP-2026-0081');

-- Repair history for the closed tickets, so every asset keeps its record.
insert into public.maintenance_history
  (space_code, asset_code, work_order_number, fault_category, action_taken,
   parts_used_json, technician_code, downtime_mins, completed_at)
select v.space_code, v.asset_code, v.wo_number, v.category, v.action, '[]', v.tech, v.mins, v.done
  from (values
    ('A1-01', 'FAN-A1-01-01', 'WO-2026-0064', 'FANS_HVAC',
     'Re-torqued the ceiling mount, balanced the blade set and verified all three speeds.', 'MAINT-12', 90, timestamptz '2026-10-30 09:15:00+00'),
    ('A1-01', 'FAN-A1-01-02', 'WO-2026-0064', 'FANS_HVAC',
     'Re-torqued the ceiling mount, balanced the blade set and verified all three speeds.', 'MAINT-12', 90, timestamptz '2026-10-30 09:15:00+00'),
    ('A1-01', 'FAN-A1-01-03', 'WO-2026-0064', 'FANS_HVAC',
     'Re-torqued the ceiling mount, balanced the blade set and verified all three speeds.', 'MAINT-12', 90, timestamptz '2026-10-30 09:15:00+00'),
    ('A1-01', 'FAN-A1-01-04', 'WO-2026-0064', 'FANS_HVAC',
     'Re-torqued the ceiling mount, balanced the blade set and verified all three speeds.', 'MAINT-12', 90, timestamptz '2026-10-30 09:15:00+00'),
    ('C5-02', 'SB-C5-02-01', 'WO-2026-0061', 'IT_AV',
     'Reseated the lamp module connector, reset the lamp timer and recalibrated touch at 1920x1080.', 'MAINT-17', 120, timestamptz '2026-10-30 13:05:00+00'),
    ('C5-02', 'FAN-C5-02-01', 'WO-2026-0061', 'FANS_HVAC',
     'Tightened the fan mount, cleaned the bearings and verified all three speeds.', 'MAINT-17', 60, timestamptz '2026-10-30 13:05:00+00'),
    ('CAN-05', 'APPL-CAN-05-04', 'WO-2026-0303', 'ELECTRICAL',
     'Reset the warmer thermostat, tightened the probe connection and held 74 C through service.', 'MAINT-02', 75, timestamptz '2026-10-30 12:40:00+00')
  ) v(space_code, asset_code, wo_number, category, action, tech, mins, done)
 where exists (select 1 from public.work_orders w where w.wo_number = v.wo_number)
   and not exists (
     select 1 from public.maintenance_history m
      where m.work_order_number = v.wo_number and m.asset_code = v.asset_code
   );

update public.assets
   set status = 'FAULTY'
 where asset_code in ('FAN-C1-02-01', 'LED-C1-02-01', 'INST-LAB-PHYS-04-14')
   and status <> 'FAULTY';
update public.assets
   set status = 'OK'
 where status = 'FAULTY'
   and parent_space_code not in ('C1-02', 'LAB-PHYS-04', 'BOT-03');
update public.assets
   set status = 'OK'
 where status not in ('OK', 'FAULTY', 'DEGRADED');
update public.assets
   set status = 'OK'
 where parent_space_code = 'LAB-PHYS-04'
   and asset_code <> 'INST-LAB-PHYS-04-14';

-- 3. One bill-bot fault -----------------------------------------------------
do $$
declare
  v_ticket text;
  v_cid integer;
  v_woid integer;
  v_admin integer;
  v_tech text;
begin
  if exists (select 1 from public.complaints where space_type = 'BILL_BOT' and space_code = 'BOT-03') then
    return;
  end if;

  select id into v_admin from public.users where email = 'facilities@nosih.edu.in' limit 1;
  select staff_code into v_tech
    from public.staff_profiles
   where staff_category = 'MAINTENANCE_TECH'
     and primary_skill = 'IT_AV'
     and is_on_shift and not is_on_leave
   order by skill_proficiency desc, current_active_jobs, staff_code
   limit 1;

  v_ticket := 'CMP-2026-' || lpad(nextval('public.nosih_doc_number_seq')::text, 4, '0');

  insert into public.complaints (
    ticket_number, space_type, space_code, building_code, floor_number, title, description,
    is_anonymous, reporter_user_id, public_reporter_label, moderation_status,
    ai_extracted_json, missing_info_questions_json, missing_info_answers_json,
    category, urgency, status, affected_upvote_count, source_channel, created_at, updated_at
  ) values (
    v_ticket, 'BILL_BOT', 'BOT-03', 'COURTYARD', null,
    'Bill bot at the Breakfast Counter is jamming and printing faded bills',
    'The bill bot at the Breakfast Counter jams every few bills and the thermal print comes out faded. The counter is sending students to the Lunch Hall bot.',
    false, v_admin, 'Facilities control room', 'APPROVED',
    jsonb_build_object(
      'ai_engine', 'openai/gpt-oss-120b',
      'target_assets', jsonb_build_array(jsonb_build_object(
        'asset_code', 'MECH-BOT-03-01', 'asset_type', 'BILL_BOT_MECHANISM', 'slot_index', 1)),
      'required_skill', 'IT_AV',
      'required_risk_clearance', 'STANDARD',
      'severity_indicators', jsonb_build_array('paper jam', 'faded thermal print'),
      'affects_active_class', false
    )::text,
    '[]', '{}',
    'BILL_BOT', 'HIGH', 'TRIAGED', 6, 'WEB_PORTAL',
    timestamptz '2026-10-30 22:15:00+00', timestamptz '2026-10-30 22:15:00+00'
  ) returning id into v_cid;

  insert into public.work_orders (
    wo_number, complaint_id, space_code, target_asset_codes_json, required_skill,
    required_risk_clearance, priority_score, assigned_staff_code,
    assignment_score_breakdown_json, status, reassignment_count, created_at
  ) values (
    'WO-2026-' || lpad(nextval('public.nosih_doc_number_seq')::text, 4, '0'),
    v_cid, 'BOT-03', '["MECH-BOT-03-01"]', 'IT_AV', 'STANDARD', 62, v_tech,
    jsonb_build_object('skill_match', 25, 'proximity', 12, 'shift', 15, 'load', 18, 'risk_clearance', 10)::text,
    'ASSIGNED', 0, timestamptz '2026-10-30 22:16:00+00'
  ) returning id into v_woid;

  insert into public.sla_clocks (
    target_type, target_id, space_code, urgency, response_target_mins,
    resolution_target_mins, elapsed_active_mins, is_paused, breach_state,
    current_escalation_tier, last_tick_at
  ) values (
    'WORK_ORDER', v_woid, 'BOT-03', 'HIGH', 30, 240, 8, false, 'HEALTHY', 1, now()
  );
end $$;

update public.assets
   set status = 'FAULTY',
       failure_count_30d = failure_count_30d + 1
 where asset_code = 'MECH-BOT-03-01'
   and status <> 'FAULTY';
update public.assets set status = 'FAULTY' where asset_code = 'MECH-BOT-03-01';

update public.bill_bots
   set visual_state = 'HEALTHY',
       rerouted_to_bot_code = null
 where code <> 'BOT-03';

update public.bill_bots
   set visual_state = 'FAULTY',
       thermal_head_health_pct = 38,
       paper_roll_pct = 63,
       active_queue_count = 0,
       rerouted_to_bot_code = 'BOT-04',
       last_bill_printed_at = timestamptz '2026-10-30 22:10:00+00'
 where code = 'BOT-03';

update public.bill_bots
   set active_queue_count = greatest(active_queue_count, 12),
       last_bill_printed_at = timestamptz '2026-10-30 22:34:00+00'
 where code = 'BOT-04';

-- 4. Conversation that matches the curated state ---------------------------
update public.complaint_comments
   set body = 'Checked all nine fans and the light circuit. Eight fans are clean; the front-row fan and LED are isolated at the breaker until the regulator and driver are replaced.'
 where complaint_id = 678 and public_author_label = 'Ravi Menon'
   and body like 'Inspected the fan regulator%';

update public.complaint_comments
   set body = 'The rest of the room is back, but the front-row fan and light are still switched off.'
 where complaint_id = 678 and public_author_label = 'Ananya Iyer'
   and body like 'The sparking has stopped%';

insert into public.complaint_comments
  (complaint_id, body, is_anonymous, public_author_label, author_role_badge, moderation_status, created_at, ai_moderated)
select s.complaint_id, s.body, false, s.label, s.badge, 'APPROVED', s.created_at, true
  from (values
    (678, 'The eight other fans tested clean. Replacement regulator and LED driver are reserved; the front-row circuit stays isolated until they are fitted.', 'Facilities control room', 'FACILITIES', timestamptz '2026-10-30 23:41:00+00'),
    (343, 'Thermostat reset and the probe connection tightened. The warmer held 74 C through the lunch service and the counter is back to normal.', 'Facilities control room', 'FACILITIES', timestamptz '2026-10-30 12:40:00+00'),
    (103, 'Mount re-torqued and blades balanced. The fan is silent at all three speeds; the front row is clear for the next lecture.', 'Facilities control room', 'FACILITIES', timestamptz '2026-10-30 09:15:00+00'),
    (84, 'Lamp connector reseated, lamp timer reset and touch recalibrated. Projector and fan verified during the 2 pm lecture.', 'Facilities control room', 'FACILITIES', timestamptz '2026-10-30 13:05:00+00')
  ) s(complaint_id, body, label, badge, created_at)
 where exists (select 1 from public.complaints c where c.id = s.complaint_id)
   and not exists (select 1 from public.complaint_comments x where x.complaint_id = s.complaint_id and x.body = s.body);

insert into public.complaint_comments
  (complaint_id, body, is_anonymous, public_author_label, author_role_badge, moderation_status, created_at, ai_moderated)
select c.id, s.body, false, s.label, s.badge, 'APPROVED', s.created_at, true
  from (values
    ('BOT-03', 'BOT-03 is rerouted to BOT-04 at the Lunch Hall counter. The thermal head is jamming every few bills; a technician is already assigned.', 'Facilities control room', 'FACILITIES', timestamptz '2026-10-30 22:22:00+00'),
    ('BOT-03', 'Queue at BOT-04 is about five minutes. Please use the Lunch Hall counter until BOT-03 is back.', 'Canteen supervisor', 'FACILITIES', timestamptz '2026-10-30 22:34:00+00')
  ) s(space_code, body, label, badge, created_at)
  join public.complaints c on c.space_code = s.space_code and c.space_type = 'BILL_BOT'
 where not exists (select 1 from public.complaint_comments x where x.complaint_id = c.id and x.body = s.body);

-- 4b. Close the simulation events whose tickets were repaired -----------------
update public.simulation_events e
   set status = 'COMPLETED',
       closed_at = c.updated_at
  from public.complaints c
 where e.complaint_id = c.id
   and e.status = 'ACTIVE'
   and c.status in ('RESOLVED', 'CLOSED');

-- 5. Re-derive every space and bill-bot state under the materiality rubric --
do $$
declare
  r record;
begin
  for r in
    select code from public.rooms
    union select code from public.labs
    union select code from public.canteens
  loop
    perform public.nosih_recompute_space_state(r.code);
  end loop;
end $$;
