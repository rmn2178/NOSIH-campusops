-- SLA integrity.
-- 1. Resolving a complaint or completing a work order closes its clock, so it
--    cannot keep accruing and breach after the repair is done.
-- 2. Reopening a complaint reopens the clock from "now", without double counts.
-- 3. The cron tick skips closed clocks and defensively closes clocks whose work
--    order is already finished.
-- 4. A class-strength change revalidates every timetable slot and future booking.

alter table public.sla_clocks add column if not exists closed_at timestamptz;
alter table public.sla_clocks add column if not exists closed_reason text;

do $$
declare
  v_def text;
  v_old text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.rpc_complete_work_order(integer, text, text)'::regprocedure);
  if position('nosih_clock_closed_on_completion' in v_def) = 0 then
    v_old := '  if v_wo.complaint_id is not null then' || E'\n'
             || '    update public.complaints set status = ''RESOLVED'', updated_at = now() where id = v_wo.complaint_id;' || E'\n'
             || '  end if;';
    v_new := v_old || E'\n\n'
             || '  update public.sla_clocks' || E'\n'
             || '     set is_paused = true, closed_at = coalesce(closed_at, now()),' || E'\n'
             || '         closed_reason = coalesce(closed_reason, ''WORK_ORDER_COMPLETED''),' || E'\n'
             || '         last_tick_at = now()' || E'\n'
             || '   where target_type = ''WORK_ORDER'' and target_id = v_wo.id; -- nosih_clock_closed_on_completion';
    if position(v_old in v_def) = 0 then
      raise exception 'completion clock anchor not found';
    end if;
    execute replace(v_def, v_old, v_new);
  end if;
end
$$;

do $$
declare
  v_def text;
  v_old text;
  v_new text;
  v_block text;
begin
  v_def := pg_get_functiondef('public.rpc_update_complaint_status(integer, text, text)'::regprocedure);
  if position('nosih_clock_follows_complaint' in v_def) = 0 then
    v_old := '  perform public.nosih_append_audit(p_actor_email, v_role, ''UPDATE_COMPLAINT'', ''COMPLAINT'', v_row.ticket_number,';
    v_block := '  if upper(p_status) in (''RESOLVED'', ''CLOSED'', ''MERGED_DUPLICATE'') then' || E'\n'
      || '    update public.sla_clocks' || E'\n'
      || '       set is_paused = true, closed_at = coalesce(closed_at, now()),' || E'\n'
      || '           closed_reason = coalesce(closed_reason, ''COMPLAINT_'' || upper(p_status)),' || E'\n'
      || '           last_tick_at = now()' || E'\n'
      || '     where target_type = ''WORK_ORDER'' and target_id in (' || E'\n'
      || '       select id from public.work_orders where complaint_id = v_row.id);' || E'\n'
      || '  elsif upper(p_status) in (''OPEN'', ''TRIAGED'', ''IN_PROGRESS'', ''BLOCKED_PARTS'') then' || E'\n'
      || '    update public.sla_clocks' || E'\n'
      || '       set is_paused = false, closed_at = null, closed_reason = null, last_tick_at = now()' || E'\n'
      || '     where target_type = ''WORK_ORDER'' and closed_at is not null and target_id in (' || E'\n'
      || '       select id from public.work_orders where complaint_id = v_row.id);' || E'\n'
      || '  end if; -- nosih_clock_follows_complaint' || E'\n\n';
    if position(v_old in v_def) = 0 then
      raise exception 'complaint status clock anchor not found';
    end if;
    execute replace(v_def, v_old, v_block || v_old);
  end if;
end
$$;

do $$
declare
  v_def text;
  v_old text;
  v_new text;
  v_guard text;
