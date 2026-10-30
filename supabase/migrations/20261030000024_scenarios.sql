-- Replayable disruption scenarios.
-- A run creates real complaints, work orders, SLA clocks and twin damage, records
-- exactly what it changed, and can be reverted so the demo can be repeated.

create table if not exists public.scenario_runs (
  id serial primary key,
  scenario_key text not null,
  title text not null,
  status text not null default 'RUNNING',
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  summary_json jsonb not null default '{}'::jsonb,
  created_by text,
  created_at timestamptz not null default now()
);

alter table public.scenario_runs enable row level security;
drop policy if exists scenario_runs_read on public.scenario_runs;
create policy scenario_runs_read on public.scenario_runs
  for select to authenticated using (public.is_admin());

create or replace function public.rpc_list_scenarios()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(r) order by r.id desc), '[]'::jsonb)
    from (
      select id, scenario_key, title, status, started_at, completed_at,
             summary_json, created_by, created_at
        from public.scenario_runs
       order by id desc
       limit 20
    ) r
$$;

create or replace function public.rpc_run_scenario(
  p_key text,
  p_actor_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.nosih_actor_role(p_actor_email);
  v_run public.scenario_runs%rowtype;
  v_space text;
  v_space_type text;
  v_title text;
  v_description text;
  v_prior_assets jsonb;
  v_complaint jsonb;
  v_complaint_id integer;
  v_ticket text;
  v_wo_id integer;
  v_wo_number text;
  v_sla_id integer;
  v_summary jsonb;
  v_open integer;
begin
  if v_role is null or v_role not in ('INCIDENT_MANAGER', 'FACILITIES_ADMIN', 'SYSTEM_ADMIN') then
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN');
  end if;
  if p_key not in ('WATER_LEAK', 'POWER_FAULT_LAB') then
    return jsonb_build_object('success', false, 'error', 'UNKNOWN_SCENARIO');
  end if;

  select * into v_run
    from public.scenario_runs
   where scenario_key = p_key and status in ('RUNNING', 'COMPLETED')
   order by id desc limit 1;
  if found then
    return jsonb_build_object('success', true, 'idempotent', true, 'run_id', v_run.id,
                              'status', v_run.status) || v_run.summary_json;
  end if;

  if p_key = 'WATER_LEAK' then
    select r.code into v_space
      from public.rooms r
     where r.visual_state = 'HEALTHY'
       and not exists (
         select 1 from public.complaints c
          where c.space_code = r.code and c.status not in ('RESOLVED', 'CLOSED', 'MERGED_DUPLICATE'))
     order by (r.code = 'C4-03') desc, r.code
     limit 1;
    v_space_type := 'ROOM';
    v_title := 'Water leak in a live classroom';
    v_description := 'Water is leaking through the ceiling in ' || v_space ||
      ' and pooling across the floor during the lecture. Two ceiling fans are wet and the lights are flickering.';
  else
    select l.code into v_space
      from public.labs l
     where l.visual_state = 'HEALTHY'
       and not exists (
         select 1 from public.complaints c
          where c.space_code = l.code and c.status not in ('RESOLVED', 'CLOSED', 'MERGED_DUPLICATE'))
     order by (l.code = 'LAB-ELEC-01') desc, l.code
     limit 1;
    v_space_type := 'LAB';
    v_title := 'Electrical fire risk in a lab';
    v_description := 'There is a burning smell and sparks from the electrical panel in ' || v_space ||
      '. The main switch is buzzing and the lab is being evacuated.';
  end if;

  if v_space is null then
    return jsonb_build_object('success', false, 'error', 'NO_HEALTHY_SPACE');
  end if;

  insert into public.scenario_runs (scenario_key, title, status, created_by)
  values (p_key, v_title, 'RUNNING', p_actor_email)
  returning * into v_run;

  select coalesce(jsonb_agg(jsonb_build_object('asset_code', a.asset_code, 'status', a.status)), '[]'::jsonb)
    into v_prior_assets
    from (
      select asset_code, status
        from public.assets
       where parent_space_code = v_space
       order by slot_index, asset_code
       limit 4
    ) a;

  if v_space_type = 'ROOM' then
    update public.assets
       set status = 'DEGRADED'
     where asset_code in (select value->>'asset_code' from jsonb_array_elements(v_prior_assets));
    update public.rooms set visual_state = 'FAULTY' where code = v_space;
  else
    update public.assets
       set status = 'FAULTY'
     where asset_code in (select value->>'asset_code' from jsonb_array_elements(v_prior_assets));
    update public.labs set visual_state = 'FAULTY' where code = v_space;
  end if;

  v_complaint := public.rpc_submit_complaint(jsonb_build_object(
    'email', coalesce(p_actor_email, 'incident@nosih.edu.in'),
    'is_anonymous', false,
    'space_code', v_space,
    'description', v_description,
    'source_channel', 'SIMULATION'));

  v_complaint_id := nullif(v_complaint #>> '{complaint,id}', '')::int;
  v_ticket := v_complaint #>> '{complaint,ticket_number}';

  if v_complaint_id is null then
    update public.scenario_runs
       set status = 'FAILED', completed_at = now(),
           summary_json = jsonb_build_object('error', v_complaint)
     where id = v_run.id;
    return jsonb_build_object('success', false, 'error', 'COMPLAINT_FAILED', 'detail', v_complaint);
  end if;

  select id, wo_number into v_wo_id, v_wo_number
    from public.work_orders
   where complaint_id = v_complaint_id
   order by id desc limit 1;

  select id into v_sla_id
    from public.sla_clocks
   where target_type = 'WORK_ORDER' and target_id = v_wo_id
   order by id desc limit 1;

  v_summary := jsonb_build_object(
    'scenario_key', p_key,
    'title', v_title,
    'space_code', v_space,
    'space_type', v_space_type,
    'complaint_id', v_complaint_id,
    'ticket_number', v_ticket,
    'work_order_id', v_wo_id,
    'work_order_number', v_wo_number,
    'sla_clock_id', v_sla_id,
    'prior_assets', v_prior_assets,
    'description', v_description);

  update public.scenario_runs
     set status = 'COMPLETED', completed_at = now(), summary_json = v_summary
   where id = v_run.id;

  perform public.nosih_append_audit(p_actor_email, v_role, 'RUN_SCENARIO', 'SCENARIO', p_key,
    'ALLOWED', 'SCENARIO_STARTED', v_title, v_summary);

  return jsonb_build_object('success', true, 'idempotent', false, 'run_id', v_run.id,
                            'status', 'COMPLETED') || v_summary;
end;
$$;

create or replace function public.rpc_reset_scenario(
  p_run_id integer,
  p_actor_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.nosih_actor_role(p_actor_email);
  v_run public.scenario_runs%rowtype;
  v_complaint_id integer;
  v_work_order_id integer;
  v_sla_id integer;
  v_space text;
  v_space_type text;
  v_asset jsonb;
  v_open integer;
begin
  if v_role is null or v_role not in ('INCIDENT_MANAGER', 'FACILITIES_ADMIN', 'SYSTEM_ADMIN') then
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN');
  end if;

  select * into v_run from public.scenario_runs where id = p_run_id for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'RUN_NOT_FOUND');
  end if;
  if v_run.status = 'REVERTED' then
    return jsonb_build_object('success', true, 'status', 'REVERTED', 'already_reverted', true);
  end if;

  v_complaint_id := nullif(v_run.summary_json->>'complaint_id', '')::int;
  v_work_order_id := nullif(v_run.summary_json->>'work_order_id', '')::int;
  v_sla_id := nullif(v_run.summary_json->>'sla_clock_id', '')::int;
  v_space := v_run.summary_json->>'space_code';
  v_space_type := v_run.summary_json->>'space_type';

  if v_work_order_id is not null then
    update public.work_orders
       set status = 'CANCELLED', completed_at = now()
     where id = v_work_order_id and status not in ('COMPLETED', 'CANCELLED');
  end if;

  if v_complaint_id is not null then
    update public.complaints
       set status = 'RESOLVED', updated_at = now()
     where id = v_complaint_id and status not in ('RESOLVED', 'CLOSED');
  end if;

  if v_sla_id is not null then
    update public.sla_clocks
       set is_paused = true, pause_reason = 'SCENARIO_RESET'
     where id = v_sla_id;
  end if;

  for v_asset in select value from jsonb_array_elements(coalesce(v_run.summary_json->'prior_assets', '[]'::jsonb))
  loop
    update public.assets set status = v_asset->>'status' where asset_code = v_asset->>'asset_code';
  end loop;

  select count(*) into v_open
    from public.complaints
   where space_code = v_space
     and id is distinct from v_complaint_id
     and status not in ('RESOLVED', 'CLOSED', 'MERGED_DUPLICATE');

  if v_open = 0 and v_space is not null then
    if v_space_type = 'LAB' then
      update public.labs set visual_state = 'HEALTHY' where code = v_space;
    else
      update public.rooms set visual_state = 'HEALTHY' where code = v_space;
    end if;
  end if;

  update public.scenario_runs
     set status = 'REVERTED', completed_at = now()
   where id = v_run.id;

  perform public.nosih_append_audit(p_actor_email, v_role, 'RESET_SCENARIO', 'SCENARIO', v_run.scenario_key,
    'ALLOWED', 'SCENARIO_REVERTED', 'Scenario restored to its pre-run state',
    jsonb_build_object('run_id', v_run.id, 'space_code', v_space));

  return jsonb_build_object('success', true, 'status', 'REVERTED', 'already_reverted', false,
                            'run_id', v_run.id, 'space_code', v_space,
                            'complaint_resolved', v_complaint_id is not null,
                            'work_order_cancelled', v_work_order_id is not null);
end;
$$;

grant execute on function public.rpc_list_scenarios() to authenticated;
grant execute on function public.rpc_run_scenario(text, text) to authenticated;
grant execute on function public.rpc_reset_scenario(integer, text) to authenticated;
