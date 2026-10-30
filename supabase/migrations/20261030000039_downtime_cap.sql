-- Downtime realism: cap billed downtime at 24 hours.
--
-- Completing a work order stamps downtime as minutes since it was raised; a
-- seeded ticket raised months ago billed months of labour (₹23 lakh for one
-- fan). Repair downtime is now capped at 1,440 minutes, and the backlog rows
-- written earlier today are repriced under the same rule.

do $$
declare
  v_def text;
begin
  v_def := pg_get_functiondef('public.rpc_complete_work_order(integer, text, text)'::regprocedure);
  if position('nosih_downtime_cap' in v_def) = 0 then
    if position($old$v_downtime := greatest(0, extract(epoch from (now() - v_wo.created_at))::int / 60);$old$ in v_def) = 0 then
      raise exception 'completion downtime anchor missing';
    end if;
    v_def := replace(v_def,
      $old$v_downtime := greatest(0, extract(epoch from (now() - v_wo.created_at))::int / 60);$old$,
      $new$v_downtime := least(1440, greatest(0, extract(epoch from (now() - v_wo.created_at))::int / 60)); -- nosih_downtime_cap$new$);
    execute v_def;
  end if;
end $$;

update public.maintenance_history mh
   set downtime_mins = least(mh.downtime_mins, 1440),
       labour_cost_inr = round((least(mh.downtime_mins, 1440) / 60.0 * coalesce(sp.hourly_cost_inr, 0))::numeric, 2)
  from public.staff_profiles sp
 where sp.staff_code = mh.technician_code
   and mh.downtime_mins > 1440;

update public.maintenance_history
   set total_cost_inr = coalesce(parts_cost_inr, 0) + coalesce(labour_cost_inr, 0)
 where total_cost_inr is distinct from coalesce(parts_cost_inr, 0) + coalesce(labour_cost_inr, 0);
