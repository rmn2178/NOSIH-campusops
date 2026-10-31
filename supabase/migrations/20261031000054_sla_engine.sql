-- The SLA engine: a policy-driven clock with a response deadline, milestones,
-- escalation and a working-hours basis.
--
-- What changed:
--
--   * The clock no longer counts wall-clock minutes. It counts the minutes the
--     campus was open, unless the policy says the service runs 24x7.
--   * A request has two promises, not one: the response deadline (acknowledge
--     the issue) and the resolution deadline (fix it). The first staff reply or
--     status change is the response, and the response clock stops there.
--   * The clock pauses while the reporter is being asked for more details and
--     resumes when the answer arrives.
--   * Half time is a milestone, not just 75% and 100%: the officer and the
--     head of department are told before a deadline is at risk.
--   * A critical request that breaches is handed to the next ranked officer.

-- ----------------------------------------------------------------------
-- 1. The clock grows the fields the policy needs
-- ----------------------------------------------------------------------
alter table public.sla_clocks add column if not exists priority_code text;
alter table public.sla_clocks add column if not exists priority_label text;
alter table public.sla_clocks add column if not exists service_name text;
alter table public.sla_clocks add column if not exists policy_note text;
alter table public.sla_clocks add column if not exists is_24x7 boolean not null default false;
alter table public.sla_clocks add column if not exists response_elapsed_mins double precision not null default 0;
alter table public.sla_clocks add column if not exists first_response_at timestamptz;
alter table public.sla_clocks add column if not exists response_breach_state text not null default 'HEALTHY';
alter table public.sla_clocks add column if not exists last_milestone text;
alter table public.sla_clocks add column if not exists escalated_at timestamptz;

-- Existing clocks adopt the matrix that matches their urgency and category.
with policy as (
  select s.id as clock_id,
         public.nosih_sla_policy_for(s.urgency, c.category) as pol
    from public.sla_clocks s
    left join public.work_orders w
      on s.target_type = 'WORK_ORDER' and w.id = s.target_id
    left join public.complaints c on c.id = w.complaint_id
)
update public.sla_clocks s
   set priority_code = policy.pol->>'priority_code',
       priority_label = policy.pol->>'priority_label',
       service_name = policy.pol->>'service_name',
       policy_note = policy.pol->>'description',
       is_24x7 = (policy.pol->>'is_24x7')::boolean,
       response_target_mins = (policy.pol->>'response_target_mins')::integer,
       resolution_target_mins = (policy.pol->>'resolution_target_mins')::integer
  from policy
 where policy.clock_id = s.id;

