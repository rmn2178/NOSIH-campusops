-- Remove orphaned faculty users left by the first (non-idempotent) timetable run.
delete from public.users u
 where u.role = 'FACULTY'
   and u.email ~ '^fac1[0-9][0-9]@nosih\.edu\.in$'
   and not exists (select 1 from public.staff_profiles sp where sp.user_id = u.id)
   and not exists (select 1 from public.complaints c where c.reporter_user_id = u.id);
