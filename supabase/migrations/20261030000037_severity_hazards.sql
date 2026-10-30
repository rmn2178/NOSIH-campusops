-- Severity refinement: water on electrics is a hazard, not a manageable fault.
--
-- The replayable water-leak scenario pools water over fans and flickering
-- lights; under the materiality rubric those assets are standard, so the room
-- fell back to manageable. Water meeting electrical fixtures (and flooding
-- generally) is a safety-adjacent incident: it stays MANAGEABLE-only if no
-- electrics are involved.

do $$
declare
  v_def text;
begin
  v_def := pg_get_functiondef('public.nosih_recompute_space_state(text)'::regprocedure);
  if position('nosih_severity_water' in v_def) = 0 then
    if position($old$or c.urgency = 'CRITICAL'$old$ in v_def) = 0 then
      raise exception 'recompute water anchor missing';
    end if;
    v_def := replace(v_def,
      $old$or c.urgency = 'CRITICAL'$old$,
      $new$or c.urgency = 'CRITICAL'
                  or (c.description ~* '(water|leak|flood)'
                      and c.description ~* '\m(fans?|lights?|electr\w*|sockets?|boards?|panels?|wiring)\M') -- nosih_severity_water$new$);
    execute v_def;
  end if;
end $$;

do $$
declare
  v_def text;
begin
  v_def := pg_get_functiondef('public.rpc_submit_complaint(jsonb)'::regprocedure);
  if position('nosih_severity_water_urgency' in v_def) = 0 then
    if position($old$-- nosih_severity_urgency$old$ in v_def) = 0 then
      raise exception 'intake urgency anchor missing';
    end if;
    v_def := replace(v_def,
      $old$-- nosih_severity_urgency$old$,
      $new$-- nosih_severity_urgency
      when v_description ~* '(water|leak|flood)'
       and v_description ~* '\m(fans?|lights?|electr\w*|sockets?|boards?|panels?|wiring)\M' then 'HIGH' -- nosih_severity_water_urgency$new$);
    v_def := replace(v_def,
      $old$else 'DEGRADED' end; -- nosih_severity_visual$old$,
      $new$when v_description ~* '(water|leak|flood)'
       and v_description ~* '\m(fans?|lights?|electr\w*|sockets?|boards?|panels?|wiring)\M' then 'FAULTY'
    else 'DEGRADED' end; -- nosih_severity_water_visual$new$);
    execute v_def;
  end if;
end $$;

-- Re-derive every space once with the hazard rule.
do $$
declare
  r record;
begin
  for r in
    select code from public.rooms
    union select code from public.labs
    union select code from public.canteens
  loop
    perform public.nosih_recompute_space_state(r.code);
  end loop;
end $$;

do $$
declare
  v_submit text := pg_get_functiondef('public.rpc_submit_complaint(jsonb)'::regprocedure);
  v_recompute text := pg_get_functiondef('public.nosih_recompute_space_state(text)'::regprocedure);
begin
  if position('nosih_severity_water_urgency' in v_submit) = 0
     or position('nosih_severity_water_visual' in v_submit) = 0
     or position('nosih_severity_water' in v_recompute) = 0 then
    raise exception 'water hazard patch incomplete';
  end if;
end $$;
