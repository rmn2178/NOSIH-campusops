-- Exact room codes must win over zero-index aliases.
--
-- Every room carries a zero-index alias (A1-01 -> A0-01), so the alias of A2-01
-- is literally A1-01. The resolver matched either column with LIMIT 1, which
-- could bind a complaint to the neighbouring room. Prefer the exact code.

do $$
declare
  v_def text;
  v_old text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.rpc_submit_complaint(jsonb)'::regprocedure);
  if position('nosih_exact_code_first' in v_def) = 0 then
    v_old := '   where upper(r.code) = v_input or upper(r.zero_index_alias) = v_input' || E'\n   limit 1;';
    v_new := '   where upper(r.code) = v_input or upper(r.zero_index_alias) = v_input' || E'\n'
             || '   order by case when upper(r.code) = v_input then 0 else 1 end, r.code' || E'\n'
             || '   limit 1; -- nosih_exact_code_first';
    if position(v_old in v_def) = 0 then
      raise exception 'complaint space-resolution anchor not found';
    end if;
    execute replace(v_def, v_old, v_new);
  end if;
end
$$;
