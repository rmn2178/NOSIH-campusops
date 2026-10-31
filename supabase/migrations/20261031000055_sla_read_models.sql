-- SLA read models: the ticket snapshot, the staff board and the compliance
-- report the school management reads.
--
--   nosih_sla_snapshot(complaint_id)  what one ticket owes and how much time
--                                     is left, for the complaint portal
--   rpc_sla_matrix()                  the promise table itself, for the
--                                     policy view
--   rpc_sla_board(state, limit)       every live clock with its officer, its
--                                     head of department and its countdown
--   rpc_sla_compliance(days)          the percentage of SLAs met per
--                                     department, per priority and per service

-- ----------------------------------------------------------------------
-- 1. The ticket snapshot
-- ----------------------------------------------------------------------
create or replace function public.nosih_sla_snapshot(p_complaint_id integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_clock public.sla_clocks%rowtype;
  v_wo public.work_orders%rowtype;
  v_resolution_remaining integer;
  v_response_remaining integer;
  v_resolution_pct numeric;
  v_response_pct numeric;
  v_state text;
  v_response_state text;
begin
  select * into v_clock
    from public.sla_clocks s
   where s.target_type = 'WORK_ORDER'
     and s.target_id in (select id from public.work_orders where complaint_id = p_complaint_id)
   order by s.id desc
   limit 1;

  if not found then
    return jsonb_build_object('available', false);
  end if;

  select * into v_wo from public.work_orders where id = v_clock.target_id;

  v_resolution_remaining := greatest(0, v_clock.resolution_target_mins - round(v_clock.elapsed_active_mins)::int);
  v_response_remaining := case
    when v_clock.first_response_at is not null then 0
    else greatest(0, v_clock.response_target_mins - round(v_clock.response_elapsed_mins)::int) end;
  v_resolution_pct := round((100.0 * v_clock.elapsed_active_mins / greatest(1, v_clock.resolution_target_mins))::numeric, 1);
  v_response_pct := round((100.0 * v_clock.response_elapsed_mins / greatest(1, v_clock.response_target_mins))::numeric, 1);

  v_state := case
    when v_clock.closed_at is not null then 'CLOSED'
    when v_clock.is_paused then 'PAUSED'
    when v_clock.breach_state = 'BREACHED_100' then 'BREACHED'
    when v_clock.breach_state = 'WARNING_75' then 'WARNING'
    else 'HEALTHY' end;

  v_response_state := case
    when v_clock.first_response_at is not null then 'MET'
    when v_clock.response_breach_state = 'BREACHED_100' then 'BREACHED'
    when v_clock.response_breach_state = 'WARNING_75' then 'WARNING'
    else 'PENDING' end;

  return jsonb_build_object(
    'available', true,
    'state', v_state,
    'breach_state', v_clock.breach_state,
    'priority_code', v_clock.priority_code,
    'priority_label', v_clock.priority_label,
    'service_name', v_clock.service_name,
    'policy_note', v_clock.policy_note,
    'is_24x7', v_clock.is_24x7,
    'basis', case when v_clock.is_24x7 then 'CLOCK' else 'WORKING' end,
    'response_state', v_response_state,
    'first_response_at', v_clock.first_response_at,
    'response_target_mins', v_clock.response_target_mins,
    'response_elapsed_mins', round(v_clock.response_elapsed_mins::numeric, 0),
    'response_remaining_mins', v_response_remaining,
    'response_progress_pct', v_response_pct,
    'resolution_target_mins', v_clock.resolution_target_mins,
    'resolution_elapsed_mins', round(v_clock.elapsed_active_mins::numeric, 0),
    'resolution_remaining_mins', v_resolution_remaining,
    'resolution_progress_pct', v_resolution_pct,
    'pause_reason', v_clock.pause_reason,
    'last_milestone', v_clock.last_milestone,
    'escalation_tier', v_clock.current_escalation_tier,
    'escalated_at', v_clock.escalated_at,
    'closed_at', v_clock.closed_at,
    'closed_reason', v_clock.closed_reason,
    'work_order_id', v_clock.target_id,
    'work_order_number', v_wo.wo_number,
    'officer', case
      when v_wo.assigned_staff_code is null then null
      else public.nosih_officer_json(v_wo.assigned_staff_code) end,
    'due_at', case
      when v_clock.is_paused or v_clock.closed_at is not null then null
      else now() + make_interval(mins => v_resolution_remaining) end,
    'milestones', jsonb_build_array(
      jsonb_build_object(
        'key', 'RESPONSE', 'label', 'Answer the reporter',
        'target_mins', v_clock.response_target_mins,
        'elapsed_mins', round(v_clock.response_elapsed_mins::numeric, 0),
        'reached', v_clock.first_response_at is not null,
        'breached', v_response_state = 'BREACHED'),
      jsonb_build_object(
        'key', 'HALF_ELAPSED', 'label', 'Half the resolution time',
        'target_mins', round(v_clock.resolution_target_mins * 0.5)::int,
        'elapsed_mins', round(v_clock.elapsed_active_mins::numeric, 0),
        'reached', v_resolution_pct >= 50, 'breached', false),
      jsonb_build_object(
        'key', 'WARNING_75', 'label', 'Deadline warning',
        'target_mins', round(v_clock.resolution_target_mins * 0.75)::int,
        'elapsed_mins', round(v_clock.elapsed_active_mins::numeric, 0),
        'reached', v_resolution_pct >= 75, 'breached', false),
      jsonb_build_object(
        'key', 'BREACHED_100', 'label', 'Resolution deadline',
        'target_mins', v_clock.resolution_target_mins,
        'elapsed_mins', round(v_clock.elapsed_active_mins::numeric, 0),
        'reached', v_resolution_pct >= 100, 'breached', v_clock.breach_state = 'BREACHED_100')
    )
  );
end;
$$;

-- The complaint payload carries the snapshot, so the card and the detail page
-- read one document.
do $$
declare
  v_def text;
  v_old text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.nosih_complaint_json(public.complaints, text)'::regprocedure);
  if position('nosih_sla_snapshot' in v_def) = 0 then
    v_old := '    ''sla_breach_state'', v_sla.breach_state,';
    v_new := v_old || E'\n'
      || '    ''sla'', public.nosih_sla_snapshot(c.id), -- nosih_sla_snapshot';
    if position(v_old in v_def) = 0 then
      raise exception 'complaint payload SLA anchor missing';
    end if;
    execute replace(v_def, v_old, v_new);
  end if;
end $$;

-- ----------------------------------------------------------------------
-- 2. The policy matrix
-- ----------------------------------------------------------------------
create or replace function public.rpc_sla_matrix()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if public.nosih_booking_role_allowed(public.nosih_actor_role(null)) is not true then
    return jsonb_build_object('error', 'FORBIDDEN');
  end if;

  return jsonb_build_object(
    'policies', coalesce((
      select jsonb_agg(jsonb_build_object(
        'priority_code', p.priority_code,
        'priority_label', p.priority_label,
        'service_name', p.service_name,
        'category', p.category,
        'response_target_mins', p.response_target_mins,
        'resolution_target_mins', p.resolution_target_mins,
        'response_hours', round(p.response_target_mins::numeric / 60.0, 2),
        'resolution_hours', round(p.resolution_target_mins::numeric / 60.0, 2),
        'resolution_days', round(p.resolution_target_mins::numeric / 360.0, 2),
        'is_24x7', p.is_24x7,
        'basis', case when p.is_24x7 then 'CLOCK' else 'WORKING' end,
        'description', p.description
      ) order by p.priority_code, (p.category is not null))
      from public.sla_policies p where p.is_active), '[]'::jsonb),
    'calendar', public.nosih_sla_calendar(current_date, current_date + 90),
    'working_hours', jsonb_build_object(
      'opens_at', '09:00', 'closes_at', '15:00',
      'timezone', 'Asia/Kolkata', 'days', 'Monday to Friday',
      'note', 'Weekends, academic holidays and semester breaks never count against a request')
  );
end;
$$;

-- ----------------------------------------------------------------------
-- 3. The staff board
-- ----------------------------------------------------------------------
create or replace function public.rpc_sla_board(
  p_state text default 'ALL',
  p_limit integer default 120
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if public.nosih_booking_role_allowed(public.nosih_actor_role(null)) is not true then
    return jsonb_build_object('error', 'FORBIDDEN');
  end if;

  return jsonb_build_object(
    'rows', coalesce((
      with clock as (
        select s.*,
               w.wo_number, w.complaint_id, w.space_code as wo_space_code,
               w.assigned_staff_code, w.status as work_order_status,
               c.ticket_number, c.category, c.urgency as complaint_urgency,
               c.title
          from public.sla_clocks s
          join public.work_orders w on w.id = s.target_id
          left join public.complaints c on c.id = w.complaint_id
         where s.target_type = 'WORK_ORDER'
      ), enriched as (
        select clock.*,
               (select ds.department_code from public.department_spaces ds
                 where ds.space_code = clock.space_code
                 order by ds.department_code limit 1) as department_code,
               public.nosih_sla_officer_email(clock.target_id) as officer_email,
               public.nosih_sla_hod_email(clock.space_code) as hod_email,
               public.nosih_officer_json(clock.assigned_staff_code) as officer
          from clock
      )
      select jsonb_agg(jsonb_build_object(
        'clock_id', id,
        'work_order_id', target_id,
        'work_order_number', wo_number,
        'ticket_number', ticket_number,
        'title', title,
        'space_code', space_code,
        'category', category,
        'urgency', complaint_urgency,
        'department_code', coalesce(department_code, 'CAMPUS'),
        'priority_code', priority_code,
        'priority_label', priority_label,
        'service_name', service_name,
        'policy_note', policy_note,
        'is_24x7', is_24x7,
        'basis', case when is_24x7 then 'CLOCK' else 'WORKING' end,
        'state', state,
        'breach_state', breach_state,
        'response_state', case
          when first_response_at is not null then 'MET'
          when response_breach_state = 'BREACHED_100' then 'BREACHED'
          when response_breach_state = 'WARNING_75' then 'WARNING'
          else 'PENDING' end,
        'first_response_at', first_response_at,
        'response_target_mins', response_target_mins,
        'response_elapsed_mins', round(response_elapsed_mins::numeric, 0),
        'response_remaining_mins', greatest(0, response_target_mins - round(response_elapsed_mins)::int),
        'response_progress_pct', round((100.0 * response_elapsed_mins / greatest(1, response_target_mins))::numeric, 1),
        'resolution_target_mins', resolution_target_mins,
        'resolution_elapsed_mins', round(elapsed_active_mins::numeric, 0),
        'resolution_remaining_mins', greatest(0, resolution_target_mins - round(elapsed_active_mins)::int),
        'resolution_progress_pct', round((100.0 * elapsed_active_mins / greatest(1, resolution_target_mins))::numeric, 1),
        'pause_reason', pause_reason,
        'last_milestone', last_milestone,
        'escalation_tier', current_escalation_tier,
        'escalated_at', escalated_at,
        'closed_at', closed_at,
        'closed_reason', closed_reason,
        'officer', officer,
        'officer_email', officer_email,
        'head_of_department', hod_email,
        'work_order_status', work_order_status
      ) order by risk, elapsed_active_mins desc, resolution_target_mins asc)
        from (
          select enriched.*,
                 case
                   when closed_at is not null then 3
                   when breach_state = 'BREACHED_100' then 0
                   when breach_state = 'WARNING_75' then 1
                   else 2 end as risk,
                 case
                   when closed_at is not null then 'CLOSED'
                   when is_paused then 'PAUSED'
                   when breach_state = 'BREACHED_100' then 'BREACHED'
                   when breach_state = 'WARNING_75' then 'WARNING'
                   else 'HEALTHY' end as state
            from enriched
           where upper(coalesce(p_state, 'ALL')) = 'ALL'
              or case
                   when closed_at is not null then 'CLOSED'
                   when is_paused then 'PAUSED'
                   when breach_state = 'BREACHED_100' then 'BREACHED'
                   when breach_state = 'WARNING_75' then 'WARNING'
                   else 'HEALTHY' end = upper(p_state)
           order by risk, elapsed_active_mins desc, resolution_target_mins asc
           limit least(300, greatest(1, coalesce(p_limit, 120)))
        ) selected
    ), '[]'::jsonb),
    'summary', (
      with clock as (
        select s.*,
               case when closed_at is not null then 'CLOSED'
                    when is_paused then 'PAUSED'
                    when breach_state = 'BREACHED_100' then 'BREACHED'
                    when breach_state = 'WARNING_75' then 'WARNING'
                    else 'HEALTHY' end as state
          from public.sla_clocks s where s.target_type = 'WORK_ORDER'
      )
      select jsonb_build_object(
        'total', count(*),
        'healthy', count(*) filter (where state = 'HEALTHY'),
        'warning', count(*) filter (where state = 'WARNING'),
        'breached', count(*) filter (where state = 'BREACHED'),
        'paused', count(*) filter (where state = 'PAUSED'),
        'closed', count(*) filter (where state = 'CLOSED'),
        'response_pending', count(*) filter (where first_response_at is null and closed_at is null)
      ) from clock
    )
  );
end;
$$;

-- ----------------------------------------------------------------------
-- 4. Compliance
-- ----------------------------------------------------------------------
create or replace function public.rpc_sla_compliance(p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_days integer := greatest(1, coalesce(p_days, 30));
begin
  if public.nosih_booking_role_allowed(public.nosih_actor_role(null)) is not true then
    return jsonb_build_object('error', 'FORBIDDEN');
  end if;

  return jsonb_build_object(
    'window_days', v_days,
    'window_basis', 'Requests raised in the window',
    'totals', (
      with scoped as (
        select s.*,
               w.complaint_id,
               coalesce((select ds.department_code from public.department_spaces ds
                          where ds.space_code = s.space_code
                          order by ds.department_code limit 1), 'CAMPUS') as department_code,
               (s.closed_at is not null and s.elapsed_active_mins <= s.resolution_target_mins) as met,
               (s.closed_at is not null and s.elapsed_active_mins > s.resolution_target_mins) as missed,
               (s.closed_at is null and s.breach_state = 'BREACHED_100') as open_breach
          from public.sla_clocks s
          join public.work_orders w on w.id = s.target_id
         where s.target_type = 'WORK_ORDER'
           and w.created_at > now() - make_interval(days => v_days)
      )
      select jsonb_build_object(
        'requests', count(*),
        'closed', count(*) filter (where closed_at is not null),
        'met', count(*) filter (where met),
        'missed', count(*) filter (where missed),
        'open', count(*) filter (where closed_at is null),
        'open_breached', count(*) filter (where open_breach),
        'compliance_pct', round(100.0 * count(*) filter (where met)
          / greatest(1, count(*) filter (where closed_at is not null)), 1),
        'responded', count(*) filter (where first_response_at is not null),
        'response_missed', count(*) filter (where first_response_at is null and closed_at is not null),
        'response_compliance_pct', round(100.0 * count(*) filter (where first_response_at is not null)
          / greatest(1, count(*)), 1),
        'avg_resolution_mins', round(avg(elapsed_active_mins) filter (where closed_at is not null))
      ) from scoped
    ),
    'by_department', (
      with scoped as (
        select s.*,
               coalesce((select ds.department_code from public.department_spaces ds
                          where ds.space_code = s.space_code
                          order by ds.department_code limit 1), 'CAMPUS') as department_code,
               (s.closed_at is not null and s.elapsed_active_mins <= s.resolution_target_mins) as met
          from public.sla_clocks s
          join public.work_orders w on w.id = s.target_id
         where s.target_type = 'WORK_ORDER'
           and w.created_at > now() - make_interval(days => v_days)
      ), grouped as (
        select department_code,
               count(*) as requests,
               count(*) filter (where closed_at is not null) as closed,
               count(*) filter (where met) as met,
               count(*) filter (where breach_state = 'BREACHED_100') as breached,
               count(*) filter (where closed_at is null) as open,
               round(avg(elapsed_active_mins) filter (where closed_at is not null)) as avg_resolution_mins,
               array_agg(distinct coalesce(service_name, 'Campus Maintenance')) as services
          from scoped group by 1
      )
      select coalesce(jsonb_agg(jsonb_build_object(
               'department_code', department_code,
               'services', to_jsonb(services),
               'requests', requests,
               'closed', closed,
               'met', met,
               'breached', breached,
               'open', open,
               'compliance_pct', round(100.0 * met / greatest(1, closed), 1),
               'avg_resolution_mins', avg_resolution_mins
             ) order by department_code), '[]'::jsonb)
        from grouped
    ),
    'by_priority', (
      with scoped as (
        select s.*,
               coalesce(priority_code, 'P4') as priority,
               (s.closed_at is not null and s.elapsed_active_mins <= s.resolution_target_mins) as met
          from public.sla_clocks s
          join public.work_orders w on w.id = s.target_id
         where s.target_type = 'WORK_ORDER'
           and w.created_at > now() - make_interval(days => v_days)
      ), grouped as (
        select priority,
               count(*) as requests,
               count(*) filter (where closed_at is not null) as closed,
               count(*) filter (where met) as met,
               count(*) filter (where breach_state = 'BREACHED_100') as breached
          from scoped group by 1
      )
      select coalesce(jsonb_agg(jsonb_build_object(
               'priority_code', priority,
               'requests', requests,
               'closed', closed,
               'met', met,
               'breached', breached,
               'compliance_pct', round(100.0 * met / greatest(1, closed), 1)
             ) order by priority), '[]'::jsonb)
        from grouped
    ),
    'by_service', (
      with scoped as (
        select s.*,
               coalesce(service_name, 'Campus Maintenance') as service,
               (s.closed_at is not null and s.elapsed_active_mins <= s.resolution_target_mins) as met
          from public.sla_clocks s
          join public.work_orders w on w.id = s.target_id
         where s.target_type = 'WORK_ORDER'
           and w.created_at > now() - make_interval(days => v_days)
      ), grouped as (
        select service,
               count(*) as requests,
               count(*) filter (where closed_at is not null) as closed,
               count(*) filter (where met) as met
          from scoped group by 1
      )
      select coalesce(jsonb_agg(jsonb_build_object(
               'service_name', service,
               'requests', requests,
               'closed', closed,
               'met', met,
               'compliance_pct', round(100.0 * met / greatest(1, closed), 1)
             ) order by service), '[]'::jsonb)
        from grouped
    )
  );
end;
$$;

grant execute on function public.nosih_sla_snapshot(integer) to authenticated, service_role;
grant execute on function public.rpc_sla_matrix() to authenticated;
grant execute on function public.rpc_sla_board(text, integer) to authenticated;
grant execute on function public.rpc_sla_compliance(integer) to authenticated;
