-- Realistic booking and officer data for the demo.
--
-- 1. The seeded exams land on the coming week instead of a weekend.
-- 2. Faculty bookings fill the calendar the way a real campus week looks:
--    capstone reviews, viva preparation, board meetings, an accreditation
--    visit, placement panels. Every row is checked against the live timetable,
--    the exam calendar and the other bookings, and a free healthy room is
--    chosen for it, so the calendar never shows a double booking.
-- 3. The three live faults get their area officer, and the technician load
--    counters are recomputed from the open work orders they really hold.

-- 1. Exams on weekdays only ----------------------------------------------------
with ordered as (
  select e.id, row_number() over (order by e.id) as rn
    from public.exams e
)
update public.exams e
   set exam_date = (date_trunc('week', current_date) + interval '7 days')::date
                     + ((ordered.rn - 1) % 5)::int,
       invigilator_staff_code = coalesce(e.invigilator_staff_code,
         (select sp.staff_code
            from public.staff_profiles sp
           where sp.staff_category = 'CLASS_FACULTY'
           order by md5(sp.staff_code || ordered.rn::text)
           limit 1))
  from ordered
 where e.id = ordered.id;

-- 2. Faculty bookings across the coming week ----------------------------------
-- One booking per seed row: the request key identifies the booking, so a
-- re-run never adds a second one even when the first room is now occupied.
delete from public.room_bookings b
 where b.request_key like 'demo-%'
   and exists (select 1 from public.room_bookings k
                where k.request_key = b.request_key and k.id < b.id);

-- Verification bookings are released again; they should not stay in the demo.
delete from public.room_bookings where purpose = 'Portal contract check';

do $$
declare
  v_seed record;
  v_room text;
  v_start timestamptz;
  v_end timestamptz;
  v_day date;
  v_owner integer;
  v_strength integer;
  v_key text;
  v_offset integer := 0;
  v_bookings integer := 0;
begin
  for v_seed in
    select * from (values
      (0, 2, 'AIDS capstone review',                    'fac001@nosih.edu.in', 'AIDS-Y1-A'),
      (0, 5, 'EC viva viva preparation',                 'fac046@nosih.edu.in', 'ECE-Y1-A'),
      (1, 1, 'Laboratory safety briefing',               'fac061@nosih.edu.in', 'MECH-Y1-A'),
      (1, 3, 'Student council orientation',              'fac016@nosih.edu.in', 'AIML-Y1-A'),
      (1, 4, 'Placement drive panel',                    'hod.cse@nosih.edu.in', 'CSE-Y1-A'),
      (2, 2, 'Internal review panel',                    'fac031@nosih.edu.in', 'CSE-Y1-A'),
      (2, 5, 'NAAC peer team visit',                     'hod.aids@nosih.edu.in', 'AIDS-Y1-A'),
      (3, 1, 'Project exhibition setup',                 'fac046@nosih.edu.in', 'ECE-Y1-A'),
      (3, 3, 'Faculty board meeting',                    'hod.ece@nosih.edu.in', 'ECE-Y1-A'),
      (3, 6, 'Research proposal sync',                   'fac061@nosih.edu.in', 'MECH-Y1-A'),
      (4, 2, 'Departmental review of the lab roster',   'hod.mech@nosih.edu.in', 'MECH-Y1-A'),
      (4, 4, 'Alumni mentoring session',                 'fac001@nosih.edu.in', 'AIDS-Y1-A'),
      (4, 5, 'Curriculum audit with the industry panel', 'hod.cyber@nosih.edu.in', 'CYBER-Y1-A')
    ) as t(day_offset, period, purpose, email, class_code)
  loop
    -- The next weekday, skipping the weekend.
    v_day := (date_trunc('week', current_date) + interval '7 days')::date;
    v_offset := 0;
    while v_offset < 5 and extract(isodow from v_day) > 5 loop
      v_day := v_day + 1;
      v_offset := v_offset + 1;
    end loop;
    v_day := v_day + v_seed.day_offset;
    while extract(isodow from v_day) > 5 loop
      v_day := v_day + 1;
    end loop;

    v_start := (v_day + public.nosih_period_start(v_seed.period)) at time zone 'Asia/Kolkata';
    v_end := (v_day + public.nosih_period_end(v_seed.period)) at time zone 'Asia/Kolkata';

    select id into v_owner from public.users where lower(email) = lower(v_seed.email) limit 1;
    if v_owner is null then
      continue;
    end if;

    v_key := 'demo-' || md5(v_seed.email || v_seed.purpose || v_day::text || v_seed.period::text);
    if exists (select 1 from public.room_bookings where request_key = v_key) then
      continue;
    end if;

    select coalesce(student_strength, 0) into v_strength
      from public.student_classes where class_code = v_seed.class_code limit 1;

    -- First free healthy room, spread deterministically across the campus.
    select r.code into v_room
      from public.rooms r
     where r.visual_state = 'HEALTHY'
       and r.capacity >= v_strength
       and jsonb_array_length(public.nosih_booking_conflicts(r.code, v_start, v_end)) = 0
     order by md5(r.code || v_seed.email || v_seed.purpose::text)
     limit 1;

    if v_room is null then
      continue;
    end if;

    insert into public.room_bookings (
      space_code, class_code, purpose, booked_by_user_id, starts_at, ends_at, request_key
    ) values (
      v_room, nullif(v_seed.class_code, ''), v_seed.purpose, v_owner, v_start, v_end, v_key
    )
    on conflict do nothing;

    v_bookings := v_bookings + 1;
  end loop;

  raise notice 'demo bookings prepared: %', v_bookings;
