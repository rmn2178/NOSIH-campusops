-- Asset repair records: every maintenance row now carries parts, labour and a
-- total cost, and the twin can open the full service history for one asset.

alter table public.maintenance_history
  add column if not exists parts_cost_inr numeric not null default 0,
  add column if not exists labour_cost_inr numeric not null default 0,
  add column if not exists total_cost_inr numeric not null default 0;

create index if not exists maintenance_history_asset_idx
  on public.maintenance_history (asset_code, completed_at desc);

-- Fill costs on every new row. Parts are charged once per work order (to the
-- first asset row); labour follows the technician's hourly rate and downtime.
create or replace function public.nosih_fill_maintenance_costs()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wo_id integer;
  v_parts jsonb := '[]'::jsonb;
  v_parts_cost numeric := 0;
  v_rate numeric := 0;
  v_labour numeric := 0;
begin
  if new.parts_used_json is null or btrim(new.parts_used_json) = '' then
    new.parts_used_json := '[]';
  end if;

  select id into v_wo_id
    from public.work_orders
   where wo_number = new.work_order_number
   limit 1;

  if v_wo_id is not null and not exists (
    select 1 from public.maintenance_history
     where work_order_number = new.work_order_number
       and parts_cost_inr > 0
  ) then
    select coalesce(jsonb_agg(jsonb_build_object(
             'sku_code', p.sku_code, 'name', p.part_name,
             'qty', p.qty, 'unit_cost_inr', p.unit_cost_inr) order by p.sku_code), '[]'::jsonb),
           coalesce(sum(p.qty * p.unit_cost_inr), 0)
      into v_parts, v_parts_cost
      from (
        select i.sku_code, i.part_name, sum(r.quantity_reserved) as qty, i.unit_cost_inr
          from public.part_reservations r
          join public.inventory_items i on i.sku_code = r.sku_code
         where r.work_order_id = v_wo_id
         group by i.sku_code, i.part_name, i.unit_cost_inr
      ) p;

    if v_parts <> '[]'::jsonb then
      new.parts_used_json := v_parts::text;
    end if;
  end if;

  select coalesce(hourly_cost_inr, 0) into v_rate
    from public.staff_profiles
   where staff_code = new.technician_code
   limit 1;

  v_labour := round(coalesce(new.downtime_mins, 0) / 60.0 * coalesce(v_rate, 0), 2);

  if coalesce(new.parts_cost_inr, 0) = 0 then
    new.parts_cost_inr := v_parts_cost;
  end if;
  if coalesce(new.labour_cost_inr, 0) = 0 then
    new.labour_cost_inr := v_labour;
  end if;
  new.total_cost_inr := coalesce(new.parts_cost_inr, 0) + coalesce(new.labour_cost_inr, 0);
  return new;
end;
$$;

drop trigger if exists trg_maintenance_costs on public.maintenance_history;
create trigger trg_maintenance_costs
  before insert on public.maintenance_history
  for each row execute function public.nosih_fill_maintenance_costs();

-- Upgrade the seeded history so old repairs carry the same detail as new ones.
update public.maintenance_history m
   set action_taken = case m.fault_category
         when 'FANS_HVAC' then 'Replaced capacitor, balanced blades and verified all three speeds.'
         when 'ELECTRICAL' then 'Replaced LED driver, reseated the connector and load-tested the circuit.'
         when 'SMART_BOARD' then 'Swapped the power supply, updated firmware and recalibrated touch.'
         when 'PLUMBING' then 'Replaced washer, pressure-tested the line and dried the enclosure.'
         when 'FURNITURE' then 'Tightened the frame, replaced the fastener and load-tested the unit.'
         else 'Inspected, repaired and function-tested the asset.'
       end
 where m.action_taken = 'Inspected, repaired, and tested the asset';

