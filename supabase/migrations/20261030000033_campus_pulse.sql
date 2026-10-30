-- Campus Pulse: automatic, scheduled fault generation across every facility
-- type. The pulse injects realistic faults (canteen appliances, bill bots,
-- labs, classrooms) through the unmodified real pipeline — rpc_submit_complaint
-- with source_channel SIMULATION — so AI-style classification, work orders,
-- SLA clocks, twin damage and audit all behave exactly like student reports.
-- Every injection is written to a revertible ledger, and an optional
-- auto-heal pass completes aged simulated work orders so the campus keeps
-- producing live history.

create table if not exists public.simulation_config (
  id boolean primary key default true check (id = true),
  enabled boolean not null default true,
  interval_minutes integer not null default 15,
  max_open_simulated integer not null default 3,
  auto_heal_hours integer not null default 0,
  last_injected_at timestamptz,
  last_tick_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint simulation_config_interval check (interval_minutes between 1 and 1440),
  constraint simulation_config_cap check (max_open_simulated between 1 and 10),
  constraint simulation_config_heal check (auto_heal_hours between 0 and 720)
);

insert into public.simulation_config (id) values (true) on conflict (id) do nothing;

alter table public.simulation_config enable row level security;
drop policy if exists simulation_config_admin_read on public.simulation_config;
create policy simulation_config_admin_read on public.simulation_config
  for select to authenticated using (public.nosih_is_privileged_admin());

create table if not exists public.simulation_events (
  id serial primary key,
  template_key text not null,
  facility_kind text not null,
  space_code text not null,
  asset_codes jsonb not null default '[]'::jsonb,
  prior_asset_states jsonb not null default '[]'::jsonb,
  prior_paper_roll_pct integer,
  prior_queue_count integer,
  prior_rerouted_to_bot_code text,
  complaint_id integer,
  ticket_number text,
  work_order_id integer,
  work_order_number text,
  sla_clock_id integer,
  reporter_email text,
  is_anonymous boolean not null default false,
  description text not null,
  status text not null default 'ACTIVE',
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint simulation_events_status check (status in ('ACTIVE', 'REVERTED', 'COMPLETED'))
);

create index if not exists simulation_events_status_idx
  on public.simulation_events (status, created_at desc);

alter table public.simulation_events enable row level security;
drop policy if exists simulation_events_admin_read on public.simulation_events;
create policy simulation_events_admin_read on public.simulation_events
  for select to authenticated using (public.nosih_is_privileged_admin());

-- Pipeline fix: the twin recompute previously ignored bill bots, so a
-- completed bill-bot repair left the bot stuck on FAULTY forever.
do $$
declare
  v_def text := pg_get_functiondef('public.nosih_recompute_space_state(text)'::regprocedure);
begin
  if position('nosih_pulse_recompute' in v_def) > 0 then
    return;
  end if;
  if position('update public.canteens set visual_state = v_state where code = p_space_code;' in v_def) = 0 then
    raise exception 'recompute anchor missing';
  end if;
  v_def := replace(
    v_def,
    'update public.canteens set visual_state = v_state where code = p_space_code;',
    'update public.canteens set visual_state = v_state where code = p_space_code;' || chr(10) ||
    '  -- nosih_pulse_recompute: bill bots follow the same complaint-driven twin state' || chr(10) ||
    '  update public.bill_bots set visual_state = v_state where code = p_space_code;');
  execute v_def;
end $$;

-- Pipeline fix: the bill-bot branch of complaint intake referenced a
-- nonexistent nearest_fallback_bot_code column, so every bill-bot complaint
-- crashed with UndefinedColumn. Resolve the fallback bot through its id.
do $$
declare
  v_def text := pg_get_functiondef('public.rpc_submit_complaint(jsonb)'::regprocedure);
