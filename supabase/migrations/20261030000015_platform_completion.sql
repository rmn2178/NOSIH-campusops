-- Bookings, chat intake, analytics, completion guard, Department Manager.

-- 1. Room bookings with a storage-level double-booking constraint -----------
create extension if not exists btree_gist;

create table if not exists public.room_bookings (
  id serial primary key,
  space_code text not null,
  class_code text,
  purpose text not null default 'Booked room',
  booked_by_user_id integer references public.users(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'ACTIVE',
  created_at timestamptz not null default now(),
  constraint room_bookings_window_check check (ends_at > starts_at)
);

alter table public.room_bookings enable row level security;
drop policy if exists room_bookings_read on public.room_bookings;
create policy room_bookings_read on public.room_bookings
  for select to authenticated using (true);

alter table public.room_bookings drop constraint if exists room_bookings_no_overlap;
alter table public.room_bookings add constraint room_bookings_no_overlap
  exclude using gist (space_code with =, tstzrange(starts_at, ends_at) with &&)
  where (status = 'ACTIVE');

create or replace function public.rpc_create_booking(
  p_space_code text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_purpose text,
  p_class_code text default null,
  p_actor_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.nosih_actor_role(p_actor_email);
  v_room record;
  v_id integer;
  v_alt jsonb;
begin
  if v_role is null or v_role not in ('FACULTY', 'DEPARTMENT_MANAGER', 'INCIDENT_MANAGER', 'FACILITIES_ADMIN', 'SYSTEM_ADMIN') then
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN');
  end if;
  if p_ends_at <= p_starts_at then
    return jsonb_build_object('success', false, 'error', 'INVALID_WINDOW');
  end if;

  select code, visual_state, capacity into v_room
    from public.rooms where upper(code) = upper(p_space_code) limit 1;
  if not found then
    return jsonb_build_object('success', false, 'error', 'ROOM_NOT_FOUND');
  end if;

  if v_room.visual_state <> 'HEALTHY' then
    select coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb) into v_alt
      from (
        select r.code as room_code, r.capacity
          from public.rooms r
         where r.visual_state = 'HEALTHY'
         order by r.capacity desc, r.code
         limit 3
      ) a;
    return jsonb_build_object('success', false, 'error', 'ROOM_NOT_HEALTHY',
                              'visual_state', v_room.visual_state, 'alternatives', coalesce(v_alt, '[]'::jsonb));
  end if;

  begin
    insert into public.room_bookings (space_code, class_code, purpose, booked_by_user_id, starts_at, ends_at)
    values (v_room.code, p_class_code, coalesce(nullif(trim(p_purpose), ''), 'Booked room'),
            public.nosih_actor_id(p_actor_email), p_starts_at, p_ends_at)
    returning id into v_id;
  exception when exclusion_violation then
    select coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb) into v_alt
      from (
        select r.code as room_code, r.capacity
          from public.rooms r
         where r.visual_state = 'HEALTHY'
           and upper(r.code) <> upper(p_space_code)
           and not exists (
             select 1 from public.room_bookings b
              where b.space_code = r.code and b.status = 'ACTIVE'
                and tstzrange(b.starts_at, b.ends_at) && tstzrange(p_starts_at, p_ends_at))
         order by r.capacity desc, r.code
         limit 3
      ) a;
    perform public.nosih_append_audit(p_actor_email, v_role, 'CREATE_BOOKING', 'ROOM', v_room.code,
      'REJECTED', 'DOUBLE_BOOKED', 'Overlapping active booking', jsonb_build_object('alternatives', v_alt));
    return jsonb_build_object('success', false, 'error', 'DOUBLE_BOOKED', 'alternatives', coalesce(v_alt, '[]'::jsonb));
  end;

  perform public.nosih_append_audit(p_actor_email, v_role, 'CREATE_BOOKING', 'ROOM', v_room.code,
    'ALLOWED', 'BOOKING_CONFIRMED', coalesce(p_purpose, 'Booked room'));

  return jsonb_build_object('success', true, 'booking_id', v_id, 'space_code', v_room.code,
                            'starts_at', p_starts_at, 'ends_at', p_ends_at);
end;
$$;

