-- The SLA policy matrix and the campus operating calendar.
--
-- The clock used to carry a hardcoded urgency-to-minutes case expression
-- inside the intake function, and it counted wall-clock minutes. A campus SLA
-- is a policy, not a constant, so both halves now live in the database:
--
--   sla_policies        what each service promises - a separate response
--                       deadline and a separate resolution deadline per
--                       priority, plus the 24x7 carve-out for services that
--                       must run when the campus is closed.
--   sla_calendar_days  when the campus is open - weekends, academic
--                       holidays, exam week and semester break. The clock
--                       only accrues while the campus is open, unless the
--                       policy says the service runs around the clock.
--
-- Deadlines for a working-hours policy are operational minutes: 48 hours of
-- P3 means 48 hours the support desk is actually open, which is what a campus
-- promises its students. A 24x7 policy is measured on the wall clock.

-- ----------------------------------------------------------------------
-- 1. The matrix
-- ----------------------------------------------------------------------
create table if not exists public.sla_policies (
  id serial primary key,
  priority_code text not null,
  priority_label text not null,
  service_name text not null,
  category text,
  response_target_mins integer not null,
  resolution_target_mins integer not null,
  is_24x7 boolean not null default false,
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint sla_policies_priority check (priority_code in ('P1', 'P2', 'P3', 'P4'))
);

create unique index if not exists sla_policies_priority_category
  on public.sla_policies (priority_code, coalesce(category, ''));

-- The campus matrix: a priority, the service that owns it, the two
-- deadlines and the example a dean would recognise.
insert into public.sla_policies (
  priority_code, priority_label, service_name, category,
  response_target_mins, resolution_target_mins, is_24x7, description
)
values
  ('P1', 'Critical', 'Campus Facilities & Safety', null,
   30, 240, true,
   'Exam portal outage, hostel power failure, classroom safety hazard - answered within the hour and fixed within four clock hours, day or night'),
  ('P1', 'Critical', 'Campus Facilities & Safety', 'SAFETY_FIRE',
   15, 120, true,
   'Fire, smoke, sparks or water near electrics - the tightest promise on campus'),
  ('P2', 'Urgent', 'Campus IT', null,
   120, 480, false,
   'Smartboard failure in a lecture hall or a campus network fault during classes - two working hours to answer, eight to fix'),
  ('P2', 'Urgent', 'Campus IT', 'IT_AV',
   60, 240, false,
   'Audio-visual kit failure - the room is unusable for the next session'),
  ('P3', 'Standard', 'Campus Maintenance', null,
   240, 2880, false,
   'Hostel room repair, a leaking tap, a broken chair - four working hours to answer, forty-eight to fix'),
  ('P4', 'Low', 'Campus Administration', null,
   1440, 1800, false,
   'Transcript request, parking permit, certificate processing - one working day to answer, five working days to deliver')
on conflict do nothing;

-- ----------------------------------------------------------------------
-- 2. The operating calendar
-- ----------------------------------------------------------------------
create table if not exists public.sla_calendar_days (
  day_date date primary key,
  is_working_day boolean not null default true,
  label text,
  open_minute integer not null default 540,
  close_minute integer not null default 900,
  note text,
  constraint sla_calendar_window check (open_minute >= 0 and close_minute <= 1440 and open_minute < close_minute)
);

-- The default academic year: the desk runs 09:00-15:00 IST on teaching days,
-- exam week extends the window, and the two long breaks and the institute
-- holiday close the campus. Weekends need no row: Saturday and Sunday are
-- never working days.
with base as (
  select date_trunc('week', current_date)::date as monday
), calendar as (
  select (b.monday + 21 + d)::date as day_date,
         'Diwali vacation'::text as label,
         'Campus closed for the Diwali vacation'::text as note,
         false as working, 540 as open_minute, 900 as close_minute
    from base b, generate_series(0, 2) d
  union all
  select (b.monday + 35 + d)::date, 'Semester break', 'Teaching paused - only 24x7 critical work runs', false, 540, 900
    from base b, generate_series(0, 4) d
  union all
  select (b.monday + 63 + 3)::date, 'Founders Day', 'Institute holiday', false, 540, 900
    from base b
)
insert into public.sla_calendar_days (day_date, is_working_day, label, open_minute, close_minute, note)
select day_date, working, label, open_minute, close_minute, note
  from calendar
on conflict (day_date) do nothing;

-- Exam week runs a longer support window.
with base as (
  select date_trunc('week', current_date)::date as monday
)
insert into public.sla_calendar_days (day_date, is_working_day, label, open_minute, close_minute, note)
select (b.monday + 28 + d)::date, true, 'Exam week - extended hours', 480, 960,
       'Examination duty extends the support window to 08:00-16:00'
  from base b, generate_series(0, 4) d
on conflict (day_date) do nothing;

-- ----------------------------------------------------------------------
-- 3. The calendar arithmetic
-- ----------------------------------------------------------------------

