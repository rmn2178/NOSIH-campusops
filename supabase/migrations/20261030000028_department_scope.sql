-- Department-scoped operational reads.
-- Facilities, incident, procurement and system roles keep campus-wide visibility.
-- Department managers and technicians see only spaces their department teaches in;
-- purchase requests are scoped by their department column.

create table if not exists public.department_spaces (
  department_code text not null,
  space_code text not null,
  primary key (department_code, space_code)
);

insert into public.department_spaces (department_code, space_code)
select distinct d.code, ts.effective_space_code
  from public.timetable_slots ts
  join public.student_classes sc on sc.class_code = ts.class_code
  join public.departments d on d.id = sc.department_id
 where ts.effective_space_code is not null
on conflict do nothing;

insert into public.department_spaces (department_code, space_code)
select distinct d.code, sc.home_room_code
  from public.student_classes sc
  join public.departments d on d.id = sc.department_id
 where sc.home_room_code is not null
on conflict do nothing;

create index if not exists department_spaces_space_idx
  on public.department_spaces (space_code);

alter table public.department_spaces enable row level security;
drop policy if exists department_spaces_admin_read on public.department_spaces;
create policy department_spaces_admin_read on public.department_spaces
  for select to authenticated using (public.is_admin());

create or replace function public.nosih_actor_department()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select department_code from public.users
   where auth_user_id = auth.uid() and is_active
   limit 1
$$;

-- Department managers need the campus graph (twin, timetable, inventory,
-- incidents) to do their job. They are readers, not administrators: audit and
-- user tables stay with privileged admins.
create or replace function public.nosih_is_campus_reader()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role in ('MAINTENANCE', 'INCIDENT_MANAGER', 'FACILITIES_ADMIN',
                     'PROCUREMENT_APPROVER', 'SYSTEM_ADMIN', 'DEPARTMENT_MANAGER')
       from public.users where auth_user_id = auth.uid() and is_active limit 1),
    false
  )
$$;

create or replace function public.nosih_is_privileged_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role in ('MAINTENANCE', 'INCIDENT_MANAGER', 'FACILITIES_ADMIN',
                     'PROCUREMENT_APPROVER', 'SYSTEM_ADMIN')
       from public.users where auth_user_id = auth.uid() and is_active limit 1),
    false
  )
$$;

do $$
declare
  t text;
  tables text[] := array[
    'buildings', 'floors', 'distribution_boards', 'rooms', 'labs', 'canteens',
    'bill_bots', 'assets', 'departments', 'student_classes', 'staff_profiles',
    'timetable_slots', 'complaint_votes', 'incidents', 'inventory_items',
    'part_reservations', 'maintenance_history', 'notification_logs'
  ];
begin
  foreach t in array tables loop
    execute format('drop policy if exists %I on public.%I', t || '_admin_read', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.nosih_is_campus_reader())',
      t || '_admin_read', t
    );
  end loop;
end $$;

-- The audit ledger and the user directory stay off-limits to department
-- managers even though is_admin() admits them for command-portal actions.
drop policy if exists audit_logs_admin_read on public.audit_logs;
create policy audit_logs_admin_read on public.audit_logs
  for select to authenticated using (public.nosih_is_privileged_admin());

drop policy if exists users_self_read on public.users;
create policy users_self_read on public.users
  for select to authenticated
  using (auth_user_id = auth.uid() or public.nosih_is_privileged_admin());

create or replace function public.nosih_can_read_operational_space(p_space_code text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select case
      when u.role in ('FACILITIES_ADMIN', 'INCIDENT_MANAGER', 'SYSTEM_ADMIN', 'PROCUREMENT_APPROVER') then true
      when u.role in ('DEPARTMENT_MANAGER', 'MAINTENANCE') then exists (
        select 1 from public.department_spaces ds
         where ds.department_code = u.department_code
           and ds.space_code = p_space_code)
      else false
    end
    from public.users u
   where u.auth_user_id = auth.uid() and u.is_active
   limit 1
  ), false)
$$;

drop policy if exists work_orders_admin_read on public.work_orders;
create policy work_orders_admin_read on public.work_orders
  for select to authenticated
  using (public.nosih_can_read_operational_space(space_code));

drop policy if exists sla_clocks_admin_read on public.sla_clocks;
create policy sla_clocks_admin_read on public.sla_clocks
  for select to authenticated
  using (public.nosih_can_read_operational_space(space_code));

drop policy if exists purchase_requests_admin_read on public.purchase_requests;
create policy purchase_requests_admin_read on public.purchase_requests
  for select to authenticated
  using (
    exists (
      select 1 from public.users u
       where u.auth_user_id = auth.uid() and u.is_active
         and u.role in ('FACILITIES_ADMIN', 'INCIDENT_MANAGER', 'SYSTEM_ADMIN', 'PROCUREMENT_APPROVER'))
    or exists (
      select 1 from public.users u
       where u.auth_user_id = auth.uid() and u.is_active
         and u.role in ('DEPARTMENT_MANAGER', 'MAINTENANCE')
         and u.department_code = purchase_requests.department_code)
  );

-- Repair sign-offs inherit the work-order space scope for department managers.
drop policy if exists repair_approvals_read on public.repair_approvals;
create policy repair_approvals_read on public.repair_approvals
  for select to authenticated
  using (
    public.nosih_is_privileged_admin()
    or exists (
      select 1 from public.work_orders w
       where w.id = repair_approvals.work_order_id
         and public.nosih_can_read_operational_space(w.space_code))
  );

grant execute on function public.nosih_actor_department() to anon, authenticated;
grant execute on function public.nosih_can_read_operational_space(text) to anon, authenticated;
grant execute on function public.nosih_is_campus_reader() to anon, authenticated;
grant execute on function public.nosih_is_privileged_admin() to anon, authenticated;
