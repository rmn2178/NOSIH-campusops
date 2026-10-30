-- Exact room codes must win over another room's zero-index alias.
-- Searching A1-02 previously opened A2-02 (which carries A1-02 as its alias),
-- and C4-03 opened C5-03. The complaint intake already prefers exact codes;
-- the inspector now does the same.

do $$
declare
  v_def text := pg_get_functiondef('public.rpc_get_space_twin_inspector(text)'::regprocedure);
  v_anchor text := $frag$   where lower(r.code) = v_input or lower(r.zero_index_alias) = v_input
   limit 1;$frag$;
  v_fixed text := $frag$   where lower(r.code) = v_input or lower(r.zero_index_alias) = v_input
   order by case when lower(r.code) = v_input then 0 else 1 end
   limit 1;$frag$;
begin
  if position('-- nosih_exact_room_code' in v_def) > 0 then
    return;
  end if;
  if position(v_anchor in v_def) = 0 then
    raise exception 'space inspector room lookup anchor missing';
  end if;
  v_def := replace(v_def, v_anchor,
    '   -- nosih_exact_room_code' || chr(10) || v_fixed);
  execute v_def;
end;
$$;
