-- Row-Level Security, realtime publication, storage bucket and Auth linkage.
-- All writes go through SECURITY DEFINER RPCs or Edge Functions (service role);
-- the browser only gets read access scoped to its role.

-- Enable RLS everywhere ------------------------------------------------------
do $$
declare
  t text;
  tables text[] := array[
    'buildings', 'floors', 'distribution_boards', 'rooms', 'labs', 'canteens',
    'bill_bots', 'assets', 'departments', 'student_classes', 'users',
    'staff_profiles', 'timetable_slots', 'identity_vault', 'complaints',
    'complaint_comments', 'complaint_votes', 'incidents', 'work_orders',
    'inventory_items', 'part_reservations', 'purchase_requests', 'sla_clocks',
    'resource_locks', 'maintenance_history', 'notification_logs', 'audit_logs',
    'campus_clock_state'
  ];
begin
  foreach t in array tables loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

alter table if exists public.alembic_version enable row level security;

-- Users ----------------------------------------------------------------------
drop policy if exists users_self_read on public.users;
create policy users_self_read on public.users
  for select to authenticated
  using (auth_user_id = auth.uid() or public.is_admin());

drop policy if exists users_self_update on public.users;
create policy users_self_update on public.users
  for update to authenticated
  using (auth_user_id = auth.uid())
  with check (auth_user_id = auth.uid());

-- Complaints & comments ------------------------------------------------------
drop policy if exists complaints_approved_read on public.complaints;
create policy complaints_approved_read on public.complaints
  for select to anon, authenticated
  using (moderation_status = 'APPROVED' or public.is_admin());

drop policy if exists comments_approved_read on public.complaint_comments;
create policy comments_approved_read on public.complaint_comments
  for select to anon, authenticated
  using (moderation_status = 'APPROVED' or public.is_admin());

-- Admin read access to the operational graph --------------------------------
do $$
declare
  t text;
  tables text[] := array[
    'buildings', 'floors', 'distribution_boards', 'rooms', 'labs', 'canteens',
    'bill_bots', 'assets', 'departments', 'student_classes', 'staff_profiles',
    'timetable_slots', 'complaint_votes', 'incidents', 'work_orders',
    'inventory_items', 'part_reservations', 'purchase_requests', 'sla_clocks',
    'resource_locks', 'maintenance_history', 'notification_logs', 'audit_logs'
  ];
begin
  foreach t in array tables loop
    execute format('drop policy if exists %I on public.%I', t || '_admin_read', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.is_admin())',
      t || '_admin_read', t
    );
  end loop;
end $$;

drop policy if exists clock_authenticated_read on public.campus_clock_state;
create policy clock_authenticated_read on public.campus_clock_state
  for select to authenticated using (true);

-- identity_vault intentionally has RLS enabled with zero policies.

-- Storage --------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'complaint-evidence', 'complaint-evidence', true, 5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists complaint_evidence_public_read on storage.objects;
create policy complaint_evidence_public_read on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'complaint-evidence');

drop policy if exists complaint_evidence_user_upload on storage.objects;
create policy complaint_evidence_user_upload on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'complaint-evidence'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists complaint_evidence_user_update on storage.objects;
create policy complaint_evidence_user_update on storage.objects
  for update to authenticated
  using (bucket_id = 'complaint-evidence' and owner = auth.uid())
  with check (bucket_id = 'complaint-evidence' and owner = auth.uid());

drop policy if exists complaint_evidence_user_delete on storage.objects;
create policy complaint_evidence_user_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'complaint-evidence' and owner = auth.uid());

-- Realtime -------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

do $$
declare
  t text;
  tables text[] := array[
    'rooms', 'labs', 'canteens', 'bill_bots', 'assets', 'campus_clock_state',
    'timetable_slots', 'complaints', 'complaint_comments', 'complaint_votes',
    'incidents', 'work_orders', 'inventory_items', 'purchase_requests',
    'sla_clocks', 'resource_locks', 'notification_logs', 'audit_logs'
  ];
begin
  foreach t in array tables loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- Auth -> profile linkage ----------------------------------------------------
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(new.email);
  v_existing integer;
  v_role text;
  v_dept text;
  v_year integer;
  v_name text;
begin
  select id into v_existing from public.users where lower(email) = v_email limit 1;

  if v_existing is not null then
    update public.users
       set auth_user_id = new.id
     where id = v_existing;
    return new;
  end if;

  -- Never accept an admin role from sign-up metadata.
  v_role := case
    when new.raw_user_meta_data->>'role' in ('STUDENT', 'FACULTY', 'LAB_STAFF')
      then new.raw_user_meta_data->>'role'
    else 'STUDENT'
  end;
  v_dept := nullif(new.raw_user_meta_data->>'department_code', '');
  v_year := nullif(new.raw_user_meta_data->>'year_number', '')::integer;
  if v_year is not null and v_year not in (1, 2, 3) then
    v_year := null;
  end if;
  v_name := coalesce(
    nullif(new.raw_user_meta_data->>'full_name', ''),
    initcap(replace(split_part(v_email, '@', 1), '.', ' '))
  );

  insert into public.users (email, full_name, role, department_code, year_number, is_active, auth_user_id)
  values (v_email, v_name, v_role, v_dept, v_year, true, new.id);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- Function grants ------------------------------------------------------------
grant execute on function public.nosih_timestamp_text(timestamptz) to anon, authenticated;
grant execute on function public.current_app_user_id() to anon, authenticated;
grant execute on function public.current_app_role() to anon, authenticated;
grant execute on function public.is_admin() to anon, authenticated;