create or replace function public.rpc_cancel_booking(p_booking_id integer, p_actor_email text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.nosih_actor_role(p_actor_email);
  v_row public.room_bookings%rowtype;
begin
  if v_role is null or v_role not in ('FACULTY', 'DEPARTMENT_MANAGER', 'INCIDENT_MANAGER', 'FACILITIES_ADMIN', 'SYSTEM_ADMIN') then
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN');
  end if;
  update public.room_bookings set status = 'CANCELLED' where id = p_booking_id returning * into v_row;
  if not found then
    return jsonb_build_object('success', false, 'error', 'BOOKING_NOT_FOUND');
  end if;
  return jsonb_build_object('success', true, 'booking_id', v_row.id, 'status', 'CANCELLED');
end;
$$;

create or replace function public.rpc_list_bookings(p_from timestamptz default now(), p_limit integer default 50)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(b) order by b.starts_at), '[]'::jsonb)
    from (
      select id, space_code, class_code, purpose, starts_at, ends_at, status
        from public.room_bookings
       where status = 'ACTIVE' and ends_at >= p_from
       order by starts_at
       limit least(200, greatest(1, p_limit))
    ) b
$$;

-- 2. Chat intake -------------------------------------------------------------
create or replace function public.rpc_chat_intake(
  p_messages jsonb,
  p_portal text default 'COMPLAINT',
  p_space_code text default null,
  p_confirm boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_text text;
  v_space text;
  v_ai jsonb;
  v_result jsonb;
  v_space_type text;
begin
  select m->>'content' into v_text
    from jsonb_array_elements(p_messages) with ordinality as t(m, ord)
   where m->>'role' = 'user'
   order by ord desc
   limit 1;

  if v_text is null or length(trim(v_text)) < 4 then
    return jsonb_build_object('success', false, 'error', 'NO_MESSAGE');
  end if;

  v_ai := public.nosih_grok_json(
    'Extract a campus facilities fault from a chat message. Return JSON only with space_code, summary, category, urgency, missing_info_questions (max 2). Never invent a room code that is not stated.',
    v_text, 20000);

  v_space := coalesce(nullif(p_space_code, ''), nullif(v_ai->>'space_code', ''));

  if not p_confirm then
    if v_space is not null then
      select case when exists (select 1 from public.rooms where code = v_space) then 'ROOM'
                  when exists (select 1 from public.labs where code = v_space) then 'LAB' end
        into v_space_type;
    end if;
    return jsonb_build_object(
      'success', true, 'mode', 'DRAFT',
      'space_code', v_space, 'space_type', v_space_type,
      'category', v_ai->>'category', 'urgency', v_ai->>'urgency',
      'summary', coalesce(v_ai->>'summary', v_text),
      'questions', coalesce(v_ai->'missing_info_questions', '[]'::jsonb));
  end if;

  v_result := public.rpc_submit_complaint(jsonb_build_object(
    'email', coalesce(public.nosih_actor_email(), 'chat@nosih.edu.in'),
    'is_anonymous', false,
    'space_code', v_space,
    'description', v_text,
    'source_channel', 'CHAT'));

  return v_result || jsonb_build_object('mode', 'CREATED');
end;
$$;

-- 3. Analytics ---------------------------------------------------------------
create or replace function public.rpc_analytics_overview(p_days integer default 30)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with window_complaints as (
    select * from public.complaints
     where created_at > now() - make_interval(days => greatest(1, coalesce(p_days, 30)))
  ), sla as (
    select count(*) as total,
           count(*) filter (where is_paused) as paused,
           count(*) filter (where breach_state = 'WARNING_75') as warnings,
           count(*) filter (where breach_state = 'BREACHED_100') as breached
      from public.sla_clocks
  ), tech as (
    select count(*) filter (where is_on_shift and not is_on_leave) as available,
           count(*) filter (where current_active_jobs > 0) as active
      from public.staff_profiles where staff_category = 'MAINTENANCE_TECH'
  )
  select jsonb_build_object(
    'window_days', greatest(1, coalesce(p_days, 30)),
    'open_requests', (select count(*) from public.complaints where status in ('OPEN','TRIAGED','IN_PROGRESS','BLOCKED_PARTS')),
    'by_status', (select coalesce(jsonb_object_agg(status, c), '{}'::jsonb)
                    from (select status, count(*) c from window_complaints group by 1) s),
    'by_category', (select coalesce(jsonb_object_agg(category, c), '{}'::jsonb)
                      from (select coalesce(category, 'UNKNOWN') category, count(*) c from window_complaints group by 1) s),
    'duplicates_merged', (select count(*) from window_complaints where status = 'MERGED_DUPLICATE'),
    'incidents_active', (select count(*) from public.incidents where status = 'ACTIVE'),
    'sla', jsonb_build_object(
      'active_clocks', (select total from sla),
      'warnings', (select warnings from sla),
      'breached', (select breached from sla),
      'paused_for_parts', (select paused from sla),
      'compliance_pct', (select round(100.0 * (total - breached) / greatest(1, total), 1) from sla)),
    'utilisation', jsonb_build_object(
      'spaces_healthy', (select count(*) from public.rooms where visual_state = 'HEALTHY'),
      'spaces_faulty', (select count(*) from public.rooms where visual_state in ('FAULTY','BLOCKED_PARTS')),
      'technicians_available', (select available from tech),
      'technicians_active', (select active from tech),
      'bookings_active', (select count(*) from public.room_bookings where status = 'ACTIVE' and ends_at > now())),
    'shortages', (select coalesce(jsonb_agg(jsonb_build_object(
                     'sku_code', sku_code, 'on_hand', on_hand_qty,
                     'reserved', reserved_qty, 'reorder_threshold', reorder_threshold)), '[]'::jsonb)
                    from public.inventory_items where on_hand_qty <= reorder_threshold),
    'recurring_faults', (select coalesce(jsonb_agg(jsonb_build_object(
                     'space_code', space_code, 'category', category, 'reports', c)), '[]'::jsonb)
                    from (select space_code, coalesce(category,'UNKNOWN') category, count(*) c
                            from window_complaints where moderation_status = 'APPROVED'
                           group by 1,2 having count(*) >= 3 order by c desc limit 10) r),
    'procurement', (select coalesce(jsonb_object_agg(status, c), '{}'::jsonb)
                      from (select status, count(*) c from public.purchase_requests group by 1) p)
  )
$$;

-- 4. Completion transition guard --------------------------------------------
do $$
declare
  v_def text := pg_get_functiondef('public.rpc_complete_work_order(integer, text, text)'::regprocedure);
  v_before text := $frag$  select * into v_wo from public.work_orders where id = p_work_order_id for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'WORK_ORDER_NOT_FOUND');
  end if;
