-- Officer appointment: a request owns an officer from the moment it is raised.
--
-- Before, a complaint produced a work order in PENDING_ASSIGNMENT and waited
-- for a facilities administrator to open the dispatch board. Every channel
-- (web form, chat, email, scenario, campus pulse) now appoints an area
-- officer automatically: the hard gates (skill, risk clearance, shift, leave,
-- capacity, resource lock) are applied first, then the area the request came
-- from decides between the survivors, and the officer's workload is updated.
-- When the conditions change - shift ended, leave taken, job load - the open
-- jobs move to the next ranked officer instead of going stale.
--
-- The ranking itself lives in nosih_rank_officers, which the dispatch board
-- also uses. The board entry point keeps its RBAC gate and delegates to that
-- core, so an automatic appointment and a manual one can never disagree.

-- 1. The area a space belongs to ---------------------------------------------
create or replace function public.nosih_space_area(p_space_code text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when p_space_code is null then null
    when upper(p_space_code) like 'LAB-%' then 'LAB_WING'
    when upper(p_space_code) ~ '^[ABC][0-9]+-[0-9]+$' then left(upper(p_space_code), 1)
    else 'C'
  end
$$;

-- 2. The officer payload the portals render ----------------------------------
create or replace function public.nosih_officer_json(p_staff_code text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'staff_code', sp.staff_code,
    'full_name', u.full_name,
    'primary_skill', sp.primary_skill,
    'skill_proficiency', sp.skill_proficiency,
    'area', sp.current_block_location,
    'assigned_jobs', sp.current_active_jobs,
    'max_jobs', sp.max_concurrent_jobs,
    'hourly_cost_inr', sp.hourly_cost_inr
  )
    from public.staff_profiles sp
    join public.users u on u.id = sp.user_id
   where sp.staff_code = p_staff_code
   limit 1
$$;

create or replace function public.nosih_complaint_officer(p_complaint_id integer)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.nosih_officer_json(w.assigned_staff_code), '{}'::jsonb)
         || jsonb_build_object(
              'area', public.nosih_space_area(w.space_code),
              'work_order_number', w.wo_number,
              'work_order_status', w.status,
              'assigned_at', w.created_at)
    from public.work_orders w
   where w.complaint_id = p_complaint_id
     and w.assigned_staff_code is not null
   order by w.id desc
   limit 1
$$;

