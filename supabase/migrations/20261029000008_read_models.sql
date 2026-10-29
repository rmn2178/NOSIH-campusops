-- Read models used by the two portals.

create or replace function public.rpc_search_directory(p_query text, p_limit integer default 8)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'email', u.email,
    'full_name', u.full_name,
    'department', case u.department_code when 'AIDS' then 'AI&DS' when 'CYBER' then 'Cyber Security' else u.department_code end,
    'academic_role', case when u.role = 'STUDENT' then 'YEAR_' || coalesce(u.year_number, 1) else 'FACULTY_STAFF' end,
    'year_number', u.year_number
  ) order by u.email), '[]'::jsonb)
  from public.users u
  where u.is_active
    and u.email ilike coalesce(p_query, '') || '%'
  limit least(20, greatest(1, coalesce(p_limit, 8)))
$$;

create or replace function public.rpc_twin_overview()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with clock as (
    select active_day, active_period from public.campus_clock_state where id = 1
  ), spaces as (
    select r.code, 'CLASSROOM' as kind, r.code as name, b.code as block, f.floor_number as floor,
           r.visual_state, r.capacity
      from public.rooms r
      join public.buildings b on b.id = r.building_id
      join public.floors f on f.id = r.floor_id
    union all
    select l.code, 'LAB', l.name, b.code, db.floor_number, l.visual_state, l.capacity
      from public.labs l
      join public.distribution_boards db on db.id = l.distribution_board_id
      join public.buildings b on b.id = db.building_id
    union all
    select c.code, 'CANTEEN', c.name, null, null, c.visual_state, c.seating_capacity
      from public.canteens c
    union all
    select b.code, 'BILL_BOT', b.name, null, null, b.visual_state, null
      from public.bill_bots b
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'code', s.code, 'kind', s.kind, 'name', s.name, 'block', s.block, 'floor', s.floor,
    'visual_state', s.visual_state, 'capacity', s.capacity,
    'is_occupied_now', exists (
      select 1 from public.timetable_slots ts
       where ts.day_of_week = (select active_day from clock)
         and ts.period_number = (select active_period from clock)
         and ts.effective_space_code = s.code
    ),
    'current_class_code', (
      select ts.class_code from public.timetable_slots ts
       where ts.day_of_week = (select active_day from clock)
         and ts.period_number = (select active_period from clock)
         and ts.effective_space_code = s.code
       limit 1
    ),
    'current_student_count', (
      select sc.student_strength
        from public.timetable_slots ts
        join public.student_classes sc on sc.class_code = ts.class_code
       where ts.day_of_week = (select active_day from clock)
         and ts.period_number = (select active_period from clock)
         and ts.effective_space_code = s.code
       limit 1
    ),
    'room_capacity', s.capacity,
    'active_fault_count', (
      select count(*) from public.assets a
       where a.parent_space_code = s.code and a.status <> 'OK'
    ),
    'has_active_lock', exists (
      select 1 from public.resource_locks l
       where l.resource_id = s.code and l.expires_at > now()
    ),
    'active_ticket_id', (
      select c.ticket_number from public.complaints c
       where c.space_code = s.code and c.moderation_status = 'APPROVED'
         and c.status not in ('RESOLVED', 'CLOSED', 'MERGED_DUPLICATE')
       order by c.created_at desc limit 1
    ),
    'sla_breach_state', (
      select sc.breach_state from public.sla_clocks sc
       where sc.space_code = s.code order by sc.id desc limit 1
    ),
    'queue_count', (select b.active_queue_count from public.bill_bots b where b.code = s.code),
    'paper_percent', (select b.paper_roll_pct from public.bill_bots b where b.code = s.code),
    'rerouted_to_bot_code', (select b.rerouted_to_bot_code from public.bill_bots b where b.code = s.code),
    'is_home_class_in_lab', (
      select exists (
        select 1 from public.student_classes sc2
          join public.timetable_slots ts2 on ts2.class_code = sc2.class_code
         where sc2.home_room_code = s.code
           and ts2.day_of_week = (select active_day from clock)
           and ts2.period_number = (select active_period from clock)
           and ts2.session_type = 'LAB'
      )
    )
  ) order by s.code), '[]'::jsonb)
  from spaces s
