-- Chat intake contract.
-- 1. Only a signed-in reporter can open a complaint from chat.
-- 2. Confirming without a resolvable room/lab is refused with suggestions.
-- 3. The draft category and urgency are carried into the real intake pipeline.
-- 4. The response names the ticket (or the duplicate it merged into) and the
--    work order created from it.

create or replace function public.rpc_chat_intake(
  p_messages jsonb,
  p_portal text default 'COMPLAINT',
  p_space_code text default null,
  p_confirm boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_email text := public.nosih_actor_email();
  v_text text;
  v_space text;
  v_space_type text;
  v_ai jsonb;
  v_result jsonb;
  v_urgency text;
  v_category text;
  v_home text;
  v_suggestions jsonb := '[]'::jsonb;
  v_complaint_id integer;
  v_ticket text;
  v_parent text;
  v_work_order text;
begin
  if v_email is null then
    return jsonb_build_object('success', false, 'error', 'SIGN_IN_REQUIRED');
  end if;

  select m->>'content' into v_text
    from jsonb_array_elements(p_messages) with ordinality as t(m, ord)
   where m->>'role' = 'user'
   order by ord desc
   limit 1;

  if v_text is null or length(trim(v_text)) < 4 then
    return jsonb_build_object('success', false, 'error', 'NO_MESSAGE');
  end if;

  v_ai := public.nosih_grok_json(
    'Extract a campus facilities fault from a chat message. Return JSON only with space_code, summary, category, urgency, missing_info_questions (max 2). Never invent a room code that is not stated.',
    v_text, 20000);

  v_space := coalesce(nullif(trim(coalesce(p_space_code, '')), ''), nullif(trim(coalesce(v_ai->>'space_code', '')), ''));
  v_urgency := upper(coalesce(nullif(v_ai->>'urgency', ''), 'MEDIUM'));
  if v_urgency not in ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL') then
    v_urgency := 'MEDIUM';
  end if;

  -- The model answers with free text ("Fan", "projector"); collapse it onto the
  -- canonical taxonomy so chat and form complaints are countable together.
  v_category := case
    when upper(coalesce(v_ai->>'category', '')) in
      ('SAFETY_FIRE', 'ELECTRICAL', 'FANS_HVAC', 'PLUMBING', 'FURNITURE',
       'CLEANLINESS', 'IT_SMARTBOARD', 'CANTEEN_APPLIANCE', 'BILL_BOT', 'OTHER')
      then upper(v_ai->>'category')
    when upper(coalesce(v_ai->>'category', '')) similar to '%(FAN|HVAC|AIR CONDITION|COOLING)%' then 'FANS_HVAC'
    when upper(coalesce(v_ai->>'category', '')) similar to '%(FIRE|SAFETY|SMOKE|SPARK|BURN|SHOCK)%' then 'SAFETY_FIRE'
    when upper(coalesce(v_ai->>'category', '')) similar to '%(PLUMB|WATER|LEAK|TAP|DRAIN|WASHROOM)%' then 'PLUMBING'
    when upper(coalesce(v_ai->>'category', '')) similar to '%(PROJECTOR|SMARTBOARD|DISPLAY|SCREEN|AV)%' then 'IT_SMARTBOARD'
    when upper(coalesce(v_ai->>'category', '')) similar to '%(FURNITURE|DESK|CHAIR|DOOR|WINDOW)%' then 'FURNITURE'
    when upper(coalesce(v_ai->>'category', '')) similar to '%(CLEAN|GARBAGE|WASTE|DIRT)%' then 'CLEANLINESS'
    when upper(coalesce(v_ai->>'category', '')) similar to '%(CANTEEN|STOVE|OVEN|FRIDGE|WARMER)%' then 'CANTEEN_APPLIANCE'
    when upper(coalesce(v_ai->>'category', '')) similar to '%(BILL|PRINTER|PAPER)%' then 'BILL_BOT'
    else 'OTHER'
  end;

  -- A spark, smoke or live-wire report is a safety incident regardless of what
  -- the model chose; the form pipeline applies the same hard override.
  if v_text ~* 'spark|smoke|fire|burning|shock|short\s*circuit|live\s*wire' then
    v_category := 'SAFETY_FIRE';
    v_urgency := 'CRITICAL';
  end if;

  if v_space is not null then
    select code into v_space from public.rooms where upper(code) = upper(v_space) limit 1;
    if found then
      v_space_type := 'ROOM';
    else
      select code into v_space from public.labs where upper(code) = upper(v_space) limit 1;
      if found then
        v_space_type := 'LAB';
      else
        v_space := null;
      end if;
    end if;
  end if;

  select sc.home_room_code into v_home
    from public.users u
    left join public.student_classes sc on sc.class_code = u.class_code
   where u.email = v_email
   limit 1;

  if v_space is null and v_home is not null then
    v_suggestions := v_suggestions || jsonb_build_array(
      jsonb_build_object('space_code', v_home, 'reason', 'YOUR_HOME_ROOM'));
  end if;

  if not p_confirm then
    return jsonb_build_object(
      'success', true, 'mode', 'DRAFT',
      'space_code', v_space, 'space_type', v_space_type,
      'category', v_category,
      'urgency', v_urgency,
      'summary', coalesce(nullif(v_ai->>'summary', ''), v_text),
      'questions', coalesce(v_ai->'missing_info_questions', '[]'::jsonb),
      'suggestions', v_suggestions);
  end if;

  if v_space is null then
    return jsonb_build_object('success', false, 'error', 'SPACE_REQUIRED',
                              'suggestions', v_suggestions);
  end if;

  v_result := public.rpc_submit_complaint(jsonb_build_object(
    'email', v_email,
    'is_anonymous', false,
    'space_code', v_space,
    'description', v_text,
    'category', v_category,
    'urgency', v_urgency,
    'source_channel', 'CHAT'));

  v_complaint_id := nullif(v_result #>> '{complaint,id}', '')::int;
  v_ticket := v_result #>> '{complaint,ticket_number}';
  v_parent := v_result #>> '{complaint,parent_ticket_number}';

  if v_complaint_id is not null then
    select wo_number into v_work_order
      from public.work_orders
     where complaint_id = v_complaint_id
     order by id desc
     limit 1;
  end if;

  return v_result || jsonb_build_object(
    'mode', 'CREATED',
    'ticket_number', v_ticket,
    'merged_into', v_parent,
    'work_order_number', v_work_order);
end;
$$;

grant execute on function public.rpc_chat_intake(jsonb, text, text, boolean) to authenticated;
