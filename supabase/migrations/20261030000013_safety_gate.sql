-- Safety override must fire only for real electrical hazards, not for every
-- severity indicator. A plumbing leak carries severity ["water leak"] but is
-- not a SAFETY_FIRE incident.
do $$
declare
  v_def text := pg_get_functiondef('public.nosih_apply_complaint_ai(integer, jsonb)'::regprocedure);
  v_before text;
  v_after text;
begin
  v_before := $frag$  if coalesce(jsonb_array_length(v_severity), 0) > 0
     or upper(coalesce(p_ai->>'category', '')) = 'SAFETY_FIRE'
     or v_c.description ~* 'spark|smoke|fire|burning|shock|short circuit|live wire' then
$frag$;

  v_after := $frag$  if upper(coalesce(p_ai->>'category', '')) = 'SAFETY_FIRE'
     or v_c.description ~* 'spark|smoke|fire|burning|shock|short circuit|live wire'
     or exists (
       select 1 from jsonb_array_elements_text(coalesce(v_severity, '[]'::jsonb)) s
        where s ~* 'spark|smoke|fire|burning|electric shock|short circuit|live wire|arcing'
     ) then
$frag$;

  if position(v_before in v_def) = 0 then
    raise exception 'safety override anchor not found';
  end if;

  execute replace(v_def, v_before, v_after);
end;
$$;
