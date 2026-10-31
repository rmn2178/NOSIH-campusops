-- Students have no booking system.
--
-- The complaint portal offers room booking to faculty and staff only: the nav
-- entry, the feed shortcut and the /bookings route itself are closed to a
-- student session. The server has to say the same thing, otherwise a student
-- who calls an RPC straight from the console would still read the campus
-- free/busy grid, list every booking or write one. Every booking RPC refuses
-- a student session now.
--
-- The write gate is widened at the same time. It used to name five roles, so a
-- technician or a lab assistant saw the booking screen and was then told
-- FORBIDDEN by the server. Booking a room is an ordinary request for any
-- member of staff, so the rule is now one rule: students never, everybody else
-- may. Cancellation keeps its ownership check - only the owner, the owner's
-- department manager or an administrator can cancel a booking.

-- True for every active role except a student. A null role (an unknown
-- caller) is not allowed either.
create or replace function public.nosih_booking_role_allowed(p_role text)
returns boolean
language sql
immutable
as $$
  select p_role is not null and upper(btrim(p_role)) <> 'STUDENT'
$$;

-- True when the caller is a signed-in student.
--
-- A service-role or cron call has no session, so it keeps its access and the
-- maintenance scripts and the api service are unaffected.
create or replace function public.nosih_booking_caller_is_student()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when auth.uid() is null then false
    else upper(coalesce(public.nosih_actor_role(null), '')) = 'STUDENT'
  end
$$;

-- The gate every booking RPC calls before it touches a room.
create or replace function public.nosih_refuse_student_booking()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if public.nosih_booking_caller_is_student() then
    raise exception 'FORBIDDEN: room bookings are for faculty and staff'
      using errcode = '42501';
  end if;
end;
$$;

grant execute on function public.nosih_booking_role_allowed(text) to authenticated, service_role;
grant execute on function public.nosih_booking_caller_is_student() to authenticated, service_role;
grant execute on function public.nosih_refuse_student_booking() to authenticated, service_role;

-- The write path. The old gate named five roles; it becomes one rule.
do $$
declare
  v_def text;
  v_old text;
  v_new text;
  v_sig text;
begin
  foreach v_sig in array array[
    'public.rpc_create_booking(text, timestamptz, timestamptz, text, text, text, text)',
    'public.rpc_cancel_booking(integer, text)'
  ] loop
    v_def := pg_get_functiondef(v_sig::regprocedure);
    if position('nosih_booking_role_allowed' in v_def) > 0 then
      continue;
    end if;
    v_old := '  if v_role is null or v_role not in (''FACULTY'', ''DEPARTMENT_MANAGER'', ''INCIDENT_MANAGER'', ''FACILITIES_ADMIN'', ''SYSTEM_ADMIN'') then';
    v_new := '  if not public.nosih_booking_role_allowed(v_role) then';
    if position(v_old in v_def) = 0 then
      raise exception 'booking role gate anchor missing in %', v_sig;
    end if;
    v_def := replace(v_def, v_old, v_new);
    execute v_def;
  end loop;
end;
$$;

