-- Operational RPCs: staff ranking/assignment, parts reservation, procurement
-- separation of duties, stock receipt, and the pgcrypto identity vault.

-- 5. Staff ranking ------------------------------------------------------------
create or replace function public.rpc_rank_staff_for_work_order(p_work_order_id integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_wo public.work_orders%rowtype;
  v_urgency numeric := 2.0;
  v_wo_block text;
  v_result jsonb;
begin
  select * into v_wo from public.work_orders where id = p_work_order_id;
  if not found then
    return jsonb_build_object('error', 'WORK_ORDER_NOT_FOUND', 'work_order_id', p_work_order_id);
  end if;

  v_wo_block := case when v_wo.space_code like 'LAB-%' then 'LAB_WING'
                     else split_part(v_wo.space_code, '-', 1) end;

  select case urgency when 'LOW' then 1.0 when 'MEDIUM' then 2.0 when 'HIGH' then 4.0 when 'CRITICAL' then 5.0 else 2.0 end
    into v_urgency
    from public.sla_clocks
   where target_type = 'WORK_ORDER' and target_id = v_wo.id
   limit 1;
  if v_urgency is null then
    v_urgency := case when v_wo.priority_score >= 90 then 5.0
                      when v_wo.priority_score >= 70 then 4.0
                      when v_wo.priority_score >= 40 then 2.0
                      else 1.0 end;
  end if;

  with base as (
    select sp.staff_code, sp.user_id, u.full_name, sp.primary_skill, sp.skill_proficiency,
           sp.risk_clearance, sp.is_on_shift, sp.is_on_leave, u.is_active,
           sp.current_active_jobs, sp.max_concurrent_jobs, sp.hourly_cost_inr,
           sp.current_block_location,
           case
             when sp.primary_skill <> v_wo.required_skill then 'GATE_1_SKILL_MISMATCH'
             when v_wo.required_risk_clearance <> 'STANDARD'
                  and sp.risk_clearance <> v_wo.required_risk_clearance then 'GATE_2_RISK_CLEARANCE'
             when not sp.is_on_shift then 'GATE_3_OFF_SHIFT'
             when sp.is_on_leave then 'GATE_3_ON_LEAVE'
             when not u.is_active then 'GATE_3_INACTIVE_USER'
             when sp.current_active_jobs >= sp.max_concurrent_jobs then 'GATE_4_CAPACITY'
             when exists (select 1 from public.resource_locks l
                           where l.resource_type = 'STAFF' and l.resource_id = sp.staff_code
                             and l.expires_at > now()) then 'GATE_5_RESOURCE_LOCKED'
             else null
           end as gate,
           case
             when sp.primary_skill <> v_wo.required_skill
               then 'PRIMARY_SKILL_MISMATCH (Required ' || v_wo.required_skill || ', actual ' || coalesce(sp.primary_skill, 'none') || ')'
             when v_wo.required_risk_clearance <> 'STANDARD'
                  and sp.risk_clearance <> v_wo.required_risk_clearance
               then 'RISK_CLEARANCE_INSUFFICIENT (Required ' || v_wo.required_risk_clearance || ', actual ' || coalesce(sp.risk_clearance, 'none') || ')'
             when not sp.is_on_shift then 'OFF_SHIFT'
             when sp.is_on_leave then 'ON_LEAVE'
             when not u.is_active then 'USER_INACTIVE'
             when sp.current_active_jobs >= sp.max_concurrent_jobs
               then 'MAX_CONCURRENT_JOBS_REACHED (' || sp.current_active_jobs || '/' || sp.max_concurrent_jobs || ')'
             when exists (select 1 from public.resource_locks l
                           where l.resource_type = 'STAFF' and l.resource_id = sp.staff_code
                             and l.expires_at > now()) then 'LOCKED_BY_ANOTHER_ADMIN'
             else null
           end as gate_reason,
           least(5.0, greatest(0.0, v_wo.priority_score / 20.0)) as priority_fit,
           case
             when sp.current_block_location = v_wo_block then 0
             when sp.current_block_location in ('A', 'B', 'C', 'LAB_WING')
               then abs(public.nosih_block_rank(sp.current_block_location) - public.nosih_block_rank(v_wo_block))
             else 2
           end as block_distance
      from public.staff_profiles sp
      join public.users u on u.id = sp.user_id
     where sp.staff_category = 'MAINTENANCE_TECH'
  ), scored as (
    select b.*,
           round((
             2.0 * b.skill_proficiency
             + 3.0 * b.priority_fit
             - 1.5 * b.current_active_jobs
             - 0.8 * b.block_distance
             - b.hourly_cost_inr / 200.0
             + 1.5 * v_urgency
           )::numeric, 4) as score
      from base b
  )
  select jsonb_build_object(
    'work_order_id', v_wo.id,
    'work_order_number', v_wo.wo_number,
    'required_skill', v_wo.required_skill,
    'required_risk_clearance', v_wo.required_risk_clearance,
    'available_ranked', coalesce(
      jsonb_agg(jsonb_build_object(
        'staff_code', s.staff_code, 'user_id', s.user_id, 'full_name', s.full_name,
        'primary_skill', s.primary_skill, 'skill_proficiency', s.skill_proficiency,
        'current_active_jobs', s.current_active_jobs,
        'max_concurrent_jobs', s.max_concurrent_jobs,
        'current_block_location', s.current_block_location,
        'score', s.score,
        'breakdown', jsonb_build_object(
          'inputs', jsonb_build_object(
            'skill_proficiency', s.skill_proficiency, 'priority_fit', s.priority_fit,
            'current_active_jobs', s.current_active_jobs, 'block_distance', s.block_distance,
            'hourly_cost_inr', s.hourly_cost_inr, 'sla_urgency_factor', v_urgency
          ),
          'terms', jsonb_build_object(
            'skill', round((2.0 * s.skill_proficiency)::numeric, 4),
            'priority_fit', round((3.0 * s.priority_fit)::numeric, 4),
            'active_jobs', round((-1.5 * s.current_active_jobs)::numeric, 4),
            'block_distance', round((-0.8 * s.block_distance)::numeric, 4),
            'hourly_cost', round((-1.0 * s.hourly_cost_inr / 200.0)::numeric, 4),
            'sla_urgency', round((1.5 * v_urgency)::numeric, 4)
          ),
          'formula', '2*skill + 3*priority_fit - 1.5*active_jobs - 0.8*block_distance - hourly_cost/200 + 1.5*sla_urgency'
        )
      ) order by s.score desc, s.staff_code) filter (where s.gate is null),
      '[]'::jsonb
    ),
    'unavailable_staff', coalesce(
      jsonb_agg(jsonb_build_object(
        'staff_code', s.staff_code, 'full_name', s.full_name,
        'failed_gate', s.gate, 'reason', s.gate_reason
      ) order by s.staff_code) filter (where s.gate is not null),
      '[]'::jsonb
    )
  )
  into v_result
  from scored s;

  return v_result;
end;
$$;

-- 6. Assign / rebalance staff -------------------------------------------------
create or replace function public.rpc_assign_or_rebalance_staff(
  p_work_order_id integer,
  p_staff_code text,
  p_actor_email text,
  p_actor_role text,
  p_is_auto_rebalance boolean default false,
  p_rebalance_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.nosih_actor_role(p_actor_email);
  v_wo public.work_orders%rowtype;
  v_staff_code text := p_staff_code;
  v_lock public.resource_locks%rowtype;
  v_profile public.staff_profiles%rowtype;
  v_ranking jsonb;
begin
  if v_role is null or v_role not in ('INCIDENT_MANAGER', 'FACILITIES_ADMIN', 'SYSTEM_ADMIN') then
    perform public.nosih_append_audit(p_actor_email, coalesce(v_role, p_actor_role), 'ASSIGN_STAFF', 'WORK_ORDER', p_work_order_id::text,
      'REJECTED', 'RBAC_ROLE_NOT_PERMITTED', 'Role cannot assign staff');
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN');
  end if;

  select * into v_wo from public.work_orders where id = p_work_order_id for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'WORK_ORDER_NOT_FOUND');
  end if;

  if p_is_auto_rebalance then
    v_ranking := public.rpc_rank_staff_for_work_order(v_wo.id);
    v_staff_code := v_ranking->'available_ranked'->0->>'staff_code';
  else
    select * into v_lock from public.resource_locks
     where resource_type = 'STAFF' and resource_id = p_staff_code and expires_at > now()
     limit 1;
    if not found or lower(coalesce(v_lock.holder_email, '')) <> lower(coalesce(p_actor_email, '')) then
      perform public.nosih_append_audit(p_actor_email, v_role, 'ASSIGN_STAFF', 'WORK_ORDER', v_wo.id::text,
        'REJECTED', 'STAFF_LOCK_REQUIRED', 'Caller does not hold the staff lock');
      return jsonb_build_object('success', false, 'error', 'LOCK_REQUIRED');
    end if;
  end if;

  if v_staff_code is null then
    perform public.nosih_append_audit(p_actor_email, v_role, 'ASSIGN_STAFF', 'WORK_ORDER', v_wo.id::text,
      'REJECTED', 'NO_AVAILABLE_STAFF', 'Every technician failed a hard gate');
    return jsonb_build_object('success', false, 'error', 'NO_AVAILABLE_STAFF');
  end if;

  select * into v_profile from public.staff_profiles where staff_code = v_staff_code for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'STAFF_NOT_FOUND');
  end if;
  if v_profile.primary_skill <> v_wo.required_skill
     or (v_wo.required_risk_clearance <> 'STANDARD' and v_profile.risk_clearance <> v_wo.required_risk_clearance)
     or not v_profile.is_on_shift or v_profile.is_on_leave
     or v_profile.current_active_jobs >= v_profile.max_concurrent_jobs then
    return jsonb_build_object('success', false, 'error', 'STAFF_GATE_FAILED');
  end if;

  if v_wo.assigned_staff_code is not null and v_wo.assigned_staff_code <> v_staff_code then
    update public.staff_profiles
       set current_active_jobs = greatest(0, current_active_jobs - 1)
     where staff_code = v_wo.assigned_staff_code;
  end if;

  update public.work_orders
     set assigned_staff_code = v_staff_code,
         status = 'ASSIGNED',
         reassignment_count = reassignment_count
           + case when v_wo.assigned_staff_code is not null and v_wo.assigned_staff_code <> v_staff_code then 1 else 0 end,
         last_reassignment_reason = coalesce(p_rebalance_reason, v_wo.last_reassignment_reason)
   where id = v_wo.id;

  if v_wo.assigned_staff_code is distinct from v_staff_code then
    update public.staff_profiles
       set current_active_jobs = current_active_jobs + 1
     where staff_code = v_staff_code;
  end if;

  perform public.nosih_append_audit(p_actor_email, v_role, 'ASSIGN_STAFF', 'WORK_ORDER', v_wo.id::text,
    'ALLOWED', 'STAFF_ASSIGNED', 'Assigned ' || v_staff_code || ' to ' || v_wo.wo_number);

  return jsonb_build_object(
    'success', true,
    'work_order_id', v_wo.id,
    'assigned_staff_code', v_staff_code,
    'staff_name', v_profile.staff_code,
    'auto_rebalance', p_is_auto_rebalance
  );