-- ----------------------------------------------------------------------
-- 2. Intake takes its deadlines from the matrix
-- ----------------------------------------------------------------------
do $$
declare
  v_def text;
  v_old text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.rpc_submit_complaint(jsonb)'::regprocedure);
  if position('nosih_sla_policy_targets' in v_def) = 0 then
    v_old := '    v_sla_response := case v_urgency when ''LOW'' then 240 when ''MEDIUM'' then 120 when ''HIGH'' then 30 else 10 end;' || E'\n'
      || '    v_sla_resolution := case v_urgency when ''LOW'' then 2880 when ''MEDIUM'' then 1440 when ''HIGH'' then 240 else 60 end;';
    v_new := '    v_sla_response := (public.nosih_sla_policy_for(v_urgency, v_category)->>''response_target_mins'')::integer;' || E'\n'
      || '    v_sla_resolution := (public.nosih_sla_policy_for(v_urgency, v_category)->>''resolution_target_mins'')::integer;';
    if position(v_old in v_def) = 0 then
      raise exception 'intake SLA assignment anchor missing';
    end if;
    v_def := replace(v_def, v_old, v_new);

    v_old := '    insert into public.sla_clocks (' || E'\n'
      || '      target_type, target_id, space_code, urgency, response_target_mins,' || E'\n'
      || '      resolution_target_mins, elapsed_active_mins, is_paused, breach_state,' || E'\n'
      || '      current_escalation_tier, last_tick_at' || E'\n'
      || '    ) values (' || E'\n'
      || '      ''WORK_ORDER'', v_work_order_id, v_space_code, v_urgency, v_sla_response,' || E'\n'
      || '      v_sla_resolution, 0, false, ''HEALTHY'', 1, now()' || E'\n'
      || '    );';
    v_new := '    insert into public.sla_clocks (' || E'\n'
      || '      target_type, target_id, space_code, urgency, response_target_mins,' || E'\n'
      || '      resolution_target_mins, elapsed_active_mins, is_paused, breach_state,' || E'\n'
      || '      current_escalation_tier, last_tick_at, priority_code, priority_label,' || E'\n'
      || '      service_name, policy_note, is_24x7' || E'\n'
      || '    ) values (' || E'\n'
      || '      ''WORK_ORDER'', v_work_order_id, v_space_code, v_urgency, v_sla_response,' || E'\n'
      || '      v_sla_resolution, 0, false, ''HEALTHY'', 1, now(),' || E'\n'
      || '      public.nosih_sla_policy_for(v_urgency, v_category)->>''priority_code'',' || E'\n'
      || '      public.nosih_sla_policy_for(v_urgency, v_category)->>''priority_label'',' || E'\n'
      || '      public.nosih_sla_policy_for(v_urgency, v_category)->>''service_name'',' || E'\n'
      || '      public.nosih_sla_policy_for(v_urgency, v_category)->>''description'',' || E'\n'
      || '      (public.nosih_sla_policy_for(v_urgency, v_category)->>''is_24x7'')::boolean' || E'\n'
      || '    ); -- nosih_sla_policy_targets';
    if position(v_old in v_def) = 0 then
      raise exception 'intake SLA insert anchor missing';
    end if;
    execute replace(v_def, v_old, v_new);
  end if;
end $$;

do $$
declare
  v_def text;
  v_old text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.nosih_apply_complaint_ai(integer, jsonb)'::regprocedure);
  if position('nosih_sla_policy_targets' in v_def) = 0 then
    v_old := '  v_sla_response := case v_urgency when ''LOW'' then 240 when ''MEDIUM'' then 120 when ''HIGH'' then 30 else 10 end;' || E'\n'
      || '  v_sla_resolution := case v_urgency when ''LOW'' then 2880 when ''MEDIUM'' then 1440 when ''HIGH'' then 240 else 60 end;';
    v_new := '  v_sla_response := (public.nosih_sla_policy_for(v_urgency, v_category)->>''response_target_mins'')::integer;' || E'\n'
      || '  v_sla_resolution := (public.nosih_sla_policy_for(v_urgency, v_category)->>''resolution_target_mins'')::integer;';
    if position(v_old in v_def) = 0 then
      raise exception 'AI SLA assignment anchor missing';
    end if;
    v_def := replace(v_def, v_old, v_new);

    v_old := '    update public.sla_clocks' || E'\n'
      || '       set urgency = v_urgency,' || E'\n'
      || '           response_target_mins = v_sla_response,' || E'\n'
      || '           resolution_target_mins = v_sla_resolution' || E'\n'
      || '     where target_type = ''WORK_ORDER'' and target_id = v_work_order_id;';
    v_new := '    update public.sla_clocks' || E'\n'
      || '       set urgency = v_urgency,' || E'\n'
      || '           response_target_mins = v_sla_response,' || E'\n'
      || '           resolution_target_mins = v_sla_resolution,' || E'\n'
      || '           priority_code = public.nosih_sla_policy_for(v_urgency, v_category)->>''priority_code'',' || E'\n'
      || '           priority_label = public.nosih_sla_policy_for(v_urgency, v_category)->>''priority_label'',' || E'\n'
      || '           service_name = public.nosih_sla_policy_for(v_urgency, v_category)->>''service_name'',' || E'\n'
      || '           policy_note = public.nosih_sla_policy_for(v_urgency, v_category)->>''description'',' || E'\n'
      || '           is_24x7 = (public.nosih_sla_policy_for(v_urgency, v_category)->>''is_24x7'')::boolean' || E'\n'
      || '     where target_type = ''WORK_ORDER'' and target_id = v_work_order_id; -- nosih_sla_policy_targets';
    if position(v_old in v_def) = 0 then
      raise exception 'AI SLA update anchor missing';
    end if;
    execute replace(v_def, v_old, v_new);
  end if;
