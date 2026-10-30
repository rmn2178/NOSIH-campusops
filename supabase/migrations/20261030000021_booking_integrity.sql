-- Booking integrity.
-- 1. A booking is checked against live classes and exams, not only other bookings.
-- 2. Class strength cannot exceed room capacity.
-- 3. Only the owner (or an admin) can cancel, and re-cancelling is idempotent.
-- 4. A client request key makes retries safe across network failures.

alter table public.room_bookings
  add column if not exists request_key text,
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by_user_id integer references public.users(id);

create unique index if not exists room_bookings_request_key_uidx
  on public.room_bookings (space_code, request_key)
  where request_key is not null;

-- Fixed period grid (IST) used by the timetable and the booking panel.
create or replace function public.nosih_period_start(p_period integer)
returns time
language sql
immutable
as $$
  select case p_period
    when 1 then '09:00'::time when 2 then '09:50'::time when 3 then '10:55'::time
    when 4 then '11:45'::time when 5 then '13:20'::time when 6 then '14:10'::time
  end
$$;

create or replace function public.nosih_period_end(p_period integer)
returns time
language sql
immutable
as $$
  select case p_period
    when 1 then '09:50'::time when 2 then '10:40'::time when 3 then '11:45'::time
    when 4 then '12:35'::time when 5 then '14:10'::time when 6 then '15:00'::time
  end
$$;

drop function if exists public.nosih_period_bounds(integer);

-- Everything that already occupies a room in a window: classes, exams, bookings.
create or replace function public.nosih_booking_conflicts(
  p_space_code text,
  p_starts_at timestamptz,
  p_ends_at timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_local_date date := (p_starts_at at time zone 'Asia/Kolkata')::date;
  v_day text;
  v_periods integer[];
  v_slot record;
  v_exam record;
  v_booking record;
  v_conflicts jsonb := '[]'::jsonb;
begin
  v_day := case extract(isodow from v_local_date)
    when 1 then 'MON' when 2 then 'TUE' when 3 then 'WED'
    when 4 then 'THU' when 5 then 'FRI' else null end;

  select coalesce(array_agg(period_number), '{}')
    into v_periods
    from generate_series(1, 6) as period_number
   where tstzrange(
           ((v_local_date + public.nosih_period_start(period_number)) at time zone 'Asia/Kolkata'),
           ((v_local_date + public.nosih_period_end(period_number)) at time zone 'Asia/Kolkata')
         ) && tstzrange(p_starts_at, p_ends_at);

  if v_day is not null and array_length(v_periods, 1) is not null then
    for v_slot in
      select ts.class_code, ts.subject_title, ts.session_type, ts.period_number,
             sc.student_strength, u.full_name as faculty_name
        from public.timetable_slots ts
        join public.student_classes sc on sc.class_code = ts.class_code
        left join public.staff_profiles sp on sp.staff_code = ts.faculty_staff_code
        left join public.users u on u.id = sp.user_id
       where ts.effective_space_code = p_space_code
         and ts.day_of_week = v_day
         and ts.period_number = any(v_periods)
       order by ts.period_number
    loop
      v_conflicts := v_conflicts || jsonb_build_object(
        'kind', 'CLASS',
        'label', v_slot.class_code || ' · ' || coalesce(v_slot.subject_title, 'Scheduled session'),
        'class_code', v_slot.class_code,
        'period_number', v_slot.period_number,
        'student_strength', v_slot.student_strength,
        'owner', v_slot.faculty_name,
        'starts_at', ((v_local_date + public.nosih_period_start(v_slot.period_number)) at time zone 'Asia/Kolkata'),
        'ends_at', ((v_local_date + public.nosih_period_end(v_slot.period_number)) at time zone 'Asia/Kolkata'));
    end loop;
  end if;

  for v_exam in
    select e.class_code, e.period_number, e.invigilator_staff_code
      from public.exams e
     where e.space_code = p_space_code
       and e.exam_date = v_local_date
       and e.period_number = any(v_periods)
  loop
    v_conflicts := v_conflicts || jsonb_build_object(
      'kind', 'EXAM',
      'label', 'Exam · ' || v_exam.class_code,
      'class_code', v_exam.class_code,
      'period_number', v_exam.period_number,
      'owner', v_exam.invigilator_staff_code,
      'starts_at', ((v_local_date + public.nosih_period_start(v_exam.period_number)) at time zone 'Asia/Kolkata'),
      'ends_at', ((v_local_date + public.nosih_period_end(v_exam.period_number)) at time zone 'Asia/Kolkata'));
  end loop;

  for v_booking in
    select b.id, b.class_code, b.purpose, b.starts_at, b.ends_at, b.booked_by_user_id,
           u.full_name as booked_by_name
      from public.room_bookings b
      left join public.users u on u.id = b.booked_by_user_id
     where b.space_code = p_space_code
       and b.status = 'ACTIVE'
       and tstzrange(b.starts_at, b.ends_at) && tstzrange(p_starts_at, p_ends_at)
     order by b.starts_at
  loop
    v_conflicts := v_conflicts || jsonb_build_object(
      'kind', 'BOOKING',
      'booking_id', v_booking.id,
      'label', coalesce(nullif(trim(v_booking.purpose), ''), 'Booked room'),
      'class_code', v_booking.class_code,
      'owner', coalesce(v_booking.booked_by_name, 'Booking owner'),
      'starts_at', v_booking.starts_at,
      'ends_at', v_booking.ends_at);
  end loop;

  return v_conflicts;
end;
$$;

-- Healthy rooms that are genuinely free for the whole window.
create or replace function public.nosih_booking_alternatives(
  p_space_code text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_limit integer default 3
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(a) order by a.capacity desc, a.room_code), '[]'::jsonb)
    from (
      select r.code as room_code, r.capacity
        from public.rooms r
       where r.visual_state = 'HEALTHY'
         and upper(r.code) <> upper(p_space_code)
         and jsonb_array_length(public.nosih_booking_conflicts(r.code, p_starts_at, p_ends_at)) = 0
       order by r.capacity desc, r.code
       limit least(10, greatest(1, p_limit))
    ) a
