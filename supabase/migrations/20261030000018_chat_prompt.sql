-- Chatbot fix: the prompt was truncated at 6,000 chars while the snapshot alone
-- was ~42,000, so the user's question (appended last) never reached the model.
-- 1. Compact the snapshot (drop verbose complaint/staff fields, cap rows).
-- 2. Put the question first, then conversation, then the snapshot.
-- 3. Raise the provider input cap and order history deterministically.
-- 4. Do not append to a conversation owned by another user.

create or replace function public.nosih_chat_context(p_portal text, p_space_code text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user_id bigint;
  v_role text;
  v_dept text;
  v_focus text := nullif(upper(coalesce(p_space_code, '')), '');
  v_ctx jsonb;
begin
  select u.id, u.role, u.department_code into v_user_id, v_role, v_dept
    from public.users u where u.auth_user_id = auth.uid() limit 1;

  select jsonb_build_object(
    'portal', upper(coalesce(p_portal, 'COMPLAINT')),
    'asked_by', jsonb_build_object('role', coalesce(v_role, 'STUDENT'), 'department', v_dept),
    'snapshot_at_ist', to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI'),
    'space_focus', v_focus,
    'campus_totals', jsonb_build_object(
      'rooms_faulty', (select count(*) from public.rooms where visual_state = 'FAULTY'),
      'rooms_degraded', (select count(*) from public.rooms where visual_state = 'DEGRADED'),
      'rooms_healthy', (select count(*) from public.rooms where visual_state = 'HEALTHY'),
      'labs_faulty', (select count(*) from public.labs where visual_state = 'FAULTY'),
      'canteens_faulty', (select count(*) from public.canteens where visual_state = 'FAULTY'),
      'bots_faulty', (select count(*) from public.bill_bots where visual_state = 'FAULTY'),
      'open_work_orders', (select count(*) from public.work_orders
                            where status in ('PENDING_ASSIGNMENT', 'ASSIGNED', 'IN_PROGRESS')),
      'active_incidents', (select count(*) from public.incidents where status not in ('RESOLVED', 'CLOSED')),
      'sla_breached', (select count(*) from public.sla_clocks
                        where breach_state in ('BREACHED', 'ESCALATED') and not is_paused),
      'staff_on_shift', (select count(*) from public.staff_profiles where is_on_shift and not is_on_leave)
    ),
    'unhealthy_spaces', coalesce((
      select jsonb_agg(jsonb_build_object('code', code, 'kind', kind, 'state', state) order by code)
        from (select code, 'ROOM' kind, visual_state state from public.rooms where visual_state <> 'HEALTHY'
              union all
              select code, 'LAB', visual_state from public.labs where visual_state <> 'HEALTHY'
              union all
              select code, 'CANTEEN', visual_state from public.canteens where visual_state <> 'HEALTHY'
              union all
              select code, 'BILL_BOT', visual_state from public.bill_bots where visual_state <> 'HEALTHY') s
       limit 40
    ), '[]'::jsonb),
    'focus_space', case when v_focus is null then null else
      coalesce((select jsonb_build_object('code', r.code, 'kind', 'ROOM', 'state', r.visual_state)
                  from public.rooms r where r.code = v_focus),
               (select jsonb_build_object('code', l.code, 'kind', 'LAB', 'state', l.visual_state, 'name', l.name)
                  from public.labs l where l.code = v_focus),
               (select jsonb_build_object('code', c.code, 'kind', 'CANTEEN', 'state', c.visual_state)
                  from public.canteens c where c.code = v_focus),
               (select jsonb_build_object('code', b.code, 'kind', 'BILL_BOT', 'state', b.visual_state,
                                          'queue', b.active_queue_count, 'paper_pct', b.paper_roll_pct)
                  from public.bill_bots b where b.code = v_focus))
      end,
    'focus_assets', coalesce((
      select jsonb_agg(jsonb_build_object('code', a.asset_code, 'type', a.asset_type, 'status', a.status)
                       order by a.asset_code)
        from public.assets a where a.parent_space_code = v_focus limit 24
    ), '[]'::jsonb),
    'active_incidents', coalesce((
      select jsonb_agg(jsonb_build_object(
               'number', incident_number, 'title', left(title, 90), 'severity', severity,
               'status', status, 'rooms', affected_rooms_csv,
               'summary', left(coalesce(ai_summary_text, ''), 180))
               order by incident_number)
        from (select * from public.incidents
               where status not in ('RESOLVED', 'CLOSED')
               order by incident_number limit 8) i
    ), '[]'::jsonb),
    'recent_complaints', coalesce((
      select jsonb_agg(jsonb_build_object(
               'ticket', ticket_number, 'space', space_code, 'title', left(title, 90),
               'category', category, 'urgency', urgency, 'status', status,
               'created', created_at::date)
               order by created_at desc)
        from (select * from public.complaints
               where moderation_status = 'APPROVED'
                 and (v_focus is null or space_code = v_focus)
               order by created_at desc limit 8) c
    ), '[]'::jsonb),
    'my_complaints', coalesce((
      select jsonb_agg(jsonb_build_object(
               'ticket', c.ticket_number, 'space', c.space_code, 'title', left(c.title, 80),
               'status', c.status, 'urgency', c.urgency,
               'work_order', (select wo.wo_number from public.work_orders wo
                               where wo.complaint_id = c.id order by wo.id desc limit 1),
               'sla_state', (select sc.breach_state from public.sla_clocks sc
                              where sc.target_type = 'COMPLAINT' and sc.target_id = c.id limit 1),
               'sla_minutes_left', (select greatest(0, sc.resolution_target_mins - round(sc.elapsed_active_mins)::int)
                                      from public.sla_clocks sc
                                     where sc.target_type = 'COMPLAINT' and sc.target_id = c.id limit 1))
               order by c.created_at desc)
        from (select * from public.complaints
               where reporter_user_id = v_user_id
               order by created_at desc limit 5) c
    ), '[]'::jsonb),
    'open_work_orders', coalesce((
      select jsonb_agg(jsonb_build_object(
               'number', wo.wo_number, 'space', wo.space_code, 'status', wo.status,
               'skill', wo.required_skill, 'risk', wo.required_risk_clearance,
               'priority', wo.priority_score, 'assigned', wo.assigned_staff_code,
               'sla_breach', (select sc.breach_state from public.sla_clocks sc
                               where sc.target_type = 'WORK_ORDER' and sc.target_id = wo.id limit 1),
               'sla_minutes_left', (select greatest(0, sc.resolution_target_mins - round(sc.elapsed_active_mins)::int)
                                      from public.sla_clocks sc
                                     where sc.target_type = 'WORK_ORDER' and sc.target_id = wo.id limit 1))
               order by wo.priority_score desc)
        from (select * from public.work_orders
               where status in ('PENDING_ASSIGNMENT', 'ASSIGNED', 'IN_PROGRESS')
                 and (v_focus is null or space_code = v_focus)
               order by priority_score desc limit 10) wo
    ), '[]'::jsonb),
    'staff_skill_counts', coalesce((
      select jsonb_object_agg(skill, n)
        from (select coalesce(primary_skill, 'UNSPECIFIED') skill, count(*) n
                from public.staff_profiles
               where is_on_shift and not is_on_leave
               group by coalesce(primary_skill, 'UNSPECIFIED')) s
    ), '{}'::jsonb),
    'staff_on_shift', coalesce((
      select jsonb_agg(jsonb_build_object(
               'code', staff_code, 'skill', primary_skill, 'clearance', risk_clearance,
               'location', left(coalesce(current_block_location, ''), 28),
               'active_jobs', current_active_jobs)
               order by staff_code)
        from (select * from public.staff_profiles
               where is_on_shift and not is_on_leave
               order by staff_code limit 10) s
    ), '[]'::jsonb)
  ) into v_ctx;

  return v_ctx;
end;
$$;

-- Raise the provider input caps. 6,000 chars cut the snapshot in half and
-- pushed the question past the limit entirely.
create or replace function public.nosih_grok_json(p_system text, p_user text, p_timeout_ms integer default 12000)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_body jsonb;
  v_content text;
  v_start integer;
  v_end integer;
begin
  v_body := public.nosih_llm_post(
    jsonb_build_object(
      'temperature', 0,
      'response_format', jsonb_build_object('type', 'json_object'),
      'messages', jsonb_build_array(
        jsonb_build_object('role', 'system', 'content', left(p_system, 8000)),
        jsonb_build_object('role', 'user', 'content', left(p_user, 24000))
      )
    ),
    p_timeout_ms
  );

  if v_body is null or v_body ? 'http_error' then
    return null;
  end if;

  v_content := v_body->'choices'->0->'message'->>'content';
  if v_content is null then
    return null;
  end if;

  v_start := position('{' in v_content);
  v_end := length(v_content) - position('}' in reverse(v_content)) + 1;
  if v_start < 1 or v_end <= v_start then
    return null;
  end if;

  begin
    return substring(v_content from v_start for (v_end - v_start + 1))::jsonb;
  exception when others then
    return null;
  end;
end;
$$;

create or replace function public.nosih_grok_text(p_system text, p_user text, p_timeout_ms integer default 12000)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_body jsonb;
begin
  v_body := public.nosih_llm_post(
    jsonb_build_object(
      'temperature', 0.4,
      'messages', jsonb_build_array(
        jsonb_build_object('role', 'system', 'content', left(p_system, 8000)),
        jsonb_build_object('role', 'user', 'content', left(p_user, 24000))
      )
    ),
    p_timeout_ms
  );

  if v_body is null or v_body ? 'http_error' then
    return null;
  end if;

  return nullif(trim(v_body->'choices'->0->'message'->>'content'), '');
end;
$$;

create or replace function public.rpc_ai_chat(
  p_messages jsonb,
  p_portal text default 'COMPLAINT',
  p_space_code text default null,
  p_conversation_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_conv uuid := coalesce(p_conversation_id, gen_random_uuid());
  v_ctx jsonb;
  v_history text;
  v_last_user text;
  v_prompt text;
  v_reply text;
  v_system text;
  v_role text;
  v_ai jsonb;
  v_engine text;
  v_lower text;
  v_items text;
begin
  if jsonb_typeof(p_messages) <> 'array' or jsonb_array_length(p_messages) = 0 then
    return jsonb_build_object('success', false, 'error', 'MESSAGES_REQUIRED');
  end if;

  select u.role into v_role
    from public.users u where u.auth_user_id = auth.uid() limit 1;
  if v_role is null then
    return jsonb_build_object('success', false, 'error', 'SIGN_IN_REQUIRED');
  end if;

  -- Never append to a conversation the caller does not own.
  if p_conversation_id is not null and not exists (
    select 1 from public.ai_chat_messages m
     where m.conversation_id = p_conversation_id and m.owner_id = auth.uid()
  ) then
    v_conv := gen_random_uuid();
  end if;

  select trim(m->>'content') into v_last_user
    from jsonb_array_elements(p_messages) with ordinality as t(m, ord)
   where lower(coalesce(m->>'role', 'user')) = 'user'
     and coalesce(trim(m->>'content'), '') <> ''
   order by ord desc
   limit 1;

  if v_last_user is null then
    return jsonb_build_object('success', false, 'error', 'EMPTY_MESSAGE');
  end if;

  v_ctx := public.nosih_chat_context(p_portal, p_space_code);

  select coalesce(string_agg(format('[%s] %s', upper(coalesce(recent.m->>'role', 'user')),
                                    left(recent.m->>'content', 500)), E'\n' order by recent.ord), '')
    into v_history
    from (select m, ord from jsonb_array_elements(p_messages) with ordinality as t(m, ord)
           order by ord desc limit 10) recent;

  v_prompt := format(
    'USER QUESTION (answer this directly):%s%s%sRECENT CONVERSATION (oldest first):%s%s%sLIVE TWIN SNAPSHOT (authoritative):%s%s%sAnswer the USER QUESTION from the snapshot.',
    E'\n', left(v_last_user, 2000), E'\n\n',
    E'\n', v_history, E'\n\n',
    E'\n', v_ctx::text, E'\n\n');

  v_system :=
    'You are the NOSIH campus assistant, the conversational face of a live digital twin of a university campus. '
    'The user turn starts with the USER QUESTION, then recent conversation, then a LIVE TWIN SNAPSHOT: the snapshot is the single source of truth. '
    'Answer only from it. Never invent room codes, tickets, work orders, staff names, timings or statuses that are not in the snapshot. '
    'If the snapshot lacks the answer, say so plainly and say what would be needed. '
    'Speak to the asker''s role: students get plain language about their space and ticket progress (use my_complaints for their own tickets); '
    'facility staff and admins get operational detail (skills, risk clearance, SLA minutes left, staffing). '
    'If the question reports an immediate hazard (sparks, smoke, fire, burning smell, shock, live wire), '
    'tell them to move away and file a SAFETY_FIRE complaint now so a qualified technician is dispatched. '
    'Be concise (max 120 words), factual and warm. No emoji, no markdown headings, no bullet symbols; use short sentences. '
    'Quote exact codes when you reference state. If a space shows HEALTHY, never call it faulty. '
    'Return JSON only: {"reply":"the answer","cited":["codes you referenced"]}.';

  begin
    v_ai := public.nosih_grok_json(v_system, v_prompt, 25000);
  exception when others then
    v_ai := null;
  end;

  v_reply := nullif(trim(coalesce(v_ai->>'reply', '')), '');
  v_engine := 'grok';

  if v_reply is null then
    begin
      v_reply := public.nosih_grok_text(v_system, v_prompt, 25000);
    exception when others then
      v_reply := null;
    end;
  end if;

  if v_reply is null then
    v_engine := 'twin_snapshot';
    v_lower := lower(v_last_user);

    if v_lower ~ '(unhealthy|faulty|fault|broken|not working|out of order)' then
      select string_agg(format('%s (%s)', e->>'code', lower(e->>'state')), ', ')
        into v_items
        from jsonb_array_elements(coalesce(v_ctx->'unhealthy_spaces', '[]'::jsonb)) e;
      v_reply := format(
        'The live model is busy, so here is the twin answer: %s unhealthy spaces — %s.',
        coalesce(jsonb_array_length(coalesce(v_ctx->'unhealthy_spaces', '[]'::jsonb))::text, '0'),
        coalesce(v_items, 'none right now'));
    elsif v_lower ~ '(work order|urgent|priority|assign|technician|repair)' then
      select string_agg(format('%s at %s (priority %s%s)', w->>'number', w->>'space', w->>'priority',
                               case when coalesce(w->>'assigned', '') = '' then ', unassigned'
                                    else ', ' || (w->>'assigned') end), '; ')
        into v_items
        from (select value w from jsonb_array_elements(coalesce(v_ctx->'open_work_orders', '[]'::jsonb))
               limit 3) t;
      v_reply := format(
        'The live model is busy, so here is the twin answer: %s open work orders. Most urgent: %s.',
        coalesce(v_ctx->'campus_totals'->>'open_work_orders', '0'), coalesce(v_items, 'none'));
    elsif v_lower ~ '(my complaint|my ticket|complaint|ticket|how long|sla|breach)' then
      select string_agg(format('%s at %s: %s%s', m->>'ticket', m->>'space', m->>'status',
                               case when coalesce(m->>'sla_minutes_left', '') = '' then ''
                                    else format(', %s min left', m->>'sla_minutes_left') end), '; ')
        into v_items
        from jsonb_array_elements(coalesce(v_ctx->'my_complaints', '[]'::jsonb)) m;
      v_reply := case when v_items is not null
        then format('The live model is busy, so here is the twin answer. Your complaints: %s.', v_items)
        else format('The live model is busy. You have no complaints on file. Campus: %s faulty rooms, %s open work orders.',
                    coalesce(v_ctx->'campus_totals'->>'rooms_faulty', '0'),
                    coalesce(v_ctx->'campus_totals'->>'open_work_orders', '0')) end;
    elsif v_lower ~ '(staff|shift|available|skill)' then
      v_reply := format(
        'The live model is busy, so here is the twin answer: %s staff on shift. By skill: %s.',
        coalesce(v_ctx->'campus_totals'->>'staff_on_shift', '0'),
        coalesce(v_ctx->'staff_skill_counts'::text, '{}'));
    elsif jsonb_typeof(v_ctx->'focus_space') = 'object' then
      v_reply := format(
        'The live model is busy, so here is the twin answer: %s is %s, with %s tracked assets.',
        v_ctx->'focus_space'->>'code', lower(v_ctx->'focus_space'->>'state'),
        coalesce(jsonb_array_length(coalesce(v_ctx->'focus_assets', '[]'::jsonb))::text, '0'));
    else
      v_reply := format(
        'The live model is busy, so here is the twin answer: %s faulty rooms, %s degraded rooms, %s open work orders, %s active incidents, %s staff on shift.',
        coalesce(v_ctx->'campus_totals'->>'rooms_faulty', '0'),
        coalesce(v_ctx->'campus_totals'->>'rooms_degraded', '0'),
        coalesce(v_ctx->'campus_totals'->>'open_work_orders', '0'),
        coalesce(v_ctx->'campus_totals'->>'active_incidents', '0'),
        coalesce(v_ctx->'campus_totals'->>'staff_on_shift', '0'));
    end if;
  end if;

  insert into public.ai_chat_messages (conversation_id, owner_id, author_role, portal, body, space_code)
  values (v_conv, auth.uid(), 'USER', upper(coalesce(p_portal, 'COMPLAINT')), left(v_last_user, 4000),
          nullif(upper(coalesce(p_space_code, '')), ''));

  insert into public.ai_chat_messages (conversation_id, owner_id, author_role, portal, body, space_code)
  values (v_conv, auth.uid(), 'ASSISTANT', upper(coalesce(p_portal, 'COMPLAINT')), left(v_reply, 8000),
          nullif(upper(coalesce(p_space_code, '')), ''));

  return jsonb_build_object(
    'success', true,
    'conversation_id', v_conv,
    'reply', v_reply,
    'cited', coalesce(v_ai->'cited', '[]'::jsonb),
    'engine', v_engine,
    'model', public.nosih_llm_model(),
    'asker_role', coalesce(v_role, 'STUDENT'),
    'snapshot', jsonb_build_object('campus_totals', v_ctx->'campus_totals', 'space_focus', v_ctx->'space_focus')
  );
end;
$$;
