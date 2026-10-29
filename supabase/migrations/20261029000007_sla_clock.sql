-- Campus clock + SLA escalation, invoked by Supabase Cron through the
-- sla-clock-tick Edge Function.

create or replace function public.rpc_tick_sla_clocks()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clock public.campus_clock_state%rowtype;
  v_sla public.sla_clocks%rowtype;
  v_delta numeric;
  v_ratio numeric;
  v_ticked integer := 0;
  v_warnings integer := 0;
  v_breaches integer := 0;
  v_notifications integer := 0;
  v_recipient text;
  v_tier_name text;
begin
  select * into v_clock from public.campus_clock_state where id = 1 for update;
  if found and v_clock.clock_mode <> 'PAUSED' then
    v_clock.period_elapsed_mins := v_clock.period_elapsed_mins + 1;
    if v_clock.period_elapsed_mins >= v_clock.period_duration_mins then
      v_clock.period_elapsed_mins := 0;
      if v_clock.active_period >= 6 then
        v_clock.active_period := 1;
        v_clock.active_day := case v_clock.active_day
          when 'MON' then 'TUE' when 'TUE' then 'WED' when 'WED' then 'THU'
          when 'THU' then 'FRI' else 'MON' end;
      else
        v_clock.active_period := v_clock.active_period + 1;
      end if;
    end if;
    update public.campus_clock_state
       set active_day = v_clock.active_day,
           active_period = v_clock.active_period,
           period_elapsed_mins = v_clock.period_elapsed_mins,
           updated_at = now()
     where id = 1;
  end if;

  for v_sla in select * from public.sla_clocks where not is_paused order by id for update loop
    v_delta := greatest(0, extract(epoch from (now() - v_sla.last_tick_at)) / 60.0);
    v_sla.elapsed_active_mins := v_sla.elapsed_active_mins + v_delta;
    v_sla.last_tick_at := now();
    v_ratio := v_sla.elapsed_active_mins / greatest(1, v_sla.resolution_target_mins);

    if v_ratio >= 1 and v_sla.breach_state <> 'BREACHED_100' then
      v_sla.breach_state := 'BREACHED_100';
      v_sla.current_escalation_tier := least(4, v_sla.current_escalation_tier + 1);
      v_breaches := v_breaches + 1;

      v_recipient := case v_sla.current_escalation_tier
        when 1 then 'maintenance@nosih.edu.in'
        when 2 then 'incident@nosih.edu.in'
        when 3 then 'facilities@nosih.edu.in'
        else 'principal@nosih.edu.in' end;
      v_tier_name := case v_sla.current_escalation_tier
        when 1 then 'Maintenance' when 2 then 'Incident Manager'
        when 3 then 'Facilities Admin' else 'Principal Office' end;

      insert into public.notification_logs (channel, recipient, subject, payload_json, delivery_status, created_at)
      values (
        'EMAIL', v_recipient,
        'SLA breached for ' || v_sla.target_type || ' ' || v_sla.target_id || ' - Tier ' || v_sla.current_escalation_tier,
        jsonb_build_object(
          'event', 'SLA_BREACHED_100', 'target_type', v_sla.target_type,
          'target_id', v_sla.target_id, 'space_code', v_sla.space_code,
          'urgency', v_sla.urgency, 'elapsed_active_mins', round(v_sla.elapsed_active_mins::numeric, 2),
          'resolution_target_mins', v_sla.resolution_target_mins,
          'escalation_tier', v_sla.current_escalation_tier, 'escalation_owner', v_tier_name
        )::text,
        'SENT', now()
      );
      v_notifications := v_notifications + 1;
    elsif v_ratio >= 0.75 and v_sla.breach_state not in ('WARNING_75', 'BREACHED_100') then
      v_sla.breach_state := 'WARNING_75';
      v_warnings := v_warnings + 1;
      insert into public.notification_logs (channel, recipient, subject, payload_json, delivery_status, created_at)
      values (
        'EMAIL', 'maintenance@nosih.edu.in',
        'SLA 75% warning for ' || v_sla.target_type || ' ' || v_sla.target_id,
        jsonb_build_object(
          'event', 'SLA_WARNING_75', 'target_type', v_sla.target_type,
          'target_id', v_sla.target_id, 'space_code', v_sla.space_code,
          'urgency', v_sla.urgency, 'elapsed_active_mins', round(v_sla.elapsed_active_mins::numeric, 2),
          'resolution_target_mins', v_sla.resolution_target_mins
        )::text,
        'SENT', now()
      );
      v_notifications := v_notifications + 1;
    elsif v_ratio < 0.75 then
      v_sla.breach_state := 'HEALTHY';
    end if;

    update public.sla_clocks
       set elapsed_active_mins = v_sla.elapsed_active_mins,
           last_tick_at = v_sla.last_tick_at,
           breach_state = v_sla.breach_state,
           current_escalation_tier = v_sla.current_escalation_tier
     where id = v_sla.id;

    v_ticked := v_ticked + 1;
  end loop;

  return jsonb_build_object(
    'ticked', v_ticked,
    'warnings', v_warnings,
    'breaches', v_breaches,
    'notifications_sent', v_notifications
  );
end;
$$;

grant execute on function public.rpc_tick_sla_clocks() to service_role;
