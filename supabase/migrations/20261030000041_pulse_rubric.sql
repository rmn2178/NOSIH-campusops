-- Campus pulse: classify scripted faults deterministically.
--
-- Pulse injections are scripted demo content, but they were sent through the
-- live model like a free-text complaint. The model occasionally judged a dead
-- fan "space unusable" (CRITICAL) or widened the targets, so the same template
-- could flip from manageable orange to major red between runs. Each template
-- now carries its own category, urgency, skill and clearance, and the model is
-- skipped for SIMULATION rows. Real intake keeps the model.

do $$
declare
  v_def text;
begin
  v_def := pg_get_functiondef('public.nosih_ai_run_intake(integer, jsonb)'::regprocedure);
  if position('nosih_ai_skip_simulation' in v_def) = 0 then
    if position('  -- An Edge Function that already ran the model wins; do not analyse twice.' in v_def) = 0 then
      raise exception 'intake skip anchor missing';
    end if;
    v_def := replace(v_def,
      '  -- An Edge Function that already ran the model wins; do not analyse twice.',
      '  if coalesce(p_payload->>''source_channel'', '''') = ''SIMULATION'' then
    update public.complaints set ai_moderated = true, ai_status = ''SIMULATED'' where id = p_complaint_id;
    return jsonb_build_object(''success'', true, ''skipped'', ''simulation''); -- nosih_ai_skip_simulation
  end if;

  -- An Edge Function that already ran the model wins; do not analyse twice.');
    execute v_def;
  end if;
end $$;

do $$
declare
  v_def text;
  v_old text := $old$    'source_channel', 'SIMULATION',$old$;
  v_new text := $new$    'source_channel', 'SIMULATION',
    'category', case
      when v_template = 'ROOM_BOARD_BLACK' then 'IT_SMARTBOARD'
      when v_template = 'ROOM_FAN_STALLED' then 'FANS_HVAC'
      when v_template = 'ROOM_LED_DARK' then 'ELECTRICAL'
      when v_template = 'LAB_WS_NO_POWER' then 'LAB_EQUIPMENT'
      when v_template like 'CAN\_%' then 'CANTEEN_APPLIANCE'
      when v_template like 'BOT\_%' then 'BILL_BOT'
      else 'ELECTRICAL' end,
    'urgency', case
      when v_template in ('ROOM_FAN_STALLED', 'ROOM_LED_DARK')
        or v_template like 'BOT\_%' then 'MEDIUM'
      else 'HIGH' end,
    'required_skill', case
      when v_template = 'ROOM_FAN_STALLED' then 'HVAC'
      when v_template = 'ROOM_BOARD_BLACK' then 'IT_AV'
      when v_template = 'LAB_WS_NO_POWER' then 'LAB_SUPPORT'
      when v_template like 'BOT\_%' then 'IT_AV'
      else 'ELECTRICAL' end,
    'required_risk_clearance', case
      when v_template = 'ROOM_FAN_STALLED' or v_template like 'BOT\_%' then 'STANDARD'
      else 'HIGH_VOLTAGE' end, -- nosih_pulse_rubric$new$;
begin
  v_def := pg_get_functiondef('public.nosih_pulse_inject()'::regprocedure);
  if position('nosih_pulse_rubric' in v_def) = 0 then
    if position(v_old in v_def) = 0 then
      raise exception 'pulse payload anchor missing';
    end if;
    v_def := replace(v_def, v_old, v_new);
    execute v_def;
  end if;
end $$;

do $$
declare
  v_inject text := pg_get_functiondef('public.nosih_pulse_inject()'::regprocedure);
  v_intake text := pg_get_functiondef('public.nosih_ai_run_intake(integer, jsonb)'::regprocedure);
begin
  if position('nosih_pulse_rubric' in v_inject) = 0
     or position('nosih_ai_skip_simulation' in v_intake) = 0 then
    raise exception 'pulse rubric patch incomplete';
  end if;
end $$;
