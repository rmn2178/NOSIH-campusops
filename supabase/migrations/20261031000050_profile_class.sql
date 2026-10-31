-- Faculty identity in the portal: expose the class a member of staff is
-- attached to, so the room booking screen can pre-fill it the way it already
-- does for a student's own class.
do $$
declare
  v_def text;
  v_old text := $old$    'class_code', u.class_code, 'home_room_code', sc.home_room_code,$old$;
  v_new text := $new$    'class_code', u.class_code, 'assigned_class_code', sp.assigned_class_code,
    'home_room_code', sc.home_room_code,$new$;
begin
  v_def := pg_get_functiondef('public.rpc_my_profile()'::regprocedure);
  if position('assigned_class_code' in v_def) = 0 then
    if position(v_old in v_def) = 0 then
      raise exception 'profile class anchor missing';
    end if;
    v_def := replace(v_def, v_old, v_new);
    execute v_def;
  end if;
end $$;

do $$
declare
  v_def text;
begin
  v_def := pg_get_functiondef('public.rpc_my_profile()'::regprocedure);
  if position('assigned_class_code' in v_def) = 0 then
    raise exception 'profile class patch incomplete';
  end if;
end $$;
