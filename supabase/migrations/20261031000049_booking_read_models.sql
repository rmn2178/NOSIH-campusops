-- Booking read models for the complaint portal.
--
-- The admin twin draws one room at a time from the 3D scene. The complaint
-- portal needs the whole campus at once: every healthy classroom with its
-- capacity and a six-period free/busy grid built from the live timetable, the
-- exam calendar and the active bookings, plus the signed-in user's own
-- bookings. One round trip keeps the faculty screen fast.

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

create or replace function public.rpc_my_bookings(
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
    ) b
$$;

grant execute on function public.rpc_bookable_rooms(date) to authenticated;
grant execute on function public.rpc_my_bookings(timestamptz, integer) to authenticated;
