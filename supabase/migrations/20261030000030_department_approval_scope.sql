-- Department managers approve spend for their own department only. Without
-- this guard a CSE head could approve an AIML purchase request because the
-- role gate stopped at "DEPARTMENT_MANAGER" and never compared departments.

do $$
declare
  v_def text := pg_get_functiondef(
    'public.rpc_decide_purchase_request(integer, text, integer, text, text, boolean, text, text)'::regprocedure);
  v_anchor text := $frag$  if v_role is null or v_role not in ('DEPARTMENT_MANAGER', 'FACILITIES_ADMIN', 'PROCUREMENT_APPROVER', 'SYSTEM_ADMIN') then$frag$;
  v_guard text := $frag$  -- nosih_department_scope
  if v_role = 'DEPARTMENT_MANAGER'
     and v_pr.department_code is distinct from public.nosih_actor_department() then
    perform public.nosih_append_audit(p_actor_email, v_role, 'APPROVE_PURCHASE', 'PURCHASE_REQUEST', v_pr.pr_number,
      'REJECTED', 'DEPARTMENT_SCOPE_VIOLATION', 'Department manager approval outside own department',
      jsonb_build_object('request_department', v_pr.department_code,
                         'actor_department', public.nosih_actor_department()));
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN_DEPARTMENT_SCOPE');
  end if;

  if v_role is null or v_role not in ('DEPARTMENT_MANAGER', 'FACILITIES_ADMIN', 'PROCUREMENT_APPROVER', 'SYSTEM_ADMIN') then$frag$;
begin
  if position('-- nosih_department_scope' in v_def) > 0 then
    return;
  end if;
  if position(v_anchor in v_def) = 0 then
    raise exception 'purchase decision role gate anchor missing';
  end if;
  v_def := replace(v_def, v_anchor, v_guard);
  execute v_def;
end;
$$;
