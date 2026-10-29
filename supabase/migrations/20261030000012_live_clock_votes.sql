-- Complaint vote integrity + live campus clock + unattended SLA ticking.

-- 1. Reporter vote on new complaints; no double counting on duplicate merges.
do $$
declare
  v_def text := pg_get_functiondef('public.rpc_submit_complaint(jsonb)'::regprocedure);
  v_before text;
  v_after text;
begin
  if position('v_vote_inserted' in v_def) > 0 then
    raise notice 'rpc_submit_complaint already patched';
    return;
  end if;

  v_before := $frag$  if v_merged then
    update public.complaints
       set affected_upvote_count = affected_upvote_count + 1,
           updated_at = now()
     where id = v_parent.id;

    insert into public.complaint_votes (complaint_id, voter_rate_limit_hash, created_at)
    values (v_parent.id, md5(coalesce(auth.uid()::text, v_email) || ':' || v_parent.id), now())
    on conflict (complaint_id, voter_rate_limit_hash) do nothing;
  elsif v_mod_status = 'APPROVED' then
$frag$;

  v_after := $frag$  if v_merged then
    declare
      v_vote_inserted integer := 0;
    begin
      insert into public.complaint_votes (complaint_id, voter_rate_limit_hash, created_at)
      values (v_parent.id, md5(coalesce(auth.uid()::text, v_email) || ':' || v_parent.id), now())
      on conflict (complaint_id, voter_rate_limit_hash) do nothing;
      get diagnostics v_vote_inserted = row_count;

      if v_vote_inserted > 0 then
        update public.complaints
           set affected_upvote_count = affected_upvote_count + 1,
               updated_at = now()
         where id = v_parent.id;
      else
        update public.complaints set updated_at = now() where id = v_parent.id;
      end if;
    end;
  elsif v_mod_status = 'APPROVED' then
    insert into public.complaint_votes (complaint_id, voter_rate_limit_hash, created_at)
    values (v_complaint_id, md5(coalesce(auth.uid()::text, v_email) || ':' || v_complaint_id), now())
    on conflict (complaint_id, voter_rate_limit_hash) do nothing;

$frag$;

  if position(v_before in v_def) = 0 then
    raise exception 'rpc_submit_complaint anchor not found';
  end if;

  execute replace(v_def, v_before, v_after);
end;
$$;

-- 2. Live clock: derive the campus period from the real IST wall clock.
create or replace function public.nosih_clock_sync()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_local timestamp := (now() at time zone 'Asia/Kolkata');
  v_minutes integer := extract(hour from v_local) * 60 + extract(minute from v_local);
  v_dow integer := extract(isodow from v_local);
  v_day text;
  v_period integer;
  v_elapsed integer;
  v_mode text;
begin
  select clock_mode into v_mode from public.campus_clock_state where id = 1;
  if v_mode is distinct from 'LIVE' then
    return;
  end if;

  v_day := case v_dow when 1 then 'MON' when 2 then 'TUE' when 3 then 'WED' when 4 then 'THU' when 5 then 'FRI' else null end;
  if v_day is null then
    return; -- weekend: freeze the last teaching state
  end if;

  if v_minutes < 540 then
    v_period := 1; v_elapsed := 0;
  elsif v_minutes < 590 then
    v_period := 1; v_elapsed := v_minutes - 540;
  elsif v_minutes < 640 then
    v_period := 2; v_elapsed := v_minutes - 590;
  elsif v_minutes < 655 then
    v_period := 2; v_elapsed := 50;
  elsif v_minutes < 705 then
    v_period := 3; v_elapsed := v_minutes - 655;
  elsif v_minutes < 755 then
    v_period := 4; v_elapsed := v_minutes - 705;
  elsif v_minutes < 800 then
    v_period := 4; v_elapsed := 50;
  elsif v_minutes < 850 then
    v_period := 5; v_elapsed := v_minutes - 800;
  elsif v_minutes < 900 then
    v_period := 6; v_elapsed := v_minutes - 850;
  else
    v_period := 6; v_elapsed := 50;
  end if;

  update public.campus_clock_state
     set active_day = v_day,
         active_period = v_period,
         period_elapsed_mins = least(period_duration_mins, greatest(0, v_elapsed)),
         updated_at = now()
   where id = 1;
end;
$$;

create or replace function public.rpc_set_clock_mode(p_mode text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.current_app_role();
  v_mode text := upper(coalesce(p_mode, ''));
begin
  if v_role is null or v_role not in ('INCIDENT_MANAGER', 'FACILITIES_ADMIN', 'SYSTEM_ADMIN') then
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN');
  end if;
  if v_mode not in ('LIVE', 'MANUAL', 'PAUSED') then
    return jsonb_build_object('success', false, 'error', 'INVALID_MODE');
  end if;

  update public.campus_clock_state
     set clock_mode = v_mode, updated_at = now()
   where id = 1;

  if v_mode = 'LIVE' then
    perform public.nosih_clock_sync();
  end if;

  return (select jsonb_build_object(
    'success', true, 'clock_mode', clock_mode, 'day_of_week', active_day,
    'active_period', active_period, 'minutes_remaining', greatest(0, period_duration_mins - period_elapsed_mins))
    from public.campus_clock_state where id = 1);
end;
$$;

-- 3. Scrubbing the clock pins it to MANUAL until live mode is resumed.
create or replace function public.rpc_set_clock(p_day text, p_period integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.current_app_role();
begin
  if v_role is null or v_role not in ('INCIDENT_MANAGER', 'FACILITIES_ADMIN', 'SYSTEM_ADMIN') then
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN');
  end if;
  update public.campus_clock_state
     set active_day = upper(left(coalesce(p_day, active_day), 3)),
         active_period = least(6, greatest(1, coalesce(p_period, active_period))),
         period_elapsed_mins = 0,
         clock_mode = 'MANUAL',
         updated_at = now()
   where id = 1;
  return (select jsonb_build_object(
    'success', true, 'clock_mode', clock_mode,
    'day_of_week', active_day, 'active_period', active_period,
    'minutes_remaining', greatest(0, period_duration_mins - period_elapsed_mins))
    from public.campus_clock_state where id = 1);
end;
$$;

-- 4. SLA tick follows the live clock instead of counting its own increments.
create or replace function public.rpc_tick_sla_clocks()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
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
  perform public.nosih_clock_sync();

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

-- 5. Run the clock + SLA sweep every minute.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'nosih-clock-tick') then
    perform cron.unschedule('nosih-clock-tick');
  end if;
  perform cron.schedule('nosih-clock-tick', '* * * * *', 'select public.rpc_tick_sla_clocks()');
end;
$$;

grant execute on function public.rpc_tick_sla_clocks() to service_role;
grant execute on function public.rpc_set_clock_mode(text) to authenticated;
grant execute on function public.nosih_clock_sync() to service_role;
