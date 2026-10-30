-- Allocation hardening.
-- 1. Staff ranking now returns the clearance/shift fields the preflight panel
--    claimed to show (the UI was defaulting every candidate to STANDARD).
-- 2. The exclusive lock is consumed when the mutation it protected succeeds,
--    instead of lingering for the full 300s and blocking other dispatchers.

do $$
declare
  v_def text;
  v_old text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.rpc_rank_staff_for_work_order(integer)'::regprocedure);
  if position('''risk_clearance'', s.risk_clearance' in v_def) = 0 then
    v_old := '''primary_skill'', s.primary_skill, ''skill_proficiency'', s.skill_proficiency,';
    v_new := '''primary_skill'', s.primary_skill, ''skill_proficiency'', s.skill_proficiency,
        ''risk_clearance'', s.risk_clearance, ''is_on_shift'', s.is_on_shift, ''is_on_leave'', s.is_on_leave,';
    if position(v_old in v_def) = 0 then
      raise exception 'staff ranking payload anchor not found';
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
begin
  v_def := pg_get_functiondef(
    'public.rpc_assign_or_rebalance_staff(integer,text,text,text,boolean,text)'::regprocedure);
  if position('nosih_assign_lock_consumed' in v_def) = 0 then
    v_old := '''ALLOWED'', ''STAFF_ASSIGNED'', ''Assigned '' || v_staff_code || '' to '' || v_wo.wo_number);';
    v_new := v_old || E'\n\n  delete from public.resource_locks\n   where resource_type = ''STAFF'' and resource_id = v_staff_code\n     and lower(holder_email) = lower(p_actor_email); -- nosih_assign_lock_consumed';
    if position(v_old in v_def) = 0 then
      raise exception 'assign lock-consumption anchor not found';
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
begin
  v_def := pg_get_functiondef(
    'public.rpc_execute_room_relocation(text,text,text,integer,text,text)'::regprocedure);
  if position('nosih_relocation_lock_consumed' in v_def) = 0 then
    v_old := '''Moved '' || v_slot.class_code || '' from '' || p_faulted_room_code || '' to '' || v_target.code || '' at P'' || p_period);';
    v_new := v_old || E'\n\n  delete from public.resource_locks\n   where resource_type = ''ROOM'' and resource_id = v_target.code\n     and lower(holder_email) = lower(p_actor_email); -- nosih_relocation_lock_consumed';
    if position(v_old in v_def) = 0 then
      raise exception 'relocation lock-consumption anchor not found';
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
begin
  v_def := pg_get_functiondef(
    'public.rpc_reserve_parts_for_work_order(integer,jsonb,text,text)'::regprocedure);
  if position('nosih_parts_lock_consumed' in v_def) = 0 then
    v_old := 'jsonb_build_object(''reserved'', v_reserved));';
    v_new := v_old || E'\n\n  delete from public.resource_locks\n   where resource_type = ''WORK_ORDER'' and resource_id = v_wo.id::text\n     and lower(holder_email) = lower(p_actor_email); -- nosih_parts_lock_consumed';
    if position(v_old in v_def) = 0 then
      raise exception 'parts lock-consumption anchor not found';
    end if;
    execute replace(v_def, v_old, v_new);
  end if;
end
$$;