-- The campus availability grid the faculty screen reads.
create or replace function public.rpc_bookable_rooms(p_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_day text;
  v_result jsonb;
begin
  perform public.nosih_refuse_student_booking();

  v_day := case extract(isodow from p_date)
    when 1 then 'MON' when 2 then 'TUE' when 3 then 'WED'
    when 4 then 'THU' when 5 then 'FRI' else null end;

  with periods as (
    select generate_series(1, 6) as period_number
  ), occupancy as (
    select ts.effective_space_code as code,
           ts.period_number,
           'CLASS'::text as state,
           ts.class_code || ' · ' || coalesce(ts.subject_title, 'Scheduled session') as label,
           u.full_name as owner,
           sc.student_strength as student_strength,
           2 as rank
      from public.timetable_slots ts
      join public.student_classes sc on sc.class_code = ts.class_code
      left join public.staff_profiles sp on sp.staff_code = ts.faculty_staff_code
      left join public.users u on u.id = sp.user_id
     where v_day is not null and ts.day_of_week = v_day
    union all
    select e.space_code,
           p.period_number,
           'EXAM'::text,
           'Exam · ' || e.class_code,
           e.invigilator_staff_code,
           null::integer,
           1
      from public.exams e
      cross join periods p
     where e.exam_date = p_date
    union all
    select bk.space_code,
           p.period_number,
           'BOOKING'::text,
           coalesce(nullif(trim(bk.purpose), ''), 'Booked room'),
           ub.full_name,
           null::integer,
           3
      from public.room_bookings bk
      cross join periods p
      left join public.users ub on ub.id = bk.booked_by_user_id
     where bk.status = 'ACTIVE'
       and tstzrange(bk.starts_at, bk.ends_at) && tstzrange(
             (p_date + public.nosih_period_start(p.period_number)) at time zone 'Asia/Kolkata',
             (p_date + public.nosih_period_end(p.period_number)) at time zone 'Asia/Kolkata')
  ), slots as (
    select rm.code as room_code,
           rm.capacity,
           b.code as block,
           f.floor_number,
           jsonb_agg(jsonb_build_object(
             'period_number', p.period_number,
             'starts_at', ((p_date + public.nosih_period_start(p.period_number)) at time zone 'Asia/Kolkata'),
             'ends_at', ((p_date + public.nosih_period_end(p.period_number)) at time zone 'Asia/Kolkata'),
             'state', coalesce(o.state, 'FREE'),
             'label', o.label,
             'owner', o.owner,
             'student_strength', o.student_strength
           ) order by p.period_number) as slots
      from public.rooms rm
      join public.buildings b on b.id = rm.building_id
      join public.floors f on f.id = rm.floor_id
      cross join periods p
      left join lateral (
        select o.state, o.label, o.owner, o.student_strength
          from occupancy o
         where o.code = rm.code
           and o.period_number = p.period_number
         order by o.rank
         limit 1
      ) o on true
     where rm.visual_state = 'HEALTHY'
     group by rm.code, rm.capacity, b.code, f.floor_number
  )
  select coalesce(jsonb_agg(to_jsonb(s) order by s.room_code), '[]'::jsonb)
    into v_result
    from slots s;

  return v_result;
end;
$$;

-- The signed-in user's own bookings.
create or replace function public.rpc_my_bookings(
  p_from timestamptz default now(),
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  perform public.nosih_refuse_student_booking();

  select coalesce(jsonb_agg(to_jsonb(b) order by b.starts_at), '[]'::jsonb)
    into v_result
    from (
      select b.id,
             b.space_code,
             b.class_code,
             b.purpose,
             b.starts_at,
             b.ends_at,
             b.status,
             b.created_at,
             u.full_name as booked_by_name,
             u.department_code
        from public.room_bookings b
        join public.users u on u.id = b.booked_by_user_id
       where b.booked_by_user_id = public.nosih_actor_id(null)
         and b.status = 'ACTIVE'
         and b.ends_at >= p_from
       order by b.starts_at
       limit least(200, greatest(1, p_limit))
    ) b;

  return v_result;
end;
$$;

-- The campus booking register and the room occupancy panel are staff surfaces:
-- the admin twin reads them, a student never does.
create or replace function public.rpc_list_bookings(
  p_from timestamptz default now(),
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  perform public.nosih_refuse_student_booking();

  select coalesce(jsonb_agg(to_jsonb(b) order by b.starts_at), '[]'::jsonb)
    into v_result
    from (
      select b.id, b.space_code, b.class_code, b.purpose, b.starts_at, b.ends_at,
             b.status, b.created_at, b.request_key,
             u.full_name as booked_by_name, u.department_code
        from public.room_bookings b
        left join public.users u on u.id = b.booked_by_user_id
       where b.status = 'ACTIVE' and b.ends_at >= p_from
       order by b.starts_at
       limit least(200, greatest(1, p_limit))
    ) b;

  return v_result;
end;
$$;

create or replace function public.rpc_get_room_occupancy(
  p_space_code text,
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_room record;
begin
  perform public.nosih_refuse_student_booking();

  select code, capacity, visual_state into v_room
    from public.rooms where upper(code) = upper(p_space_code) limit 1;
  if not found then
    return jsonb_build_object('error', 'ROOM_NOT_FOUND');
  end if;

  return jsonb_build_object(
    'space_code', v_room.code,
    'capacity', v_room.capacity,
    'visual_state', v_room.visual_state,
    'from', p_from,
    'to', p_to,
    'conflicts', public.nosih_booking_conflicts(v_room.code, p_from, p_to));
end;
$$;

grant execute on function public.rpc_bookable_rooms(date) to authenticated;
grant execute on function public.rpc_my_bookings(timestamptz, integer) to authenticated;
grant execute on function public.rpc_list_bookings(timestamptz, integer) to authenticated;
grant execute on function public.rpc_get_room_occupancy(text, timestamptz, timestamptz) to authenticated;
