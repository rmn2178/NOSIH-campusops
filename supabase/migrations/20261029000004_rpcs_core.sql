-- Core transactional RPCs: twin inspector, resource locks, room relocation,
-- affected-count voting. Adapted to the existing integer-key schema.

create or replace function public.nosih_period_label(p_period integer)
returns text
language sql
immutable
as $$
  select case p_period
    when 1 then '09:00-09:50'
    when 2 then '09:50-10:40'
    when 3 then '10:55-11:45'
    when 4 then '11:45-12:35'
    when 5 then '13:20-14:10'
    when 6 then '14:10-15:00'
    else null
  end
$$;

create or replace function public.nosih_block_rank(p_block text)
returns integer
language sql
immutable
as $$
  select case p_block
    when 'A' then 0
    when 'B' then 1
    when 'C' then 2
    when 'LAB_WING' then 3
    else 2
  end
$$;

create or replace function public.nosih_lock_json(p_lock public.resource_locks)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'id', p_lock.id,
    'resource_type', p_lock.resource_type,
    'resource_id', p_lock.resource_id,
    'locked_by_user_id', p_lock.holder_user_id,
    'locked_by_name', p_lock.holder_name,
    'locked_by_role', p_lock.holder_role,
    'acquired_seconds_ago', greatest(0, extract(epoch from (now() - p_lock.acquired_at))::int),
    'expires_in_seconds', greatest(0, extract(epoch from (p_lock.expires_at - now()))::int),
    'expires_at', p_lock.expires_at
  )
$$;

