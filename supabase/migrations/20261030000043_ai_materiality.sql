-- One colour rule: AI refines dispatch, materiality decides the twin.
--
-- nosih_apply_complaint_ai painted the space from the model's urgency, so a
-- working model could call a single dead fan "unusable" (CRITICAL) and turn it
-- red after the intake had already classified it manageable. Urgency is now
-- capped for faults that target only standard assets, and the twin is always
-- recomputed with the shared rubric instead of being painted directly.

do $$
declare
  v_def text;
  v_old text := $old$    if v_risk = 'STANDARD' and v_category = 'ELECTRICAL' then
      v_risk := 'HIGH_VOLTAGE';
    end if;
  end if;$old$;
  v_new text := $new$    if v_risk = 'STANDARD' and v_category = 'ELECTRICAL' then
      v_risk := 'HIGH_VOLTAGE';
    end if;
    -- A fault whose targets are all standard material is never CRITICAL;
    -- safety wording and critical assets keep their escalation. -- nosih_urgency_materiality
    if v_urgency = 'CRITICAL'
       and v_category <> 'SAFETY_FIRE'
       and not exists (
         select 1
           from jsonb_array_elements(coalesce(v_extracted->'target_assets', '[]'::jsonb)) t
          where public.nosih_asset_type_criticality(t->>'asset_type') = 'CRITICAL')
    then
      v_urgency := 'HIGH';
    end if;
  end if;$new$;
begin
  v_def := pg_get_functiondef('public.nosih_apply_complaint_ai(integer, jsonb)'::regprocedure);
  if position('nosih_urgency_materiality' in v_def) = 0 then
    if position(v_old in v_def) = 0 then
      raise exception 'AI urgency anchor missing';
    end if;
    v_def := replace(v_def, v_old, v_new);
    execute v_def;
  end if;
end $$;

do $$
declare
  v_def text;
  v_old text := $old$  else
    v_space_state := case when v_urgency in ('HIGH', 'CRITICAL') then 'FAULTY' else 'DEGRADED' end;
    if v_c.space_type = 'ROOM' then
      update public.rooms set visual_state = v_space_state where code = v_c.space_code;
    elsif v_c.space_type = 'LAB' then
      update public.labs set visual_state = v_space_state where code = v_c.space_code;
    elsif v_c.space_type = 'CANTEEN' then
      update public.canteens set visual_state = v_space_state where code = v_c.space_code;
    end if;
  end if;$old$;
  v_new text := $new$  else
    v_space_state := public.nosih_recompute_space_state(v_c.space_code); -- nosih_ai_colour_recompute
  end if;$new$;
begin
  v_def := pg_get_functiondef('public.nosih_apply_complaint_ai(integer, jsonb)'::regprocedure);
  if position('nosih_ai_colour_recompute' in v_def) = 0 then
    if position(v_old in v_def) = 0 then
      raise exception 'AI colour anchor missing';
    end if;
    v_def := replace(v_def, v_old, v_new);
    execute v_def;
  end if;
end $$;

do $$
declare
  v_def text := pg_get_functiondef('public.nosih_apply_complaint_ai(integer, jsonb)'::regprocedure);
begin
  if position('nosih_urgency_materiality' in v_def) = 0
     or position('nosih_ai_colour_recompute' in v_def) = 0 then
    raise exception 'AI materiality patch incomplete';
  end if;
end $$;
