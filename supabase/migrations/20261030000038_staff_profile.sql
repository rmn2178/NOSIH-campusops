-- F9: person profiles — every technician opens a full record with their jobs.
--
-- rpc_workforce_summary gains the roster (identity + live load) so the
-- dispatch strip can list all thirty people; rpc_get_staff_profile returns one
-- technician's details, job history and priced repair record.

create or replace function public.rpc_workforce_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.nosih_is_campus_reader() then
    return jsonb_build_object('error', 'FORBIDDEN');
  end if;
  return (
    select jsonb_build_object(
      'success', true,
      'total', count(*),
      'on_shift', count(*) filter (where sp.is_on_shift and not sp.is_on_leave),
      'on_leave', count(*) filter (where sp.is_on_leave),
      'available', count(*) filter (where sp.is_on_shift and not sp.is_on_leave
                                     and sp.current_active_jobs < sp.max_concurrent_jobs),
      'by_skill', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'skill', s.skill,
                 'total', s.total,
                 'on_shift', s.on_shift,
                 'available', s.available) order by s.skill), '[]'::jsonb)
          from (
            select sp2.primary_skill as skill,
                   count(*) as total,
                   count(*) filter (where sp2.is_on_shift and not sp2.is_on_leave) as on_shift,
                   count(*) filter (where sp2.is_on_shift and not sp2.is_on_leave
                                      and sp2.current_active_jobs < sp2.max_concurrent_jobs) as available
              from public.staff_profiles sp2
             where sp2.staff_category = 'MAINTENANCE_TECH'
             group by sp2.primary_skill
          ) s),
      'staff', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'staff_code', sp3.staff_code,
                 'full_name', u3.full_name,
                 'primary_skill', sp3.primary_skill,
                 'shift_code', sp3.shift_code,
                 'is_on_shift', sp3.is_on_shift,
                 'is_on_leave', sp3.is_on_leave,
                 'current_active_jobs', sp3.current_active_jobs,
                 'max_concurrent_jobs', sp3.max_concurrent_jobs) order by sp3.staff_code), '[]'::jsonb)
          from public.staff_profiles sp3
          join public.users u3 on u3.id = sp3.user_id
         where sp3.staff_category = 'MAINTENANCE_TECH')
    )
      from public.staff_profiles sp
     where sp.staff_category = 'MAINTENANCE_TECH'
  );
end
$$;

create or replace function public.rpc_get_staff_profile(p_staff_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sp record;
begin
  if not public.nosih_is_campus_reader() then
    return jsonb_build_object('error', 'FORBIDDEN');
  end if;

  select sp.*, u.full_name, u.email, u.role as portal_role, u.department_code, u.is_active
    into v_sp
    from public.staff_profiles sp
    join public.users u on u.id = sp.user_id
   where sp.staff_code = p_staff_code;
  if not found then
    return jsonb_build_object('error', 'STAFF_NOT_FOUND', 'staff_code', p_staff_code);
  end if;

  return jsonb_build_object(
    'staff_code', v_sp.staff_code,
    'full_name', v_sp.full_name,
    'email', v_sp.email,
    'portal_role', v_sp.portal_role,
    'department_code', v_sp.department_code,
    'staff_category', v_sp.staff_category,
    'primary_skill', v_sp.primary_skill,
    'skill_proficiency', v_sp.skill_proficiency,
    'risk_clearance', v_sp.risk_clearance,
    'shift_code', v_sp.shift_code,
    'is_on_shift', v_sp.is_on_shift,
    'is_on_leave', v_sp.is_on_leave,
    'current_block_location', v_sp.current_block_location,
    'hourly_cost_inr', v_sp.hourly_cost_inr,
    'current_active_jobs', v_sp.current_active_jobs,
    'max_concurrent_jobs', v_sp.max_concurrent_jobs,
    'stats', jsonb_build_object(
      'jobs_total', (
        select count(*) from public.work_orders w where w.assigned_staff_code = v_sp.staff_code),
      'jobs_open', (
        select count(*) from public.work_orders w
         where w.assigned_staff_code = v_sp.staff_code
           and w.status in ('PENDING_ASSIGNMENT', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED_PARTS')),
      'jobs_completed', (
        select count(*) from public.work_orders w
         where w.assigned_staff_code = v_sp.staff_code
           and w.status in ('COMPLETED', 'CLOSED')),
      'repairs_count', (
        select count(*) from public.maintenance_history m where m.technician_code = v_sp.staff_code),
      'repair_cost_inr', (
        select coalesce(sum(m.total_cost_inr), 0) from public.maintenance_history m
         where m.technician_code = v_sp.staff_code),
      'avg_downtime_mins', (
        select coalesce(round(avg(m.downtime_mins), 1), 0) from public.maintenance_history m
         where m.technician_code = v_sp.staff_code),
      'last_repair_at', (
        select max(m.completed_at) from public.maintenance_history m
         where m.technician_code = v_sp.staff_code)
    ),
    'jobs', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'wo_number', w.wo_number,
               'space_code', w.space_code,
               'status', w.status,
               'required_skill', w.required_skill,
               'priority_score', w.priority_score,
               'created_at', w.created_at,
               'completed_at', w.completed_at) order by w.id desc), '[]'::jsonb)
        from (select * from public.work_orders
               where assigned_staff_code = v_sp.staff_code
               order by id desc limit 20) w),
    'repairs', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'asset_code', m.asset_code,
               'space_code', m.space_code,
               'fault_category', m.fault_category,
               'action_taken', m.action_taken,
               'completed_at', m.completed_at,
               'downtime_mins', m.downtime_mins,
               'total_cost_inr', m.total_cost_inr) order by m.completed_at desc), '[]'::jsonb)
        from (select * from public.maintenance_history
               where technician_code = v_sp.staff_code
               order by completed_at desc limit 10) m)
  );
end
$$;

revoke all on function public.rpc_get_staff_profile(text) from public, anon;
grant execute on function public.rpc_get_staff_profile(text) to authenticated;