-- One timetable card for a space and period, including the home-class-away case.
create or replace function public.nosih_period_card(
  p_code text,
  p_day text,
  p_period integer,
  p_capacity integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_slot record;
  v_home record;
  v_faculty text;
begin
  select ts.class_code, ts.session_type, ts.subject_title, ts.faculty_staff_code,
         ts.is_relocated, ts.relocated_from_code,
         sc.student_strength, sc.year_number, sc.section_letter, d.code as department
    into v_slot
    from public.timetable_slots ts
    join public.student_classes sc on sc.class_code = ts.class_code
    join public.departments d on d.id = sc.department_id
   where ts.day_of_week = p_day
     and ts.period_number = p_period
     and ts.effective_space_code = p_code
   limit 1;

  if found then
    select u.full_name into v_faculty
      from public.staff_profiles sp
      join public.users u on u.id = sp.user_id
     where sp.staff_code = v_slot.faculty_staff_code
     limit 1;

    return jsonb_build_object(
      'period_number', p_period,
      'time_label', public.nosih_period_label(p_period),
      'class_code', v_slot.class_code,
      'department', v_slot.department,
      'year', v_slot.year_number,
      'section', v_slot.section_letter,
      'student_strength', v_slot.student_strength,
      'room_capacity', p_capacity,
      'subject_title', v_slot.subject_title,
      'session_type', v_slot.session_type,
      'faculty_name', v_faculty,
      'location_status', case when v_slot.is_relocated then 'RELOCATED' else 'IN_ROOM' end,
      'is_relocated', coalesce(v_slot.is_relocated, false),
      'relocated_from_code', v_slot.relocated_from_code,
      'relocated_to_code', null,
      'away_in_lab_code', null
    );
  end if;

  select sc.class_code, sc.student_strength, sc.year_number, sc.section_letter,
         d.code as department, ts.effective_space_code, ts.subject_title, ts.faculty_staff_code
    into v_home
    from public.student_classes sc
    join public.departments d on d.id = sc.department_id
    left join public.timetable_slots ts
      on ts.class_code = sc.class_code
     and ts.day_of_week = p_day
     and ts.period_number = p_period
   where sc.home_room_code = p_code
   limit 1;

  if found and v_home.effective_space_code is not null
     and v_home.effective_space_code <> p_code then
    select u.full_name into v_faculty
      from public.staff_profiles sp
      join public.users u on u.id = sp.user_id
     where sp.staff_code = v_home.faculty_staff_code
     limit 1;

    return jsonb_build_object(
      'period_number', p_period,
      'time_label', public.nosih_period_label(p_period),
      'class_code', v_home.class_code,
      'department', v_home.department,
      'year', v_home.year_number,
      'section', v_home.section_letter,
      'student_strength', v_home.student_strength,
      'room_capacity', p_capacity,
      'subject_title', v_home.subject_title,
      'session_type', 'LAB',
      'faculty_name', v_faculty,
      'location_status', 'AWAY_IN_LAB',
      'is_relocated', false,
      'relocated_from_code', null,
      'relocated_to_code', null,
      'away_in_lab_code', v_home.effective_space_code
    );
  end if;

  return jsonb_build_object(
    'period_number', p_period,
    'time_label', public.nosih_period_label(p_period),
    'class_code', null,
    'location_status', 'VACANT'
  );
end;
$$;

create or replace function public.rpc_get_space_twin_inspector(p_space_input text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_input text := lower(trim(coalesce(p_space_input, '')));
  v_code text;
  v_alias text;
  v_kind text;
  v_name text;
  v_visual text;
  v_capacity integer;
  v_block text;
  v_floor integer;
  v_board text;
  v_home_class text;
  v_home_strength integer;
  v_day text;
  v_period integer;
  v_duration integer;
  v_elapsed integer;
  v_lock jsonb;
  v_timeline jsonb;
  v_cards jsonb;
  v_assets jsonb;
  v_complaints jsonb;
  v_incident jsonb;
  v_work_order jsonb;
  v_sla jsonb;
  v_maintenance jsonb;
begin
  select active_day, active_period, period_duration_mins, period_elapsed_mins
    into v_day, v_period, v_duration, v_elapsed
    from public.campus_clock_state where id = 1;

  select r.code, r.zero_index_alias, 'CLASSROOM', r.code, r.visual_state, r.capacity,
         b.code, f.floor_number, db.code
    into v_code, v_alias, v_kind, v_name, v_visual, v_capacity, v_block, v_floor, v_board
    from public.rooms r
    join public.buildings b on b.id = r.building_id
    join public.floors f on f.id = r.floor_id
    join public.distribution_boards db on db.id = r.distribution_board_id
   where lower(r.code) = v_input or lower(r.zero_index_alias) = v_input
   limit 1;

  if v_code is null then
    select l.code, l.code, 'LAB', l.name, l.visual_state, l.capacity,
           b.code, db.floor_number, db.code
      into v_code, v_alias, v_kind, v_name, v_visual, v_capacity, v_block, v_floor, v_board
      from public.labs l
      join public.distribution_boards db on db.id = l.distribution_board_id
      join public.buildings b on b.id = db.building_id
     where lower(l.code) = v_input
     limit 1;
  end if;

  if v_code is null then
    select c.code, c.code, 'CANTEEN', c.name, c.visual_state, c.seating_capacity,
           null, null, null
      into v_code, v_alias, v_kind, v_name, v_visual, v_capacity, v_block, v_floor, v_board
      from public.canteens c
     where lower(c.code) = v_input
     limit 1;
  end if;

  if v_code is null then
    select b.code, b.code, 'BILL_BOT', b.name, b.visual_state, null,
           null, null, null
      into v_code, v_alias, v_kind, v_name, v_visual, v_capacity, v_block, v_floor, v_board
      from public.bill_bots b
     where lower(b.code) = v_input
     limit 1;
  end if;

  if v_code is null then
    return jsonb_build_object('error', 'SPACE_NOT_FOUND', 'input', p_space_input);
  end if;

  select sc.class_code, sc.student_strength
    into v_home_class, v_home_strength
    from public.student_classes sc
   where sc.home_room_code = v_code
   limit 1;

  select public.nosih_lock_json(l)
    into v_lock
    from public.resource_locks l
   where l.resource_id = v_code
     and l.resource_type = case v_kind
       when 'CLASSROOM' then 'ROOM'
       when 'LAB' then 'LAB'
       when 'CANTEEN' then 'CANTEEN'
       else 'BILL_BOT' end
     and l.expires_at > now()
   limit 1;

  select jsonb_agg(public.nosih_period_card(v_code, v_day, p, v_capacity) order by p)
    into v_timeline
    from generate_series(1, 6) as p;

  v_cards := jsonb_build_object(
    'previous_period', case when v_period between 2 and 6
      then public.nosih_period_card(v_code, v_day, v_period - 1, v_capacity) else null end,
    'current_period', case when v_period between 1 and 6 then
      public.nosih_period_card(v_code, v_day, v_period, v_capacity)
        || jsonb_build_object('minutes_remaining', greatest(0, coalesce(v_duration, 50) - coalesce(v_elapsed, 0)))
      else null end,
    'next_period', case when v_period between 1 and 5
      then public.nosih_period_card(v_code, v_day, v_period + 1, v_capacity) else null end
  );

  select coalesce(jsonb_agg(jsonb_build_object(
      'asset_code', a.asset_code,
      'name', a.name,
      'asset_type', a.asset_type,
      'slot_index', a.slot_index,
      'status', a.status,
      'sku_code', a.sku_code
    ) order by a.slot_index, a.asset_type), '[]'::jsonb)
    into v_assets
    from public.assets a
   where a.parent_space_code = v_code;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id,
      'ticket_number', c.ticket_number,
      'space_code', c.space_code,
      'space_type', c.space_type,
      'title', c.title,
      'description', c.description,
      'category', c.category,
      'urgency', c.urgency,
      'status', c.status,
      'reporter_label', c.public_reporter_label,
      'is_anonymous', c.is_anonymous,
      'photo_url', c.image_url,
      'affected_count', c.affected_upvote_count,
      'viewer_has_voted', false,
      'comment_count', (select count(*) from public.complaint_comments cc
                         where cc.complaint_id = c.id and cc.moderation_status = 'APPROVED'),
      'sla_target_minutes', coalesce((select s.resolution_target_mins from public.sla_clocks s
                                       where s.target_type = 'COMPLAINT' and s.target_id = c.id), 240),
      'created_at', c.created_at,
      'updated_at', c.updated_at,
      'target_assets', case when c.ai_extracted_json ~ '^\s*\{'
                            then coalesce((c.ai_extracted_json::jsonb)->'target_assets', '[]'::jsonb)
                            else '[]'::jsonb end
    ) order by c.created_at desc), '[]'::jsonb)
    into v_complaints
    from public.complaints c
   where c.space_code = v_code
     and c.moderation_status = 'APPROVED'
     and c.status not in ('RESOLVED', 'CLOSED', 'MERGED_DUPLICATE', 'HELD_MODERATION');

  select jsonb_build_object(
      'id', i.id, 'incident_number', i.incident_number, 'title', i.title,
      'correlation_type', i.correlation_type, 'root_cause', i.root_cause_key,
      'severity', i.severity, 'status', i.status, 'ai_summary_text', i.ai_summary_text,
      'affected_space_codes', string_to_array(i.affected_rooms_csv, ','),
      'affected_class_count', cardinality(string_to_array(nullif(i.affected_classes_csv, ''), ',')),
      'affected_student_count', i.total_students_impacted,
      'chronic_replacement_advised', i.chronic_replacement_advised,
      'created_at', i.created_at
    )
    into v_incident
    from public.incidents i
   where i.status not in ('RESOLVED', 'CLOSED')
     and (
       i.id in (select c.linked_incident_id from public.complaints c
                 where c.space_code = v_code and c.linked_incident_id is not null)
       or (',' || i.affected_rooms_csv || ',') like ('%,' || v_code || ',%')
     )
   order by i.created_at desc
   limit 1;

  select jsonb_build_object(
      'id', w.id, 'work_order_number', w.wo_number, 'complaint_id', w.complaint_id,
      'space_code', w.space_code, 'status', w.status, 'priority', w.status,
      'priority_score', w.priority_score, 'required_skill', w.required_skill,
      'required_risk_clearance', w.required_risk_clearance,
      'assigned_staff_code', w.assigned_staff_code,
      'assigned_staff_name', (select u.full_name from public.staff_profiles sp
                               join public.users u on u.id = sp.user_id
                              where sp.staff_code = w.assigned_staff_code limit 1),
      'reassignment_count', w.reassignment_count,
      'last_reassignment_reason', w.last_reassignment_reason,
      'required_parts', case when w.target_asset_codes_json ~ '^\s*\['
                             then w.target_asset_codes_json::jsonb else '[]'::jsonb end,
      'created_at', w.created_at
    )
    into v_work_order
    from public.work_orders w
   where w.space_code = v_code
     and w.status not in ('RESOLVED', 'CLOSED', 'COMPLETED')
   order by w.created_at desc
   limit 1;

  select jsonb_build_object(
      'id', s.id, 'target_type', s.target_type, 'target_id', s.target_id,
      'space_code', s.space_code, 'urgency', s.urgency,
      'response_target_mins', s.response_target_mins,
      'resolution_target_mins', s.resolution_target_mins,
      'elapsed_active_mins', round(s.elapsed_active_mins::numeric, 2),
      'is_paused', s.is_paused, 'pause_reason', s.pause_reason,
      'breach_state', s.breach_state,
      'current_escalation_tier', s.current_escalation_tier,
      'last_tick_at', s.last_tick_at
    )
    into v_sla
    from public.sla_clocks s
   where s.space_code = v_code
   order by s.id desc
   limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', m.id, 'asset_code', m.asset_code,
      'asset_type', (select a.asset_type from public.assets a where a.asset_code = m.asset_code limit 1),
      'action', m.action_taken, 'notes', m.action_taken,
      'technician_code', m.technician_code,
      'technician_name', (select u.full_name from public.staff_profiles sp
                           join public.users u on u.id = sp.user_id
                          where sp.staff_code = m.technician_code limit 1),
      'downtime_mins', m.downtime_mins, 'completed_at', m.completed_at
    ) order by m.completed_at desc), '[]'::jsonb)
    into v_maintenance
    from public.maintenance_history m
   where m.space_code = v_code;

  return jsonb_build_object(
    'code', v_code,
    'alias_code', v_alias,
    'kind', v_kind,
    'visual_state', v_visual,
    'space', jsonb_build_object(
      'code', v_code, 'alias_code', v_alias, 'kind', v_kind, 'name', v_name,
      'block', v_block, 'floor', v_floor, 'distribution_board_code', v_board,
      'visual_state', v_visual, 'capacity', v_capacity,
      'home_class_code', v_home_class, 'home_student_count', v_home_strength,
      'active_lock', v_lock
    ),
    'period_cards', v_cards,
    'full_day_timeline', coalesce(v_timeline, '[]'::jsonb),
    'assets', v_assets,
    'active_complaints', v_complaints,
    'correlated_incident', v_incident,
    'active_work_order', v_work_order,
    'sla_clock', v_sla,
    'maintenance_history', v_maintenance
  );
