-- Active-clock analytics must exclude clocks closed by resolution, otherwise the
-- SLA workspace and the dashboard report finished work as still at risk.

do $$
declare
  v_def text;
  v_old text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.rpc_analytics_overview(integer)'::regprocedure);
  if position('nosih_active_clocks_only' in v_def) = 0 then
    v_old := '      from public.sla_clocks';
    v_new := '      from public.sla_clocks where closed_at is null -- nosih_active_clocks_only';
    if position(v_old in v_def) = 0 then
      raise exception 'analytics SLA anchor not found';
    end if;
    execute replace(v_def, v_old, v_new);
  end if;
end
$$;

-- Backfill clocks that were paused for finished work orders before closure existed.
update public.sla_clocks s
   set is_paused = true,
       closed_at = coalesce(s.closed_at, now()),
       closed_reason = coalesce(s.closed_reason, 'TARGET_RESOLVED')
 where s.closed_at is null
   and s.target_type = 'WORK_ORDER'
   and exists (
     select 1 from public.work_orders w
      where w.id = s.target_id and w.status in ('COMPLETED', 'CANCELLED', 'RESOLVED', 'CLOSED'));