end;
$$;

create or replace function public.rpc_trigger_staff_shift_change(
  p_staff_code text,
  p_new_on_shift boolean,
  p_actor_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.nosih_actor_role(p_actor_email);
  v_wo record;
  v_next text;
  v_count integer := 0;
begin
  if v_role is null or v_role not in ('INCIDENT_MANAGER', 'FACILITIES_ADMIN', 'SYSTEM_ADMIN') then
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN');
  end if;

  update public.staff_profiles set is_on_shift = p_new_on_shift where staff_code = p_staff_code;

  if not p_new_on_shift then
    for v_wo in
      select * from public.work_orders
       where assigned_staff_code = p_staff_code
         and status not in ('RESOLVED', 'CLOSED', 'COMPLETED')
       order by priority_score desc
    loop
      select (public.rpc_rank_staff_for_work_order(v_wo.id)->'available_ranked'->0->>'staff_code')
        into v_next;
      if v_next is not null then
        update public.staff_profiles set current_active_jobs = greatest(0, current_active_jobs - 1)
         where staff_code = p_staff_code;
        update public.work_orders
           set assigned_staff_code = v_next,
               reassignment_count = reassignment_count + 1,
               last_reassignment_reason = 'Shift ended for ' || p_staff_code
         where id = v_wo.id;
        update public.staff_profiles set current_active_jobs = current_active_jobs + 1
         where staff_code = v_next;
        v_count := v_count + 1;
      end if;
    end loop;
  end if;

  perform public.nosih_append_audit(p_actor_email, v_role, 'ASSIGN_STAFF', 'STAFF', p_staff_code,
    'ALLOWED', case when p_new_on_shift then 'SHIFT_STARTED' else 'SHIFT_ENDED' end,
    'Shift state changed; ' || v_count || ' work orders reassigned');

  return jsonb_build_object('success', true, 'staff_code', p_staff_code, 'reassigned', v_count);
end;
$$;

-- 7. Parts reservation --------------------------------------------------------
create or replace function public.rpc_reserve_parts_for_work_order(
  p_work_order_id integer,
  p_parts_json jsonb,
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
  v_actor_id integer := public.nosih_actor_id(p_actor_email);
  v_wo public.work_orders%rowtype;
  v_parts jsonb := case when jsonb_typeof(p_parts_json) = 'array' then p_parts_json
                        else coalesce(p_parts_json->'parts', '[]'::jsonb) end;
  v_req record;
  v_item public.inventory_items%rowtype;
  v_missing jsonb := '[]'::jsonb;
  v_reserved jsonb := '[]'::jsonb;
  v_first_missing text;
  v_pr record;
  v_pr_number text;
  v_dept text;
  v_year text := to_char(now(), 'YYYY');
begin
  if v_role is null or v_role not in ('MAINTENANCE', 'INCIDENT_MANAGER', 'FACILITIES_ADMIN', 'SYSTEM_ADMIN') then
    perform public.nosih_append_audit(p_actor_email, coalesce(v_role, p_actor_role), 'RESERVE_PARTS', 'WORK_ORDER', p_work_order_id::text,
      'REJECTED', 'RBAC_ROLE_NOT_PERMITTED', 'Role cannot reserve parts');
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN');
  end if;

  if jsonb_array_length(v_parts) = 0 then
    return jsonb_build_object('success', false, 'error', 'EMPTY_PART_LIST');
  end if;

  select * into v_wo from public.work_orders where id = p_work_order_id for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'WORK_ORDER_NOT_FOUND');
  end if;

  for v_req in
    select (x->>'sku_code') as sku_code,
           sum(coalesce((x->>'qty')::int, (x->>'quantity')::int, 0)) as qty
      from jsonb_array_elements(v_parts) x
     group by 1
     order by 1
  loop
    if v_req.sku_code is null or v_req.qty is null or v_req.qty <= 0 then
      return jsonb_build_object('success', false, 'error', 'INVALID_PART', 'part', v_req);
    end if;

    select * into v_item from public.inventory_items where sku_code = v_req.sku_code for update;
    if not found then
      v_missing := v_missing || jsonb_build_object('sku_code', v_req.sku_code, 'reason', 'UNKNOWN_SKU', 'requested', v_req.qty);
    elsif v_item.on_hand_qty - v_item.reserved_qty < v_req.qty then
      v_missing := v_missing || jsonb_build_object(
        'sku_code', v_req.sku_code, 'reason', 'INSUFFICIENT_STOCK', 'requested', v_req.qty,
        'available', greatest(0, v_item.on_hand_qty - v_item.reserved_qty)
      );
    else
      v_reserved := v_reserved || jsonb_build_object('sku_code', v_req.sku_code, 'qty', v_req.qty);
    end if;
  end loop;

  if jsonb_array_length(v_missing) > 0 then
    update public.work_orders set status = 'BLOCKED_PARTS' where id = v_wo.id;

    update public.rooms set visual_state = 'BLOCKED_PARTS' where code = v_wo.space_code;
    update public.labs set visual_state = 'BLOCKED_PARTS' where code = v_wo.space_code;

    v_first_missing := v_missing->0->>'sku_code';

    update public.sla_clocks
       set is_paused = true,
           pause_reason = 'BLOCKED_AWAITING_PARTS: ' || v_first_missing
     where target_type = 'WORK_ORDER' and target_id = v_wo.id;

    select department_code into v_dept from public.users where id = v_actor_id;
    v_dept := coalesce(v_dept, 'CSE');

    for v_req in
      select (m->>'sku_code') as sku_code from jsonb_array_elements(v_missing) m
    loop
      select * into v_item from public.inventory_items where sku_code = v_req.sku_code;
      if found then
        select coalesce(max((regexp_match(pr_number, '([0-9]+)$'))[1]::int), 0) + 1
          into v_pr_number
          from public.purchase_requests
         where pr_number like 'PR-' || v_year || '-%';
        v_pr_number := 'PR-' || v_year || '-' || lpad(v_pr_number::text, 4, '0');

        insert into public.purchase_requests (
          pr_number, linked_work_order_id, department_code, sku_code,
          quantity_requested, unit_cost_inr, total_cost_inr, requested_by_user_id,
          status, requires_dual_approval, created_at
        ) values (
          v_pr_number, v_wo.id, v_dept, v_item.sku_code,
          greatest(10, v_item.reorder_threshold * 2), v_item.unit_cost_inr,
          greatest(10, v_item.reorder_threshold * 2) * v_item.unit_cost_inr,
          coalesce(v_actor_id, (select id from public.users order by id limit 1)),
          'PENDING_APPROVAL', greatest(10, v_item.reorder_threshold * 2) * v_item.unit_cost_inr > 100000,
          now()
        ) returning * into v_pr;
      end if;
    end loop;

    perform public.nosih_append_audit(p_actor_email, v_role, 'RESERVE_PARTS', 'WORK_ORDER', v_wo.id::text,
      'REJECTED', 'STOCK_OUT_BLOCKED_PARTS',
      'Zero partial reservations; missing ' || v_first_missing,
      jsonb_build_object('missing', v_missing));

    return jsonb_build_object(
      'success', false, 'error', 'PARTS_SHORTAGE',
      'work_order_status', 'BLOCKED_PARTS',
      'missing', v_missing
    );
  end if;

  for v_req in
    select (x->>'sku_code') as sku_code,
           sum(coalesce((x->>'qty')::int, (x->>'quantity')::int, 0)) as qty
      from jsonb_array_elements(v_parts) x
     group by 1
     order by 1
  loop
    update public.inventory_items
       set reserved_qty = reserved_qty + v_req.qty
     where sku_code = v_req.sku_code;

    insert into public.part_reservations (work_order_id, sku_code, quantity_reserved, status, reserved_at)
    values (v_wo.id, v_req.sku_code, v_req.qty, 'RESERVED', now());
  end loop;

  update public.work_orders set status = 'IN_PROGRESS' where id = v_wo.id;

  perform public.nosih_append_audit(p_actor_email, v_role, 'RESERVE_PARTS', 'WORK_ORDER', v_wo.id::text,
    'ALLOWED', 'PARTS_RESERVED', 'Reserved ' || jsonb_array_length(v_reserved) || ' SKUs',
    jsonb_build_object('reserved', v_reserved));

  return jsonb_build_object('success', true, 'reserved', v_reserved, 'work_order_status', 'IN_PROGRESS');
end;
$$;

-- 8. Purchase request decision ------------------------------------------------
create or replace function public.rpc_decide_purchase_request(
  p_pr_id integer,
  p_decision text,
  p_actor_user_id integer,
  p_actor_email text,
  p_actor_role text,
  p_is_override boolean default false,
  p_override_reason text default null,
  p_countersign_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.nosih_actor_role(p_actor_email);
  v_actor_id integer := public.nosih_actor_id(p_actor_email);
  v_pr public.purchase_requests%rowtype;
  v_dept public.departments%rowtype;
  v_limit numeric;
  v_self_ok boolean;
  v_assignee_ok boolean;
  v_cost_ok boolean;
  v_budget_ok boolean;
  v_rule text;
  v_reason text;
  v_countersign_id integer;
  v_first_role text;
begin
  select * into v_pr from public.purchase_requests where id = p_pr_id for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'PURCHASE_REQUEST_NOT_FOUND');
  end if;

  if v_role is null or v_role not in ('FACILITIES_ADMIN', 'PROCUREMENT_APPROVER', 'SYSTEM_ADMIN') then
    perform public.nosih_append_audit(p_actor_email, coalesce(v_role, p_actor_role), 'APPROVE_PURCHASE', 'PURCHASE_REQUEST', v_pr.pr_number,
      'REJECTED', 'RBAC_ROLE_NOT_PERMITTED', 'Role cannot decide purchase requests');
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN');
  end if;

  if p_is_override then
    if length(trim(coalesce(p_override_reason, ''))) < 20 then
      perform public.nosih_append_audit(p_actor_email, v_role, 'OVERRIDE_PURCHASE', 'PURCHASE_REQUEST', v_pr.pr_number,
        'REJECTED', 'OVERRIDE_REASON_TOO_SHORT', 'Override justification must be at least 20 characters');
      return jsonb_build_object('success', false, 'error', 'OVERRIDE_REASON_TOO_SHORT');
    end if;

    select id into v_countersign_id from public.users
     where lower(email) = lower(coalesce(p_countersign_email, '')) and is_active limit 1;
    if v_countersign_id is null or v_countersign_id = v_actor_id then
      perform public.nosih_append_audit(p_actor_email, v_role, 'OVERRIDE_PURCHASE', 'PURCHASE_REQUEST', v_pr.pr_number,
        'REJECTED', 'COUNTERSIGN_REQUIRED', 'A distinct active counter-signer is required');
      return jsonb_build_object('success', false, 'error', 'COUNTERSIGN_REQUIRED');
    end if;

    update public.purchase_requests
       set status = 'OVERRIDDEN_APPROVED', override_reason = p_override_reason
     where id = v_pr.id;

    update public.departments
       set budget_spent_inr = budget_spent_inr + v_pr.total_cost_inr
     where code = v_pr.department_code;

    perform public.nosih_append_audit(p_actor_email, v_role, 'OVERRIDE_PURCHASE', 'PURCHASE_REQUEST', v_pr.pr_number,
      'OVERRIDE', 'SEPARATION_OF_DUTIES_OVERRIDDEN', p_override_reason,
      jsonb_build_object('countersign_email', p_countersign_email));

    return jsonb_build_object('success', true, 'outcome', 'OVERRIDE', 'status', 'OVERRIDDEN_APPROVED');
  end if;

  if upper(coalesce(p_decision, 'APPROVE')) = 'REJECT' then
    update public.purchase_requests set status = 'REJECTED' where id = v_pr.id;
    perform public.nosih_append_audit(p_actor_email, v_role, 'APPROVE_PURCHASE', 'PURCHASE_REQUEST', v_pr.pr_number,
      'REJECTED', 'MANUAL_REJECTION', 'Approver rejected the request');
    return jsonb_build_object('success', true, 'outcome', 'REJECTED', 'status', 'REJECTED');
  end if;

  v_limit := case v_role
    when 'FACILITIES_ADMIN' then 10000
    when 'PROCUREMENT_APPROVER' then 100000
    else 1000000000 end;

  v_self_ok := v_actor_id is distinct from v_pr.requested_by_user_id;
  v_assignee_ok := not exists (
    select 1 from public.work_orders w
     join public.staff_profiles sp on sp.staff_code = w.assigned_staff_code
    where w.id = v_pr.linked_work_order_id and sp.user_id = v_actor_id
  );
  v_cost_ok := v_pr.total_cost_inr <= v_limit;

  select * into v_dept from public.departments where code = v_pr.department_code;
  v_budget_ok := v_dept.code is not null
    and v_dept.budget_spent_inr + v_pr.total_cost_inr <= v_dept.monthly_maintenance_budget_inr;

  v_rule := case
    when not v_self_ok then 'SEPARATION_OF_DUTIES_SELF_APPROVAL_FORBIDDEN'
    when not v_assignee_ok then 'SEPARATION_OF_DUTIES_WORK_ORDER_ASSIGNEE_CONFLICT'
    when not v_cost_ok then 'ROLE_COST_LIMIT_EXCEEDED_' || v_limit::int || '_INR'
    when not v_budget_ok then 'DEPARTMENT_BUDGET_EXCEEDED'
    else null end;

  if v_rule is not null then
    perform public.nosih_append_audit(p_actor_email, v_role, 'APPROVE_PURCHASE', 'PURCHASE_REQUEST', v_pr.pr_number,
      'REJECTED', v_rule, 'Pre-flight rule failed for ' || v_pr.pr_number,
      jsonb_build_object('self_ok', v_self_ok, 'assignee_ok', v_assignee_ok,
                         'cost_ok', v_cost_ok, 'budget_ok', v_budget_ok));
    return jsonb_build_object(
      'success', false, 'outcome', 'REJECTED', 'rule_fired', v_rule,
      'preflight', jsonb_build_object(
        'role', v_role, 'limit_inr', v_limit,
        'no_self_approval', v_self_ok, 'no_assignee_conflict', v_assignee_ok,
        'cost_within_limit', v_cost_ok, 'budget_available', v_budget_ok,
        'remaining_budget_inr', coalesce(v_dept.monthly_maintenance_budget_inr - v_dept.budget_spent_inr, 0)
      )
    );
  end if;

  if v_pr.total_cost_inr > 100000 then
    if v_pr.first_approver_user_id is null then
      update public.purchase_requests
         set first_approver_user_id = v_actor_id, status = 'PENDING_SECOND_APPROVAL'
       where id = v_pr.id;
      perform public.nosih_append_audit(p_actor_email, v_role, 'APPROVE_PURCHASE', 'PURCHASE_REQUEST', v_pr.pr_number,
        'ALLOWED', 'DUAL_APPROVAL_FIRST_APPROVED', 'First approval recorded; second approver required');
      return jsonb_build_object('success', true, 'outcome', 'PENDING_SECOND_APPROVAL');
    end if;

    if v_pr.first_approver_user_id = v_actor_id then
      perform public.nosih_append_audit(p_actor_email, v_role, 'APPROVE_PURCHASE', 'PURCHASE_REQUEST', v_pr.pr_number,
        'REJECTED', 'DUAL_APPROVAL_REQUIRES_DISTINCT_USER', 'Second approver must be a different user');
      return jsonb_build_object('success', false, 'outcome', 'REJECTED',
                                'rule_fired', 'DUAL_APPROVAL_REQUIRES_DISTINCT_USER');
    end if;

    select role into v_first_role from public.users where id = v_pr.first_approver_user_id;

    update public.purchase_requests
       set second_approver_user_id = v_actor_id, status = 'APPROVED'
     where id = v_pr.id;

    update public.departments
       set budget_spent_inr = budget_spent_inr + v_pr.total_cost_inr
     where code = v_pr.department_code;

    perform public.nosih_append_audit(p_actor_email, v_role, 'APPROVE_PURCHASE', 'PURCHASE_REQUEST', v_pr.pr_number,
      'ALLOWED', 'DUAL_APPROVAL_COMPLETED', 'Second approval recorded; request approved',
      jsonb_build_object('first_approver_role', v_first_role, 'second_approver_role', v_role));

    return jsonb_build_object('success', true, 'outcome', 'APPROVED', 'dual_approval', true);
  end if;

  update public.purchase_requests set status = 'APPROVED' where id = v_pr.id;
  update public.departments
     set budget_spent_inr = budget_spent_inr + v_pr.total_cost_inr
   where code = v_pr.department_code;

  perform public.nosih_append_audit(p_actor_email, v_role, 'APPROVE_PURCHASE', 'PURCHASE_REQUEST', v_pr.pr_number,
    'ALLOWED', 'PURCHASE_APPROVED', 'Approved ' || v_pr.pr_number);

  return jsonb_build_object('success', true, 'outcome', 'APPROVED', 'dual_approval', false);
end;
$$;

create or replace function public.rpc_receive_purchase_request_stock(
  p_pr_id integer,
  p_actor_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.nosih_actor_role(p_actor_email);
  v_pr public.purchase_requests%rowtype;
  v_wo public.work_orders%rowtype;
begin
  if v_role is null or v_role not in ('FACILITIES_ADMIN', 'PROCUREMENT_APPROVER', 'SYSTEM_ADMIN') then
    perform public.nosih_append_audit(p_actor_email, coalesce(v_role, 'UNKNOWN'), 'RECEIVE_STOCK', 'PURCHASE_REQUEST', p_pr_id::text,
      'REJECTED', 'RBAC_ROLE_NOT_PERMITTED', 'Role cannot receive stock');
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN');
  end if;

  select * into v_pr from public.purchase_requests where id = p_pr_id for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'PURCHASE_REQUEST_NOT_FOUND');
  end if;
  if v_pr.status not in ('APPROVED', 'OVERRIDDEN_APPROVED', 'ORDERED') then
    return jsonb_build_object('success', false, 'error', 'PURCHASE_REQUEST_NOT_APPROVED', 'status', v_pr.status);
  end if;

  update public.inventory_items
     set on_hand_qty = on_hand_qty + v_pr.quantity_requested
   where sku_code = v_pr.sku_code;

  update public.purchase_requests set status = 'RECEIVED' where id = v_pr.id;

  if v_pr.linked_work_order_id is not null then
    select * into v_wo from public.work_orders where id = v_pr.linked_work_order_id for update;
    if found and v_wo.status = 'BLOCKED_PARTS' then
      update public.work_orders set status = 'IN_PROGRESS' where id = v_wo.id;
      update public.rooms set visual_state = 'HEALTHY' where code = v_wo.space_code;
      update public.labs set visual_state = 'HEALTHY' where code = v_wo.space_code;
      update public.sla_clocks
         set is_paused = false, pause_reason = null
       where target_type = 'WORK_ORDER' and target_id = v_wo.id;
    end if;
  end if;

  perform public.nosih_append_audit(p_actor_email, v_role, 'RECEIVE_STOCK', 'PURCHASE_REQUEST', v_pr.pr_number,
    'ALLOWED', 'STOCK_RECEIVED',
    'Received ' || v_pr.quantity_requested || ' x ' || v_pr.sku_code);

  return jsonb_build_object('success', true, 'pr_number', v_pr.pr_number, 'status', 'RECEIVED');
end;
$$;

-- 9. Identity vault -----------------------------------------------------------
create or replace function public.rpc_seal_identity_in_vault(
  p_entity_type text,
  p_entity_id integer,
  p_identity_json jsonb,
  p_sender_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_secret text;
  v_token text := extensions.gen_random_uuid()::text;
begin
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'nosih_vault_secret' limit 1;
  if v_secret is null then
    raise exception 'VAULT_SECRET_MISSING: create the nosih_vault_secret in Supabase Vault';
  end if;

  insert into public.identity_vault (
    vault_token, target_entity_type, target_entity_id,
    encrypted_identity_blob, encrypted_identity_bytea, reporter_rate_limit_hash, created_at
  ) values (
    v_token, upper(p_entity_type), p_entity_id,
    '', extensions.pgp_sym_encrypt(p_identity_json::text, v_secret),
    coalesce(p_sender_hash, ''), now()
  );

  return jsonb_build_object('vault_token', v_token);
end;
$$;

create or replace function public.rpc_break_glass_unseal_identity(
  p_vault_token text,
  p_actor_email text,
  p_actor_role text,
  p_justification text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_role text := public.nosih_actor_role(p_actor_email);
  v_vault public.identity_vault%rowtype;
  v_secret text;
  v_identity jsonb;
begin
  if v_role is null or v_role <> 'SYSTEM_ADMIN' then
    perform public.nosih_append_audit(p_actor_email, coalesce(v_role, p_actor_role), 'BREAK_GLASS_UNSEAL', 'IDENTITY_VAULT', p_vault_token,
      'REJECTED', 'RBAC_BREAK_GLASS_SYSTEM_ADMIN_ONLY', 'Only the System Administrator may unseal identities');
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN');
  end if;

  if length(trim(coalesce(p_justification, ''))) < 25 then
    perform public.nosih_append_audit(p_actor_email, v_role, 'BREAK_GLASS_UNSEAL', 'IDENTITY_VAULT', p_vault_token,
      'REJECTED', 'JUSTIFICATION_TOO_SHORT', 'Break-glass justification must be at least 25 characters');
    return jsonb_build_object('success', false, 'error', 'JUSTIFICATION_TOO_SHORT');
  end if;

  select * into v_vault from public.identity_vault where vault_token = p_vault_token for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'VAULT_ENTRY_NOT_FOUND');
  end if;
  if v_vault.encrypted_identity_bytea is null then
    return jsonb_build_object('success', false, 'error', 'NO_PGP_BLOB', 'hint', 'This vault row predates the pgcrypto migration');
  end if;

  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'nosih_vault_secret' limit 1;
  if v_secret is null then
    return jsonb_build_object('success', false, 'error', 'VAULT_SECRET_MISSING');
  end if;

  v_identity := extensions.pgp_sym_decrypt(v_vault.encrypted_identity_bytea, v_secret)::jsonb;

  update public.identity_vault
     set unsealed_at = now(), unsealed_by_email = p_actor_email, unseal_reason = p_justification
   where id = v_vault.id;

  perform public.nosih_append_audit(p_actor_email, v_role, 'BREAK_GLASS_UNSEAL', 'IDENTITY_VAULT', p_vault_token,
    'BREAK_GLASS', 'BREAK_GLASS_POLICY_CLAUSE', p_justification,
    jsonb_build_object('entity_type', v_vault.target_entity_type, 'entity_id', v_vault.target_entity_id));

  return jsonb_build_object('success', true, 'identity', v_identity, 'vault_token', p_vault_token);
end;
$$;

grant execute on function public.rpc_rank_staff_for_work_order(integer) to authenticated;
grant execute on function public.rpc_assign_or_rebalance_staff(integer, text, text, text, boolean, text) to authenticated;
grant execute on function public.rpc_trigger_staff_shift_change(text, boolean, text) to authenticated;
grant execute on function public.rpc_reserve_parts_for_work_order(integer, jsonb, text, text) to authenticated;
grant execute on function public.rpc_decide_purchase_request(integer, text, integer, text, text, boolean, text, text) to authenticated;
grant execute on function public.rpc_receive_purchase_request_stock(integer, text) to authenticated;
grant execute on function public.rpc_break_glass_unseal_identity(text, text, text, text) to authenticated;
grant execute on function public.rpc_seal_identity_in_vault(text, integer, jsonb, text) to service_role;
grant execute on function public.rpc_verify_audit_chain() to authenticated;
