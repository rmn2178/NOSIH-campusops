-- Reopening a complaint must also reopen its work order, otherwise the tick's
-- defensive guard closes the clock again because the work order is finished.

do $$
declare
  v_def text;
  v_old text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.rpc_update_complaint_status(integer, text, text)'::regprocedure);
  if position('nosih_clock_follows_complaint_v2' in v_def) = 0 then
    v_old := '  elsif upper(p_status) in (''OPEN'', ''TRIAGED'', ''IN_PROGRESS'', ''BLOCKED_PARTS'') then' || E'\n'
      || '    update public.sla_clocks' || E'\n'
      || '       set is_paused = false, closed_at = null, closed_reason = null, last_tick_at = now()' || E'\n'
      || '     where target_type = ''WORK_ORDER'' and closed_at is not null and target_id in (' || E'\n'
      || '       select id from public.work_orders where complaint_id = v_row.id);' || E'\n'
      || '  end if; -- nosih_clock_follows_complaint';
    v_new := '  elsif upper(p_status) in (''OPEN'', ''TRIAGED'', ''IN_PROGRESS'', ''BLOCKED_PARTS'') then' || E'\n'
      || '    update public.work_orders' || E'\n'
      || '       set status = ''IN_PROGRESS'', completed_at = null' || E'\n'
      || '     where complaint_id = v_row.id and status in (''COMPLETED'', ''CANCELLED'');' || E'\n'
      || E'\n'
      || '    update public.sla_clocks' || E'\n'
      || '       set is_paused = false, closed_at = null, closed_reason = null, last_tick_at = now()' || E'\n'
      || '     where target_type = ''WORK_ORDER'' and closed_at is not null and target_id in (' || E'\n'
      || '       select id from public.work_orders where complaint_id = v_row.id);' || E'\n'
      || '  end if; -- nosih_clock_follows_complaint_v2';
    if position(v_old in v_def) = 0 then
      raise exception 'reopen block anchor not found';
    end if;
    execute replace(v_def, v_old, v_new);
  end if;
end
$$;
