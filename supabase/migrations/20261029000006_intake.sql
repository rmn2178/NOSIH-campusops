-- Complaint intake, serialization and feed RPCs.
-- AI enrichment happens in an Edge Function; this layer is deterministic and
-- transactional, and remains usable as a fallback if no LLM key is configured.

create or replace function public.nosih_complaint_json(
  c public.complaints,
  p_viewer_hash text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_assets jsonb;
  v_questions jsonb;
  v_answers jsonb;
  v_sla public.sla_clocks%rowtype;
  v_space_state text;
  v_department text;
  v_status text;
begin
  v_assets := case when c.ai_extracted_json ~ '^\s*\{'
    then coalesce((c.ai_extracted_json::jsonb)->'target_assets', '[]'::jsonb)
    else '[]'::jsonb end;
  v_questions := case when c.missing_info_questions_json ~ '^\s*\['
    then c.missing_info_questions_json::jsonb else '[]'::jsonb end;
  v_answers := case when c.missing_info_answers_json ~ '^\s*\{'
    then c.missing_info_answers_json::jsonb else '{}'::jsonb end;

  select * into v_sla from public.sla_clocks
   where target_type = 'WORK_ORDER'
     and target_id = (select id from public.work_orders where complaint_id = c.id order by id desc limit 1)
   limit 1;

  v_space_state := case c.space_type
    when 'ROOM' then (select visual_state from public.rooms where code = c.space_code limit 1)
    when 'LAB' then (select visual_state from public.labs where code = c.space_code limit 1)
    when 'CANTEEN' then (select visual_state from public.canteens where code = c.space_code limit 1)
    when 'BILL_BOT' then (select visual_state from public.bill_bots where code = c.space_code limit 1)
    else null end;

  select department_code into v_department
    from public.users where id = c.reporter_user_id and not c.is_anonymous
    limit 1;

  v_status := case when c.status = 'TRIAGED' then 'IN_PROGRESS' else c.status end;

  return jsonb_build_object(
    'id', c.id,
    'ticket_number', c.ticket_number,
    'space_code', c.space_code,
    'space_name', (select name from public.labs where code = c.space_code
                   union all select name from public.canteens where code = c.space_code
                   union all select name from public.bill_bots where code = c.space_code
                   limit 1),
    'space_kind', case c.space_type when 'ROOM' then 'CLASSROOM' else c.space_type end,
    'space_type', c.space_type,
    'building_code', c.building_code,
    'floor_number', c.floor_number,
    'title', c.title,
    'description', c.description,
    'category', coalesce(c.category, 'ELECTRICAL'),
    'urgency', c.urgency,
    'status', v_status,
    'twin_state', coalesce(v_space_state,
      case when c.status = 'RESOLVED' then 'HEALTHY'
           when c.status = 'BLOCKED_PARTS' then 'BLOCKED_PARTS'
           when c.urgency in ('HIGH', 'CRITICAL') then 'FAULTY'
           else 'DEGRADED' end),
    'reporter_label', c.public_reporter_label,
    'is_anonymous', c.is_anonymous,
    'reporter_department', v_department,
    'photo_url', c.image_url,
    'image_url', c.image_url,
    'target_assets', v_assets,
    'affected_count', c.affected_upvote_count,
    'viewer_has_voted',
      (p_viewer_hash is not null and exists (
        select 1 from public.complaint_votes v
         where v.complaint_id = c.id and v.voter_rate_limit_hash = p_viewer_hash)),
    'comment_count', (select count(*) from public.complaint_comments cc
                       where cc.complaint_id = c.id and cc.moderation_status = 'APPROVED'),
    'sla_target_minutes', coalesce(v_sla.resolution_target_mins,
      case c.urgency when 'LOW' then 2880 when 'MEDIUM' then 1440 when 'HIGH' then 240 else 60 end),
    'sla_due_at', case when v_sla.id is not null and not v_sla.is_paused
      then c.created_at + make_interval(mins => greatest(0, v_sla.resolution_target_mins - round(v_sla.elapsed_active_mins)::int))
      else null end,
    'sla_breach_state', v_sla.breach_state,
    'created_at', c.created_at,
    'updated_at', c.updated_at,
    'parent_complaint_id', c.parent_complaint_id,
    'parent_ticket_number', (select ticket_number from public.complaints pc where pc.id = c.parent_complaint_id limit 1),
    'linked_incident_id', c.linked_incident_id,
    'moderation_status', c.moderation_status,
    'missing_info_questions', v_questions,
    'missing_info_answers', v_answers,
    'first_response', jsonb_build_object(
      'space_code', c.space_code,
      'block_floor', case when c.floor_number is not null
        then coalesce(c.building_code, '') || ' / Floor ' || c.floor_number
        else c.building_code end,
      'target_assets', v_assets,
      'category', coalesce(c.category, 'ELECTRICAL'),
      'urgency', c.urgency,
      'sla_target_minutes', coalesce(v_sla.resolution_target_mins,
        case c.urgency when 'LOW' then 2880 when 'MEDIUM' then 1440 when 'HIGH' then 240 else 60 end),
      'missing_info_questions', v_questions,
      'merged_duplicate', c.parent_complaint_id is not null,
      'parent_complaint_id', c.parent_complaint_id,
      'parent_ticket_number', (select ticket_number from public.complaints pc where pc.id = c.parent_complaint_id limit 1),
      'affected_count', c.affected_upvote_count
    )
  );
end;
$$;

create or replace function public.rpc_submit_complaint(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user public.users%rowtype;
  v_email text;
  v_name text;
  v_role text;
  v_dept text;
  v_year integer;
  v_actor_id integer;
  v_description text;
  v_title text;
  v_is_anon boolean := coalesce((p_payload->>'is_anonymous')::boolean, false);
  v_input text;
  v_space_type text;
  v_space_code text;
  v_building text;
  v_floor integer;
  v_category text;
  v_urgency text;
  v_skill text;
  v_risk text;
  v_visual text;
  v_mod_status text;
  v_mod_reason text;
  v_target_assets jsonb := coalesce(p_payload->'target_assets', '[]'::jsonb);
  v_asset_codes jsonb := '[]'::jsonb;
  v_questions jsonb;
  v_ticket text;
  v_complaint_id integer;
  v_parent public.complaints%rowtype;
  v_merged boolean := false;
  v_label text;
  v_vault_token text;
  v_work_order_id integer;
  v_incident_id integer;
  v_board_id integer;
  v_board_code text;
  v_board_rooms integer;
  v_sla_response integer;
  v_sla_resolution integer;
  v_priority numeric;
  v_embedding extensions.vector(384);
  v_response jsonb;
begin
  -- Actor: the Auth session wins over the payload so a browser cannot spoof
  -- another user's identity when calling this RPC directly.
  select * into v_user from public.users where auth_user_id = auth.uid() limit 1;
  v_email := lower(coalesce(v_user.email, p_payload->>'email', ''));
  if v_email = '' then
    return jsonb_build_object('success', false, 'error', 'EMAIL_REQUIRED');
  end if;
  if v_user.id is null then
    select * into v_user from public.users where lower(email) = v_email limit 1;
  end if;
  if v_user.id is null then
    insert into public.users (email, full_name, role, department_code, year_number, is_active)
    values (
      v_email,
      coalesce(p_payload->>'full_name', initcap(replace(split_part(v_email, '@', 1), '.', ' '))),
      coalesce(p_payload->>'role', 'STUDENT'),
      nullif(p_payload->>'department_code', ''),
      nullif(p_payload->>'year_number', '')::integer,
      true
    ) returning * into v_user;
  end if;

  v_actor_id := v_user.id;
  v_name := v_user.full_name;
  v_role := v_user.role;
  v_dept := v_user.department_code;
  v_year := v_user.year_number;

  v_description := trim(coalesce(p_payload->>'description', ''));
  if length(v_description) < 5 then
    return jsonb_build_object('success', false, 'error', 'DESCRIPTION_TOO_SHORT');
  end if;
  v_title := coalesce(nullif(trim(p_payload->>'title'), ''), left(split_part(v_description, E'\n', 1), 80));

  v_input := upper(trim(coalesce(p_payload->>'space_code', '')));
  select 'ROOM', r.code, b.code, f.floor_number
    into v_space_type, v_space_code, v_building, v_floor
    from public.rooms r
    join public.buildings b on b.id = r.building_id
    join public.floors f on f.id = r.floor_id
   where upper(r.code) = v_input or upper(r.zero_index_alias) = v_input
   limit 1;

  if v_space_code is null then
    select 'LAB', l.code, b.code, db.floor_number
      into v_space_type, v_space_code, v_building, v_floor
      from public.labs l
      join public.distribution_boards db on db.id = l.distribution_board_id
      join public.buildings b on b.id = db.building_id
     where upper(l.code) = v_input
     limit 1;
  end if;
  if v_space_code is null then
    select 'CANTEEN', c.code, null, null into v_space_type, v_space_code, v_building, v_floor
      from public.canteens c where upper(c.code) = v_input limit 1;
  end if;
  if v_space_code is null then
    select 'BILL_BOT', b.code, 'COURTYARD', null into v_space_type, v_space_code, v_building, v_floor
      from public.bill_bots b where upper(b.code) = v_input limit 1;
  end if;
  if v_space_code is null then
    return jsonb_build_object('success', false, 'error', 'UNKNOWN_SPACE', 'space_code', p_payload->>'space_code');
  end if;

  -- Normalise target assets to codes that actually exist in this space.
  if jsonb_array_length(v_target_assets) > 0 then
    with requested as (
      select t->>'asset_code' as asset_code
        from jsonb_array_elements(v_target_assets) t
       where t ? 'asset_code'
      union
      select jsonb_array_elements_text(t->'asset_codes')
        from jsonb_array_elements(v_target_assets) t
       where t ? 'asset_codes'
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'asset_code', a.asset_code, 'asset_type', a.asset_type, 'slot_index', a.slot_index
           ) order by a.slot_index), '[]'::jsonb)
      into v_target_assets
      from public.assets a
      join requested r on r.asset_code = a.asset_code
     where a.parent_space_code = v_space_code;
  end if;

  if jsonb_array_length(v_target_assets) = 0 then
    if v_description ~* 'smart\s*board|projector|display|screen' then
      v_target_assets := v_target_assets || jsonb_build_object(
        'asset_type', 'SMART_BOARD',
        'asset_codes', jsonb_build_array('SB-' || v_space_code || '-01')
      );
    end if;
    if v_description ~* '\mfans?\M' then
      v_target_assets := v_target_assets || jsonb_build_object(
        'asset_type', 'CEILING_FAN',
        'asset_codes', (select jsonb_agg('FAN-' || v_space_code || '-' || lpad(i::text, 2, '0') order by i)
                          from generate_series(1, 4) i)
      );
    end if;
    if v_description ~* '\m(leds?|lights?|tube)\M' then
      v_target_assets := v_target_assets || jsonb_build_object(
        'asset_type', 'LED_LIGHT',
        'asset_codes', (select jsonb_agg('LED-' || v_space_code || '-' || lpad(i::text, 2, '0') order by i)
                          from generate_series(1, 4) i)
      );
    end if;
    with requested as (
      select jsonb_array_elements_text(t->'asset_codes') as asset_code
        from jsonb_array_elements(v_target_assets) t
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'asset_code', a.asset_code, 'asset_type', a.asset_type, 'slot_index', a.slot_index
           ) order by a.slot_index), '[]'::jsonb)
      into v_target_assets
      from public.assets a
      join requested r on r.asset_code = a.asset_code
     where a.parent_space_code = v_space_code;
  end if;

  select coalesce(jsonb_agg(t->>'asset_code'), '[]'::jsonb)
    into v_asset_codes
    from jsonb_array_elements(v_target_assets) t;

  -- Classification with a hard safety override.
  if v_description ~* 'spark|smoke|fire|burning|shock|short circuit|live wire' then
    v_category := 'SAFETY_FIRE';
    v_urgency := 'CRITICAL';
    v_skill := 'ELECTRICAL';
    v_risk := 'HIGH_VOLTAGE';
  else
    v_category := coalesce(nullif(p_payload->>'category', ''), case
      when v_space_type = 'BILL_BOT' then 'BILL_BOT'
      when v_description ~* 'bill\s*bot|printer|thermal|paper jam' then 'BILL_BOT'
      when v_description ~* 'stove|oven|fridge|refrigerator|coffee|warmer' then 'CANTEEN_APPLIANCE'
      when v_description ~* 'smart\s*board|projector|display' then 'IT_SMARTBOARD'
      when v_description ~* 'fan|ac\b|air conditioner|hvac' then 'FANS_HVAC'
      when v_description ~* 'water|leak|pipe|tap|drain' then 'PLUMBING'
      when v_description ~* 'desk|chair|door|furniture' then 'FURNITURE'
      when v_description ~* 'dirty|garbage|clean|waste' then 'CLEANLINESS'
      else 'ELECTRICAL' end);

    v_urgency := coalesce(nullif(p_payload->>'urgency', ''), case
      when v_description ~* 'not working at all|total failure|flooding' then 'HIGH'
      when jsonb_array_length(v_target_assets) > 1 then 'HIGH'
      else 'MEDIUM' end);

    v_skill := coalesce(nullif(p_payload->>'required_skill', ''), case v_category
      when 'BILL_BOT' then 'IT_AV'
      when 'CANTEEN_APPLIANCE' then 'ELECTRICAL'
      when 'IT_SMARTBOARD' then 'IT_AV'
      when 'FANS_HVAC' then 'HVAC'
      when 'LAB_EQUIPMENT' then 'LAB_SUPPORT'
      when 'PLUMBING' then 'PLUMBING'
      when 'FURNITURE' then 'CARPENTRY'
      when 'CLEANLINESS' then 'LAB_SUPPORT'
      else 'ELECTRICAL' end);

    v_risk := coalesce(nullif(p_payload->>'required_risk_clearance', ''), 'STANDARD');
    if v_risk = 'STANDARD' and v_category = 'ELECTRICAL' then
      v_risk := 'HIGH_VOLTAGE';
    end if;
  end if;

  v_visual := case when v_urgency in ('HIGH', 'CRITICAL') then 'FAULTY' else 'DEGRADED' end;
  v_mod_status := coalesce(nullif(p_payload->>'moderation_status', ''), 'APPROVED');
  v_mod_reason := p_payload->>'moderation_reason';

  v_questions := coalesce(p_payload->'missing_info_questions', '[]'::jsonb);
  if jsonb_array_length(v_questions) = 0 then
    v_questions := '[]'::jsonb;
    if v_description !~* '\mfans?\M' and v_target_assets @> '[{"asset_type":"CEILING_FAN"}]' then
      v_questions := v_questions || to_jsonb('Which fan numbers are affected?'::text);
    end if;
    if v_target_assets @> '[{"asset_type":"SMART_BOARD"}]' then
      v_questions := v_questions || to_jsonb('Is the Smart Board completely black, or flickering?'::text);
    end if;
    if v_description !~* 'spark|smoke|fire|burning|shock|short circuit' then
      v_questions := v_questions || to_jsonb('Is there any burning smell, smoke, sparking, or electric shock?'::text);
    end if;
  end if;

  -- Semantic/trigram duplicate detection for approved complaints.
  if v_mod_status = 'APPROVED' and p_payload ? 'embedding' then
    begin
      v_embedding := (p_payload->'embedding')::text::extensions.vector;
    exception when others then
      v_embedding := null;
    end;
  end if;

  if v_mod_status = 'APPROVED' then
    select * into v_parent
      from public.complaints c
     where c.space_code = v_space_code
       and c.moderation_status = 'APPROVED'
       and c.status in ('OPEN', 'TRIAGED', 'IN_PROGRESS', 'BLOCKED_PARTS')
       and c.created_at > now() - interval '24 hours'
       and (
         (v_embedding is not null and c.embedding is not null
           and (1 - (c.embedding <=> v_embedding)) > 0.82)
         or extensions.similarity(c.description, v_description) > 0.45
       )
     order by c.created_at desc
     limit 1;
    if found then
      v_merged := true;
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtext('nosih.tickets'));
  select 'CMP-2026-' || lpad((count(*) + 1)::text, 4, '0') into v_ticket from public.complaints;

  if v_merged then
    v_label := case when v_is_anon then 'Anonymous duplicate report' else v_name end;
  else
    v_label := case
      when v_is_anon and v_role = 'STUDENT'
        then 'Anonymous Student • ' || coalesce(v_dept, 'General') || ' (Year ' || coalesce(v_year, 1) || ')'
      when v_is_anon then 'Anonymous Faculty/Staff'
      else v_name end;
  end if;

  insert into public.complaints (
    ticket_number, space_type, space_code, building_code, floor_number, title, description,
    image_url, is_anonymous, reporter_user_id, public_reporter_label, moderation_status,
    moderation_reason, ai_extracted_json, missing_info_questions_json, missing_info_answers_json,
    category, urgency, status, parent_complaint_id, affected_upvote_count, source_channel,
    created_at, updated_at
  ) values (
    v_ticket, v_space_type, v_space_code, v_building, v_floor, v_title, v_description,
    p_payload->>'image_url', v_is_anon, case when v_is_anon then null else v_actor_id end,
    v_label, v_mod_status, v_mod_reason,
    jsonb_build_object(
      'target_assets', v_target_assets,
      'required_skill', v_skill,
      'required_risk_clearance', v_risk,
      'severity_indicators', '[]'::jsonb,
      'affects_active_class', v_description ~* '\m(class|students?|lecture|session)\M'
    )::text,
    v_questions::text, '{}',
    v_category, v_urgency,
    case when v_merged then 'MERGED_DUPLICATE'
         when v_mod_status = 'APPROVED' then 'OPEN'
         else 'HELD_MODERATION' end,
    v_parent.id, 1, coalesce(p_payload->>'source_channel', 'WEB_PORTAL'),
    now(), now()
  ) returning id into v_complaint_id;

  if v_is_anon then
    select (public.rpc_seal_identity_in_vault(
      'COMPLAINT', v_complaint_id,
      jsonb_build_object('email', v_email, 'full_name', v_name, 'role', v_role,
                         'department_code', v_dept, 'year_number', v_year),
      md5(v_email || ':' || v_complaint_id)
    )->>'vault_token') into v_vault_token;
    update public.complaints set vault_token = v_vault_token where id = v_complaint_id;
  end if;

  if v_merged then
    update public.complaints
       set affected_upvote_count = affected_upvote_count + 1,
           updated_at = now()
     where id = v_parent.id;

    insert into public.complaint_votes (complaint_id, voter_rate_limit_hash, created_at)
    values (v_parent.id, md5(coalesce(auth.uid()::text, v_email) || ':' || v_parent.id), now())
    on conflict (complaint_id, voter_rate_limit_hash) do nothing;
  elsif v_mod_status = 'APPROVED' then
    if v_space_type = 'ROOM' then
      update public.rooms set visual_state = v_visual where code = v_space_code;
    elsif v_space_type = 'LAB' then
      update public.labs set visual_state = v_visual where code = v_space_code;
    elsif v_space_type = 'CANTEEN' then
      update public.canteens set visual_state = v_visual where code = v_space_code;
    elsif v_space_type = 'BILL_BOT' then
      update public.bill_bots b
         set visual_state = 'FAULTY',
             active_queue_count = 0,
             rerouted_to_bot_code = coalesce(b.nearest_fallback_bot_code, b.rerouted_to_bot_code),
             paper_roll_pct = case when v_description ~* 'out of paper|paper low' then 0 else b.paper_roll_pct end
       where b.code = v_space_code;
      update public.bill_bots fb
         set active_queue_count = fb.active_queue_count + coalesce(
               (select b.active_queue_count from public.bill_bots b where b.code = v_space_code), 0)
       where fb.code = (select nearest_fallback_bot_code from public.bill_bots where code = v_space_code);
    end if;

    update public.assets a
       set status = 'FAULTY',
           failure_count_30d = a.failure_count_30d + 1
     where a.asset_code in (select jsonb_array_elements_text(v_asset_codes));

    -- Distribution-board correlation: two or more faulted rooms on one board.
    if v_space_type = 'ROOM' then
      select r.distribution_board_id, db.code into v_board_id, v_board_code
        from public.rooms r join public.distribution_boards db on db.id = r.distribution_board_id
       where r.code = v_space_code limit 1;

      select count(*) into v_board_rooms
        from public.rooms r2
       where r2.distribution_board_id = v_board_id
         and r2.visual_state in ('FAULTY', 'DEGRADED');

      if v_board_rooms >= 2 then
        select id into v_incident_id from public.incidents
         where root_cause_key = 'DB-' || v_board_code
           and status not in ('RESOLVED', 'CLOSED')
         limit 1;

        if v_incident_id is null then
          insert into public.incidents (
            incident_number, title, correlation_type, root_cause_key, severity, status,
            ai_summary_text, affected_rooms_csv, affected_classes_csv,
            total_students_impacted, chronic_replacement_advised, created_at
          )
          select
            'INC-2026-' || lpad(((select count(*) from public.incidents) + 1)::text, 4, '0'),
            'Distribution board fault: ' || v_board_code,
            'DISTRIBUTION_BOARD', 'DB-' || v_board_code, 'HIGH', 'ACTIVE',
            'Multiple rooms on ' || v_board_code || ' report faults in the same window; likely a shared electrical fault.',
            string_agg(r2.code, ','),
            coalesce(string_agg(sc.class_code, ','), ''),
            coalesce(sum(sc.student_strength), 0),
            false, now()
          from public.rooms r2
          left join public.student_classes sc on sc.home_room_code = r2.code
          where r2.distribution_board_id = v_board_id
            and r2.visual_state in ('FAULTY', 'DEGRADED')
          returning id into v_incident_id;
        end if;

        update public.complaints set linked_incident_id = v_incident_id where id = v_complaint_id;
      end if;
    end if;

    v_sla_response := case v_urgency when 'LOW' then 240 when 'MEDIUM' then 120 when 'HIGH' then 30 else 10 end;
    v_sla_resolution := case v_urgency when 'LOW' then 2880 when 'MEDIUM' then 1440 when 'HIGH' then 240 else 60 end;
    v_priority := case v_urgency when 'LOW' then 25 when 'MEDIUM' then 50 when 'HIGH' then 80 else 100 end;

    perform pg_advisory_xact_lock(hashtext('nosih.work_orders'));
    insert into public.work_orders (
      wo_number, incident_id, complaint_id, space_code, target_asset_codes_json,
      required_skill, required_risk_clearance, priority_score,
      assignment_score_breakdown_json, status, reassignment_count, created_at
    ) values (
      'WO-2026-' || lpad(((select count(*) from public.work_orders) + 1)::text, 4, '0'),
      v_incident_id, v_complaint_id, v_space_code, v_asset_codes::text,
      v_skill, v_risk, v_priority, '{}', 'PENDING_ASSIGNMENT', 0, now()
    ) returning id into v_work_order_id;

    insert into public.sla_clocks (
      target_type, target_id, space_code, urgency, response_target_mins,
      resolution_target_mins, elapsed_active_mins, is_paused, breach_state,
      current_escalation_tier, last_tick_at
    ) values (
      'WORK_ORDER', v_work_order_id, v_space_code, v_urgency, v_sla_response,
      v_sla_resolution, 0, false, 'HEALTHY', 1, now()
    );

    update public.complaints set status = 'TRIAGED', updated_at = now() where id = v_complaint_id;
  end if;

  select public.nosih_complaint_json(c, md5(coalesce(auth.uid()::text, v_email)))
    into v_response
    from public.complaints c where c.id = v_complaint_id;

  return jsonb_build_object(
    'success', true,
    'complaint', v_response,
    'first_response', v_response->'first_response',
    'moderation_status', v_mod_status,
    'suggested_rewrite', p_payload->>'suggested_rewrite'
  );
