-- Asset guard: AI-suggested assets are accepted only when the report actually
-- mentions that equipment. A water leak must not flag ceiling lights.
do $$
declare
  v_def text := pg_get_functiondef('public.nosih_apply_complaint_ai(integer, jsonb)'::regprocedure);
  v_before text := $frag$  -- Assets: keep only codes that really exist in this space.
  select coalesce(jsonb_agg(a.asset_code), '[]'::jsonb)
    into v_asset_codes
    from public.assets a
   where a.parent_space_code = v_c.space_code
     and a.asset_code in (
       select jsonb_array_elements_text(t->'asset_codes')
         from jsonb_array_elements(coalesce(p_ai->'target_assets', '[]'::jsonb)) t
        where jsonb_typeof(t->'asset_codes') = 'array'
     );
$frag$;
  v_after text := $frag$  -- Assets: keep only codes that exist in this space AND are named in the report.
  select coalesce(jsonb_agg(a.asset_code), '[]'::jsonb)
    into v_asset_codes
    from public.assets a
   where a.parent_space_code = v_c.space_code
     and a.asset_code in (
       select jsonb_array_elements_text(t->'asset_codes')
         from jsonb_array_elements(coalesce(p_ai->'target_assets', '[]'::jsonb)) t
        where jsonb_typeof(t->'asset_codes') = 'array'
     )
     and case
           when v_c.description ~* '\mfans?\M' then a.asset_type = 'CEILING_FAN'
           when v_c.description ~* '\m(leds?|lights?|tube)\M' then a.asset_type = 'LED_LIGHT'
           when v_c.description ~* 'smart\s*board|projector|display|screen' then a.asset_type = 'SMART_BOARD'
           when v_c.description ~* 'lab\s+(instrument|equipment)|oscilloscope|microscope' then a.asset_type = 'LAB_WORKSTATION'
           when v_c.description ~* 'stove|oven|fridge|refrigerator|coffee|warmer' then a.asset_type = 'CANTEEN_APPLIANCE'
           when v_c.description ~* 'bill\s*bot|printer|thermal|paper jam' then a.asset_type = 'BILL_BOT_MECHANISM'
           else false
         end;
$frag$;
begin
  if position(v_before in v_def) = 0 then
    raise exception 'asset guard anchor not found';
  end if;
  execute replace(v_def, v_before, v_after);
end;
$$;