end;
$$;

-- 2. Resource locks -----------------------------------------------------------
create or replace function public.rpc_claim_resource_lock(
  p_resource_type text,
  p_resource_id text,
  p_actor_email text,
  p_actor_name text,
  p_actor_role text,
  p_ttl_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.nosih_actor_role(p_actor_email);
  v_existing public.resource_locks%rowtype;
  v_lock public.resource_locks%rowtype;
  v_user_id integer := public.nosih_actor_id(p_actor_email);
  v_ttl integer := least(3600, greatest(30, coalesce(p_ttl_seconds, 300)));
begin
  if v_role is null or v_role not in ('MAINTENANCE', 'INCIDENT_MANAGER', 'FACILITIES_ADMIN', 'PROCUREMENT_APPROVER', 'SYSTEM_ADMIN') then
    perform public.nosih_append_audit(p_actor_email, coalesce(v_role, p_actor_role), 'CLAIM_RESOURCE_LOCK', p_resource_type, p_resource_id,
      'REJECTED', 'RBAC_ROLE_NOT_PERMITTED', 'Role cannot claim resource locks');
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN');
  end if;

  delete from public.resource_locks where expires_at < now();

  select * into v_existing
    from public.resource_locks
   where resource_type = p_resource_type and resource_id = p_resource_id
   for update;

  if found and lower(coalesce(v_existing.holder_email, '')) <> lower(coalesce(p_actor_email, '')) then
    perform public.nosih_append_audit(p_actor_email, v_role, 'CLAIM_RESOURCE_LOCK', p_resource_type, p_resource_id,
      'REJECTED', 'LOCK_CONTENTION_ACTIVE_HOLDER',
      'Resource is currently locked by ' || v_existing.holder_name || ' (' || v_existing.holder_role || ')');
    return jsonb_build_object(
      'success', false, 'error', 'LOCK_HELD',
      'holder_name', v_existing.holder_name,
      'holder_role', v_existing.holder_role,
      'acquired_seconds_ago', greatest(0, extract(epoch from (now() - v_existing.acquired_at))::int),
      'expires_in_seconds', greatest(0, extract(epoch from (v_existing.expires_at - now()))::int)
    );
  end if;

  insert into public.resource_locks (
    resource_type, resource_id, holder_user_id, holder_email, holder_name, holder_role,
    acquired_at, expires_at, heartbeat_at
  ) values (
    p_resource_type, p_resource_id, coalesce(v_user_id, 0), p_actor_email,
    coalesce(p_actor_name, p_actor_email), v_role, now(), now() + make_interval(secs => v_ttl), now()
  )
  on conflict (resource_type, resource_id) do update
    set holder_user_id = excluded.holder_user_id,
        holder_email = excluded.holder_email,
        holder_name = excluded.holder_name,
        holder_role = excluded.holder_role,
        expires_at = excluded.expires_at,
        heartbeat_at = now()
  returning * into v_lock;

  perform public.nosih_append_audit(p_actor_email, v_role, 'CLAIM_RESOURCE_LOCK', p_resource_type, p_resource_id,
    'ALLOWED', 'LOCK_ACQUIRED', 'Lock acquired for ' || v_ttl || ' seconds');

  return jsonb_build_object('success', true, 'lock', public.nosih_lock_json(v_lock));
end;
$$;

-- 3. Room relocation candidates ----------------------------------------------
create or replace function public.rpc_get_room_relocation_candidates(
  p_faulted_room_code text,
  p_day text,
  p_period integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_fault record;
  v_session record;
  v_strength integer;
  v_available jsonb;
  v_unavailable jsonb;
begin
  select r.code, r.room_number_on_floor, b.code as building, f.floor_number
    into v_fault
    from public.rooms r
    join public.buildings b on b.id = r.building_id
    join public.floors f on f.id = r.floor_id
   where lower(r.code) = lower(p_faulted_room_code)
   limit 1;

  if not found then
    return jsonb_build_object('error', 'ROOM_NOT_FOUND', 'room_code', p_faulted_room_code);
  end if;

  select ts.class_code, sc.student_strength
    into v_session
    from public.timetable_slots ts
    join public.student_classes sc on sc.class_code = ts.class_code
   where ts.day_of_week = p_day
     and ts.period_number = p_period
     and ts.effective_space_code = v_fault.code
   limit 1;

  v_strength := coalesce(v_session.student_strength, 60);

  with candidates as (
    select r.code,
           b.code as building,
           f.floor_number,
           r.room_number_on_floor,
           r.capacity,
           r.visual_state,
           sc.class_code as home_class,
           hts.effective_space_code as home_effective,
           exists (
             select 1 from public.timetable_slots x
              where x.day_of_week = p_day and x.period_number = p_period
                and x.effective_space_code = r.code
           ) as occupied,
           exists (
             select 1 from public.assets a
              where a.parent_space_code = r.code and a.asset_type = 'SMART_BOARD' and a.status = 'OK'
           ) as smartboard_ok,
           exists (
             select 1 from public.resource_locks l
              where l.resource_type = 'ROOM' and l.resource_id = r.code
                and l.expires_at > now()
           ) as locked
      from public.rooms r
      join public.buildings b on b.id = r.building_id
      join public.floors f on f.id = r.floor_id
      left join public.student_classes sc on sc.home_room_code = r.code
      left join public.timetable_slots hts
        on hts.class_code = sc.class_code and hts.day_of_week = p_day and hts.period_number = p_period
  ), scored as (
    select c.*,
           round((
             100
             - case when c.building <> v_fault.building then 20 else 0 end
             - 6 * abs(c.floor_number - v_fault.floor_number)
             - 0.5 * abs(c.room_number_on_floor - v_fault.room_number_on_floor)
           )::numeric, 1) as score,
           case
             when c.occupied then 'OCCUPIED_BY_CLASS'
             when c.visual_state <> 'HEALTHY' then 'ROOM_FAULTY'
             when not c.smartboard_ok then 'SMART_BOARD_FAULTY'
             when c.locked then 'LOCKED_BY_OTHER_ADMIN'
             when c.capacity < v_strength then 'CAPACITY_TOO_SMALL'
             else null
           end as exclusion,
           case
             when c.home_effective is not null and c.home_effective <> c.code
               then 'vacant during P' || p_period || ' because home class ' || c.home_class || ' is in ' || c.home_effective
             else 'vacant during P' || p_period
           end as why_reason
      from candidates c
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'room_code', s.code, 'building', s.building, 'floor', s.floor_number,
      'room_index', s.room_number_on_floor, 'capacity', s.capacity,
      'home_class_code', s.home_class, 'home_class_away_in', s.home_effective,
      'score', s.score, 'why_reason', s.why_reason
    ) order by s.score desc, s.code) filter (where s.exclusion is null), '[]'::jsonb),
    coalesce(jsonb_agg(jsonb_build_object(
      'room_code', s.code, 'building', s.building, 'floor', s.floor_number,
      'reason', s.exclusion
    )) filter (where s.exclusion is not null), '[]'::jsonb)
  into v_available, v_unavailable
  from scored s;

  return jsonb_build_object(
    'faulted_room', jsonb_build_object(
      'room_code', v_fault.code, 'building', v_fault.building,
      'floor', v_fault.floor_number, 'room_index', v_fault.room_number_on_floor
    ),
    'session', jsonb_build_object(
      'class_code', v_session.class_code, 'student_strength', v_strength,
      'day_of_week', p_day, 'period_number', p_period
    ),
    'available_candidates', v_available,
    'unavailable_rooms', v_unavailable
  );