end;
$$;

create or replace function public.rpc_list_complaints(
  p_zone text default 'ALL',
  p_status text default null,
  p_category text default null,
  p_my_department boolean default false,
  p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_hash text;
  v_dept text;
  v_result jsonb;
begin
  v_hash := md5(coalesce(auth.uid()::text, 'anonymous'));
  select department_code into v_dept from public.users where auth_user_id = auth.uid() limit 1;

  select coalesce(jsonb_agg(public.nosih_complaint_json(c, v_hash) order by c.created_at desc), '[]'::jsonb)
    into v_result
    from public.complaints c
   where c.moderation_status = 'APPROVED'
     and (p_status is null or p_status = 'ALL' or
          case when p_status = 'IN_PROGRESS' then c.status in ('TRIAGED', 'IN_PROGRESS')
               else c.status = p_status end)
     and (p_category is null or p_category = '' or c.category = p_category)
     and (not p_my_department or v_dept is null or c.reporter_user_id in (
           select id from public.users where department_code = v_dept))
     and (p_zone is null or p_zone = 'ALL'
          or (p_zone = 'BLOCK_A' and c.building_code = 'A')
          or (p_zone = 'BLOCK_B' and c.building_code = 'B')
          or (p_zone = 'BLOCK_C' and c.building_code = 'C')
          or (p_zone = 'LABS' and c.space_type = 'LAB')
          or (p_zone = 'CANTEENS' and c.space_type = 'CANTEEN')
          or (p_zone = 'BILL_BOTS' and c.space_type = 'BILL_BOT'))
   limit least(200, greatest(1, coalesce(p_limit, 100)));

  return coalesce(v_result, '[]'::jsonb);
end;
$$;

create or replace function public.rpc_get_complaint(p_complaint_id integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_row public.complaints%rowtype;
  v_result jsonb;
  v_hash text := md5(coalesce(auth.uid()::text, 'anonymous'));
begin
  select * into v_row from public.complaints where id = p_complaint_id;
  if not found then
    return jsonb_build_object('error', 'COMPLAINT_NOT_FOUND');
  end if;
  if v_row.moderation_status <> 'APPROVED' and not public.is_admin() then
    return jsonb_build_object('error', 'COMPLAINT_NOT_FOUND');
  end if;

  v_result := public.nosih_complaint_json(v_row, v_hash);
  return v_result || jsonb_build_object(
    'comments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', cc.id, 'complaint_id', cc.complaint_id, 'body', cc.body,
        'author_label', cc.public_author_label,
        'public_author_label', cc.public_author_label,
        'is_anonymous', cc.is_anonymous, 'created_at', cc.created_at
      ) order by cc.created_at)
      from public.complaint_comments cc
      where cc.complaint_id = p_complaint_id and cc.moderation_status = 'APPROVED'
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.rpc_post_comment(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.users%rowtype;
  v_email text;
  v_complaint public.complaints%rowtype;
  v_body text := trim(coalesce(p_payload->>'body', ''));
  v_is_anon boolean := coalesce((p_payload->>'is_anonymous')::boolean, false);
  v_mod text := coalesce(nullif(p_payload->>'moderation_status', ''), 'APPROVED');
  v_label text;
  v_comment_id integer;
  v_token text;
begin
  select * into v_user from public.users where auth_user_id = auth.uid() limit 1;
  v_email := lower(coalesce(v_user.email, p_payload->>'email', ''));
  if v_user.id is null then
    select * into v_user from public.users where lower(email) = v_email limit 1;
  end if;
  if v_user.id is null then
    return jsonb_build_object('success', false, 'error', 'UNKNOWN_USER');
  end if;
  if length(v_body) < 2 then
    return jsonb_build_object('success', false, 'error', 'COMMENT_TOO_SHORT');
  end if;

  select * into v_complaint from public.complaints where id = (p_payload->>'complaint_id')::integer;
  if not found or v_complaint.moderation_status <> 'APPROVED' then
    return jsonb_build_object('success', false, 'error', 'COMPLAINT_NOT_FOUND');
  end if;

  v_label := case
    when v_is_anon and v_user.role = 'STUDENT'
      then 'Anonymous Student • ' || coalesce(v_user.department_code, 'General')
    when v_is_anon then 'Anonymous Faculty/Staff'
    else v_user.full_name end;

  insert into public.complaint_comments (
    complaint_id, body, is_anonymous, author_user_id, public_author_label,
    author_role_badge, moderation_status, created_at
  ) values (
    v_complaint.id, v_body, v_is_anon,
    case when v_is_anon then null else v_user.id end,
    v_label, v_user.role, v_mod, now()
  ) returning id into v_comment_id;

  if v_is_anon then
    select (public.rpc_seal_identity_in_vault(
      'COMMENT', v_comment_id,
      jsonb_build_object('email', v_email, 'full_name', v_user.full_name,
                         'role', v_user.role, 'department_code', v_user.department_code),
      md5(v_email || ':' || v_comment_id)
    )->>'vault_token') into v_token;
    update public.complaint_comments set vault_token = v_token where id = v_comment_id;
  end if;

  update public.complaints set updated_at = now() where id = v_complaint.id;

  return jsonb_build_object(
    'success', true,
    'moderation_status', v_mod,
    'comment', jsonb_build_object(
      'id', v_comment_id, 'complaint_id', v_complaint.id, 'body', v_body,
      'author_label', v_label, 'public_author_label', v_label,
      'is_anonymous', v_is_anon, 'created_at', now()
    )
  );
end;
$$;

create or replace function public.rpc_supplement_complaint(p_complaint_id integer, p_answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.complaints%rowtype;
  v_merged jsonb;
begin
  select * into v_row from public.complaints where id = p_complaint_id for update;
  if not found then
    return jsonb_build_object('error', 'COMPLAINT_NOT_FOUND');
  end if;

  v_merged := case when v_row.missing_info_answers_json ~ '^\s*\{'
    then v_row.missing_info_answers_json::jsonb else '{}'::jsonb end;
  v_merged := v_merged || coalesce(p_answers, '{}'::jsonb);

  update public.complaints
     set missing_info_answers_json = v_merged::text, updated_at = now()
   where id = p_complaint_id;

  select * into v_row from public.complaints where id = p_complaint_id;
  return public.nosih_complaint_json(v_row, md5(coalesce(auth.uid()::text, 'anonymous')));
end;
$$;

grant execute on function public.nosih_complaint_json(public.complaints, text) to anon, authenticated;
grant execute on function public.rpc_submit_complaint(jsonb) to anon, authenticated, service_role;
grant execute on function public.rpc_list_complaints(text, text, text, boolean, integer) to anon, authenticated;
grant execute on function public.rpc_get_complaint(integer) to anon, authenticated;
grant execute on function public.rpc_post_comment(jsonb) to anon, authenticated, service_role;
grant execute on function public.rpc_supplement_complaint(integer, jsonb) to anon, authenticated;