-- Operational minutes between two instants: only the minutes the campus was
-- open count. Weekends, holidays and breaks contribute nothing.
create or replace function public.nosih_sla_working_minutes(
  p_from timestamptz,
  p_to timestamptz
)
returns integer
language sql
stable
as $$
  with days as (
    select (generate_series(
      (coalesce(p_from, now()) at time zone 'Asia/Kolkata')::date::timestamp,
      (coalesce(p_to, now()) at time zone 'Asia/Kolkata')::date::timestamp,
      interval '1 day'))::date as day
  ), windows as (
    select d.day,
           (d.day + make_interval(mins => coalesce(c.open_minute, 540))) at time zone 'Asia/Kolkata' as open_at,
           (d.day + make_interval(mins => coalesce(c.close_minute, 900))) at time zone 'Asia/Kolkata' as close_at
      from days d
      left join public.sla_calendar_days c on c.day_date = d.day
     where extract(isodow from d.day) between 1 and 5
       and coalesce(c.is_working_day, true)
       and coalesce(c.open_minute, 540) < coalesce(c.close_minute, 900)
  )
  select coalesce(sum(greatest(0, floor(extract(epoch from (
      least(w.close_at, coalesce(p_to, now())) - greatest(w.open_at, coalesce(p_from, now()))
    )) / 60.0))::int), 0)::int
    from windows w
   where least(w.close_at, coalesce(p_to, now()))
       > greatest(w.open_at, coalesce(p_from, now()))
$$;

-- The minutes a clock actually accrues. A 24x7 service accrues wall-clock
-- minutes; everything else accrues operational minutes only.
create or replace function public.nosih_sla_operating_minutes(
  p_from timestamptz,
  p_to timestamptz,
  p_is_24x7 boolean default false
)
returns integer
language sql
stable
as $$
  select case
    when coalesce(p_is_24x7, false) then
      greatest(0, floor(extract(epoch from (
        coalesce(p_to, now()) - coalesce(p_from, now())
      )) / 60.0)::int)
    else public.nosih_sla_working_minutes(p_from, p_to)
  end
$$;

-- ----------------------------------------------------------------------
-- 4. Resolving the policy for a request
-- ----------------------------------------------------------------------

-- The effective promise for a request: its priority, its service and its two
-- deadlines. A category override wins over the general row for that
-- priority, so SAFETY_FIRE is answered faster than a plain critical fault.
create or replace function public.nosih_sla_policy_for(p_urgency text, p_category text)
returns jsonb
language sql
stable
as $$
  with picked as (
    select p.*
      from public.sla_policies p
     where p.is_active
       and p.priority_code = case upper(coalesce(p_urgency, 'LOW'))
              when 'CRITICAL' then 'P1'
              when 'HIGH' then 'P2'
              when 'MEDIUM' then 'P3'
              else 'P4' end
       and (p.category is null or p.category = upper(coalesce(p_category, '')))
     order by (p.category is null), p.id
     limit 1
  )
  select coalesce(
    (select jsonb_build_object(
       'priority_code', priority_code,
       'priority_label', priority_label,
       'service_name', service_name,
       'category', category,
       'response_target_mins', response_target_mins,
       'resolution_target_mins', resolution_target_mins,
       'is_24x7', is_24x7,
       'description', description,
       'basis', case when is_24x7 then 'CLOCK' else 'WORKING' end,
       'response_hours', round(response_target_mins::numeric / 60.0, 2),
       'resolution_hours', round(resolution_target_mins::numeric / 60.0, 2),
       'resolution_days', round(resolution_target_mins::numeric / 360.0, 2)
     ) from picked),
    jsonb_build_object(
       'priority_code', 'P4', 'priority_label', 'Low', 'service_name', 'Campus Administration',
       'category', null, 'response_target_mins', 1440, 'resolution_target_mins', 1800,
       'is_24x7', false, 'description', 'No policy row matched this request',
       'basis', 'WORKING', 'response_hours', 24, 'resolution_hours', 30, 'resolution_days', 5
    )
  )
$$;

-- The calendar as the portals and the admin console read it.
create or replace function public.nosih_sla_calendar(p_from date, p_to date)
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_agg(to_jsonb(c) order by c.day_date), '[]'::jsonb)
    from (
      select c.day_date, c.is_working_day, c.label, c.open_minute, c.close_minute, c.note,
             (c.open_minute / 60) || ':' || lpad((c.open_minute % 60)::text, 2, '0') as opens_at,
             (c.close_minute / 60) || ':' || lpad((c.close_minute % 60)::text, 2, '0') as closes_at
        from public.sla_calendar_days c
       where c.day_date between coalesce(p_from, current_date)
                           and coalesce(p_to, current_date + 60)
       order by c.day_date
    ) c
$$;

-- ----------------------------------------------------------------------
-- 5. Access
-- ----------------------------------------------------------------------
alter table public.sla_policies enable row level security;
alter table public.sla_calendar_days enable row level security;

drop policy if exists sla_policies_read on public.sla_policies;
create policy sla_policies_read on public.sla_policies
  for select to authenticated
  using (true);

drop policy if exists sla_policies_write on public.sla_policies;
create policy sla_policies_write on public.sla_policies
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists sla_calendar_days_read on public.sla_calendar_days;
create policy sla_calendar_days_read on public.sla_calendar_days
  for select to authenticated
  using (true);

drop policy if exists sla_calendar_days_write on public.sla_calendar_days;
create policy sla_calendar_days_write on public.sla_calendar_days
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

grant execute on function public.nosih_sla_working_minutes(timestamptz, timestamptz) to authenticated, service_role;
grant execute on function public.nosih_sla_operating_minutes(timestamptz, timestamptz, boolean) to authenticated, service_role;
grant execute on function public.nosih_sla_policy_for(text, text) to authenticated, service_role;
grant execute on function public.nosih_sla_calendar(date, date) to authenticated, service_role;