begin
  if position('nosih_pulse_bot_reroute' in v_def) > 0 then
    return;
  end if;
  if position('rerouted_to_bot_code = coalesce(b.nearest_fallback_bot_code, b.rerouted_to_bot_code),'
              in v_def) = 0
     or position('where fb.code = (select nearest_fallback_bot_code from public.bill_bots'
                 ' where code = v_space_code);' in v_def) = 0 then
    raise exception 'bill-bot reroute anchor missing';
  end if;
  v_def := replace(
    v_def,
    'rerouted_to_bot_code = coalesce(b.nearest_fallback_bot_code, b.rerouted_to_bot_code),',
    'rerouted_to_bot_code = coalesce((select fb.code from public.bill_bots fb'
      ' where fb.id = b.nearest_fallback_bot_id), b.rerouted_to_bot_code), -- nosih_pulse_bot_reroute');
  v_def := replace(
    v_def,
    'where fb.code = (select nearest_fallback_bot_code from public.bill_bots where code = v_space_code);',
    'where fb.code = (select fbc.code from public.bill_bots fbc'
      ' where fbc.id = (select bb.nearest_fallback_bot_id from public.bill_bots bb'
      ' where bb.code = v_space_code));');
  execute v_def;
end $$;

-- ---------------------------------------------------------------------------
-- Injection: pick a facility type by time of day, a healthy space, a real
-- asset, and describe the fault in authentic reporter voice.
-- ---------------------------------------------------------------------------
create or replace function public.nosih_pulse_inject()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ist timestamptz;
  v_hour integer;
  v_dow integer;
  v_favoured text[];
  v_fac text;
  v_space text;
  v_label text;
  v_asset_code text;
  v_asset_name text;
  v_prior_assets jsonb;
  v_prior_visual text;
  v_prior_paper integer;
  v_prior_queue integer;
  v_prior_reroute text;
  v_paper_variant boolean;
  v_template text;
  v_body text;
  v_description text;
  v_reporter text;
  v_anon boolean;
  v_res jsonb;
  v_complaint_id integer;
  v_ticket text;
  v_wo_id integer;
  v_wo_number text;
  v_sla_id integer;