$frag$;
  v_after text := $frag$  select * into v_wo from public.work_orders where id = p_work_order_id for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'WORK_ORDER_NOT_FOUND');
  end if;

  if v_wo.status not in ('ASSIGNED', 'IN_PROGRESS') then
    return jsonb_build_object('success', false, 'error', 'INVALID_TRANSITION', 'status', v_wo.status);
  end if;
$frag$;
begin
  if position(v_before in v_def) = 0 then
    raise exception 'completion guard anchor not found';
  end if;
  execute replace(v_def, v_before, v_after);
end;
$$;

-- 5. Department Manager role -------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select conname, pg_get_constraintdef(oid) as def
      from pg_constraint
     where conrelid = 'public.users'::regclass and contype = 'c'
  loop
    if r.def ilike '%FACILITIES_ADMIN%' and r.def ilike '%STUDENT%' then
      execute format('alter table public.users drop constraint %I', r.conname);
    end if;
  end loop;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.users'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%DEPARTMENT_MANAGER%'
  ) then
    alter table public.users add constraint users_role_check check (
      role in ('STUDENT','FACULTY','LAB_STAFF','MAINTENANCE','INCIDENT_MANAGER',
               'FACILITIES_ADMIN','PROCUREMENT_APPROVER','SYSTEM_ADMIN','DEPARTMENT_MANAGER'));
  end if;
end;
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role in ('MAINTENANCE', 'INCIDENT_MANAGER', 'FACILITIES_ADMIN',
                     'PROCUREMENT_APPROVER', 'SYSTEM_ADMIN', 'DEPARTMENT_MANAGER')
       from public.users where auth_user_id = auth.uid() limit 1),
    false
  )
$$;

do $$
declare
  v_def text := pg_get_functiondef('public.rpc_decide_purchase_request(integer, text, integer, text, text, boolean, text, text)'::regprocedure);
begin
  v_def := replace(v_def,
    'v_role not in (''FACILITIES_ADMIN'', ''PROCUREMENT_APPROVER'', ''SYSTEM_ADMIN'')',
    'v_role not in (''DEPARTMENT_MANAGER'', ''FACILITIES_ADMIN'', ''PROCUREMENT_APPROVER'', ''SYSTEM_ADMIN'')');
  v_def := replace(v_def,
    'when ''FACILITIES_ADMIN'' then 10000',
    'when ''DEPARTMENT_MANAGER'' then 10000 when ''FACILITIES_ADMIN'' then 10000');
  execute v_def;
end;
$$;

grant execute on function public.rpc_create_booking(text, timestamptz, timestamptz, text, text, text) to authenticated;
grant execute on function public.rpc_cancel_booking(integer, text) to authenticated;
grant execute on function public.rpc_list_bookings(timestamptz, integer) to authenticated;
grant execute on function public.rpc_chat_intake(jsonb, text, text, boolean) to authenticated;
grant execute on function public.rpc_analytics_overview(integer) to authenticated;