begin
  v_def := pg_get_functiondef('public.rpc_tick_sla_clocks()'::regprocedure);
  if position('nosih_tick_skips_closed' in v_def) = 0 then
    v_new := '  for v_sla in select * from public.sla_clocks where not is_paused and closed_at is null order by id for update loop';
    v_old := '  for v_sla in select * from public.sla_clocks where not is_paused order by id for update loop';
    if position(v_old in v_def) = 0 then
      raise exception 'tick loop anchor not found';
    end if;
    v_def := replace(v_def, v_old, v_new);

    v_old := '    v_delta := greatest(0, extract(epoch from (now() - v_sla.last_tick_at)) / 60.0);';
    v_guard := '    if v_sla.target_type = ''WORK_ORDER'' and exists (' || E'\n'
      || '      select 1 from public.work_orders w' || E'\n'
      || '       where w.id = v_sla.target_id and w.status in (''COMPLETED'', ''CANCELLED'', ''RESOLVED'', ''CLOSED'')) then' || E'\n'
      || '      update public.sla_clocks' || E'\n'
      || '         set is_paused = true, closed_at = coalesce(closed_at, now()),' || E'\n'
      || '             closed_reason = coalesce(closed_reason, ''TARGET_RESOLVED''), last_tick_at = now()' || E'\n'
      || '       where id = v_sla.id;' || E'\n'
      || '      continue;' || E'\n'
      || '    end if; -- nosih_tick_skips_closed' || E'\n\n';
    if position(v_old in v_def) = 0 then
      raise exception 'tick delta anchor not found';
    end if;
    execute replace(v_def, v_old, v_guard || v_old);
  end if;
end
$$;

create or replace function public.rpc_set_class_strength(
  p_class_code text,
  p_strength integer,
  p_actor_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.nosih_actor_role(p_actor_email);
  v_old integer;
  v_conflicts jsonb := '[]'::jsonb;
  v_booking_conflicts jsonb := '[]'::jsonb;
begin
  if v_role is null or v_role not in ('DEPARTMENT_MANAGER', 'FACILITIES_ADMIN', 'SYSTEM_ADMIN') then
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN');
  end if;
  if p_strength is null or p_strength < 1 or p_strength > 500 then
    return jsonb_build_object('success', false, 'error', 'INVALID_STRENGTH');
  end if;

  select student_strength into v_old
    from public.student_classes where class_code = p_class_code limit 1;
  if not found then
    return jsonb_build_object('success', false, 'error', 'CLASS_NOT_FOUND', 'class_code', p_class_code);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'kind', 'TIMETABLE',
           'space_code', ts.effective_space_code,
           'day_of_week', ts.day_of_week,
           'period_number', ts.period_number,
           'capacity', coalesce(r.capacity, l.capacity),
           'student_strength', p_strength) order by ts.day_of_week, ts.period_number), '[]'::jsonb)
    into v_conflicts
    from public.timetable_slots ts
    left join public.rooms r on r.code = ts.effective_space_code
    left join public.labs l on l.code = ts.effective_space_code
   where ts.class_code = p_class_code
     and coalesce(r.capacity, l.capacity, 0) < p_strength;

  select coalesce(jsonb_agg(jsonb_build_object(
           'kind', 'BOOKING',
           'booking_id', b.id,
           'space_code', b.space_code,
           'starts_at', b.starts_at,
           'ends_at', b.ends_at,
           'capacity', r.capacity,
           'student_strength', p_strength) order by b.starts_at), '[]'::jsonb)
    into v_booking_conflicts
    from public.room_bookings b
    join public.rooms r on r.code = b.space_code
   where b.class_code = p_class_code
     and b.status = 'ACTIVE'
     and b.ends_at >= now()
     and r.capacity < p_strength;

  update public.student_classes
     set student_strength = p_strength
   where class_code = p_class_code;

  perform public.nosih_append_audit(p_actor_email, v_role, 'SET_CLASS_STRENGTH', 'CLASS', p_class_code,
    'ALLOWED', 'STRENGTH_UPDATED', 'Strength ' || v_old || ' -> ' || p_strength,
    jsonb_build_object('timetable_conflicts', v_conflicts, 'booking_conflicts', v_booking_conflicts));

  return jsonb_build_object(
    'success', true, 'class_code', p_class_code,
    'previous_strength', v_old, 'student_strength', p_strength,
    'timetable_conflicts', v_conflicts,
    'booking_conflicts', v_booking_conflicts,
    'requires_review', jsonb_array_length(v_conflicts) > 0 or jsonb_array_length(v_booking_conflicts) > 0);
end;
$$;

grant execute on function public.rpc_set_class_strength(text, integer, text) to authenticated;
