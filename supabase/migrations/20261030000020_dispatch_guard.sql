-- Dispatch hardening.
-- 1. Ranking is manager-only and ignores locks held by the caller.
-- 2. Assignment can be guarded against the state the dispatcher actually saw.
-- 3. Technicians may only lock their own staff resource.

do $$
declare
  v_def text;
  v_old text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.rpc_rank_staff_for_work_order(integer)'::regprocedure);

  if position('nosih_rank_rbac' in v_def) = 0 then
    v_old := E'  v_result jsonb;\nbegin';
    v_new := E'  v_result jsonb;\n  v_email text;\n  v_role text;\nbegin\n  -- nosih_rank_rbac\n  select lower(u.email), u.role into v_email, v_role\n    from public.users u where u.auth_user_id = auth.uid() limit 1;\n  if v_role is null or v_role not in (''INCIDENT_MANAGER'', ''FACILITIES_ADMIN'', ''SYSTEM_ADMIN'', ''DEPARTMENT_MANAGER'') then\n    return jsonb_build_object(''error'', ''FORBIDDEN'');\n  end if;';

    if position(v_old in v_def) = 0 then
      raise exception 'rank prelude anchor not found';
    end if;
    v_def := replace(v_def, v_old, v_new);

    v_old := 'and l.expires_at > now()) then ''GATE_5_RESOURCE_LOCKED''';
    v_new := 'and l.expires_at > now() and lower(l.holder_email) <> lower(v_email)) then ''GATE_5_RESOURCE_LOCKED''';
    if position(v_old in v_def) = 0 then
      raise exception 'rank gate anchor not found';
    end if;
    v_def := replace(v_def, v_old, v_new);

    v_old := 'and l.expires_at > now()) then ''LOCKED_BY_ANOTHER_ADMIN''';
    v_new := 'and l.expires_at > now() and lower(l.holder_email) <> lower(v_email)) then ''LOCKED_BY_ANOTHER_ADMIN''';
    if position(v_old in v_def) = 0 then
      raise exception 'rank reason anchor not found';
    end if;
    v_def := replace(v_def, v_old, v_new);

    execute v_def;
  end if;
end
$$;

do $$
declare
  v_def text;
  v_old text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.rpc_claim_resource_lock(text,text,text,text,text,integer)'::regprocedure);
  if position('nosih_claim_self' in v_def) = 0 then
    v_old := '  delete from public.resource_locks where expires_at < now();';
    v_new := E'  -- nosih_claim_self\n  if v_role = ''MAINTENANCE'' and p_resource_type = ''STAFF'' then\n    if not exists (\n      select 1 from public.staff_profiles sp\n        join public.users u on u.id = sp.user_id\n       where lower(u.email) = lower(p_actor_email)\n         and sp.staff_code = p_resource_id) then\n      perform public.nosih_append_audit(p_actor_email, v_role, ''CLAIM_RESOURCE_LOCK'', p_resource_type, p_resource_id,\n        ''REJECTED'', ''SELF_LOCK_ONLY'', ''Technicians may only lock their own staff resource'');\n      return jsonb_build_object(''success'', false, ''error'', ''FORBIDDEN'');\n    end if;\n  end if;\n\n  delete from public.resource_locks where expires_at < now();';
    if position(v_old in v_def) = 0 then
      raise exception 'claim self-lock anchor not found';
    end if;
    execute replace(v_def, v_old, v_new);
  end if;
end
$$;

create or replace function public.rpc_assign_or_rebalance_staff_checked(
  p_work_order_id integer,
  p_staff_code text,
  p_actor_email text,
  p_actor_role text,
  p_expected jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.nosih_actor_role(p_actor_email);
  v_wo public.work_orders%rowtype;
  v_expected_staff text;
  v_expected_count integer;
begin
  if v_role is null or v_role not in ('INCIDENT_MANAGER', 'FACILITIES_ADMIN', 'SYSTEM_ADMIN') then
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN');
  end if;

  if p_expected is null or jsonb_typeof(p_expected) <> 'object' then
    return public.rpc_assign_or_rebalance_staff(p_work_order_id, p_staff_code, p_actor_email, p_actor_role);
  end if;

  select * into v_wo from public.work_orders where id = p_work_order_id for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'WORK_ORDER_NOT_FOUND');
  end if;

  v_expected_staff := nullif(p_expected->>'assigned_staff_code', '');
  v_expected_count := coalesce((p_expected->>'reassignment_count')::int, 0);

  if v_wo.assigned_staff_code is distinct from v_expected_staff
     or v_wo.reassignment_count is distinct from v_expected_count then
    perform public.nosih_append_audit(
      p_actor_email, v_role, 'ASSIGN_STAFF', 'WORK_ORDER', v_wo.id::text,
      'REJECTED', 'STALE_ASSIGNMENT',
      'Expected ' || coalesce(v_expected_staff, 'unassigned') || ' / ' || v_expected_count ||
      ' but current is ' || coalesce(v_wo.assigned_staff_code, 'unassigned') || ' / ' || v_wo.reassignment_count);
    return jsonb_build_object(
      'success', false, 'error', 'STALE_ASSIGNMENT',
      'current_assignee', v_wo.assigned_staff_code,
      'current_reassignment_count', v_wo.reassignment_count);
  end if;

  return public.rpc_assign_or_rebalance_staff(p_work_order_id, p_staff_code, p_actor_email, p_actor_role);
end;
$$;

revoke all on function public.rpc_assign_or_rebalance_staff_checked(integer,text,text,text,jsonb) from public;
grant execute on function public.rpc_assign_or_rebalance_staff_checked(integer,text,text,text,jsonb) to authenticated;
