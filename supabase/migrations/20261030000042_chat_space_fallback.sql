-- Chat intake: resolve the room without the model, and cover every space kind.
--
-- A chat draft depended entirely on the model for space_code, so when the
-- provider was rate-limited (or offline) a message that plainly named B2-04
-- came back with no room and could not be filed. The explicit code in the
-- message now wins when the model returns nothing, and canteens and bill bots
-- validate like rooms and labs.

do $$
declare
  v_def text;
  v_old text := $old$  v_space := coalesce(nullif(trim(coalesce(p_space_code, '')), ''), nullif(trim(coalesce(v_ai->>'space_code', '')), ''));$old$;
  v_new text := $new$  v_space := coalesce(nullif(trim(coalesce(p_space_code, '')), ''), nullif(trim(coalesce(v_ai->>'space_code', '')), ''));

  -- The model is optional; parse an explicit code so a busy provider cannot
  -- drop the room from a message that names it. -- nosih_chat_space_parse
  if v_space is null then
    v_space := substring(upper(v_text) from '\m([ABC][1-7]-0[1-6]|LAB-[A-Z]+-[0-9]{2}|CAN-[0-9]{2}|BOT-[0-9]{2})\M');
  end if;$new$;
begin
  v_def := pg_get_functiondef('public.rpc_chat_intake(jsonb, text, text, boolean)'::regprocedure);
  if position('nosih_chat_space_parse' in v_def) = 0 then
    if position(v_old in v_def) = 0 then
      raise exception 'chat space anchor missing';
    end if;
    v_def := replace(v_def, v_old, v_new);
    execute v_def;
  end if;
end $$;

do $$
declare
  v_def text := pg_get_functiondef('public.rpc_chat_intake(jsonb, text, text, boolean)'::regprocedure);
  v_old text := $old$      select code into v_space from public.labs where upper(code) = upper(v_space) limit 1;
      if found then
        v_space_type := 'LAB';
      else
        v_space := null;
      end if;
    end if;
  end if;$old$;
  v_new text := $new$      select code into v_space from public.labs where upper(code) = upper(v_space) limit 1;
      if found then
        v_space_type := 'LAB';
      else
        select code into v_space from public.canteens where upper(code) = upper(v_space) limit 1;
        if found then
          v_space_type := 'CANTEEN';
        else
          select code into v_space from public.bill_bots where upper(code) = upper(v_space) limit 1;
          if found then
            v_space_type := 'BILL_BOT';
          else
            v_space := null;
          end if;
        end if;
      end if;
    end if;
  end if; -- nosih_chat_space_kinds$new$;
begin
  if position('nosih_chat_space_kinds' in v_def) = 0 then
    if position(v_old in v_def) = 0 then
      raise exception 'chat validation anchor missing';
    end if;
    v_def := replace(v_def, v_old, v_new);
    execute v_def;
  end if;
end $$;

do $$
declare
  v_def text := pg_get_functiondef('public.rpc_chat_intake(jsonb, text, text, boolean)'::regprocedure);
begin
  if position('nosih_chat_space_parse' in v_def) = 0
     or position('nosih_chat_space_kinds' in v_def) = 0 then
    raise exception 'chat space patch incomplete';
  end if;
end $$;
