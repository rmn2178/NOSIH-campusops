-- Real AI inside the database — Grok only, no embeddings (by request).
-- Keys live in Supabase Vault; the browser never sees them.
--
--   * Intake runs the LLM synchronously inside the same transaction as the
--     complaint, so the row, its work order, SLA clock, assets, space
--     visual_state and any correlated incident are all written together:
--     after processing, the digital twin cannot disagree with the request.
--   * Comments are moderated by the LLM at insert time, word-list fallback.
--   * rpc_ai_chat answers from a live twin snapshot, so the assistant can
--     never contradict the campus state.
--   * If the provider is unreachable the deterministic result is kept and the
--     job is retried asynchronously through pg_net. Intake never fails.

alter table public.complaints
  add column if not exists ai_status text default null;

alter table public.complaints
  add column if not exists ai_moderated boolean not null default false;

alter table public.complaint_comments
  add column if not exists ai_moderated boolean not null default false;

alter table public.complaint_comments
  add column if not exists moderation_reason text;

create table if not exists public.ai_jobs (
  id bigint generated always as identity primary key,
  stage text not null,
  target_table text not null default 'COMPLAINT',
  target_id integer not null,
  status text not null default 'QUEUED',
  attempts integer not null default 0,
  request_id bigint,
  request_json jsonb not null default '{}'::jsonb,
  response_json jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.ai_jobs enable row level security;
alter table public.ai_jobs add column if not exists request_id bigint;
grant select on public.ai_jobs to authenticated;

create table if not exists public.ai_chat_messages (
  id bigint generated always as identity primary key,
  conversation_id uuid not null,
  owner_id uuid,
  author_role text not null default 'USER',
  portal text not null default 'COMPLAINT',
  body text not null,
  space_code text,
  created_at timestamptz not null default now()
);

alter table public.ai_chat_messages enable row level security;
alter table public.ai_chat_messages add column if not exists owner_id uuid;

-- Jobs left over from the earlier trigger-based design are meaningless now.
delete from public.ai_jobs where status = 'QUEUED' or request_id is null;

drop policy if exists nosih_chat_own_select on public.ai_chat_messages;
create policy nosih_chat_own_select on public.ai_chat_messages
  for select to authenticated
  using (owner_id = auth.uid());

drop policy if exists nosih_chat_own_insert on public.ai_chat_messages;
create policy nosih_chat_own_insert on public.ai_chat_messages
  for insert to authenticated
  with check (owner_id = auth.uid());

grant select, insert on public.ai_chat_messages to authenticated;
grant usage on sequence public.ai_chat_messages_id_seq to authenticated;

-- ---------------------------------------------------------------------------
-- Vault-backed secrets and provider resolution
-- ---------------------------------------------------------------------------

create or replace function public.nosih_ai_secret(p_name text)
returns text
language sql
stable
security definer
set search_path = public, vault, extensions
as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_name limit 1;
$$;

-- The stored key selects the provider: "gsk_..." is Groq (OpenAI-compatible),
-- anything else is treated as an x.ai Grok key. Both speak the same schema.
create or replace function public.nosih_llm_endpoint()
returns text
language sql
stable
security definer
set search_path = public, vault
as $$
  select case
    when public.nosih_ai_secret('xai_api_key') like 'gsk\_%'
      then 'https://api.groq.com/openai/v1/chat/completions'
    else 'https://api.x.ai/v1/chat/completions'
  end;
$$;

create or replace function public.nosih_llm_model()
returns text
language sql
stable
security definer
set search_path = public, vault
as $$
  select coalesce(
    nullif(public.nosih_ai_secret('llm_model'), ''),
    case
      when public.nosih_ai_secret('xai_api_key') like 'gsk\_%'
        then 'openai/gpt-oss-120b'
      else 'grok-4-fast'
    end);
$$;

create or replace function public.nosih_llm_headers()
returns jsonb
language sql
stable
security definer
set search_path = public, vault
as $$
  select jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || public.nosih_ai_secret('xai_api_key')
  );
$$;

-- One synchronous chat completion. Returns jsonb with either the parsed body or
-- {"http_error": status, "body": "..."}; null when no key or a transport fault.
create or replace function public.nosih_llm_post(p_payload jsonb, p_timeout_ms integer default 15000)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_key text := public.nosih_ai_secret('xai_api_key');
  v_resp extensions.http_response;
begin
  if v_key is null or v_key = '' then
    return null;
  end if;

  begin
    perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', greatest(1000, p_timeout_ms)::text);
  exception when others then
    null;
  end;

  begin
    select * into v_resp
      from extensions.http(
        row('POST', public.nosih_llm_endpoint(),
            array[
              extensions.http_header('Content-Type', 'application/json'),
              extensions.http_header('Authorization', 'Bearer ' || v_key)
            ],
            'application/json',
            (p_payload || jsonb_build_object('model', public.nosih_llm_model()))::text
        )::extensions.http_request
      );
  exception when others then
    begin
      perform extensions.http_reset_curlopt();
    exception when others then
      null;
    end;
    return null;
  end;

  begin
    perform extensions.http_reset_curlopt();
  exception when others then
    null;
  end;

  if v_resp.status is null or v_resp.status >= 300 then
    return jsonb_build_object('http_error', v_resp.status, 'body', left(coalesce(v_resp.content, ''), 400));
  end if;

  begin
    return v_resp.content::jsonb;
  exception when others then
    return null;
  end;
end;
$$;

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
        jsonb_build_object('role', 'system', 'content', left(p_system, 6000)),
        jsonb_build_object('role', 'user', 'content', left(p_user, 6000))
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
        jsonb_build_object('role', 'system', 'content', left(p_system, 6000)),
        jsonb_build_object('role', 'user', 'content', left(p_user, 12000))
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

-- ---------------------------------------------------------------------------
-- Moderation
-- ---------------------------------------------------------------------------

create or replace function public.nosih_word_moderation(p_text text)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
  v_lower text := lower(coalesce(p_text, ''));