end;
$$;

-- 4. Execute relocation -------------------------------------------------------
create or replace function public.rpc_execute_room_relocation(
  p_faulted_room_code text,
  p_target_room_code text,
  p_day text,
  p_period integer,
  p_actor_email text,
  p_actor_role text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.nosih_actor_role(p_actor_email);
  v_target record;
  v_slot record;
  v_lock public.resource_locks%rowtype;
  v_advisor_email text;
begin
  if v_role is null or v_role not in ('FACILITIES_ADMIN', 'INCIDENT_MANAGER', 'SYSTEM_ADMIN') then
    perform public.nosih_append_audit(p_actor_email, coalesce(v_role, p_actor_role), 'ROOM_RELOCATE', 'ROOM', p_target_room_code,
      'REJECTED', 'RBAC_ROLE_NOT_PERMITTED', 'Role cannot relocate rooms');
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN');
  end if;

  select r.code, r.visual_state, r.capacity
    into v_target
    from public.rooms r
   where lower(r.code) = lower(p_target_room_code)
   limit 1;
  if not found or v_target.visual_state <> 'HEALTHY' then
    return jsonb_build_object('success', false, 'error', 'TARGET_NOT_HEALTHY');
  end if;

  if exists (
    select 1 from public.timetable_slots
     where day_of_week = p_day and period_number = p_period
       and effective_space_code = v_target.code
  ) then
    return jsonb_build_object('success', false, 'error', 'TARGET_OCCUPIED');
  end if;

  select * into v_lock
    from public.resource_locks
   where resource_type = 'ROOM' and resource_id = v_target.code
     and expires_at > now()
   limit 1;
  if not found or lower(coalesce(v_lock.holder_email, '')) <> lower(coalesce(p_actor_email, '')) then
    perform public.nosih_append_audit(p_actor_email, v_role, 'ROOM_RELOCATE', 'ROOM', v_target.code,
      'REJECTED', 'TARGET_LOCK_REQUIRED', 'Caller does not hold the target room lock');
    return jsonb_build_object('success', false, 'error', 'LOCK_REQUIRED');
  end if;

  select ts.id, ts.class_code
    into v_slot
    from public.timetable_slots ts
   where ts.day_of_week = p_day
     and ts.period_number = p_period
     and ts.effective_space_code = p_faulted_room_code
   limit 1;

  if not found then
    return jsonb_build_object('success', false, 'error', 'NO_SESSION_TO_RELOCATE');
  end if;

  update public.timetable_slots
     set effective_space_code = v_target.code,
         is_relocated = true,
         relocated_from_code = p_faulted_room_code,
         relocation_reason = 'Fault in ' || p_faulted_room_code
   where id = v_slot.id;

  select u.email into v_advisor_email
    from public.student_classes sc
    join public.staff_profiles sp on sp.staff_code = (
      select sp2.staff_code from public.staff_profiles sp2 where sp2.assigned_class_code = sc.class_code limit 1
    )
    join public.users u on u.id = sp.user_id
   where sc.class_code = v_slot.class_code
   limit 1;

  insert into public.notification_logs (channel, recipient, subject, payload_json, delivery_status, created_at)
  values (
    'EMAIL', coalesce(v_advisor_email, 'advisor@nosih.edu.in'),
    'Relocation: ' || v_slot.class_code || ' P' || p_period || ' moved to ' || v_target.code,
    jsonb_build_object(
      'event', 'ROOM_RELOCATED', 'class_code', v_slot.class_code,
      'from', p_faulted_room_code, 'to', v_target.code,
      'day_of_week', p_day, 'period_number', p_period
    )::text,
    'SENT', now()
  );

  perform public.nosih_append_audit(p_actor_email, v_role, 'ROOM_RELOCATE', 'ROOM', v_target.code,
    'ALLOWED', 'RELOCATION_EXECUTED',
    'Moved ' || v_slot.class_code || ' from ' || p_faulted_room_code || ' to ' || v_target.code || ' at P' || p_period);

  return jsonb_build_object(
    'success', true,
    'relocation', jsonb_build_object(
      'class_code', v_slot.class_code, 'day_of_week', p_day, 'period_number', p_period,
      'from_room', p_faulted_room_code, 'to_room', v_target.code
    )
  );
end;
$$;

-- Affected-count voting -------------------------------------------------------
create or replace function public.rpc_confirm_affected(
  p_complaint_id integer,
  p_voter_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted integer;
  v_count integer;
  v_hash text := coalesce(md5(auth.uid()::text), p_voter_hash);
begin
  insert into public.complaint_votes (complaint_id, voter_rate_limit_hash, created_at)
  values (p_complaint_id, v_hash, now())
  on conflict (complaint_id, voter_rate_limit_hash) do nothing;

  get diagnostics v_inserted = row_count;

  if v_inserted > 0 then
    update public.complaints
       set affected_upvote_count = affected_upvote_count + 1
     where id = p_complaint_id
     returning affected_upvote_count into v_count;
  else
    select affected_upvote_count into v_count from public.complaints where id = p_complaint_id;
  end if;

  return jsonb_build_object('success', true, 'inserted', v_inserted > 0, 'affected_count', coalesce(v_count, 0));
end;
$$;

grant execute on function public.nosih_period_label(integer) to anon, authenticated;
grant execute on function public.nosih_block_rank(text) to anon, authenticated;
grant execute on function public.nosih_period_card(text, text, integer, integer) to anon, authenticated;
grant execute on function public.rpc_get_space_twin_inspector(text) to anon, authenticated;
grant execute on function public.rpc_claim_resource_lock(text, text, text, text, text, integer) to authenticated;
grant execute on function public.rpc_get_room_relocation_candidates(text, text, integer) to authenticated;
grant execute on function public.rpc_execute_room_relocation(text, text, text, integer, text, text) to authenticated;
grant execute on function public.rpc_confirm_affected(integer, text) to anon, authenticated;
