-- Costly repairs, parts consumption, space recompute, exam schedule, clock backfill.

-- 1. Costly repair approvals ------------------------------------------------
alter table public.work_orders add column if not exists estimated_cost_inr numeric not null default 0;

create table if not exists public.repair_approvals (
  id serial primary key,
  work_order_id integer not null references public.work_orders(id),
  estimated_cost_inr numeric not null,
  status text not null default 'PENDING',
  reason text,
  approved_by_user_id integer references public.users(id),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
alter table public.repair_approvals enable row level security;
drop policy if exists repair_approvals_read on public.repair_approvals;
create policy repair_approvals_read on public.repair_approvals
  for select to authenticated using (public.is_admin());

create or replace function public.rpc_approve_repair(
  p_work_order_id integer,
  p_approve boolean,
  p_reason text default null,
  p_actor_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.nosih_actor_role(p_actor_email);
  v_id integer := public.nosih_actor_id(p_actor_email);
  v_wo public.work_orders%rowtype;
  v_assigned_user integer;
begin
  if v_role is null or v_role not in ('FACILITIES_ADMIN', 'PROCUREMENT_APPROVER', 'SYSTEM_ADMIN') then
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN');
  end if;

  select * into v_wo from public.work_orders where id = p_work_order_id for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'WORK_ORDER_NOT_FOUND');
  end if;

  select sp.user_id into v_assigned_user
    from public.staff_profiles sp where sp.staff_code = v_wo.assigned_staff_code limit 1;
  if v_assigned_user is not null and v_assigned_user = v_id then
    return jsonb_build_object('success', false, 'error', 'SELF_APPROVAL_FORBIDDEN');
  end if;

  insert into public.repair_approvals (work_order_id, estimated_cost_inr, status, reason, approved_by_user_id, decided_at)
  values (v_wo.id, v_wo.estimated_cost_inr, case when p_approve then 'APPROVED' else 'REJECTED' end,
          nullif(trim(coalesce(p_reason, '')), ''), v_id, now());

  perform public.nosih_append_audit(p_actor_email, v_role, 'APPROVE_REPAIR', 'WORK_ORDER', v_wo.wo_number,
    case when p_approve then 'ALLOWED' else 'REJECTED' end,
    case when p_approve then 'REPAIR_APPROVED' else 'REPAIR_REJECTED' end,
    coalesce(p_reason, ''), jsonb_build_object('estimated_cost_inr', v_wo.estimated_cost_inr));

  return jsonb_build_object('success', true, 'status', case when p_approve then 'APPROVED' else 'REJECTED' end);
end;
$$;

-- 2. Completion: repair gate, parts consumption, twin recompute -------------
do $$
declare
  v_def text := pg_get_functiondef('public.rpc_complete_work_order(integer, text, text)'::regprocedure);
  v_guard text := $frag$  if v_wo.status not in ('ASSIGNED', 'IN_PROGRESS') then
    return jsonb_build_object('success', false, 'error', 'INVALID_TRANSITION', 'status', v_wo.status);
  end if;
$frag$;
  v_guard_after text := $frag$  if v_wo.status not in ('ASSIGNED', 'IN_PROGRESS') then
    return jsonb_build_object('success', false, 'error', 'INVALID_TRANSITION', 'status', v_wo.status);
  end if;

  if coalesce(v_wo.estimated_cost_inr, 0) > 25000 and not exists (
    select 1 from public.repair_approvals
     where work_order_id = v_wo.id and status = 'APPROVED'
  ) then
    return jsonb_build_object('success', false, 'error', 'REPAIR_APPROVAL_REQUIRED',
                              'estimated_cost_inr', v_wo.estimated_cost_inr);
  end if;
$frag$;
  v_parts text := $frag$  if v_wo.complaint_id is not null then
    update public.complaints set status = 'RESOLVED', updated_at = now() where id = v_wo.complaint_id;
  end if;
$frag$;
  v_parts_after text := $frag$  update public.inventory_items i
     set on_hand_qty = greatest(0, i.on_hand_qty - r.qty),
         reserved_qty = greatest(0, i.reserved_qty - r.qty)
    from (
      select sku_code, sum(quantity_reserved) as qty
        from public.part_reservations
       where work_order_id = v_wo.id and status = 'RESERVED'
       group by 1
    ) r
   where i.sku_code = r.sku_code;

  update public.part_reservations
     set status = 'CONSUMED'
   where work_order_id = v_wo.id and status = 'RESERVED';

  if v_wo.complaint_id is not null then
    update public.complaints set status = 'RESOLVED', updated_at = now() where id = v_wo.complaint_id;
  end if;
$frag$;
  v_rooms text := $frag$  update public.rooms set visual_state = 'HEALTHY' where code = v_wo.space_code;
  update public.labs set visual_state = 'HEALTHY' where code = v_wo.space_code;
$frag$;
  v_rooms_after text := $frag$  perform public.nosih_recompute_space_state(v_wo.space_code);
$frag$;
begin
  if position(v_guard in v_def) = 0 then
    raise exception 'completion guard anchor missing';
  end if;
  v_def := replace(v_def, v_guard, v_guard_after);
  v_def := replace(v_def, v_parts, v_parts_after);
  v_def := replace(v_def, v_rooms, v_rooms_after);
  execute v_def;
end;
$$;

-- 3. Exam schedule -----------------------------------------------------------
create table if not exists public.exams (
  id serial primary key,
  class_code text not null,
  space_code text not null,
  exam_date date not null,
  period_number integer not null,
  invigilator_staff_code text,
  created_at timestamptz not null default now(),
  constraint exams_unique_slot unique (space_code, exam_date, period_number)
);

insert into public.exams (class_code, space_code, exam_date, period_number)
select c.class_code, r.code, current_date + (1 + (c.rn % 3))::int, (1 + (c.rn % 3))::int
  from (select class_code, row_number() over (order by class_code) rn from public.student_classes limit 24) c
  join (select code, row_number() over (order by code) rn from public.rooms limit 24) r
    on r.rn = c.rn
on conflict do nothing;

-- 4. Backfill SLA clocks so every work order is tracked ----------------------
insert into public.sla_clocks (
  target_type, target_id, space_code, urgency, response_target_mins,
  resolution_target_mins, elapsed_active_mins, is_paused, breach_state,
  current_escalation_tier, last_tick_at
)
select 'WORK_ORDER', wo.id, wo.space_code, u.urgency,
       case u.urgency when 'LOW' then 240 when 'MEDIUM' then 120 when 'HIGH' then 30 else 10 end,
       case u.urgency when 'LOW' then 2880 when 'MEDIUM' then 1440 when 'HIGH' then 240 else 60 end,
       case when wo.status = 'COMPLETED'
            then round(case u.urgency when 'LOW' then 2880 when 'MEDIUM' then 1440 when 'HIGH' then 240 else 60 end * (0.55 + (wo.id % 40) / 100.0))
            else round(case u.urgency when 'LOW' then 2880 when 'MEDIUM' then 1440 when 'HIGH' then 240 else 60 end * (wo.id % 30) / 100.0)
       end,
       wo.status in ('COMPLETED', 'RESOLVED', 'CLOSED', 'CANCELLED'),
       'HEALTHY', 1, now()
  from public.work_orders wo
  left join public.complaints c on c.id = wo.complaint_id
  cross join lateral (select coalesce(c.urgency, 'MEDIUM') as urgency) u
 where not exists (
   select 1 from public.sla_clocks sc
    where sc.target_type = 'WORK_ORDER' and sc.target_id = wo.id
 );

grant execute on function public.rpc_approve_repair(integer, boolean, text, text) to authenticated;