end $$;

-- 3. Area officers for the live faults ----------------------------------------
-- The live work orders are released and appointed again so the officer is
-- chosen with the corrected area rule (the block letter, not "C1").
update public.work_orders w
   set assigned_staff_code = null,
       status = 'PENDING_ASSIGNMENT'
 where w.id in (
   select w2.id from public.work_orders w2
     join public.complaints c on c.id = w2.complaint_id
    where c.status not in ('RESOLVED', 'CLOSED', 'MERGED_DUPLICATE')
 );

-- Release the load those jobs were carrying, so the ranking below sees the
-- real workload and the same officers are appointed on every run.
update public.staff_profiles sp
   set current_active_jobs = (
     select count(*) from public.work_orders w
      where w.assigned_staff_code = sp.staff_code
        and w.status in ('ASSIGNED', 'IN_PROGRESS', 'BLOCKED_PARTS'));

do $$
declare
  v_wo record;
begin
  for v_wo in
    select w.id, w.wo_number
      from public.work_orders w
      join public.complaints c on c.id = w.complaint_id
     where c.status not in ('RESOLVED', 'CLOSED', 'MERGED_DUPLICATE')
       and w.assigned_staff_code is null
  loop
    perform public.nosih_appoint_officer(v_wo.id);
  end loop;
end $$;

-- 3b. The legacy facilities booking reads like a real one --------------------
update public.room_bookings
   set purpose = 'Exam hall preparation'
 where purpose = 'Booked room'
   and space_code = 'A1-01';

-- 4. Technician load counters follow the work they really hold ----------------
update public.staff_profiles sp
   set current_active_jobs = (
     select count(*) from public.work_orders w
      where w.assigned_staff_code = sp.staff_code
        and w.status in ('ASSIGNED', 'IN_PROGRESS', 'BLOCKED_PARTS'));

-- 5. The three live tickets now name their officer ----------------------------
select c.ticket_number,
       c.space_code,
       public.nosih_complaint_officer(c.id) ->> 'full_name' as officer,
       public.nosih_complaint_officer(c.id) ->> 'primary_skill' as skill,
       public.nosih_complaint_officer(c.id) ->> 'area' as area
  from public.complaints c
 where c.status not in ('RESOLVED', 'CLOSED', 'MERGED_DUPLICATE')
 order by c.created_at desc;
