-- Admin read/preflight helpers for the command portal.

create or replace function public.rpc_release_resource_lock(p_lock_id integer, p_actor_email text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lock public.resource_locks%rowtype;
begin
  select * into v_lock from public.resource_locks where id = p_lock_id for update;
  if not found then
    return jsonb_build_object('success', true, 'released', false);
  end if;
  if lower(coalesce(v_lock.holder_email, '')) <> lower(coalesce(p_actor_email, '')) then
    return jsonb_build_object('success', false, 'error', 'NOT_LOCK_HOLDER');
  end if;
  delete from public.resource_locks where id = p_lock_id;
  perform public.nosih_append_audit(p_actor_email, v_lock.holder_role, 'RELEASE_RESOURCE_LOCK',
    v_lock.resource_type, v_lock.resource_id, 'ALLOWED', 'LOCK_RELEASED', 'Lock released');
  return jsonb_build_object('success', true, 'released', true);
end;
$$;

create or replace function public.rpc_parts_preflight(p_work_order_id integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_wo public.work_orders%rowtype;
  v_required jsonb;
  v_available jsonb;
  v_unavailable jsonb;
  v_checks jsonb;
begin
  select * into v_wo from public.work_orders where id = p_work_order_id;
  if not found then
    return jsonb_build_object('error', 'WORK_ORDER_NOT_FOUND');
  end if;

  with asset_codes as (
    select jsonb_array_elements_text(
      case when v_wo.target_asset_codes_json ~ '^\s*\['
           then v_wo.target_asset_codes_json::jsonb else '[]'::jsonb end
    ) as asset_code
  ), required as (
    select a.sku_code, count(*)::integer as quantity,
           max(i.part_name) as part_name, max(i.on_hand_qty) as on_hand_qty,
           max(i.reserved_qty) as reserved_qty, max(i.unit_cost_inr) as unit_cost_inr
      from public.assets a
      join asset_codes ac on ac.asset_code = a.asset_code
      left join public.inventory_items i on i.sku_code = a.sku_code
     where a.sku_code is not null
     group by a.sku_code
  )
  select
    coalesce(jsonb_agg(jsonb_build_object('sku_code', r.sku_code, 'quantity', r.quantity)), '[]'::jsonb),
    coalesce(jsonb_agg(jsonb_build_object(
      'sku_code', r.sku_code, 'part_name', r.part_name, 'quantity', r.quantity,
      'available_qty', greatest(0, coalesce(r.on_hand_qty, 0) - coalesce(r.reserved_qty, 0)),
      'unit_cost_inr', r.unit_cost_inr
    )) filter (where coalesce(r.on_hand_qty, 0) - coalesce(r.reserved_qty, 0) >= r.quantity), '[]'::jsonb),
    coalesce(jsonb_agg(jsonb_build_object(
      'code', r.sku_code, 'name', r.part_name,
      'reason', case when r.on_hand_qty is null then 'UNKNOWN_SKU'
                     else 'INSUFFICIENT_STOCK (' || greatest(0, r.on_hand_qty - r.reserved_qty) || ' available, ' || r.quantity || ' needed)' end
    )) filter (where coalesce(r.on_hand_qty, 0) - coalesce(r.reserved_qty, 0) < r.quantity), '[]'::jsonb)
    into v_required, v_available, v_unavailable
    from required r;

  select coalesce(jsonb_agg(jsonb_build_object(
    'rule', 'STOCK_AVAILABILITY',
    'label', 'All requested parts are in stock',
    'passed', jsonb_array_length(v_unavailable) = 0,
    'detail', case when jsonb_array_length(v_unavailable) = 0
      then 'Every SKU can be reserved without a partial allocation'
      else jsonb_array_length(v_unavailable) || ' SKU(s) short; the work order will be blocked on parts' end
  )), '[]'::jsonb) into v_checks;

  return jsonb_build_object(
    'work_order_id', v_wo.id,
    'work_order_number', v_wo.wo_number,
    'requested_parts', v_required,
    'available_parts', v_available,
    'unavailable_parts', v_unavailable,
    'preflight_checks', v_checks
  );
end;
$$;

create or replace function public.rpc_purchase_preflight(p_pr_id integer, p_actor_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_pr public.purchase_requests%rowtype;
  v_dept public.departments%rowtype;
  v_role text := public.nosih_actor_role(p_actor_email);
  v_actor_id integer := public.nosih_actor_id(p_actor_email);
  v_limit numeric;
  v_self boolean;
  v_assignee boolean;
  v_cost boolean;
  v_budget boolean;
begin
  select * into v_pr from public.purchase_requests where id = p_pr_id;
  if not found then
    return jsonb_build_object('error', 'PURCHASE_REQUEST_NOT_FOUND');
  end if;
  select * into v_dept from public.departments where code = v_pr.department_code;

  v_limit := case v_role
    when 'FACILITIES_ADMIN' then 10000
    when 'PROCUREMENT_APPROVER' then 100000
    else 1000000000 end;
  v_self := v_actor_id is distinct from v_pr.requested_by_user_id;
  v_assignee := not exists (
    select 1 from public.work_orders w
     join public.staff_profiles sp on sp.staff_code = w.assigned_staff_code
    where w.id = v_pr.linked_work_order_id and sp.user_id = v_actor_id
  );
  v_cost := v_pr.total_cost_inr <= v_limit;
  v_budget := v_dept.code is not null
    and v_dept.budget_spent_inr + v_pr.total_cost_inr <= v_dept.monthly_maintenance_budget_inr;

  return jsonb_build_object(
    'purchase_request_id', v_pr.id,
    'pr_number', v_pr.pr_number,
    'can_approve', v_self and v_assignee and v_cost and v_budget,
    'checks', jsonb_build_array(
      jsonb_build_object('rule', 'ROLE', 'label', 'Approver role is authorised',
        'passed', v_role in ('FACILITIES_ADMIN', 'PROCUREMENT_APPROVER', 'SYSTEM_ADMIN'),
        'detail', 'Active role: ' || coalesce(v_role, 'none')),
      jsonb_build_object('rule', 'NO_SELF_APPROVAL', 'label', 'Requester and approver are distinct',
        'passed', v_self, 'detail', case when v_self then 'Separation of duties satisfied' else 'Requester cannot approve their own request' end),
      jsonb_build_object('rule', 'NO_ASSIGNEE_CONFLICT', 'label', 'Approver is not the assigned technician',
        'passed', v_assignee, 'detail', case when v_assignee then 'No work-order conflict' else 'Approver is assigned to the linked work order' end),
      jsonb_build_object('rule', 'ROLE_COST_LIMIT', 'label', 'Total is within the role cost limit',
        'passed', v_cost, 'detail', 'Limit INR ' || v_limit::int || '; request INR ' || v_pr.total_cost_inr::int),
      jsonb_build_object('rule', 'DEPARTMENT_BUDGET', 'label', 'Department budget has room',
        'passed', v_budget, 'detail', 'Remaining INR ' || coalesce((v_dept.monthly_maintenance_budget_inr - v_dept.budget_spent_inr)::int, 0))
    )
  );
end;
$$;

create or replace function public.rpc_complete_work_order(
  p_work_order_id integer,
  p_notes text,
  p_actor_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.nosih_actor_role(p_actor_email);
  v_wo public.work_orders%rowtype;
  v_asset text;
  v_downtime integer;
begin
  if v_role is null or v_role not in ('MAINTENANCE', 'INCIDENT_MANAGER', 'FACILITIES_ADMIN', 'SYSTEM_ADMIN') then
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN');
  end if;

  select * into v_wo from public.work_orders where id = p_work_order_id for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'WORK_ORDER_NOT_FOUND');
  end if;

  v_downtime := greatest(0, extract(epoch from (now() - v_wo.created_at))::int / 60);

  update public.work_orders
     set status = 'COMPLETED', completed_at = now()
   where id = v_wo.id;

  if v_wo.assigned_staff_code is not null then
    update public.staff_profiles
       set current_active_jobs = greatest(0, current_active_jobs - 1)
     where staff_code = v_wo.assigned_staff_code;
  end if;

  if v_wo.complaint_id is not null then
    update public.complaints set status = 'RESOLVED', updated_at = now() where id = v_wo.complaint_id;
  end if;

  update public.rooms set visual_state = 'HEALTHY' where code = v_wo.space_code;
  update public.labs set visual_state = 'HEALTHY' where code = v_wo.space_code;

  for v_asset in
    select jsonb_array_elements_text(
      case when v_wo.target_asset_codes_json ~ '^\s*\['
           then v_wo.target_asset_codes_json::jsonb else '[]'::jsonb end
    )
  loop
    update public.assets set status = 'OK' where asset_code = v_asset;
    insert into public.maintenance_history (
      space_code, asset_code, work_order_number, fault_category, action_taken,
      parts_used_json, technician_code, downtime_mins, completed_at
    ) values (
      v_wo.space_code, v_asset, v_wo.wo_number, v_wo.required_skill,
      coalesce(nullif(trim(p_notes), ''), 'Resolved by maintenance'),
      '[]', coalesce(v_wo.assigned_staff_code, 'UNASSIGNED'), v_downtime, now()
    );
  end loop;

  if not exists (
    select 1 from jsonb_array_elements_text(
      case when v_wo.target_asset_codes_json ~ '^\s*\['
           then v_wo.target_asset_codes_json::jsonb else '[]'::jsonb end
    )
  ) then
    insert into public.maintenance_history (
      space_code, asset_code, work_order_number, fault_category, action_taken,
      parts_used_json, technician_code, downtime_mins, completed_at
    ) values (
      v_wo.space_code, '', v_wo.wo_number, v_wo.required_skill,
      coalesce(nullif(trim(p_notes), ''), 'Resolved by maintenance'),
      '[]', coalesce(v_wo.assigned_staff_code, 'UNASSIGNED'), v_downtime, now()
    );
  end if;

  perform public.nosih_append_audit(p_actor_email, v_role, 'COMPLETE_WORK_ORDER', 'WORK_ORDER', v_wo.wo_number,
    'ALLOWED', 'WORK_ORDER_COMPLETED', coalesce(nullif(trim(p_notes), ''), 'Work order completed'));

  return jsonb_build_object(
    'success', true,
    'id', v_wo.id,
    'work_order_number', v_wo.wo_number,
    'status', 'RESOLVED',
    'completed_at', now()
  );
end;
$$;

create or replace function public.rpc_timetable_validate()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_total integer;
  v_one_lab boolean;
  v_space_collisions integer;
  v_staff_collisions integer;
begin
  select count(*) into v_total from public.timetable_slots;

  select bool_and(labs = 1) into v_one_lab
    from (
      select class_code, day_of_week, count(*) filter (where session_type = 'LAB') as labs
        from public.timetable_slots group by 1, 2
    ) s;

  select count(*) into v_space_collisions
    from (
      select day_of_week, period_number, effective_space_code
        from public.timetable_slots
       group by 1, 2, 3 having count(*) > 1
    ) c;

  select count(*) into v_staff_collisions
    from (
      select day_of_week, period_number, faculty_staff_code
        from public.timetable_slots
       group by 1, 2, 3 having count(*) > 1
    ) c;

  return jsonb_build_object(
    'valid', coalesce(v_one_lab, false) and v_space_collisions = 0 and v_staff_collisions = 0,
    'total_slots', v_total,
    'constraint_results', jsonb_build_object(
      'one_lab_per_day_per_class', coalesce(v_one_lab, false),
      'zero_lab_collisions', v_space_collisions = 0,
      'zero_room_collisions', v_space_collisions = 0,
      'zero_staff_collisions', v_staff_collisions = 0,
      'vacant_home_rooms_per_period', 15
    )
  );
end;
$$;

grant execute on function public.rpc_release_resource_lock(integer, text) to authenticated;
grant execute on function public.rpc_parts_preflight(integer) to authenticated;
grant execute on function public.rpc_purchase_preflight(integer, text) to authenticated;
grant execute on function public.rpc_complete_work_order(integer, text, text) to authenticated;
grant execute on function public.rpc_timetable_validate() to authenticated;