$$;

create or replace function public.rpc_set_clock(p_day text, p_period integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.current_app_role();
begin
  if v_role is null or v_role not in ('INCIDENT_MANAGER', 'FACILITIES_ADMIN', 'SYSTEM_ADMIN') then
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN');
  end if;
  update public.campus_clock_state
     set active_day = upper(left(coalesce(p_day, active_day), 3)),
         active_period = least(6, greatest(1, coalesce(p_period, active_period))),
         period_elapsed_mins = 0,
         updated_at = now()
   where id = 1;
  return (select jsonb_build_object(
    'day_of_week', active_day, 'active_period', active_period,
    'minutes_remaining', greatest(0, period_duration_mins - period_elapsed_mins)
  ) from public.campus_clock_state where id = 1);
end;
$$;

create or replace function public.rpc_update_complaint_status(
  p_complaint_id integer,
  p_status text,
  p_actor_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.nosih_actor_role(p_actor_email);
  v_row public.complaints%rowtype;
  v_open integer;
  v_state text;
begin
  if v_role is null or v_role not in ('MAINTENANCE', 'INCIDENT_MANAGER', 'FACILITIES_ADMIN', 'SYSTEM_ADMIN') then
    perform public.nosih_append_audit(p_actor_email, coalesce(v_role, 'UNKNOWN'), 'UPDATE_COMPLAINT', 'COMPLAINT', p_complaint_id::text,
      'REJECTED', 'RBAC_ROLE_NOT_PERMITTED', 'Role cannot update complaint status');
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN');
  end if;

  update public.complaints
     set status = upper(p_status), updated_at = now()
   where id = p_complaint_id
  returning * into v_row;
  if not found then
    return jsonb_build_object('success', false, 'error', 'COMPLAINT_NOT_FOUND');
  end if;

  if upper(p_status) in ('RESOLVED', 'CLOSED') then
    select count(*) into v_open from public.complaints
     where space_code = v_row.space_code
       and id <> v_row.id
       and status not in ('RESOLVED', 'CLOSED', 'MERGED_DUPLICATE');

    v_state := case when v_open = 0 then 'HEALTHY' else 'FAULTY' end;
    if v_row.space_type = 'ROOM' then
      update public.rooms set visual_state = v_state where code = v_row.space_code;
    elsif v_row.space_type = 'LAB' then
      update public.labs set visual_state = v_state where code = v_row.space_code;
    end if;
  end if;

  perform public.nosih_append_audit(p_actor_email, v_role, 'UPDATE_COMPLAINT', 'COMPLAINT', v_row.ticket_number,
    'ALLOWED', 'STATUS_UPDATED', 'Status set to ' || upper(p_status));

  return public.nosih_complaint_json(v_row, null);
end;
$$;

create or replace function public.rpc_my_profile()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', u.id, 'email', u.email, 'full_name', u.full_name, 'role', u.role,
    'department_code', u.department_code, 'year_number', u.year_number,
    'class_code', u.class_code, 'home_room_code', sc.home_room_code,
    'section', sc.section_letter, 'staff_code', sp.staff_code
  )
  from public.users u
  left join public.student_classes sc on sc.class_code = u.class_code
  left join public.staff_profiles sp on sp.user_id = u.id
  where u.auth_user_id = auth.uid()
  limit 1
$$;

grant execute on function public.rpc_my_profile() to authenticated;
grant execute on function public.rpc_search_directory(text, integer) to anon, authenticated;
grant execute on function public.rpc_twin_overview() to authenticated;
grant execute on function public.rpc_set_clock(text, integer) to authenticated;
grant execute on function public.rpc_update_complaint_status(integer, text, text) to authenticated;
