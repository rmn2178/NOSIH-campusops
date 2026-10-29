-- Chat intake must apply the same safety rule as the complaint pipeline.
do $$
declare
  v_def text := pg_get_functiondef('public.rpc_chat_intake(jsonb, text, text, boolean)'::regprocedure);
  v_before text := 'Extract a campus facilities fault from a chat message. Return JSON only with space_code, summary, category, urgency, missing_info_questions (max 2). Never invent a room code that is not stated.';
  v_after text := 'Extract a campus facilities fault from a chat message. Return JSON only with space_code, summary, category, urgency, missing_info_questions (max 2). Never invent a room code that is not stated. Any safety hazard (sparks, smoke, fire, burning smell, electric shock, live wire) is always category SAFETY_FIRE and urgency CRITICAL.';
begin
  if position(v_before in v_def) = 0 then
    raise exception 'chat prompt anchor not found';
  end if;
  execute replace(v_def, v_before, v_after);
end;
$$;
