-- Surface the AI rewrite on the comment RPC.
--
-- rpc_post_comment asks the model to moderate every comment, but only kept the
-- status. A NEEDS_REWRITE verdict therefore inserted a hidden row and returned
-- no rewrite, so the portal could only say "held" instead of offering the
-- polite version the model produced. Carry the rewrite back to the caller.

do $$
declare
  v_def text;
begin
  v_def := pg_get_functiondef('public.rpc_post_comment(jsonb)'::regprocedure);
  if position('nosih_comment_rewrite' in v_def) = 0 then
    if position('v_token text;' in v_def) = 0 then
      raise exception 'comment declare anchor missing';
    end if;
    v_def := replace(v_def,
      'v_token text;',
      'v_token text;
  v_ai_rewrite text; -- nosih_comment_rewrite');

    if position($old$v_mod := coalesce(nullif(v_ai_mod->>'status', ''), 'APPROVED');$old$ in v_def) = 0 then
      raise exception 'comment AI anchor missing';
    end if;
    v_def := replace(v_def,
      $old$v_mod := coalesce(nullif(v_ai_mod->>'status', ''), 'APPROVED');$old$,
      $new$v_mod := coalesce(nullif(v_ai_mod->>'status', ''), 'APPROVED');
      v_ai_rewrite := nullif(v_ai_mod->>'rewrite', '');$new$);

    if position($old$'moderation_status', v_mod,$old$ in v_def) = 0 then
      raise exception 'comment return anchor missing';
    end if;
    v_def := replace(v_def,
      $old$'moderation_status', v_mod,$old$,
      $new$'moderation_status', v_mod,
    'suggested_polite_rewrite', v_ai_rewrite,$new$);

    execute v_def;
  end if;
end $$;

do $$
declare
  v_def text := pg_get_functiondef('public.rpc_post_comment(jsonb)'::regprocedure);
begin
  if position('nosih_comment_rewrite' in v_def) = 0
     or position('suggested_polite_rewrite' in v_def) = 0 then
    raise exception 'comment rewrite patch incomplete';
  end if;
end $$;