-- 3. The ranking core, usable without a session ------------------------------
create or replace function public.nosih_rank_officers(
  p_work_order_id integer,
  p_holder_email text default ''
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_wo public.work_orders%rowtype;
  v_urgency numeric := 2.0;
  v_wo_block text;
  v_result jsonb;
  v_email text := coalesce(p_holder_email, '');
begin
  select * into v_wo from public.work_orders where id = p_work_order_id;
  if not found then
    return jsonb_build_object('error', 'WORK_ORDER_NOT_FOUND', 'work_order_id', p_work_order_id);
  end if;

  v_wo_block := public.nosih_space_area(v_wo.space_code);

  select case urgency when 'LOW' then 1.0 when 'MEDIUM' then 2.0 when 'HIGH' then 4.0 when 'CRITICAL' then 5.0 else 2.0 end
    into v_urgency
    from public.sla_clocks
   where target_type = 'WORK_ORDER' and target_id = v_wo.id
   limit 1;
  if v_urgency is null then
    v_urgency := case when v_wo.priority_score >= 90 then 5.0
                      when v_wo.priority_score >= 70 then 4.0
                      when v_wo.priority_score >= 40 then 2.0
                      else 1.0 end;
  end if;

  with base as (
    select sp.staff_code, sp.user_id, u.full_name, sp.primary_skill, sp.skill_proficiency,
           sp.risk_clearance, sp.is_on_shift, sp.is_on_leave, u.is_active,
           sp.current_active_jobs, sp.max_concurrent_jobs, sp.hourly_cost_inr,
           sp.current_block_location,
           case
             when sp.primary_skill <> v_wo.required_skill then 'GATE_1_SKILL_MISMATCH'
             when v_wo.required_risk_clearance <> 'STANDARD'
                  and sp.risk_clearance <> v_wo.required_risk_clearance then 'GATE_2_RISK_CLEARANCE'
             when not sp.is_on_shift then 'GATE_3_OFF_SHIFT'
             when sp.is_on_leave then 'GATE_3_ON_LEAVE'
             when not u.is_active then 'GATE_3_INACTIVE_USER'
             when sp.current_active_jobs >= sp.max_concurrent_jobs then 'GATE_4_CAPACITY'
             when exists (select 1 from public.resource_locks l
                           where l.resource_type = 'STAFF' and l.resource_id = sp.staff_code
                             and l.expires_at > now() and lower(l.holder_email) <> lower(v_email)) then 'GATE_5_RESOURCE_LOCKED'
             else null
           end as gate,
           case
             when sp.primary_skill <> v_wo.required_skill
               then 'PRIMARY_SKILL_MISMATCH (Required ' || v_wo.required_skill || ', actual ' || coalesce(sp.primary_skill, 'none') || ')'
             when v_wo.required_risk_clearance <> 'STANDARD'
                  and sp.risk_clearance <> v_wo.required_risk_clearance
               then 'RISK_CLEARANCE_INSUFFICIENT (Required ' || v_wo.required_risk_clearance || ', actual ' || coalesce(sp.risk_clearance, 'none') || ')'
             when not sp.is_on_shift then 'OFF_SHIFT'
             when sp.is_on_leave then 'ON_LEAVE'
             when not u.is_active then 'USER_INACTIVE'
             when sp.current_active_jobs >= sp.max_concurrent_jobs
               then 'MAX_CONCURRENT_JOBS_REACHED (' || sp.current_active_jobs || '/' || sp.max_concurrent_jobs || ')'
             when exists (select 1 from public.resource_locks l
                           where l.resource_type = 'STAFF' and l.resource_id = sp.staff_code
                             and l.expires_at > now() and lower(l.holder_email) <> lower(v_email)) then 'LOCKED_BY_ANOTHER_ADMIN'
             else null
           end as gate_reason,
           least(5.0, greatest(0.0, v_wo.priority_score / 20.0)) as priority_fit,
           case
             when sp.current_block_location = v_wo_block then 0
             when sp.current_block_location in ('A', 'B', 'C', 'LAB_WING')
               then abs(public.nosih_block_rank(sp.current_block_location) - public.nosih_block_rank(v_wo_block))
             else 2
           end as block_distance
      from public.staff_profiles sp
      join public.users u on u.id = sp.user_id
     where sp.staff_category = 'MAINTENANCE_TECH'
  ), scored as (
    select b.*,
           round((
             2.0 * b.skill_proficiency
             + 3.0 * b.priority_fit
             - 1.5 * b.current_active_jobs
             - 0.8 * b.block_distance
             - b.hourly_cost_inr / 200.0
             + 1.5 * v_urgency
           )::numeric, 4) as score
      from base b
  )
  select jsonb_build_object(
    'work_order_id', v_wo.id,
    'work_order_number', v_wo.wo_number,
    'required_skill', v_wo.required_skill,
    'required_risk_clearance', v_wo.required_risk_clearance,
    'available_ranked', coalesce(
      jsonb_agg(jsonb_build_object(
        'staff_code', s.staff_code, 'user_id', s.user_id, 'full_name', s.full_name,
        'primary_skill', s.primary_skill, 'skill_proficiency', s.skill_proficiency,
        'risk_clearance', s.risk_clearance, 'is_on_shift', s.is_on_shift, 'is_on_leave', s.is_on_leave,
        'current_active_jobs', s.current_active_jobs,
        'max_concurrent_jobs', s.max_concurrent_jobs,
        'current_block_location', s.current_block_location,
        'score', s.score,
        'breakdown', jsonb_build_object(
          'inputs', jsonb_build_object(
            'skill_proficiency', s.skill_proficiency, 'priority_fit', s.priority_fit,
            'current_active_jobs', s.current_active_jobs, 'block_distance', s.block_distance,
            'hourly_cost_inr', s.hourly_cost_inr, 'sla_urgency_factor', v_urgency
          ),
          'terms', jsonb_build_object(
            'skill', round((2.0 * s.skill_proficiency)::numeric, 4),
            'priority_fit', round((3.0 * s.priority_fit)::numeric, 4),
            'active_jobs', round((-1.5 * s.current_active_jobs)::numeric, 4),
            'block_distance', round((-0.8 * s.block_distance)::numeric, 4),
            'hourly_cost', round((-1.0 * s.hourly_cost_inr / 200.0)::numeric, 4),
            'sla_urgency', round((1.5 * v_urgency)::numeric, 4)
          ),
          'formula', '2*skill + 3*priority_fit - 1.5*active_jobs - 0.8*block_distance - hourly_cost/200 + 1.5*sla_urgency'
        )
      ) order by s.score desc, s.staff_code) filter (where s.gate is null),
      '[]'::jsonb
    ),
    'unavailable_staff', coalesce(
      jsonb_agg(jsonb_build_object(
        'staff_code', s.staff_code, 'full_name', s.full_name,
        'failed_gate', s.gate, 'reason', s.gate_reason
      ) order by s.staff_code) filter (where s.gate is not null),
      '[]'::jsonb
    )
  )
  into v_result
  from scored s;

  return v_result;
end;
$$;

-- The dispatch board keeps its RBAC gate and delegates to the shared core.
do $$
declare
  v_def text;
  v_start integer;
  v_end integer;
  v_old text;
begin
  v_def := pg_get_functiondef('public.rpc_rank_staff_for_work_order(integer)'::regprocedure);
  if position('nosih_rank_delegate' in v_def) > 0 then
    return;
  end if;
  v_start := position('  with base as (' in v_def);
  v_end := position('  return v_result;' in v_def);
  if v_start = 0 or v_end = 0 or v_end < v_start then
    raise exception 'ranking delegation anchor missing';
  end if;
  v_old := substr(v_def, v_start, v_end - v_start + length('  return v_result;'));
  v_def := replace(v_def, v_old,
    '  return public.nosih_rank_officers(p_work_order_id, coalesce(v_email, '''')); -- nosih_rank_delegate');
  execute v_def;
end $$;

-- 4. Appoint the officer for one work order ----------------------------------
create or replace function public.nosih_appoint_officer(p_work_order_id integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wo public.work_orders%rowtype;
  v_ranking jsonb;
  v_staff text;
  v_officer jsonb;
begin
  select * into v_wo from public.work_orders where id = p_work_order_id for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'WORK_ORDER_NOT_FOUND');
  end if;

  -- Already owned: report the current officer and change nothing.
  if v_wo.assigned_staff_code is not null then
    return jsonb_build_object(
      'success', true,
      'work_order_id', v_wo.id,
      'already_assigned', true,
      'officer', coalesce(public.nosih_officer_json(v_wo.assigned_staff_code), '{}'::jsonb)
        || jsonb_build_object('area', public.nosih_space_area(v_wo.space_code)));
  end if;

  -- Same hard gates as the dispatch board ranking, then area and workload.
  v_ranking := public.nosih_rank_officers(p_work_order_id, '');
  v_staff := v_ranking->'available_ranked'->0->>'staff_code';

  if v_staff is null then
    perform public.nosih_append_audit('dispatch@nosih.edu.in', 'SYSTEM_ADMIN', 'APPOINT_OFFICER',
      'WORK_ORDER', v_wo.wo_number, 'REJECTED', 'NO_AVAILABLE_OFFICER',
      'No technician passed the skill, clearance, shift and capacity gates for ' || v_wo.space_code,
      jsonb_build_object('unavailable_staff', v_ranking->'unavailable_staff'));
    return jsonb_build_object(
      'success', false,
      'error', 'NO_AVAILABLE_OFFICER',
      'work_order_id', v_wo.id,
      'unavailable_staff', v_ranking->'unavailable_staff');
  end if;

  update public.work_orders
     set assigned_staff_code = v_staff,
         status = 'ASSIGNED',
         assignment_score_breakdown_json = coalesce(v_ranking->'available_ranked'->0, '{}'::jsonb)::text
   where id = v_wo.id;

  update public.staff_profiles
     set current_active_jobs = current_active_jobs + 1
   where staff_code = v_staff;

  v_officer := public.nosih_officer_json(v_staff)
    || jsonb_build_object('area', public.nosih_space_area(v_wo.space_code));

  perform public.nosih_append_audit('dispatch@nosih.edu.in', 'SYSTEM_ADMIN', 'APPOINT_OFFICER',
    'WORK_ORDER', v_wo.wo_number, 'ALLOWED', 'OFFICER_APPOINTED',
    'Area officer ' || v_staff || ' appointed for ' || v_wo.space_code,
    jsonb_build_object('staff_code', v_staff, 'area', public.nosih_space_area(v_wo.space_code),
                       'ranking', v_ranking->'available_ranked'->0));

  return jsonb_build_object(
    'success', true,
    'work_order_id', v_wo.id,
    'work_order_number', v_wo.wo_number,
    'already_assigned', false,
    'officer', v_officer);
end;
$$;

-- 5. Every new work order is owned immediately --------------------------------
create or replace function public.nosih_trg_appoint_officer()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'PENDING_ASSIGNMENT' and new.assigned_staff_code is null then
    perform public.nosih_appoint_officer(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_appoint_officer on public.work_orders;
create trigger trg_appoint_officer
  after insert on public.work_orders
  for each row execute function public.nosih_trg_appoint_officer();

-- 6. The complaint carries its officer ---------------------------------------
do $$
declare
  v_def text;
  v_old text := $old$    'target_assets', v_assets,
    'affected_count', c.affected_upvote_count,$old$;
  v_new text := $new$    'target_assets', v_assets,
    'officer', public.nosih_complaint_officer(c.id), -- nosih_officer_payload
    'affected_count', c.affected_upvote_count,$new$;
begin
  v_def := pg_get_functiondef('public.nosih_complaint_json(public.complaints,text)'::regprocedure);
  if position('nosih_officer_payload' in v_def) = 0 then
    if position(v_old in v_def) = 0 then
      raise exception 'complaint officer anchor missing';
    end if;
    v_def := replace(v_def, v_old, v_new);
    execute v_def;
  end if;
end $$;

-- 7. Reassign when the conditions change -------------------------------------
create or replace function public.nosih_reassign_officer_jobs(
  p_staff_code text,
  p_reason text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wo record;
  v_next text;
  v_count integer := 0;
begin
  for v_wo in
    select id, priority_score
      from public.work_orders
     where assigned_staff_code = p_staff_code
       and status in ('ASSIGNED', 'IN_PROGRESS')
     order by priority_score desc, id
  loop
    v_next := public.nosih_rank_officers(v_wo.id, '')->'available_ranked'->0->>'staff_code';
    if v_next is not null and v_next <> p_staff_code then
      update public.staff_profiles
         set current_active_jobs = greatest(0, current_active_jobs - 1)
       where staff_code = p_staff_code;
      update public.work_orders
         set assigned_staff_code = v_next,
             status = 'ASSIGNED',
             reassignment_count = reassignment_count + 1,
             last_reassignment_reason = p_reason
       where id = v_wo.id;
      update public.staff_profiles
         set current_active_jobs = current_active_jobs + 1
       where staff_code = v_next;
      perform public.nosih_append_audit('dispatch@nosih.edu.in', 'SYSTEM_ADMIN', 'REASSIGN_OFFICER',
        'WORK_ORDER', v_wo.id::text, 'ALLOWED', 'OFFICER_REASSIGNED',
        p_reason || ': ' || p_staff_code || ' to ' || v_next,
        jsonb_build_object('from_staff', p_staff_code, 'to_staff', v_next));
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

create or replace function public.rpc_set_staff_availability(
  p_staff_code text,
  p_on_shift boolean default null,
  p_on_leave boolean default null,
  p_actor_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.nosih_actor_role(p_actor_email);
  v_profile public.staff_profiles%rowtype;
  v_moved integer := 0;
begin
  if v_role is null or v_role not in ('INCIDENT_MANAGER', 'FACILITIES_ADMIN', 'SYSTEM_ADMIN') then
    perform public.nosih_append_audit(p_actor_email, coalesce(v_role, 'UNKNOWN'), 'SET_AVAILABILITY', 'STAFF',
      p_staff_code, 'REJECTED', 'RBAC_ROLE_NOT_PERMITTED', 'Role cannot change technician availability');
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN');
  end if;

  select * into v_profile from public.staff_profiles where staff_code = p_staff_code for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'STAFF_NOT_FOUND');
  end if;

  update public.staff_profiles
     set is_on_shift = coalesce(p_on_shift, is_on_shift),
         is_on_leave = coalesce(p_on_leave, is_on_leave)
   where staff_code = p_staff_code;

  if coalesce(p_on_shift, v_profile.is_on_shift) = false
     or coalesce(p_on_leave, v_profile.is_on_leave) = true then
    v_moved := public.nosih_reassign_officer_jobs(
      p_staff_code,
      case when coalesce(p_on_leave, v_profile.is_on_leave) then 'Officer placed on leave'
           else 'Shift ended for ' || p_staff_code end);
  end if;

  perform public.nosih_append_audit(p_actor_email, v_role, 'SET_AVAILABILITY', 'STAFF', p_staff_code,
    'ALLOWED', 'AVAILABILITY_UPDATED',
    'Availability changed; ' || v_moved || ' work orders reassigned',
    jsonb_build_object('on_shift', coalesce(p_on_shift, v_profile.is_on_shift),
                       'on_leave', coalesce(p_on_leave, v_profile.is_on_leave),
                       'reassigned', v_moved));

  return jsonb_build_object('success', true, 'staff_code', p_staff_code,
                            'reassigned', v_moved);
end;
$$;

grant execute on function public.nosih_space_area(text) to anon, authenticated;
grant execute on function public.nosih_officer_json(text) to authenticated;
grant execute on function public.nosih_complaint_officer(integer) to authenticated;
grant execute on function public.nosih_rank_officers(integer, text) to authenticated, service_role;
grant execute on function public.nosih_appoint_officer(integer) to service_role;
grant execute on function public.rpc_set_staff_availability(text, boolean, boolean, text) to authenticated;

-- 8. Guard: the officer must really be attached to the complaint payload -----
do $$
declare
  v_def text;
begin
  v_def := pg_get_functiondef('public.nosih_complaint_json(public.complaints,text)'::regprocedure);
  if position('nosih_officer_payload' in v_def) = 0 then
    raise exception 'complaint officer patch incomplete';
  end if;
  if position('nosih_appoint_officer' in
     pg_get_functiondef('public.nosih_trg_appoint_officer()'::regprocedure)) = 0 then
    raise exception 'officer trigger patch incomplete';
  end if;
  if position('nosih_rank_delegate' in
     pg_get_functiondef('public.rpc_rank_staff_for_work_order(integer)'::regprocedure)) = 0 then
    raise exception 'ranking delegation patch incomplete';
  end if;
end $$;