begin
  v_ist := now() at time zone 'Asia/Kolkata';
  v_hour := extract(hour from v_ist)::int;
  v_dow := extract(isodow from v_ist)::int;

  -- Meal windows favour canteens and bill bots; class hours favour rooms and
  -- labs. The favoured families get double weight, but every family with a
  -- healthy candidate stays in rotation at all hours.
  if v_hour between 7 and 10 or v_hour between 11 and 14 or v_hour between 16 and 19 then
    v_favoured := array['CANTEEN', 'BILL_BOT'];
  elsif v_dow between 1 and 5 and v_hour between 8 and 16 then
    v_favoured := array['ROOM', 'LAB'];
  else
    v_favoured := array['LAB', 'BILL_BOT'];
  end if;

  with cand as (
    select 'CANTEEN'::text as fac, c.code as space, c.name as label,
           a.asset_code, a.name as asset_name,
           null::integer as paper, null::integer as queue, null::text as reroute
      from public.canteens c
      join public.assets a
        on a.parent_space_code = c.code
       and a.status = 'OK'
       and a.asset_type = 'CANTEEN_APPLIANCE'
     where c.visual_state = 'HEALTHY'
       and not exists (select 1 from public.complaints x
                        where x.space_code = c.code
                          and x.status in ('OPEN', 'TRIAGED', 'IN_PROGRESS', 'BLOCKED_PARTS'))
       and not exists (select 1 from public.simulation_events e
                        where e.space_code = c.code and e.status = 'ACTIVE')
    union all
    select 'BILL_BOT', b.code, coalesce(b.location_description, b.name),
           a.asset_code, a.name,
           b.paper_roll_pct, b.active_queue_count, b.rerouted_to_bot_code
      from public.bill_bots b
      join public.assets a
        on a.parent_space_code = b.code
       and a.status = 'OK'
       and a.asset_type = 'BILL_BOT_MECHANISM'
     where b.visual_state = 'HEALTHY'
       and not exists (select 1 from public.complaints x
                        where x.space_code = b.code
                          and x.status in ('OPEN', 'TRIAGED', 'IN_PROGRESS', 'BLOCKED_PARTS'))
       and not exists (select 1 from public.simulation_events e
                        where e.space_code = b.code and e.status = 'ACTIVE')
    union all
    select 'LAB', l.code, l.name, a.asset_code, a.name, null, null, null
      from public.labs l
      join public.assets a
        on a.parent_space_code = l.code
       and a.status = 'OK'
     where l.visual_state = 'HEALTHY'
       and not exists (select 1 from public.complaints x
                        where x.space_code = l.code
                          and x.status in ('OPEN', 'TRIAGED', 'IN_PROGRESS', 'BLOCKED_PARTS'))
       and not exists (select 1 from public.simulation_events e
                        where e.space_code = l.code and e.status = 'ACTIVE')
    union all
    select 'ROOM', r.code, null::text, a.asset_code, a.name, null, null, null
      from public.rooms r
      join public.assets a
        on a.parent_space_code = r.code
       and a.status = 'OK'
     where r.visual_state = 'HEALTHY'
       and not exists (select 1 from public.complaints x
                        where x.space_code = r.code
                          and x.status in ('OPEN', 'TRIAGED', 'IN_PROGRESS', 'BLOCKED_PARTS'))
       and not exists (select 1 from public.simulation_events e
                        where e.space_code = r.code and e.status = 'ACTIVE')
  )
  select cd.fac, cd.space, cd.label, cd.asset_code, cd.asset_name, cd.paper, cd.queue, cd.reroute
    into v_fac, v_space, v_label, v_asset_code, v_asset_name, v_prior_paper, v_prior_queue, v_prior_reroute
    from (select fac, case when fac = any(v_favoured) then 2.0 else 1.0 end as w,
                 (select c2.asset_code from cand c2 where c2.fac = cand.fac order by random() limit 1) as pick
            from cand group by fac) t
    join cand cd on cd.fac = t.fac and cd.asset_code = t.pick
   order by t.w * random() desc
   limit 1;

  if v_space is null then
    return jsonb_build_object('fired', false, 'reason', 'NO_HEALTHY_CANDIDATE');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('asset_code', a.asset_code, 'status', a.status)), '[]'::jsonb)
    into v_prior_assets
    from public.assets a
   where a.asset_code = v_asset_code;

  if v_fac = 'CANTEEN' then
    select visual_state into v_prior_visual from public.canteens where code = v_space;
  elsif v_fac = 'BILL_BOT' then
    select visual_state into v_prior_visual from public.bill_bots where code = v_space;
  elsif v_fac = 'LAB' then
    select visual_state into v_prior_visual from public.labs where code = v_space;
  else
    select visual_state into v_prior_visual from public.rooms where code = v_space;
  end if;

  v_paper_variant := v_fac = 'BILL_BOT' and random() < 0.4;

  v_body := case
    when v_fac = 'BILL_BOT' and v_paper_variant then
      'the bill bot has run out of paper and cannot print any bills — students at the counter are stuck in the queue.'
  when v_fac = 'BILL_BOT' then
      'the bill bot is jamming every ticket and printing blank bills — the queue is backing up during service.'
    when v_asset_name ilike 'Refrigerator%' then
      'the refrigerator at the counter is not cooling at all — milk and prep food are going warm and we cannot store anything safely.'
    when v_asset_name ilike '%Stove%' then
      'the induction stove on the counter keeps tripping and will not heat the pans during meal prep.'
    when v_asset_name ilike '%Coffee%' then
      'the coffee machine is not working at all — no heat, no steam, and there is a queue at the counter.'
    when v_asset_name ilike '%Warmer%' then
      'the food warmer is completely cold during service and the food is going lukewarm.'
    when v_asset_name ilike '%Smart Board%' then
      'the smart board is completely black and will not switch on during the lecture.'
    when v_asset_name ilike '%Ceiling Fan%' then
      'the ' || lower(v_asset_name) || ' is not spinning at all and the room feels stuffy with a full class.'
    when v_asset_name ilike '%LED%' then
      'the ' || lower(v_asset_name) || ' is flickering and half the fixtures near it are dark during the lecture.'
    when v_asset_name ilike '%Workstation%' then
      'the ' || lower(v_asset_name) || ' has no power and will not boot — students in the session cannot run their experiments.'
    else
      'the ' || lower(v_asset_name) || ' is not working at all and needs maintenance attention.'
  end;

  v_template := case
    when v_fac = 'BILL_BOT' and v_paper_variant then 'BOT_PAPER_OUT'
    when v_fac = 'BILL_BOT' then 'BOT_PRINT_JAM'
    when v_asset_name ilike 'Refrigerator%' then 'CAN_FRIDGE_WARM'
    when v_asset_name ilike '%Stove%' then 'CAN_STOVE_TRIP'
    when v_asset_name ilike '%Coffee%' then 'CAN_COFFEE_COLD'
    when v_asset_name ilike '%Warmer%' then 'CAN_WARMER_COLD'
    when v_asset_name ilike '%Smart Board%' then 'ROOM_BOARD_BLACK'
    when v_asset_name ilike '%Ceiling Fan%' then 'ROOM_FAN_STALLED'
    when v_asset_name ilike '%LED%' then 'ROOM_LED_DARK'
    when v_asset_name ilike '%Workstation%' then 'LAB_WS_NO_POWER'
    else v_fac || '_GENERIC'
  end;

  if v_fac = 'CANTEEN' then
    v_description := 'At ' || v_space || ' (' || coalesce(v_label, 'canteen') || '), ' || v_body;
  elsif v_fac = 'BILL_BOT' then
    v_description := 'At ' || v_space || ', ' || v_body;
  else
    v_description := 'In ' || v_space || ', ' || v_body;
  end if;

  select email into v_reporter
    from public.users
   where role = 'STUDENT' and is_active
   order by random()
   limit 1;
  if v_reporter is null then
    v_reporter := 'student@nosih.edu.in';
  end if;
  v_anon := random() < 0.35;

  v_res := public.rpc_submit_complaint(jsonb_build_object(
    'email', v_reporter,
    'is_anonymous', v_anon,
    'space_code', v_space,
    'description', v_description,
    'source_channel', 'SIMULATION',
    'target_assets', jsonb_build_array(jsonb_build_object('asset_codes', jsonb_build_array(v_asset_code)))
  ));

  if coalesce(v_res->>'success', '') is distinct from 'true' then
    return jsonb_build_object('fired', false, 'reason', 'SUBMIT_FAILED', 'detail', v_res);
  end if;

  v_complaint_id := nullif(v_res #>> '{complaint,id}', '')::int;
  v_ticket := v_res #>> '{complaint,ticket_number}';

  select id, wo_number into v_wo_id, v_wo_number
    from public.work_orders
   where complaint_id = v_complaint_id
   order by id desc
   limit 1;

  select id into v_sla_id
    from public.sla_clocks
   where target_type = 'WORK_ORDER' and target_id = v_wo_id
   order by id desc
   limit 1;

  insert into public.simulation_events (
    template_key, facility_kind, space_code, asset_codes, prior_asset_states,
    prior_paper_roll_pct, prior_queue_count, prior_rerouted_to_bot_code,
    complaint_id, ticket_number, work_order_id, work_order_number, sla_clock_id,
    reporter_email, is_anonymous, description
  ) values (
    v_template, v_fac, v_space, jsonb_build_array(v_asset_code), v_prior_assets,
    v_prior_paper, v_prior_queue, v_prior_reroute,
    v_complaint_id, v_ticket, v_wo_id, v_wo_number, v_sla_id,
    v_reporter, v_anon, v_description
  );

  update public.simulation_config set last_injected_at = now(), updated_at = now() where id;

  perform public.nosih_append_audit('pulse@nosih.edu.in', 'SYSTEM_ADMIN', 'PULSE_INJECT', 'COMPLAINT',
    coalesce(v_ticket, v_space), 'ALLOWED', 'PULSE_FAULT_INJECTED', v_description,
    jsonb_build_object('facility_kind', v_fac, 'space_code', v_space,
                       'asset_code', v_asset_code, 'template_key', v_template));

  return jsonb_build_object('fired', true, 'facility_kind', v_fac, 'space_code', v_space,
                            'asset_code', v_asset_code, 'template_key', v_template,
                            'ticket_number', v_ticket, 'work_order_id', v_wo_id,
                            'work_order_number', v_wo_number,
                            'sla_clock_id', v_sla_id, 'description', v_description);
end;
$$;

-- Auto-heal: when enabled, complete aged simulated work orders (assigning the
-- top-ranked technician first if needed) so analytics, SLA closures and asset
-- history keep growing. Returns the number of healed events.
create or replace function public.nosih_pulse_heal()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hours integer;
  v_ev record;
  v_staff text;
  v_status text;
  v_done jsonb;
  v_healed integer := 0;
begin
  select coalesce(auto_heal_hours, 0) into v_hours from public.simulation_config where id;
  if v_hours is null or v_hours <= 0 then
    return 0;
  end if;

  for v_ev in
    select e.id, e.work_order_id, e.space_code, e.prior_paper_roll_pct,
           w.status as wo_status, w.required_skill, w.required_risk_clearance
      from public.simulation_events e
      join public.work_orders w on w.id = e.work_order_id
     where e.status = 'ACTIVE'
       and w.status in ('PENDING_ASSIGNMENT', 'ASSIGNED', 'IN_PROGRESS')
       and w.created_at < now() - make_interval(hours => v_hours)
     order by e.id
  loop
    if v_ev.wo_status = 'PENDING_ASSIGNMENT' then
      -- Cron context has no session, so the session-bound ranking RPC cannot be
      -- used. Apply the same hard gates directly and pick the least-loaded
      -- matching technician.
      select sp.staff_code into v_staff
        from public.staff_profiles sp
       where sp.primary_skill = v_ev.required_skill
         and sp.is_on_shift
         and not sp.is_on_leave
         and sp.current_active_jobs < sp.max_concurrent_jobs
         and (v_ev.required_risk_clearance = 'STANDARD'
              or sp.risk_clearance = v_ev.required_risk_clearance)
       order by sp.current_active_jobs, sp.staff_code
       limit 1;
      if v_staff is null then
        continue;
      end if;
      update public.work_orders
         set assigned_staff_code = v_staff, status = 'ASSIGNED'
       where id = v_ev.work_order_id;
      update public.staff_profiles
         set current_active_jobs = current_active_jobs + 1
       where staff_code = v_staff;
      perform public.nosih_append_audit('pulse@nosih.edu.in', 'SYSTEM_ADMIN', 'PULSE_AUTO_ASSIGN', 'WORK_ORDER',
        v_ev.work_order_id::text, 'ALLOWED', 'PULSE_TECHNICIAN_ASSIGNED',
        'Auto-assigned ' || v_staff || ' during the pulse heal pass',
        jsonb_build_object('event_id', v_ev.id, 'staff_code', v_staff));
    end if;

    select status into v_status from public.work_orders where id = v_ev.work_order_id;
    if v_status in ('ASSIGNED', 'IN_PROGRESS') then
      v_done := public.rpc_complete_work_order(
        v_ev.work_order_id,
        'Auto-resolved by the campus pulse: repair verified and equipment restored to service.',
        'facilities@nosih.edu.in');
      if coalesce(v_done->>'success', '') is distinct from 'true' then
        continue;
      end if;
      update public.simulation_events
         set status = 'COMPLETED', closed_at = now()
       where id = v_ev.id;
      if v_ev.prior_paper_roll_pct is not null then
        update public.bill_bots
           set paper_roll_pct = v_ev.prior_paper_roll_pct
         where code = v_ev.space_code;
      end if;
      perform public.nosih_append_audit('pulse@nosih.edu.in', 'SYSTEM_ADMIN', 'PULSE_HEAL', 'WORK_ORDER',
        v_ev.work_order_id::text, 'ALLOWED', 'PULSE_EVENT_HEALED',
        'Simulated work order auto-completed after the configured heal window',
        jsonb_build_object('event_id', v_ev.id, 'space_code', v_ev.space_code));
      v_healed := v_healed + 1;
    end if;
  end loop;

  return v_healed;
end;
$$;

create or replace function public.rpc_pulse_tick()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg public.simulation_config%rowtype;
  v_open integer;
  v_healed integer;
  v_inject jsonb;
begin
  select * into v_cfg from public.simulation_config where id;
  if not found then
    return jsonb_build_object('fired', false, 'reason', 'NO_CONFIG');
  end if;

  update public.simulation_config set last_tick_at = now() where id;

  if not v_cfg.enabled then
    return jsonb_build_object('fired', false, 'reason', 'PAUSED');
  end if;

  v_healed := public.nosih_pulse_heal();

  if v_cfg.last_injected_at is not null
     and v_cfg.last_injected_at + make_interval(mins => v_cfg.interval_minutes) > now() then
    return jsonb_build_object('fired', false, 'reason', 'COOLDOWN', 'healed', v_healed);
  end if;

  select count(*) into v_open from public.simulation_events where status = 'ACTIVE';
  if v_open >= v_cfg.max_open_simulated then
    return jsonb_build_object('fired', false, 'reason', 'CAP_REACHED', 'open_simulated', v_open, 'healed', v_healed);
  end if;

  v_inject := public.nosih_pulse_inject();
  return coalesce(v_inject, jsonb_build_object('fired', false, 'reason', 'INJECT_NULL')) || jsonb_build_object('healed', v_healed);
end;
$$;

revoke all on function public.rpc_pulse_tick() from public, anon, authenticated;
revoke all on function public.nosih_pulse_inject() from public, anon, authenticated;
revoke all on function public.nosih_pulse_heal() from public, anon, authenticated;

create or replace function public.rpc_pulse_status()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg public.simulation_config%rowtype;
begin
  if not public.nosih_is_campus_reader() then
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN');
  end if;

  select * into v_cfg from public.simulation_config where id;

  return jsonb_build_object(
    'success', true,
    'enabled', v_cfg.enabled,
    'interval_minutes', v_cfg.interval_minutes,
    'max_open_simulated', v_cfg.max_open_simulated,
    'auto_heal_hours', v_cfg.auto_heal_hours,
    'last_injected_at', v_cfg.last_injected_at,
    'last_tick_at', v_cfg.last_tick_at,
    'open_simulated', (select count(*) from public.simulation_events where status = 'ACTIVE'),
    'injected_24h', (select count(*) from public.simulation_events
                      where created_at > now() - interval '24 hours'),
    'healed_24h', (select count(*) from public.simulation_events
                    where status = 'COMPLETED' and closed_at > now() - interval '24 hours'),
    'active_events', coalesce((
      select jsonb_agg(to_jsonb(e) order by e.id desc)
        from (select * from public.simulation_events
               where status = 'ACTIVE' order by id desc limit 10) e),
      '[]'::jsonb),
    'recent_events', coalesce((
      select jsonb_agg(to_jsonb(e) order by e.id desc)
        from (select * from public.simulation_events order by id desc limit 15) e),
      '[]'::jsonb)
  );
end;
$$;

create or replace function public.rpc_pulse_configure(
  p_enabled boolean default null,
  p_interval_minutes integer default null,
  p_max_open_simulated integer default null,
  p_auto_heal_hours integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.nosih_is_privileged_admin() then
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN');
  end if;

  update public.simulation_config set
    enabled = coalesce(p_enabled, enabled),
    interval_minutes = coalesce(p_interval_minutes, interval_minutes),
    max_open_simulated = coalesce(p_max_open_simulated, max_open_simulated),
    auto_heal_hours = coalesce(p_auto_heal_hours, auto_heal_hours),
    updated_at = now()
   where id;

  perform public.nosih_append_audit(public.nosih_actor_email(), 'SYSTEM_ADMIN', 'PULSE_CONFIGURE', 'SIMULATION', 'pulse',
    'ALLOWED', 'PULSE_CONFIGURED', 'Campus pulse configuration updated',
    jsonb_build_object('enabled', p_enabled, 'interval_minutes', p_interval_minutes,
                       'max_open_simulated', p_max_open_simulated, 'auto_heal_hours', p_auto_heal_hours));

  return jsonb_build_object('success', true) || (select to_jsonb(c) from public.simulation_config c where id);
end;
$$;

create or replace function public.rpc_pulse_run_now()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.nosih_is_privileged_admin() then
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN');
  end if;
  return public.nosih_pulse_inject();
end;
$$;

create or replace function public.rpc_pulse_revert(p_event_id integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ev public.simulation_events%rowtype;
  v_asset jsonb;
  v_open integer;
begin
  if not public.nosih_is_privileged_admin() then
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN');
  end if;

  select * into v_ev from public.simulation_events where id = p_event_id for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'EVENT_NOT_FOUND');
  end if;
  if v_ev.status <> 'ACTIVE' then
    return jsonb_build_object('success', true, 'status', v_ev.status, 'already_closed', true);
  end if;

  if v_ev.work_order_id is not null then
    update public.work_orders
       set status = 'CANCELLED', completed_at = now()
     where id = v_ev.work_order_id and status not in ('COMPLETED', 'CANCELLED');
  end if;

  if v_ev.complaint_id is not null then
    update public.complaints
       set status = 'RESOLVED', updated_at = now()
     where id = v_ev.complaint_id and status not in ('RESOLVED', 'CLOSED');
  end if;

  if v_ev.sla_clock_id is not null then
    update public.sla_clocks
       set is_paused = true, pause_reason = 'SIMULATION_RESET'
     where id = v_ev.sla_clock_id;
  end if;

  for v_asset in select value from jsonb_array_elements(coalesce(v_ev.prior_asset_states, '[]'::jsonb))
  loop
    update public.assets
       set status = v_asset->>'status'
     where asset_code = v_asset->>'asset_code';
  end loop;

  if v_ev.facility_kind = 'BILL_BOT' then
    update public.bill_bots
       set paper_roll_pct = coalesce(v_ev.prior_paper_roll_pct, paper_roll_pct),
           active_queue_count = coalesce(v_ev.prior_queue_count, active_queue_count),
           rerouted_to_bot_code = coalesce(v_ev.prior_rerouted_to_bot_code, rerouted_to_bot_code)
     where code = v_ev.space_code;
  end if;

  select count(*) into v_open
    from public.complaints
   where space_code = v_ev.space_code
     and id is distinct from v_ev.complaint_id
     and status not in ('RESOLVED', 'CLOSED', 'MERGED_DUPLICATE');

  if v_open = 0 then
    perform public.nosih_recompute_space_state(v_ev.space_code);
  end if;

  update public.simulation_events
     set status = 'REVERTED', closed_at = now()
   where id = v_ev.id;

  perform public.nosih_append_audit(public.nosih_actor_email(), 'SYSTEM_ADMIN', 'PULSE_REVERT', 'SIMULATION',
    coalesce(v_ev.ticket_number, v_ev.id::text), 'ALLOWED', 'PULSE_EVENT_REVERTED',
    'Simulated fault reverted to its pre-injection state',
    jsonb_build_object('event_id', v_ev.id, 'space_code', v_ev.space_code));

  return jsonb_build_object('success', true, 'status', 'REVERTED', 'event_id', v_ev.id,
                            'space_code', v_ev.space_code);
end;
$$;

grant execute on function public.rpc_pulse_status() to authenticated;
grant execute on function public.rpc_pulse_configure(boolean, integer, integer, integer) to authenticated;
grant execute on function public.rpc_pulse_run_now() to authenticated;
grant execute on function public.rpc_pulse_revert(integer) to authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'nosih-campus-pulse') then
    perform cron.unschedule('nosih-campus-pulse');
  end if;
  perform cron.schedule('nosih-campus-pulse', '* * * * *', 'select public.rpc_pulse_tick()');
end $$;
