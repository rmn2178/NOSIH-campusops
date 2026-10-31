-- Close the last table without row level security.
--
-- The exam schedule was created after the RLS sweep and never joined it, so
-- every signed-in student could read the whole campus exam grid straight from
-- the table - the same grid the booking system is built from. It is a
-- scheduling table, so it follows the booking rule: staff read it, students
-- do not.
--
-- The two functions that read it - nosih_booking_conflicts() and
-- rpc_bookable_rooms() - are security definer, so they still see every row.

alter table public.exams enable row level security;

drop policy if exists exams_staff_read on public.exams;
create policy exams_staff_read on public.exams
  for select to authenticated
  using (public.nosih_booking_role_allowed(public.nosih_actor_role(null)));

drop policy if exists exams_staff_write on public.exams;
create policy exams_staff_write on public.exams
  for all to authenticated
  using (public.nosih_booking_role_allowed(public.nosih_actor_role(null)))
  with check (public.nosih_booking_role_allowed(public.nosih_actor_role(null)));