end $$;

-- ----------------------------------------------------------------------
-- 3. Who answers, who is told
-- ----------------------------------------------------------------------
-- The officer who owns the request.
create or replace function public.nosih_sla_officer_email(p_work_order_id integer)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select u.email
    from public.work_orders w
    join public.staff_profiles sp on sp.staff_code = w.assigned_staff_code
    join public.users u on u.id = sp.user_id
   where w.id = p_work_order_id
   limit 1
$$;

-- The head of the department that teaches in the affected space.
create or replace function public.nosih_sla_hod_email(p_space_code text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select u.email
    from public.department_spaces ds
    join public.users u
      on u.department_code = ds.department_code
     and u.role = 'DEPARTMENT_MANAGER'
     and u.is_active
   where ds.space_code = p_space_code
   limit 1
$$;

-- One notification row per recipient, with the event payload every consumer
-- (the console, the API service, the complaint portal) reads the same way.
create or replace function public.nosih_sla_notify(
  p_channel text,
  p_recipients text[],
  p_subject text,
  p_payload jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recipient text;
  v_sent integer := 0;
begin
  foreach v_recipient in array coalesce(p_recipients, '{}'::text[]) loop
    if v_recipient is null or btrim(v_recipient) = '' then
      continue;
    end if;
    insert into public.notification_logs (channel, recipient, subject, payload_json, delivery_status, created_at)
    values (coalesce(p_channel, 'EMAIL'), v_recipient, p_subject, p_payload::text, 'SENT', now());
    v_sent := v_sent + 1;
  end loop;
  return v_sent;
end;
$$;

-- ----------------------------------------------------------------------
-- 4. Escalation: a critical request that breaches changes hands
-- ----------------------------------------------------------------------
create or replace function public.nosih_sla_escalate_assignment(p_work_order_id integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wo public.work_orders%rowtype;
  v_ranking jsonb;
  v_new text;
  v_old text;
begin
  select * into v_wo from public.work_orders where id = p_work_order_id for update;
  if not found or v_wo.assigned_staff_code is null then
    return 0;
  end if;

  v_ranking := public.nosih_rank_officers(p_work_order_id, '');

  select candidate->>'staff_code' into v_new
    from jsonb_array_elements(coalesce(v_ranking->'available_ranked', '[]'::jsonb)) candidate
   where candidate->>'staff_code' <> v_wo.assigned_staff_code
   limit 1;

  if v_new is null then
    perform public.nosih_append_audit('sla@nosih.edu.in', 'SYSTEM', 'SLA_ESCALATION_REASSIGN',
      'WORK_ORDER', v_wo.wo_number, 'REJECTED', 'NO_ALTERNATE_OFFICER',
      'No other technician passes the gates for ' || v_wo.space_code,
      jsonb_build_object('current_officer', v_wo.assigned_staff_code));
    return 0;
  end if;

  v_old := v_wo.assigned_staff_code;

  update public.staff_profiles
     set current_active_jobs = greatest(0, current_active_jobs - 1)
   where staff_code = v_old;

  update public.work_orders
     set assigned_staff_code = v_new,
         status = 'ASSIGNED',
         reassignment_count = reassignment_count + 1,
         last_reassignment_reason = 'SLA_BREACH_ESCALATION'
   where id = v_wo.id;

  update public.staff_profiles
     set current_active_jobs = current_active_jobs + 1
   where staff_code = v_new;

  perform public.nosih_append_audit('sla@nosih.edu.in', 'SYSTEM', 'SLA_ESCALATION_REASSIGN',
    'WORK_ORDER', v_wo.wo_number, 'ALLOWED', 'SLA_BREACHED_REASSIGNED',
    'Critical request breached its resolution deadline and moved from ' || v_old || ' to ' || v_new,
    jsonb_build_object('previous_officer', v_old, 'new_officer', v_new,
                       'ranking', v_ranking->'available_ranked'));

  return 1;
end;
$$;

-- ----------------------------------------------------------------------
-- 5. The tick
-- ----------------------------------------------------------------------
create or replace function public.rpc_tick_sla_clocks()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sla public.sla_clocks%rowtype;
  v_delta integer;
  v_response_ratio numeric;
  v_resolution_ratio numeric;
  v_ticked integer := 0;
  v_warnings integer := 0;
  v_breaches integer := 0;
  v_milestones integer := 0;
  v_notifications integer := 0;
  v_reassigned integer := 0;
  v_officer text;
  v_hod text;
  v_recipients text[];
  v_payload jsonb;
begin
  perform public.nosih_clock_sync();

  for v_sla in
    select * from public.sla_clocks
     where not is_paused and closed_at is null
     order by id
     for update
  loop
    -- A finished work order closes its clock.
    if v_sla.target_type = 'WORK_ORDER' and exists (
      select 1 from public.work_orders w
       where w.id = v_sla.target_id
         and w.status in ('COMPLETED', 'CANCELLED', 'RESOLVED', 'CLOSED')
    ) then
      update public.sla_clocks
         set is_paused = true,
             closed_at = coalesce(closed_at, now()),
             closed_reason = coalesce(closed_reason, 'TARGET_RESOLVED'),
             last_tick_at = now()
       where id = v_sla.id;
      continue;
    end if;

    -- Only the minutes the campus was open count, unless the service is 24x7.
    v_delta := public.nosih_sla_operating_minutes(v_sla.last_tick_at, now(), v_sla.is_24x7);
    if v_delta <= 0 then
      update public.sla_clocks set last_tick_at = now() where id = v_sla.id;
      continue;
    end if;

    v_sla.elapsed_active_mins := v_sla.elapsed_active_mins + v_delta;
    if v_sla.first_response_at is null then
      v_sla.response_elapsed_mins := v_sla.response_elapsed_mins + v_delta;
    end if;
    v_sla.last_tick_at := now();

    v_officer := public.nosih_sla_officer_email(v_sla.target_id);
    v_hod := public.nosih_sla_hod_email(v_sla.space_code);
    v_recipients := (select coalesce(array_agg(distinct r), '{}'::text[])
                       from unnest(array_remove(array[v_officer, v_hod], null)) r);

    -- The response deadline is a promise of its own.
    v_response_ratio := case
      when v_sla.first_response_at is null
        then v_sla.response_elapsed_mins / greatest(1, v_sla.response_target_mins)
      else 0 end;

    if v_sla.first_response_at is null and v_response_ratio >= 1
       and v_sla.response_breach_state <> 'BREACHED_100' then
      v_sla.response_breach_state := 'BREACHED_100';
      v_payload := jsonb_build_object(
        'event', 'SLA_RESPONSE_BREACHED', 'target_type', v_sla.target_type,
        'target_id', v_sla.target_id, 'space_code', v_sla.space_code,
        'priority_code', v_sla.priority_code, 'urgency', v_sla.urgency,
        'response_target_mins', v_sla.response_target_mins,
        'response_elapsed_mins', round(v_sla.response_elapsed_mins::numeric, 2));
      v_notifications := v_notifications + public.nosih_sla_notify(
        'EMAIL', v_recipients || array['maintenance@nosih.edu.in'],
        'SLA response missed for ' || v_sla.target_type || ' ' || v_sla.target_id
          || ' - ' || coalesce(v_sla.priority_code, '') || ' ' || coalesce(v_sla.space_code, ''),
        v_payload);
    elsif v_sla.first_response_at is null and v_response_ratio >= 0.75
          and v_sla.response_breach_state <> 'WARNING_75' then
      v_sla.response_breach_state := 'WARNING_75';
      v_payload := jsonb_build_object(
        'event', 'SLA_RESPONSE_WARNING', 'target_type', v_sla.target_type,
        'target_id', v_sla.target_id, 'space_code', v_sla.space_code,
        'priority_code', v_sla.priority_code,
        'response_target_mins', v_sla.response_target_mins,
        'response_elapsed_mins', round(v_sla.response_elapsed_mins::numeric, 2));
      v_notifications := v_notifications + public.nosih_sla_notify(
        'EMAIL', v_recipients,
        'SLA response deadline approaching for ' || v_sla.target_type || ' ' || v_sla.target_id,
        v_payload);
    elsif v_sla.first_response_at is not null then
      v_sla.response_breach_state := 'MET';
    else
      v_sla.response_breach_state := 'HEALTHY';
    end if;

    -- The resolution deadline.
    v_resolution_ratio := v_sla.elapsed_active_mins / greatest(1, v_sla.resolution_target_mins);

    if v_resolution_ratio >= 1 and v_sla.breach_state <> 'BREACHED_100' then
      v_sla.breach_state := 'BREACHED_100';
      v_sla.last_milestone := 'BREACHED_100';
      v_sla.current_escalation_tier := least(4, v_sla.current_escalation_tier + 1);
      v_sla.escalated_at := coalesce(v_sla.escalated_at, now());
      v_breaches := v_breaches + 1;

      v_payload := jsonb_build_object(
        'event', 'SLA_BREACHED_100', 'target_type', v_sla.target_type,
        'target_id', v_sla.target_id, 'space_code', v_sla.space_code,
        'priority_code', v_sla.priority_code, 'urgency', v_sla.urgency,
        'service_name', v_sla.service_name,
        'elapsed_active_mins', round(v_sla.elapsed_active_mins::numeric, 2),
        'resolution_target_mins', v_sla.resolution_target_mins,
        'escalation_tier', v_sla.current_escalation_tier,
        'escalation_owner', case v_sla.current_escalation_tier
          when 1 then 'Maintenance' when 2 then 'Incident Manager'
          when 3 then 'Facilities Admin' else 'Principal Office' end,
        'head_of_department', v_hod);

      v_notifications := v_notifications + public.nosih_sla_notify(
        'EMAIL',
        v_recipients || array['maintenance@nosih.edu.in', 'incident@nosih.edu.in', 'facilities@nosih.edu.in'],
        'SLA breached for ' || v_sla.target_type || ' ' || v_sla.target_id
          || ' - Tier ' || v_sla.current_escalation_tier,
        v_payload);

      -- A critical request that breaches changes hands.
      if v_sla.priority_code = 'P1' then
        v_reassigned := v_reassigned + public.nosih_sla_escalate_assignment(v_sla.target_id);
      end if;

    elsif v_resolution_ratio >= 0.75 and v_sla.breach_state not in ('WARNING_75', 'BREACHED_100') then
      v_sla.breach_state := 'WARNING_75';
      v_sla.last_milestone := 'WARNING_75';
      v_warnings := v_warnings + 1;

      v_payload := jsonb_build_object(
        'event', 'SLA_WARNING_75', 'target_type', v_sla.target_type,
        'target_id', v_sla.target_id, 'space_code', v_sla.space_code,
        'priority_code', v_sla.priority_code,
        'elapsed_active_mins', round(v_sla.elapsed_active_mins::numeric, 2),
        'resolution_target_mins', v_sla.resolution_target_mins);

      v_notifications := v_notifications + public.nosih_sla_notify(
        'EMAIL', v_recipients || array['maintenance@nosih.edu.in'],
        'SLA 75% warning for ' || v_sla.target_type || ' ' || v_sla.target_id,
        v_payload);

    elsif v_resolution_ratio >= 0.5
          and coalesce(v_sla.last_milestone, '') not in ('HALF_ELAPSED', 'WARNING_75', 'BREACHED_100') then
      v_sla.last_milestone := 'HALF_ELAPSED';
      v_milestones := v_milestones + 1;

      v_payload := jsonb_build_object(
        'event', 'SLA_HALF_ELAPSED', 'target_type', v_sla.target_type,
        'target_id', v_sla.target_id, 'space_code', v_sla.space_code,
        'priority_code', v_sla.priority_code,
        'elapsed_active_mins', round(v_sla.elapsed_active_mins::numeric, 2),
        'resolution_target_mins', v_sla.resolution_target_mins);

      v_notifications := v_notifications + public.nosih_sla_notify(
        'EMAIL', v_recipients,
        'SLA half elapsed for ' || v_sla.target_type || ' ' || v_sla.target_id
          || ' - ' || coalesce(v_sla.priority_code, '') || ' ' || coalesce(v_sla.space_code, ''),
        v_payload);

    elsif v_resolution_ratio < 0.5 then
      v_sla.breach_state := 'HEALTHY';
    end if;

    update public.sla_clocks
       set elapsed_active_mins = v_sla.elapsed_active_mins,
           response_elapsed_mins = v_sla.response_elapsed_mins,
           last_tick_at = v_sla.last_tick_at,
           breach_state = v_sla.breach_state,
           response_breach_state = v_sla.response_breach_state,
           current_escalation_tier = v_sla.current_escalation_tier,
           last_milestone = v_sla.last_milestone,
           escalated_at = v_sla.escalated_at
     where id = v_sla.id;

    v_ticked := v_ticked + 1;
  end loop;

  return jsonb_build_object(
    'ticked', v_ticked,
    'warnings', v_warnings,
    'breaches', v_breaches,
    'milestones', v_milestones,
    'notifications_sent', v_notifications,
    'reassigned', v_reassigned
  );
end;
$$;

-- ----------------------------------------------------------------------
-- 6. Pausing a clock by hand
-- ----------------------------------------------------------------------
create or replace function public.rpc_sla_pause_clock(
  p_work_order_id integer,
  p_reason text,
  p_actor_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.nosih_actor_role(p_actor_email);
  v_reason text := upper(trim(coalesce(p_reason, '')));
  v_clock public.sla_clocks%rowtype;
begin
  if v_role is null or v_role not in ('MAINTENANCE', 'DEPARTMENT_MANAGER', 'INCIDENT_MANAGER', 'FACILITIES_ADMIN', 'SYSTEM_ADMIN') then
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN');
  end if;
  if v_reason not in ('AWAITING_REPORTER', 'AWAITING_STUDENT_RESPONSE', 'PARTS_UNAVAILABLE', 'EXTERNAL_VENDOR', 'ACCESS_DENIED') then
    return jsonb_build_object('success', false, 'error', 'INVALID_REASON');
  end if;

  select * into v_clock from public.sla_clocks
   where target_type = 'WORK_ORDER' and target_id = p_work_order_id
   for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'CLOCK_NOT_FOUND');
  end if;
  if v_clock.closed_at is not null then
    return jsonb_build_object('success', false, 'error', 'CLOCK_CLOSED');
  end if;

  update public.sla_clocks
     set is_paused = true, pause_reason = v_reason, last_tick_at = now()
   where id = v_clock.id;

  perform public.nosih_append_audit(p_actor_email, v_role, 'SLA_PAUSE', 'WORK_ORDER',
    p_work_order_id::text, 'ALLOWED', 'SLA_PAUSED',
    'SLA clock paused: ' || v_reason,
    jsonb_build_object('reason', v_reason, 'priority_code', v_clock.priority_code));

  return jsonb_build_object('success', true, 'work_order_id', p_work_order_id,
    'is_paused', true, 'pause_reason', v_reason);
end;
$$;

create or replace function public.rpc_sla_resume_clock(
  p_work_order_id integer,
  p_actor_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.nosih_actor_role(p_actor_email);
  v_clock public.sla_clocks%rowtype;
begin
  if v_role is null or v_role not in ('MAINTENANCE', 'DEPARTMENT_MANAGER', 'INCIDENT_MANAGER', 'FACILITIES_ADMIN', 'SYSTEM_ADMIN') then
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN');
  end if;

  select * into v_clock from public.sla_clocks
   where target_type = 'WORK_ORDER' and target_id = p_work_order_id
   for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'CLOCK_NOT_FOUND');
  end if;
  if v_clock.closed_at is not null then
    return jsonb_build_object('success', false, 'error', 'CLOCK_CLOSED');
  end if;

  update public.sla_clocks
     set is_paused = false, pause_reason = null, last_tick_at = now()
   where id = v_clock.id;

  perform public.nosih_append_audit(p_actor_email, v_role, 'SLA_RESUME', 'WORK_ORDER',
    p_work_order_id::text, 'ALLOWED', 'SLA_RESUMED',
    'SLA clock resumed', jsonb_build_object('previous_reason', v_clock.pause_reason));

  return jsonb_build_object('success', true, 'work_order_id', p_work_order_id,
    'is_paused', false, 'pause_reason', null);
end;
$$;

-- ----------------------------------------------------------------------
-- 7. The two triggers that move the clock
-- ----------------------------------------------------------------------

-- A staff reply is the acknowledgement: the response clock stops here.
create or replace function public.nosih_trg_sla_first_response()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  select u.role into v_role from public.users u where u.id = new.author_user_id;
  if v_role is null or v_role = 'STUDENT' then
    return new;
  end if;

  update public.sla_clocks
     set first_response_at = coalesce(first_response_at, now()),
         response_breach_state = case when first_response_at is null then 'MET' else response_breach_state end
   where target_type = 'WORK_ORDER'
     and closed_at is null
     and first_response_at is null
     and target_id in (select id from public.work_orders where complaint_id = new.complaint_id);

  return new;
end;
$$;

drop trigger if exists trg_sla_first_response on public.complaint_comments;
create trigger trg_sla_first_response
  after insert on public.complaint_comments
  for each row execute function public.nosih_trg_sla_first_response();

-- Asking the reporter for more details pauses the clock: the campus is not
-- late for an answer it has not got.
create or replace function public.nosih_trg_sla_awaiting_reporter()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.missing_info_questions_json is not null
     and btrim(new.missing_info_questions_json) not in ('', '[]', '{}')
     and coalesce(btrim(coalesce(new.missing_info_answers_json, '')), '') in ('', '[]', '{}') then
    update public.sla_clocks
       set is_paused = true, pause_reason = 'AWAITING_REPORTER', last_tick_at = now()
     where target_type = 'WORK_ORDER'
       and closed_at is null
       and target_id in (select id from public.work_orders where complaint_id = new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sla_awaiting_reporter on public.complaints;
create trigger trg_sla_awaiting_reporter
  after update of missing_info_questions_json on public.complaints
  for each row execute function public.nosih_trg_sla_awaiting_reporter();

-- The answer arrives: the clock runs again.
do $$
declare
  v_def text;
  v_old text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.rpc_supplement_complaint(integer, jsonb)'::regprocedure);
  if position('nosih_sla_resume_on_answer' in v_def) = 0 then
    v_old := '  update public.complaints' || E'\n'
      || '     set missing_info_answers_json = v_merged::text, updated_at = now()' || E'\n'
      || '   where id = p_complaint_id;';
    v_new := v_old || E'\n\n'
      || '  update public.sla_clocks' || E'\n'
      || '     set is_paused = false,' || E'\n'
      || '         pause_reason = null,' || E'\n'
      || '         last_tick_at = now()' || E'\n'
      || '   where target_type = ''WORK_ORDER''' || E'\n'
      || '     and closed_at is null' || E'\n'
      || '     and pause_reason = ''AWAITING_REPORTER''' || E'\n'
      || '     and target_id in (select id from public.work_orders where complaint_id = p_complaint_id); -- nosih_sla_resume_on_answer';
    if position(v_old in v_def) = 0 then
      raise exception 'supplement anchor not found';
    end if;
    execute replace(v_def, v_old, v_new);
  end if;
end $$;

grant execute on function public.rpc_sla_pause_clock(integer, text, text) to authenticated;
grant execute on function public.rpc_sla_resume_clock(integer, text) to authenticated;
grant execute on function public.nosih_sla_escalate_assignment(integer) to service_role;
grant execute on function public.nosih_sla_notify(text, text[], text, jsonb) to service_role;
grant execute on function public.nosih_sla_officer_email(integer) to authenticated, service_role;
grant execute on function public.nosih_sla_hod_email(text) to authenticated, service_role;