begin
  if v_lower ~ '(kill|murder|attack|threaten|threat|acid|weapon|bomb)' then
    return jsonb_build_object('status', 'HELD_HARMFUL', 'reason', 'Threat or harmful content detected', 'rewrite', null);
  end if;
  if v_lower ~ '\m(idiot|stupid|useless|incompetent|moron|bastard|damn)\M' then
    return jsonb_build_object(
      'status', 'NEEDS_REWRITE',
      'reason', 'Personal attacks or abusive language detected',
      'rewrite', trim(regexp_replace(p_text, '\m(idiot|stupid|useless|incompetent|moron|bastard|damn)\M', '', 'gi'))
    );
  end if;
  return jsonb_build_object('status', 'APPROVED', 'reason', 'No policy violation detected', 'rewrite', null);
end;
$$;

create or replace function public.nosih_ai_moderate_text(p_text text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_ai jsonb;
  v_status text;
begin
  begin
    v_ai := public.nosih_grok_json(
      'You moderate a university campus facilities feed. Return JSON only: {"status":"APPROVED|NEEDS_REWRITE|HELD_ABUSIVE|HELD_HARMFUL","reason":"short reason","rewrite":"polite factual rewrite or null"}. Legitimate frustration about a broken facility is APPROVED. Personal insults are NEEDS_REWRITE with a factual rewrite that keeps every room code and asset detail. Threats, hate or self-harm content is HELD_HARMFUL. Obscene abuse with no factual content is HELD_ABUSIVE.',
      p_text,
      9000
    );
  exception when others then
    v_ai := null;
  end;

  v_status := upper(coalesce(v_ai->>'status', ''));
  if v_status in ('APPROVED', 'NEEDS_REWRITE', 'HELD_ABUSIVE', 'HELD_HARMFUL') then
    return jsonb_build_object(
      'status', v_status,
      'reason', coalesce(nullif(v_ai->>'reason', ''), 'Moderated by AI'),
      'rewrite', nullif(v_ai->>'rewrite', ''),
      'engine', 'llm'
    );
  end if;

  return public.nosih_word_moderation(p_text) || jsonb_build_object('engine', 'fallback');
end;
$$;

-- ---------------------------------------------------------------------------
-- Complaint analysis: one call, moderation + extraction + classification
-- ---------------------------------------------------------------------------

create or replace function public.nosih_ai_system_prompt()
returns text
language sql
immutable
set search_path = public
as $$
  select
    'You are NOSIH, the facilities AI of a university campus. Analyse one complaint and return STRICT JSON only, no markdown, with exactly these keys: '
    '{"moderation":{"status":"APPROVED|NEEDS_REWRITE|HELD_ABUSIVE|HELD_HARMFUL","reason":"short reason","rewrite":"polite factual rewrite or null"},'
    '"target_assets":[{"asset_type":"SMART_BOARD|CEILING_FAN|LED_LIGHT|LAB_WORKSTATION|CANTEEN_APPLIANCE|BILL_BOT_MECHANISM","asset_codes":["exact codes from the registered list"]}],'
    '"missing_info_questions":["max 3 short questions, empty array when nothing is missing"],'
    '"affects_active_class":true|false,'
    '"severity_indicators":["short phrases such as sparks, smoke, flooding"],'
    '"category":"ELECTRICAL|FANS_HVAC|PLUMBING|FURNITURE|CLEANLINESS|IT_SMARTBOARD|LAB_EQUIPMENT|CANTEEN_APPLIANCE|BILL_BOT|SAFETY_FIRE",'
    '"required_skill":"ELECTRICAL|HVAC|PLUMBING|CARPENTRY|IT_AV|LAB_SUPPORT",'
    '"required_risk_clearance":"STANDARD|HIGH_VOLTAGE",'
    '"urgency":"LOW|MEDIUM|HIGH|CRITICAL"}. '
    'Only use asset codes that appear in the registered list you are given; never invent codes. '
    'Any safety hazard (sparks, smoke, fire, burning smell, electric shock, live wire, flooding) forces category SAFETY_FIRE, urgency CRITICAL, required_risk_clearance HIGH_VOLTAGE. '
    'CRITICAL is reserved for safety hazards or a space that is unusable; HIGH for a fully failed asset that blocks classes; MEDIUM for partial failure; LOW for cosmetic issues. '
    'Only ask a missing-info question when the answer would genuinely change the repair.';
$$;

create or replace function public.nosih_ai_analyse_complaint(p_complaint_id integer)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row public.complaints%rowtype;
  v_assets text;
  v_ai jsonb;
begin
  select * into v_row from public.complaints where id = p_complaint_id;
  if not found then
    return null;
  end if;

  select coalesce(string_agg(asset_code || ' [' || asset_type || ']', ', '), 'none registered')
    into v_assets
    from (select asset_code, asset_type from public.assets
           where parent_space_code = v_row.space_code order by asset_code limit 40) a;

  v_ai := public.nosih_grok_json(
    public.nosih_ai_system_prompt(),
    format('Space: %s (%s).%sRegistered assets in this space: %s.%sComplaint title: %s%sComplaint text: %s',
      coalesce(v_row.space_code, 'unknown'), coalesce(v_row.space_type, 'unknown'), E'\n',
      v_assets, E'\n', coalesce(v_row.title, ''), E'\n', left(v_row.description, 1800)),
    15000
  );

  if v_ai is null or jsonb_typeof(v_ai) <> 'object' then
    return null;
  end if;

  return v_ai;
end;
$$;

-- ---------------------------------------------------------------------------
-- Twin-aligned application of AI results
-- ---------------------------------------------------------------------------

create or replace function public.nosih_recompute_space_state(p_space_code text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state text;
begin
  select case when count(*) filter (where c.urgency in ('HIGH', 'CRITICAL')) > 0 then 'FAULTY'
              when count(*) > 0 then 'DEGRADED'
              else 'HEALTHY' end
    into v_state
    from public.complaints c
   where c.space_code = p_space_code
     and c.moderation_status = 'APPROVED'
     and c.status in ('OPEN', 'TRIAGED', 'IN_PROGRESS', 'BLOCKED_PARTS');

  v_state := coalesce(v_state, 'HEALTHY');

  update public.rooms    set visual_state = v_state where code = p_space_code;
  update public.labs     set visual_state = v_state where code = p_space_code;
  update public.canteens set visual_state = v_state where code = p_space_code;

  return v_state;
end;
$$;

create or replace function public.nosih_hold_complaint(
  p_complaint_id integer, p_status text, p_reason text, p_rewrite text, p_actor_email text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_complaint public.complaints%rowtype;
  v_live boolean;
  v_codes jsonb := '[]'::jsonb;
begin
  select * into v_complaint from public.complaints where id = p_complaint_id for update;
  if not found then
    return;
  end if;

  v_live := v_complaint.moderation_status = 'APPROVED'
            and v_complaint.status in ('OPEN', 'TRIAGED', 'IN_PROGRESS', 'BLOCKED_PARTS');

  update public.complaints
     set moderation_status = p_status,
         moderation_reason = p_reason,
         suggested_rewrite = coalesce(p_rewrite, suggested_rewrite),
         status = case when v_live then 'HELD_MODERATION' else status end,
         ai_moderated = true,
         updated_at = now()
   where id = p_complaint_id;

  if not v_live then
    return;
  end if;

  update public.work_orders
     set status = 'CANCELLED'
   where complaint_id = p_complaint_id
     and status in ('PENDING_ASSIGNMENT', 'ASSIGNED');

  update public.sla_clocks sc
     set is_paused = true, breach_state = 'HEALTHY'
   where sc.target_type = 'WORK_ORDER'
     and sc.target_id in (select id from public.work_orders where complaint_id = p_complaint_id);

  if v_complaint.ai_extracted_json ~ '^\s*\{' then
    select coalesce(jsonb_agg(x->>'asset_code'), '[]'::jsonb)
      into v_codes
      from jsonb_array_elements(coalesce(v_complaint.ai_extracted_json::jsonb->'target_assets', '[]'::jsonb)) x
     where x ? 'asset_code';
  end if;

  update public.assets a
     set status = 'OPERATIONAL'
   where a.status = 'FAULTY'
     and a.asset_code in (select jsonb_array_elements_text(v_codes))
     and not exists (
       select 1 from public.work_orders wo2
        where wo2.status in ('PENDING_ASSIGNMENT', 'ASSIGNED', 'IN_PROGRESS')
          and wo2.target_asset_codes_json like '%' || a.asset_code || '%'
     );

  if v_complaint.space_type in ('ROOM', 'LAB', 'CANTEEN') then
    perform public.nosih_recompute_space_state(v_complaint.space_code);
  elsif v_complaint.space_type = 'BILL_BOT' then
    update public.bill_bots
       set visual_state = 'HEALTHY', rerouted_to_bot_code = null
     where code = v_complaint.space_code;
  end if;

  perform public.nosih_append_audit(
    coalesce(p_actor_email, 'ai@nosih.edu.in'), 'SYSTEM', 'AI_HOLD_COMPLAINT',
    'COMPLAINT', v_complaint.ticket_number, 'ALLOWED', 'AI_MODERATION', p_reason,
    jsonb_build_object('complaint_id', p_complaint_id, 'moderation_status', p_status));
end;
$$;

create or replace function public.nosih_apply_complaint_ai(p_complaint_id integer, p_ai jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_c public.complaints%rowtype;
  v_moderation jsonb := coalesce(p_ai->'moderation', '{}'::jsonb);
  v_mod_status text := upper(coalesce(v_moderation->>'status', 'APPROVED'));
  v_asset_codes jsonb := '[]'::jsonb;
  v_extracted jsonb;
  v_merged_assets jsonb;
  v_category text;
  v_urgency text;
  v_skill text;
  v_risk text;
  v_severity jsonb := coalesce(p_ai->'severity_indicators', '[]'::jsonb);
  v_questions jsonb := coalesce(p_ai->'missing_info_questions', '[]'::jsonb);
  v_priority integer;
  v_sla_response integer;
  v_sla_resolution integer;
  v_work_order_id integer;
  v_wo_status text;
  v_board_id integer;
  v_board_code text;
  v_board_rooms integer;
  v_incident_id integer;
  v_space_state text;
  v_changed boolean := false;
begin
  if jsonb_typeof(p_ai) <> 'object' then
    return jsonb_build_object('success', false, 'error', 'NO_AI_RESULT');
  end if;

  select * into v_c from public.complaints where id = p_complaint_id for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'COMPLAINT_NOT_FOUND');
  end if;

  if v_mod_status in ('HELD_ABUSIVE', 'HELD_HARMFUL') then
    perform public.nosih_hold_complaint(p_complaint_id, v_mod_status,
      coalesce(nullif(v_moderation->>'reason', ''), 'Held by AI moderation'),
      nullif(v_moderation->>'rewrite', ''));
    update public.complaints set ai_status = 'APPLIED' where id = p_complaint_id;
    return jsonb_build_object('success', true, 'held', true, 'moderation_status', v_mod_status);
  end if;

  if v_mod_status = 'NEEDS_REWRITE' then
    update public.complaints
       set moderation_status = 'NEEDS_REWRITE',
           moderation_reason = coalesce(nullif(v_moderation->>'reason', ''), 'Rewrite suggested by AI'),
           suggested_rewrite = coalesce(nullif(v_moderation->>'rewrite', ''), suggested_rewrite),
           ai_moderated = true,
           updated_at = now()
     where id = p_complaint_id;
  else
    update public.complaints
       set moderation_status = 'APPROVED',
           moderation_reason = coalesce(nullif(v_moderation->>'reason', ''), 'Approved by AI moderation'),
           ai_moderated = true,
           updated_at = now()
     where id = p_complaint_id;
  end if;

  v_extracted := case when v_c.ai_extracted_json ~ '^\s*\{' then v_c.ai_extracted_json::jsonb else '{}'::jsonb end;

  -- Merged / held / closed complaints are informational only: never touch the twin.
  if v_c.status in ('MERGED_DUPLICATE', 'HELD_MODERATION', 'RESOLVED', 'CLOSED', 'CANCELLED') then
    update public.complaints
       set ai_extracted_json = (v_extracted || jsonb_strip_nulls(jsonb_build_object(
             'ai_engine', public.nosih_llm_model(),
             'ai_category', nullif(upper(p_ai->>'category'), ''),
             'ai_urgency', nullif(upper(p_ai->>'urgency'), ''))))::text,
           ai_status = 'APPLIED',
           updated_at = now()
     where id = p_complaint_id;
    return jsonb_build_object('success', true, 'informational', true);
  end if;

  -- Assets: keep only codes that really exist in this space.
  select coalesce(jsonb_agg(a.asset_code), '[]'::jsonb)
    into v_asset_codes
    from public.assets a
   where a.parent_space_code = v_c.space_code
     and a.asset_code in (
       select jsonb_array_elements_text(t->'asset_codes')
         from jsonb_array_elements(coalesce(p_ai->'target_assets', '[]'::jsonb)) t
        where jsonb_typeof(t->'asset_codes') = 'array'
     );

  if jsonb_array_length(v_asset_codes) > 0 then
    with existing as (
      select x->>'asset_code' as code, x->>'asset_type' as type, coalesce((x->>'slot_index')::int, 0) as slot
        from jsonb_array_elements(coalesce(v_extracted->'target_assets', '[]'::jsonb)) x
       where x ? 'asset_code'
      union
      select code, a2.asset_type, coalesce(a2.slot_index, 0)
        from jsonb_array_elements_text(v_asset_codes) code
        join public.assets a2 on a2.asset_code = code
    )
    select coalesce(jsonb_agg(jsonb_build_object('asset_code', code, 'asset_type', type, 'slot_index', slot)
                              order by slot, code), '[]'::jsonb)
      into v_merged_assets
      from existing;

    v_extracted := jsonb_set(v_extracted, '{target_assets}', v_merged_assets);

    update public.assets a
       set status = 'FAULTY',
           failure_count_30d = a.failure_count_30d + 1
     where a.asset_code in (select jsonb_array_elements_text(v_asset_codes))
       and a.status <> 'FAULTY';

    update public.work_orders
       set target_asset_codes_json = (
             select coalesce(jsonb_agg(distinct e), '[]'::jsonb)::text
               from (select jsonb_array_elements_text(target_asset_codes_json::jsonb) e
                     union all
                     select jsonb_array_elements_text(v_asset_codes) e) u
           )
     where complaint_id = p_complaint_id
       and status in ('PENDING_ASSIGNMENT', 'ASSIGNED');

    v_changed := true;
  end if;

  if jsonb_typeof(v_questions) <> 'array' then
    v_questions := '[]'::jsonb;
  end if;
  if jsonb_typeof(v_severity) <> 'array' then
    v_severity := '[]'::jsonb;
  end if;

  v_extracted := v_extracted || jsonb_strip_nulls(jsonb_build_object(
    'ai_engine', public.nosih_llm_model(),
    'affects_active_class', p_ai->'affects_active_class',
    'severity_indicators', v_severity,
    'required_skill', nullif(upper(p_ai->>'required_skill'), ''),
    'required_risk_clearance', nullif(upper(p_ai->>'required_risk_clearance'), '')
  ));

  update public.complaints
     set ai_extracted_json = v_extracted::text,
         missing_info_questions_json = case when jsonb_array_length(v_questions) > 0
           then v_questions::text else missing_info_questions_json end,
         updated_at = now()
   where id = p_complaint_id;

  -- Classification: deterministic baseline, AI refinement, safety override last.
  v_category := v_c.category;
  v_urgency := v_c.urgency;
  v_skill := nullif(upper(p_ai->>'required_skill'), '');
  v_risk := coalesce(nullif(upper(p_ai->>'required_risk_clearance'), ''),
                     v_c.required_risk_clearance, 'STANDARD');

  if v_skill is null then
    select required_skill into v_skill from public.work_orders
     where complaint_id = p_complaint_id order by id desc limit 1;
  end if;

  if coalesce(jsonb_array_length(v_severity), 0) > 0
     or upper(coalesce(p_ai->>'category', '')) = 'SAFETY_FIRE'
     or v_c.description ~* 'spark|smoke|fire|burning|shock|short circuit|live wire' then
    v_category := 'SAFETY_FIRE';
    v_urgency := 'CRITICAL';
    v_skill := 'ELECTRICAL';
    v_risk := 'HIGH_VOLTAGE';
  else
    v_category := coalesce(nullif(upper(p_ai->>'category'), ''), v_category);
    v_urgency := coalesce(nullif(upper(p_ai->>'urgency'), ''), v_urgency);
    if v_risk = 'STANDARD' and v_category = 'ELECTRICAL' then
      v_risk := 'HIGH_VOLTAGE';
    end if;
  end if;

  if v_skill is null then
    v_skill := case v_category
      when 'BILL_BOT' then 'IT_AV' when 'CANTEEN_APPLIANCE' then 'ELECTRICAL'
      when 'IT_SMARTBOARD' then 'IT_AV' when 'FANS_HVAC' then 'HVAC'
      when 'LAB_EQUIPMENT' then 'LAB_SUPPORT' when 'PLUMBING' then 'PLUMBING'
      when 'FURNITURE' then 'CARPENTRY' when 'CLEANLINESS' then 'LAB_SUPPORT'
      else 'ELECTRICAL' end;
  end if;

  v_priority := case v_urgency when 'LOW' then 25 when 'MEDIUM' then 50 when 'HIGH' then 80 else 100 end;
  v_sla_response := case v_urgency when 'LOW' then 240 when 'MEDIUM' then 120 when 'HIGH' then 30 else 10 end;
  v_sla_resolution := case v_urgency when 'LOW' then 2880 when 'MEDIUM' then 1440 when 'HIGH' then 240 else 60 end;

  if v_category is distinct from v_c.category or v_urgency is distinct from v_c.urgency then
    v_changed := true;
  end if;

  update public.complaints
     set category = v_category,
         urgency = v_urgency,
         required_risk_clearance = v_risk,
         ai_status = 'APPLIED',
         updated_at = now()
   where id = p_complaint_id;

  select id, status into v_work_order_id, v_wo_status
    from public.work_orders where complaint_id = p_complaint_id order by id desc limit 1;

  if v_work_order_id is not null and v_wo_status in ('PENDING_ASSIGNMENT', 'ASSIGNED') then
    update public.work_orders
       set required_skill = v_skill,
           required_risk_clearance = v_risk,
           priority_score = v_priority
     where id = v_work_order_id;

    update public.sla_clocks
       set urgency = v_urgency,
           response_target_mins = v_sla_response,
           resolution_target_mins = v_sla_resolution
     where target_type = 'WORK_ORDER' and target_id = v_work_order_id;
  end if;

  -- Twin visual state always follows the processed urgency.
  if v_c.space_type = 'BILL_BOT' then
    update public.bill_bots set visual_state = 'FAULTY' where code = v_c.space_code;
    v_space_state := 'FAULTY';
  else
    v_space_state := case when v_urgency in ('HIGH', 'CRITICAL') then 'FAULTY' else 'DEGRADED' end;
    if v_c.space_type = 'ROOM' then
      update public.rooms set visual_state = v_space_state where code = v_c.space_code;
    elsif v_c.space_type = 'LAB' then
      update public.labs set visual_state = v_space_state where code = v_c.space_code;
    elsif v_c.space_type = 'CANTEEN' then
      update public.canteens set visual_state = v_space_state where code = v_c.space_code;
    end if;
  end if;

  -- Distribution-board correlation when the AI escalates a room.
  if v_c.space_type = 'ROOM' and v_urgency in ('HIGH', 'CRITICAL') then
    select r.distribution_board_id, db.code into v_board_id, v_board_code
      from public.rooms r join public.distribution_boards db on db.id = r.distribution_board_id
     where r.code = v_c.space_code limit 1;

    select count(*) into v_board_rooms
      from public.rooms r2
     where r2.distribution_board_id = v_board_id
       and r2.visual_state in ('FAULTY', 'DEGRADED');

    if v_board_rooms >= 2 then
      select id into v_incident_id from public.incidents
       where root_cause_key = 'DB-' || v_board_code and status not in ('RESOLVED', 'CLOSED')
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

      update public.work_orders set incident_id = v_incident_id
       where complaint_id = p_complaint_id and status in ('PENDING_ASSIGNMENT', 'ASSIGNED');
      update public.complaints set linked_incident_id = v_incident_id where id = p_complaint_id;
    end if;
  end if;

  if v_changed then
    perform public.nosih_append_audit(
      'ai@nosih.edu.in', 'SYSTEM', 'AI_ENRICH_COMPLAINT', 'COMPLAINT', v_c.ticket_number,
      'ALLOWED', 'AI_ENRICHMENT', 'Complaint re-aligned to the digital twin',
      jsonb_build_object('complaint_id', p_complaint_id, 'category', v_category,
                         'urgency', v_urgency, 'skill', v_skill, 'risk', v_risk,
                         'space_state', v_space_state));
  end if;

  return jsonb_build_object('success', true, 'category', v_category, 'urgency', v_urgency,
                            'skill', v_skill, 'risk', v_risk, 'assets', v_asset_codes,
                            'space_state', v_space_state, 'changed', v_changed);
end;
$$;

-- ---------------------------------------------------------------------------
-- Intake hook: analyse synchronously, queue an async retry when unreachable
-- ---------------------------------------------------------------------------

create or replace function public.nosih_ai_enqueue_complaint(p_complaint_id integer, p_job_id bigint default null)
returns bigint
language plpgsql
security definer
set search_path = public, extensions, net
as $$
declare
  v_row public.complaints%rowtype;
  v_assets text;
  v_system text;
  v_user text;
  v_job_id bigint := p_job_id;
  v_request_id bigint;
begin
  if public.nosih_ai_secret('xai_api_key') is null then
    return null;
  end if;

  select * into v_row from public.complaints where id = p_complaint_id;
  if not found then
    return null;
  end if;

  select coalesce(string_agg(asset_code || ' [' || asset_type || ']', ', '), 'none registered')
    into v_assets
    from (select asset_code, asset_type from public.assets
           where parent_space_code = v_row.space_code order by asset_code limit 40) a;

  v_system := public.nosih_ai_system_prompt();
  v_user := format('Space: %s (%s).%sRegistered assets in this space: %s.%sComplaint title: %s%sComplaint text: %s',
    coalesce(v_row.space_code, 'unknown'), coalesce(v_row.space_type, 'unknown'), E'\n',
    v_assets, E'\n', coalesce(v_row.title, ''), E'\n', left(v_row.description, 1800));

  if v_job_id is null then
    insert into public.ai_jobs (stage, target_table, target_id, status, attempts, request_json)
    values ('COMPLAINT_ENRICH', 'COMPLAINT', p_complaint_id, 'PENDING', 1,
            jsonb_build_object('system', v_system, 'user', v_user))
    returning id into v_job_id;
  else
    update public.ai_jobs
       set status = 'PENDING',
           attempts = attempts + 1,
           request_json = jsonb_build_object('system', v_system, 'user', v_user),
           error = null,
           updated_at = now()
     where id = v_job_id;
  end if;

  select net.http_post(
    url := public.nosih_llm_endpoint(),
    headers := public.nosih_llm_headers(),
    body := jsonb_build_object(
      'model', public.nosih_llm_model(),
      'temperature', 0,
      'response_format', jsonb_build_object('type', 'json_object'),
      'messages', jsonb_build_array(
        jsonb_build_object('role', 'system', 'content', v_system),
        jsonb_build_object('role', 'user', 'content', v_user)
      )
    ),
    timeout_milliseconds := 30000
  ) into v_request_id;

  update public.ai_jobs set request_id = v_request_id, updated_at = now() where id = v_job_id;
  return v_job_id;
end;
$$;

create or replace function public.nosih_ai_run_intake(p_complaint_id integer, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_ai jsonb;
  v_result jsonb;
  v_job_id bigint;
begin
  -- An Edge Function that already ran the model wins; do not analyse twice.
  if p_payload ? 'moderation_status' then
    update public.complaints
       set ai_moderated = true, ai_status = 'EDGE_FUNCTION'
     where id = p_complaint_id;
    return jsonb_build_object('success', true, 'skipped', 'edge_function');
  end if;

  update public.complaints set ai_status = 'PENDING' where id = p_complaint_id;

  begin
    v_ai := public.nosih_ai_analyse_complaint(p_complaint_id);
  exception when others then
    v_ai := null;
  end;

  if v_ai is not null then
    begin
      v_result := public.nosih_apply_complaint_ai(p_complaint_id, v_ai);
      return v_result || jsonb_build_object('engine', public.nosih_llm_model(), 'mode', 'sync');
    exception when others then
      perform public.nosih_append_audit(
        'ai@nosih.edu.in', 'SYSTEM', 'AI_APPLY_FAILED', 'COMPLAINT', p_complaint_id::text,
        'DENIED', 'AI_ENRICHMENT', sqlerrm, '{}'::jsonb);
    end;
  end if;

  -- Provider unreachable: keep the deterministic result, retry in background.
  begin
    select public.nosih_ai_enqueue_complaint(p_complaint_id) into v_job_id;
    update public.complaints set ai_status = 'QUEUED' where id = p_complaint_id;
  exception when others then
    update public.complaints set ai_status = 'FAILED' where id = p_complaint_id;
  end;

  return jsonb_build_object('success', true, 'mode', 'deferred', 'job_id', v_job_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Async retry path (pg_net responses are drained by cron, not a trigger,
-- because net._http_response is owned by supabase_admin)
-- ---------------------------------------------------------------------------

create or replace function public.nosih_ai_process_response(p_response_id bigint)
returns void
language plpgsql
security definer
set search_path = public, extensions, net
as $$
declare
  v_resp net._http_response%rowtype;
  v_job public.ai_jobs%rowtype;
  v_body jsonb;
  v_content text;
  v_start integer;
  v_end integer;
  v_parsed jsonb;
begin
  select * into v_resp from net._http_response where id = p_response_id;
  if not found then
    return;
  end if;

  select * into v_job from public.ai_jobs where request_id = p_response_id and status = 'PENDING';
  if not found then
    return;
  end if;

  if v_resp.status_code is not null and v_resp.status_code < 300 then
    begin
      v_body := v_resp.content::jsonb;
      v_content := v_body->'choices'->0->'message'->>'content';
    exception when others then
      v_content := null;
    end;

    if v_content is not null then
      v_start := position('{' in v_content);
      v_end := length(v_content) - position('}' in reverse(v_content)) + 1;
      if v_start >= 1 and v_end > v_start then
        begin
          v_parsed := substring(v_content from v_start for (v_end - v_start + 1))::jsonb;
        exception when others then
          v_parsed := null;
        end;
      end if;
    end if;
  end if;

  if v_parsed is not null then
    update public.ai_jobs
       set status = 'DONE', response_json = v_parsed, error = null, updated_at = now()
     where id = v_job.id;

    begin
      perform public.nosih_apply_complaint_ai(v_job.target_id, v_parsed);
    exception when others then
      perform public.nosih_append_audit(
        'ai@nosih.edu.in', 'SYSTEM', 'AI_APPLY_FAILED', 'COMPLAINT', v_job.target_id::text,
        'DENIED', 'AI_ENRICHMENT', sqlerrm, jsonb_build_object('job_id', v_job.id));
    end;

    update public.complaints set ai_status = 'APPLIED' where id = v_job.target_id;
    return;
  end if;

  update public.ai_jobs
     set status = 'FAILED',
         error = left(coalesce(v_resp.error_msg, 'http ' || coalesce(v_resp.status_code::text, 'unparseable')), 500),
         response_json = jsonb_build_object('status', v_resp.status_code, 'body', left(coalesce(v_resp.content, ''), 400)),
         updated_at = now()
   where id = v_job.id;

  if v_job.attempts < 3 then
    perform public.nosih_ai_enqueue_complaint(v_job.target_id, v_job.id);
  else
    update public.complaints
       set ai_status = 'FAILED', updated_at = now()
     where id = v_job.target_id and ai_status in ('PENDING', 'QUEUED');
    perform public.nosih_append_audit(
      'ai@nosih.edu.in', 'SYSTEM', 'AI_ENRICH_GAVE_UP', 'COMPLAINT', v_job.target_id::text,
      'DENIED', 'AI_ENRICHMENT', 'Deterministic classification kept',
      jsonb_build_object('job_id', v_job.id, 'error', v_job.error));
  end if;
end;
$$;

create or replace function public.nosih_ai_drain_responses()
returns integer
language plpgsql
security definer
set search_path = public, net
as $$
declare
  v_row record;
  v_done integer := 0;
begin
  for v_row in
    select r.id
      from net._http_response r
      join public.ai_jobs j on j.request_id = r.id and j.status = 'PENDING'
     where r.created > now() - interval '2 hours'
     order by r.id
  loop
    begin
      perform public.nosih_ai_process_response(v_row.id);
      v_done := v_done + 1;
    exception when others then
      null;
    end;
  end loop;

  return v_done;
end;
$$;

create or replace function public.nosih_ai_retry_stale()
returns void
language plpgsql
security definer
set search_path = public, net
as $$
declare
  v_job public.ai_jobs%rowtype;
begin
  for v_job in
    select j.* from public.ai_jobs j
     where j.status = 'PENDING'
       and j.updated_at < now() - interval '5 minutes'
       and j.attempts < 3
  loop
    begin
      perform public.nosih_ai_enqueue_complaint(v_job.target_id, v_job.id);
    exception when others then
      update public.ai_jobs set status = 'FAILED', error = left(sqlerrm, 500), updated_at = now()
       where id = v_job.id;
    end;
  end loop;

  update public.ai_jobs set status = 'FAILED', error = 'abandoned', updated_at = now()
   where status = 'PENDING' and attempts >= 3 and updated_at < now() - interval '30 minutes';

  update public.complaints c
     set ai_status = 'FAILED'
   where c.ai_status in ('PENDING', 'QUEUED')
     and c.updated_at < now() - interval '30 minutes'
     and not exists (select 1 from public.ai_jobs j
                      where j.target_id = c.id and j.status in ('QUEUED', 'PENDING'));

  delete from public.ai_jobs
   where created_at < now() - interval '7 days' and status in ('DONE', 'FAILED');
end;
$$;

create or replace function public.nosih_ai_maintenance()
returns jsonb
language plpgsql
security definer
set search_path = public, net
as $$
declare
  v_drained integer;
begin
  v_drained := public.nosih_ai_drain_responses();
  perform public.nosih_ai_retry_stale();
  return jsonb_build_object('drained', v_drained, 'at', now());
end;
$$;

select cron.schedule(
  'nosih-ai-maintenance',
  '* * * * *',
  $$select public.nosih_ai_maintenance()$$
);

-- ---------------------------------------------------------------------------
-- Twin-aware chatbot
-- ---------------------------------------------------------------------------

create or replace function public.nosih_chat_context(p_portal text, p_space_code text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_email text;
  v_role text;
  v_dept text;
  v_focus text := nullif(upper(coalesce(p_space_code, '')), '');
  v_ctx jsonb;
begin
  select lower(u.email), u.role, u.department_code into v_email, v_role, v_dept
    from public.users u where u.auth_user_id = auth.uid() limit 1;

  select jsonb_build_object(
    'portal', upper(coalesce(p_portal, 'COMPLAINT')),
    'asked_by', jsonb_build_object('email', v_email, 'role', coalesce(v_role, 'STUDENT'), 'department', v_dept),
    'snapshot_taken_at', now(),
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
        from public.assets a where a.parent_space_code = v_focus limit 30
    ), '[]'::jsonb),
    'active_incidents', coalesce((
      select jsonb_agg(jsonb_build_object(
               'number', incident_number, 'title', title, 'severity', severity,
               'status', status, 'rooms', affected_rooms_csv, 'summary', ai_summary_text)
               order by incident_number)
        from public.incidents where status not in ('RESOLVED', 'CLOSED') limit 10
    ), '[]'::jsonb),
    'recent_complaints', coalesce((
      select jsonb_agg(jsonb_build_object(
               'ticket', c.ticket_number, 'space', c.space_code, 'title', c.title,
               'category', c.category, 'urgency', c.urgency, 'status', c.status,
               'reporter', c.public_reporter_label, 'created_at', c.created_at)
               order by c.created_at desc)
        from public.complaints c
       where c.moderation_status = 'APPROVED'
         and (v_focus is null or c.space_code = v_focus)
       limit 10
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
        from public.work_orders wo
       where wo.status in ('PENDING_ASSIGNMENT', 'ASSIGNED', 'IN_PROGRESS')
         and (v_focus is null or wo.space_code = v_focus)
       limit 12
    ), '[]'::jsonb),
    'staff_on_shift', coalesce((
      select jsonb_agg(jsonb_build_object(
               'code', staff_code, 'skill', primary_skill, 'clearance', risk_clearance,
               'location', current_block_location, 'active_jobs', current_active_jobs)
               order by staff_code)
        from public.staff_profiles where is_on_shift and not is_on_leave limit 15
    ), '[]'::jsonb)
  ) into v_ctx;

  return v_ctx;
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
  v_reply text;
  v_system text;
  v_email text;
  v_role text;
  v_ai jsonb;
  v_engine text;
begin
  if jsonb_typeof(p_messages) <> 'array' or jsonb_array_length(p_messages) = 0 then
    return jsonb_build_object('success', false, 'error', 'MESSAGES_REQUIRED');
  end if;

  select lower(u.email), u.role into v_email, v_role
    from public.users u where u.auth_user_id = auth.uid() limit 1;
  if v_email is null then
    return jsonb_build_object('success', false, 'error', 'SIGN_IN_REQUIRED');
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
                                    left(recent.m->>'content', 700)), E'\n'), '')
    into v_history
    from (select m, ord from jsonb_array_elements(p_messages) with ordinality as t(m, ord)
           order by ord desc limit 12) recent;

  v_system :=
    'You are the NOSIH campus assistant, the conversational face of a live digital twin of a university campus. '
    'The user turn contains a LIVE TWIN SNAPSHOT: it is the single source of truth. Answer only from it. '
    'Never invent room codes, tickets, work orders, staff names, timings or statuses that are not in the snapshot. '
    'If the snapshot lacks the answer, say so plainly and say what would be needed. '
    'Speak to the asker''s role: students get plain language about their space and ticket progress; '
    'facility staff and admins get operational detail (skills, risk clearance, SLA minutes left, staffing). '
    'Be concise (max 120 words), factual and warm. No emoji, no markdown headings, no bullet symbols; use short sentences. '
    'Quote exact codes when you reference state. If a space shows HEALTHY, never call it faulty. '
    'Return JSON only: {"reply":"the answer","cited":["codes you referenced"]}.';

  begin
    v_ai := public.nosih_grok_json(
      v_system,
      format('LIVE TWIN SNAPSHOT (authoritative):%s%s%sCONVERSATION (oldest first):%s%s%sAnswer the last USER turn.',
        E'\n', v_ctx::text, E'\n\n', E'\n', v_history, E'\n\n'),
      25000
    );
  exception when others then
    v_ai := null;
  end;

  v_reply := nullif(trim(coalesce(v_ai->>'reply', '')), '');
  v_engine := 'grok';

  if v_reply is null then
    begin
      v_reply := public.nosih_grok_text(v_system, format(
        'LIVE TWIN SNAPSHOT (authoritative):%s%s%sCONVERSATION:%s%s%sAnswer the last USER turn in plain text.',
        E'\n', v_ctx::text, E'\n\n', E'\n', v_history, E'\n\n'), 25000);
    exception when others then
      v_reply := null;
    end;
  end if;

  if v_reply is null then
    v_engine := 'twin_snapshot';
    v_reply := format(
      'The AI model is unreachable right now, so here is the live twin state. Campus: %s faulty rooms, %s degraded rooms, %s open work orders, %s active incidents, %s staff on shift. %s',
      coalesce(v_ctx->'campus_totals'->>'rooms_faulty', '0'),
      coalesce(v_ctx->'campus_totals'->>'rooms_degraded', '0'),
      coalesce(v_ctx->'campus_totals'->>'open_work_orders', '0'),
      coalesce(v_ctx->'campus_totals'->>'active_incidents', '0'),
      coalesce(v_ctx->'campus_totals'->>'staff_on_shift', '0'),
      case when v_ctx->'focus_space' is not null
        then format('Your focus space %s is %s.', v_ctx->'focus_space'->>'code', v_ctx->'focus_space'->>'state')
        else 'Ask again in a moment for a full answer.' end);
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

create or replace function public.rpc_ai_chat_history(p_conversation_id uuid default null, p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id, 'conversation_id', m.conversation_id, 'role', m.author_role,
           'body', m.body, 'space_code', m.space_code, 'created_at', m.created_at)
         order by m.created_at asc, m.id asc), '[]'::jsonb)
    into v_result
    from (select * from public.ai_chat_messages
           where owner_id = auth.uid()
             and (p_conversation_id is null or conversation_id = p_conversation_id)
           order by created_at desc, id desc
           limit least(200, greatest(1, coalesce(p_limit, 50)))) m;

  return coalesce(v_result, '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Wire the AI into the existing intake and comment RPCs without rewriting them:
-- inject one call into each function body.
-- ---------------------------------------------------------------------------

do $inject$
declare
  v_def text;
  v_marker text;
begin
  -- Complaint intake: run the model after the deterministic twin mutations.
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_submit_complaint'
     and pg_get_function_identity_arguments(p.oid) = 'p_payload jsonb';

  if v_def is not null and v_def not like '%nosih_ai_run_intake%' then
    v_marker := 'select public.nosih_complaint_json(c, md5(coalesce(auth.uid()::text, v_email)))';
    if position(v_marker in v_def) > 0 then
      v_def := replace(v_def, v_marker,
        'perform public.nosih_ai_run_intake(v_complaint_id, p_payload);' || E'\n\n  ' || v_marker);
      execute v_def;
      raise notice 'rpc_submit_complaint wired to AI';
    else
      raise warning 'rpc_submit_complaint marker not found; AI not wired';
    end if;
  end if;

  -- Comments: real moderation at insert time.
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_post_comment'
     and pg_get_function_identity_arguments(p.oid) = 'p_payload jsonb';

  if v_def is not null and v_def not like '%nosih_ai_moderate_text%' then
    v_marker := 'select * into v_complaint from public.complaints where id = (p_payload->>''complaint_id'')::integer;';
    if position(v_marker in v_def) > 0 then
      v_def := replace(v_def, v_marker,
        'if p_payload->>''moderation_status'' is null then' || E'\n'
        || '    declare' || E'\n'
        || '      v_ai_mod jsonb := public.nosih_ai_moderate_text(v_body);' || E'\n'
        || '    begin' || E'\n'
        || '      v_mod := coalesce(nullif(v_ai_mod->>''status'', ''''), ''APPROVED'');' || E'\n'
        || '    end;' || E'\n'
        || '  end if;' || E'\n\n  ' || v_marker);
      execute v_def;
      raise notice 'rpc_post_comment wired to AI moderation';
    else
      raise warning 'rpc_post_comment marker not found; AI moderation not wired';
    end if;
  end if;
end
$inject$;

-- Record the moderation reason for comments when the AI held one.
create or replace function public.nosih_trg_comment_reason()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.moderation_status <> 'APPROVED' and new.moderation_reason is null then
    new.moderation_reason := public.nosih_word_moderation(new.body)->>'reason';
    new.ai_moderated := true;
  end if;
  return new;
end;
$$;

drop trigger if exists nosih_comment_reason on public.complaint_comments;
create trigger nosih_comment_reason
  before insert on public.complaint_comments
  for each row
  execute function public.nosih_trg_comment_reason();

-- Realtime: both portals watch AI verdicts and chat history.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.ai_chat_messages;
    exception when duplicate_object then
      null;
    end;
  end if;
end;
$$;

-- Retire the earlier trigger-based wiring: the model now runs inside the intake
-- transaction itself, and net._http_response is owned by supabase_admin so a
-- trigger on it cannot be dropped from the postgres role. Neutralise the
-- handler instead (it also referenced request/response columns that pg_net
-- 0.20 no longer has) and drain responses from cron.
create or replace function public.nosih_ai_handle_response()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Legacy no-op: superseded by public.nosih_ai_drain_responses().
  return new;
end;
$$;

revoke all on function public.nosih_ai_handle_response() from public;

drop trigger if exists nosih_complaint_queue_ai on public.complaints;
drop trigger if exists nosih_complaint_dispatch_ai on public.complaints;
drop trigger if exists nosih_comment_queue_ai on public.complaint_comments;
drop trigger if exists nosih_comment_dispatch_ai on public.complaint_comments;
drop trigger if exists nosih_comment_word_moderation on public.complaint_comments;

drop function if exists public.nosih_trg_complaint_queue_ai();
drop function if exists public.nosih_trg_complaint_dispatch_ai();
drop function if exists public.nosih_trg_comment_queue_ai();
drop function if exists public.nosih_trg_comment_word_moderation();
drop function if exists public.nosih_ai_requeue(bigint);
drop function if exists public.nosih_ai_enqueue_comment(integer);
drop function if exists public.nosih_apply_comment_ai(integer, jsonb);
drop function if exists public.nosih_intake_queue_ai(integer, jsonb);
drop function if exists public.nosih_gemini_embedding(text, integer);

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

grant execute on function public.nosih_word_moderation(text) to authenticated, anon, service_role;
grant execute on function public.nosih_ai_moderate_text(text) to authenticated, anon, service_role;
grant execute on function public.nosih_apply_complaint_ai(integer, jsonb) to authenticated, service_role;
grant execute on function public.nosih_hold_complaint(integer, text, text, text, text) to authenticated, service_role;
grant execute on function public.nosih_recompute_space_state(text) to authenticated, service_role;
grant execute on function public.nosih_ai_run_intake(integer, jsonb) to authenticated, anon, service_role;
grant execute on function public.nosih_chat_context(text, text) to authenticated, service_role;
grant execute on function public.rpc_ai_chat(jsonb, text, text, uuid) to authenticated, service_role;
grant execute on function public.rpc_ai_chat_history(uuid, integer) to authenticated;

revoke all on function public.nosih_ai_secret(text) from public;
revoke all on function public.nosih_llm_endpoint() from public;
revoke all on function public.nosih_llm_model() from public;
revoke all on function public.nosih_llm_headers() from public;
revoke all on function public.nosih_llm_post(jsonb, integer) from public;
revoke all on function public.nosih_grok_json(text, text, integer) from public;
revoke all on function public.nosih_grok_text(text, text, integer) from public;
revoke all on function public.nosih_ai_analyse_complaint(integer) from public;
revoke all on function public.nosih_ai_enqueue_complaint(integer, bigint) from public;
revoke all on function public.nosih_ai_process_response(bigint) from public;
revoke all on function public.nosih_ai_drain_responses() from public;
revoke all on function public.nosih_ai_retry_stale() from public;
revoke all on function public.nosih_ai_maintenance() from public;