$$;

drop function if exists public.rpc_create_booking(text, timestamptz, timestamptz, text, text, text);

create or replace function public.rpc_create_booking(
  p_space_code text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_purpose text,
  p_class_code text default null,
  p_actor_email text default null,
  p_request_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.nosih_actor_role(p_actor_email);
  v_actor_id integer := public.nosih_actor_id(p_actor_email);
  v_room record;
  v_id integer;
  v_alt jsonb;
  v_conflicts jsonb;
  v_strength integer;
  v_existing public.room_bookings%rowtype;
  v_error text;
begin
  if v_role is null or v_role not in ('FACULTY', 'DEPARTMENT_MANAGER', 'INCIDENT_MANAGER', 'FACILITIES_ADMIN', 'SYSTEM_ADMIN') then
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN');
  end if;
  if p_ends_at <= p_starts_at then
    return jsonb_build_object('success', false, 'error', 'INVALID_WINDOW');
  end if;
  if p_ends_at - p_starts_at > interval '12 hours' then
    return jsonb_build_object('success', false, 'error', 'INVALID_WINDOW', 'reason', 'MAX_12_HOURS');
  end if;

  select code, visual_state, capacity into v_room
    from public.rooms where upper(code) = upper(p_space_code) limit 1;
  if not found then
    return jsonb_build_object('success', false, 'error', 'ROOM_NOT_FOUND');
  end if;

  if nullif(trim(coalesce(p_request_key, '')), '') is not null then
    select * into v_existing from public.room_bookings
     where space_code = v_room.code and request_key = p_request_key
     limit 1;
    if found then
      return jsonb_build_object('success', true, 'booking_id', v_existing.id,
        'space_code', v_existing.space_code, 'starts_at', v_existing.starts_at,
        'ends_at', v_existing.ends_at, 'status', v_existing.status, 'idempotent', true);
    end if;
  end if;

  if v_room.visual_state <> 'HEALTHY' then
    v_alt := public.nosih_booking_alternatives(v_room.code, p_starts_at, p_ends_at);
    return jsonb_build_object('success', false, 'error', 'ROOM_NOT_HEALTHY',
                              'visual_state', v_room.visual_state, 'alternatives', v_alt);
  end if;

  if nullif(trim(coalesce(p_class_code, '')), '') is not null then
    select sc.student_strength into v_strength
      from public.student_classes sc where sc.class_code = p_class_code limit 1;
    if not found then
      return jsonb_build_object('success', false, 'error', 'CLASS_NOT_FOUND', 'class_code', p_class_code);
    end if;
    if v_strength > v_room.capacity then
      v_alt := public.nosih_booking_alternatives(v_room.code, p_starts_at, p_ends_at);
      return jsonb_build_object('success', false, 'error', 'CAPACITY_EXCEEDED',
        'class_code', p_class_code, 'student_strength', v_strength,
        'room_capacity', v_room.capacity, 'alternatives', v_alt);
    end if;
  end if;

  v_conflicts := public.nosih_booking_conflicts(v_room.code, p_starts_at, p_ends_at);
  if jsonb_array_length(v_conflicts) > 0 then
    v_alt := public.nosih_booking_alternatives(v_room.code, p_starts_at, p_ends_at);
    v_error := case when exists (
      select 1 from jsonb_array_elements(v_conflicts) c where c->>'kind' = 'BOOKING'
    ) then 'DOUBLE_BOOKED' else 'ROOM_IN_USE' end;
    perform public.nosih_append_audit(p_actor_email, v_role, 'CREATE_BOOKING', 'ROOM', v_room.code,
      'REJECTED', v_error, 'Overlapping class, exam or booking',
      jsonb_build_object('conflicts', v_conflicts, 'alternatives', v_alt));
    return jsonb_build_object('success', false, 'error', v_error,
                              'conflicts', v_conflicts, 'alternatives', v_alt);
  end if;

  begin
    insert into public.room_bookings (
      space_code, class_code, purpose, booked_by_user_id, starts_at, ends_at, request_key
    ) values (
      v_room.code, nullif(trim(coalesce(p_class_code, '')), ''),
      coalesce(nullif(trim(p_purpose), ''), 'Booked room'),
      v_actor_id, p_starts_at, p_ends_at,
      nullif(trim(coalesce(p_request_key, '')), '')
    ) returning id into v_id;
  exception
    when exclusion_violation then
      v_alt := public.nosih_booking_alternatives(v_room.code, p_starts_at, p_ends_at);
      perform public.nosih_append_audit(p_actor_email, v_role, 'CREATE_BOOKING', 'ROOM', v_room.code,
        'REJECTED', 'DOUBLE_BOOKED', 'Overlapping active booking', jsonb_build_object('alternatives', v_alt));
      return jsonb_build_object('success', false, 'error', 'DOUBLE_BOOKED', 'alternatives', v_alt);
    when unique_violation then
      select * into v_existing from public.room_bookings
       where space_code = v_room.code and request_key = p_request_key limit 1;
      if found then
        return jsonb_build_object('success', true, 'booking_id', v_existing.id,
          'space_code', v_existing.space_code, 'starts_at', v_existing.starts_at,
          'ends_at', v_existing.ends_at, 'status', v_existing.status, 'idempotent', true);
      end if;
      raise;
  end;

  perform public.nosih_append_audit(p_actor_email, v_role, 'CREATE_BOOKING', 'ROOM', v_room.code,
    'ALLOWED', 'BOOKING_CONFIRMED', coalesce(p_purpose, 'Booked room'));

  return jsonb_build_object('success', true, 'booking_id', v_id, 'space_code', v_room.code,
                            'starts_at', p_starts_at, 'ends_at', p_ends_at,
                            'status', 'ACTIVE', 'idempotent', false);
end;
$$;

create or replace function public.rpc_cancel_booking(
  p_booking_id integer,
  p_actor_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.nosih_actor_role(p_actor_email);
  v_actor_id integer := public.nosih_actor_id(p_actor_email);
  v_row public.room_bookings%rowtype;
  v_owner_dept text;
  v_actor_dept text;
  v_allowed boolean;
begin
  if v_role is null or v_role not in ('FACULTY', 'DEPARTMENT_MANAGER', 'INCIDENT_MANAGER', 'FACILITIES_ADMIN', 'SYSTEM_ADMIN') then
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN');
  end if;

  select * into v_row from public.room_bookings where id = p_booking_id for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'BOOKING_NOT_FOUND');
  end if;

  select department_code into v_owner_dept from public.users where id = v_row.booked_by_user_id;
  select department_code into v_actor_dept from public.users where id = v_actor_id;

  v_allowed := v_role in ('FACILITIES_ADMIN', 'SYSTEM_ADMIN')
    or v_row.booked_by_user_id = v_actor_id
    or (v_role = 'DEPARTMENT_MANAGER' and v_owner_dept is not null and v_owner_dept = v_actor_dept);

  if not v_allowed then
    perform public.nosih_append_audit(p_actor_email, v_role, 'CANCEL_BOOKING', 'ROOM', v_row.space_code,
      'REJECTED', 'NOT_BOOKING_OWNER', 'Only the owner or an administrator can cancel this booking');
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN',
                              'reason', 'NOT_BOOKING_OWNER');
  end if;

  if v_row.status = 'CANCELLED' then
    return jsonb_build_object('success', true, 'booking_id', v_row.id,
                              'status', 'CANCELLED', 'already_cancelled', true);
  end if;

  update public.room_bookings
     set status = 'CANCELLED', cancelled_at = now(), cancelled_by_user_id = v_actor_id
   where id = v_row.id;

  perform public.nosih_append_audit(p_actor_email, v_role, 'CANCEL_BOOKING', 'ROOM', v_row.space_code,
    'ALLOWED', 'BOOKING_CANCELLED', coalesce(v_row.purpose, 'Booking cancelled'));

  return jsonb_build_object('success', true, 'booking_id', v_row.id,
                            'status', 'CANCELLED', 'already_cancelled', false);
end;
$$;

create or replace function public.rpc_list_bookings(
  p_from timestamptz default now(),
  p_limit integer default 50
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(b) order by b.starts_at), '[]'::jsonb)
    from (
      select b.id, b.space_code, b.class_code, b.purpose, b.starts_at, b.ends_at,
             b.status, b.created_at, b.request_key,
             u.full_name as booked_by_name, u.department_code
        from public.room_bookings b
        left join public.users u on u.id = b.booked_by_user_id
       where b.status = 'ACTIVE' and b.ends_at >= p_from
       order by b.starts_at
       limit least(200, greatest(1, p_limit))
    ) b
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

grant execute on function public.nosih_period_start(integer) to anon, authenticated;
grant execute on function public.nosih_period_end(integer) to anon, authenticated;
grant execute on function public.rpc_create_booking(text, timestamptz, timestamptz, text, text, text, text) to authenticated;
grant execute on function public.rpc_cancel_booking(integer, text) to authenticated;
grant execute on function public.rpc_list_bookings(timestamptz, integer) to authenticated;
grant execute on function public.rpc_get_room_occupancy(text, timestamptz, timestamptz) to authenticated;