update public.maintenance_history m
   set parts_used_json = jsonb_build_array(jsonb_build_object(
         'sku_code', a.sku_code, 'name', i.part_name, 'qty', 1,
         'unit_cost_inr', i.unit_cost_inr))::text,
       parts_cost_inr = i.unit_cost_inr,
       labour_cost_inr = round(m.downtime_mins / 60.0 *
         coalesce((select sp.hourly_cost_inr::numeric from public.staff_profiles sp
                    where sp.staff_code = m.technician_code limit 1), 400), 2),
       total_cost_inr = i.unit_cost_inr + round(m.downtime_mins / 60.0 *
         coalesce((select sp.hourly_cost_inr::numeric from public.staff_profiles sp
                    where sp.staff_code = m.technician_code limit 1), 400), 2)
  from public.assets a
  join public.inventory_items i on i.sku_code = a.sku_code
 where a.asset_code = m.asset_code
   and m.parts_cost_inr = 0
   and m.parts_used_json = '[]';

-- Full service record for one asset.
create or replace function public.rpc_get_asset_history(p_asset_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_asset public.assets%rowtype;
  v_kind text;
  v_space_name text;
  v_block text;
  v_floor integer;
  v_repairs integer := 0;
  v_downtime integer := 0;
  v_parts_spend numeric := 0;
  v_labour_spend numeric := 0;
  v_total_spend numeric := 0;
  v_avg_downtime integer := 0;
  v_last_repair timestamptz;
  v_days_since integer;
  v_age_days integer;
  v_health integer;
  v_history jsonb;
  v_parts jsonb;
  v_current jsonb;
  v_complaint_ticket text;
begin
  if not public.nosih_is_campus_reader() then
    return jsonb_build_object('error', 'FORBIDDEN');
  end if;

  select * into v_asset from public.assets where asset_code = p_asset_code;
  if not found then
    return jsonb_build_object('error', 'ASSET_NOT_FOUND');
  end if;

  select kind, space_name, block, floor
    into v_kind, v_space_name, v_block, v_floor
    from (
      select 'CLASSROOM' as kind, r.code as space_name, b.code as block, f.floor_number as floor
        from public.rooms r
        join public.buildings b on b.id = r.building_id
        join public.floors f on f.id = r.floor_id
       where r.code = v_asset.parent_space_code
      union all
      select 'LAB', l.code, b.code, db.floor_number
        from public.labs l
        join public.distribution_boards db on db.id = l.distribution_board_id
        join public.buildings b on b.id = db.building_id
       where l.code = v_asset.parent_space_code
      union all
      select 'CANTEEN', c.code, null::text, null::integer
        from public.canteens c where c.code = v_asset.parent_space_code
      union all
      select 'BILL_BOT', b.code, null::text, null::integer
        from public.bill_bots b where b.code = v_asset.parent_space_code
    ) s
   limit 1;

  select count(*),
         coalesce(sum(m.downtime_mins), 0)::integer,
         coalesce(sum(m.parts_cost_inr), 0),
         coalesce(sum(m.labour_cost_inr), 0),
         coalesce(sum(m.total_cost_inr), 0),
         coalesce(round(avg(m.downtime_mins)), 0)::integer,
         max(m.completed_at)
    into v_repairs, v_downtime, v_parts_spend, v_labour_spend, v_total_spend,
         v_avg_downtime, v_last_repair
    from public.maintenance_history m
   where m.asset_code = v_asset.asset_code;

  v_days_since := case when v_last_repair is null then null
                       else extract(day from now() - v_last_repair)::integer end;
  v_age_days := case when v_asset.installed_at is null then null
                     else extract(day from now() - v_asset.installed_at)::integer end;

  v_health := greatest(5, 100
    - coalesce(v_asset.failure_count_30d, 0) * 15
    - case v_asset.status when 'FAULTY' then 30 when 'DEGRADED' then 12 else 0 end
    - least(15, v_repairs * 3));

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id,
           'completed_at', m.completed_at,
           'work_order_number', m.work_order_number,
           'fault_category', m.fault_category,
           'action_taken', m.action_taken,
           'technician_code', m.technician_code,
           'technician_name', u.full_name,
           'technician_role', u.role,
           'downtime_mins', m.downtime_mins,
           'parts_cost_inr', m.parts_cost_inr,
           'labour_cost_inr', m.labour_cost_inr,
           'total_cost_inr', m.total_cost_inr,
           'parts', case when m.parts_used_json ~ '^\s*\['
                         then m.parts_used_json::jsonb else '[]'::jsonb end,
           'complaint_ticket', c.ticket_number,
           'complaint_title', c.title
         ) order by m.completed_at desc), '[]'::jsonb)
    into v_history
    from public.maintenance_history m
    left join public.staff_profiles sp on sp.staff_code = m.technician_code
    left join public.users u on u.id = sp.user_id
    left join public.work_orders w on w.wo_number = m.work_order_number
    left join public.complaints c on c.id = w.complaint_id
   where m.asset_code = v_asset.asset_code;

  select coalesce(jsonb_agg(jsonb_build_object(
           'sku_code', p.sku_code,
           'name', p.part_name,
           'quantity', p.quantity,
           'spend_inr', p.spend,
           'last_used_at', p.last_used) order by p.spend desc), '[]'::jsonb)
    into v_parts
    from (
      select x->>'sku_code' as sku_code,
             max(x->>'name') as part_name,
             sum(coalesce((x->>'qty')::numeric, 0)) as quantity,
             sum(coalesce((x->>'qty')::numeric, 0) * coalesce((x->>'unit_cost_inr')::numeric, 0)) as spend,
             max(m.completed_at) as last_used
        from public.maintenance_history m,
             jsonb_array_elements(
               case when m.parts_used_json ~ '^\s*\['
                    then m.parts_used_json::jsonb else '[]'::jsonb end) x
       where m.asset_code = v_asset.asset_code
       group by 1
    ) p;

  select jsonb_build_object(
           'wo_number', w.wo_number,
           'status', w.status,
           'priority_score', w.priority_score,
           'assigned_staff_code', w.assigned_staff_code,
           'technician_name', u.full_name,
           'created_at', w.created_at,
           'age_minutes', extract(epoch from now() - w.created_at)::integer / 60,
           'complaint_ticket', c.ticket_number,
           'complaint_title', c.title)
    into v_current
    from public.work_orders w
    left join public.staff_profiles sp on sp.staff_code = w.assigned_staff_code
    left join public.users u on u.id = sp.user_id
    left join public.complaints c on c.id = w.complaint_id
   where w.space_code = v_asset.parent_space_code
     and w.status not in ('COMPLETED', 'CLOSED', 'RESOLVED', 'CANCELLED')
     and w.target_asset_codes_json ~ '^\s*\['
     and (w.target_asset_codes_json::jsonb) ? v_asset.asset_code
   order by w.created_at desc
   limit 1;

  return jsonb_build_object(
    'asset', jsonb_build_object(
      'asset_code', v_asset.asset_code,
      'name', v_asset.name,
      'asset_type', v_asset.asset_type,
      'status', v_asset.status,
      'sku_code', v_asset.sku_code,
      'installed_at', v_asset.installed_at,
      'age_days', v_age_days,
      'failure_count_30d', coalesce(v_asset.failure_count_30d, 0),
      'space_code', v_asset.parent_space_code,
      'space_kind', v_kind,
      'space_name', v_space_name,
      'block', v_block,
      'floor', v_floor),
    'stats', jsonb_build_object(
      'repair_count', v_repairs,
      'total_downtime_mins', v_downtime,
      'total_parts_cost_inr', v_parts_spend,
      'total_labour_cost_inr', v_labour_spend,
      'total_cost_inr', v_total_spend,
      'avg_downtime_mins', v_avg_downtime,
      'last_repair_at', v_last_repair,
      'days_since_last_repair', v_days_since,
      'health_score', v_health,
      'health_label', case
        when v_asset.status = 'FAULTY' then 'CRITICAL'
        when v_asset.status = 'DEGRADED' or coalesce(v_asset.failure_count_30d, 0) >= 3 then 'WATCH'
        when v_repairs > 0 then 'SERVICED'
        else 'STABLE' end),
    'current_work_order', v_current,
    'history', v_history,
    'parts_summary', v_parts);
end;
$$;

revoke all on function public.rpc_get_asset_history(text) from public;
revoke execute on function public.rpc_get_asset_history(text) from anon;
grant execute on function public.rpc_get_asset_history(text) to authenticated;
