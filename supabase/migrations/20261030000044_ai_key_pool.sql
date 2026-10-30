-- AI key pool: rotate across Groq keys and fail over on rate limits.
--
-- The assistant previously used one Vault key, so a single daily token cap or
-- 429 took every AI surface down together. Keys now live in a pool (the legacy
-- xai_api_key plus ai_api_keys), each call starts at the next key, and auth,
-- quota, rate-limit and 5xx responses retry with the following key before the
-- caller falls back to the deterministic answer.

create sequence if not exists public.nosih_ai_key_seq;

create or replace function public.nosih_ai_keys()
returns jsonb
language sql
stable
security definer
set search_path = public, vault
as $$
  with raw as (
    select nullif(public.nosih_ai_secret('xai_api_key'), '') as k, true as is_primary
    union all
    select value, false
      from jsonb_array_elements_text(
        case when coalesce(public.nosih_ai_secret('ai_api_keys'), '') ~ '^\s*\['
             then public.nosih_ai_secret('ai_api_keys')::jsonb
             else '[]'::jsonb end)
  ), clean as (
    select k, bool_or(is_primary) as is_primary
      from raw
     where coalesce(trim(k), '') <> ''
     group by k
  )
  select coalesce(jsonb_agg(k order by is_primary desc, k), '[]'::jsonb) from clean;
$$;

create or replace function public.nosih_ai_key_count()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_array_length(public.nosih_ai_keys());
$$;

create or replace function public.nosih_register_ai_keys(p_keys jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_primary text := nullif(public.nosih_ai_secret('xai_api_key'), '');
  v_existing jsonb := case when coalesce(public.nosih_ai_secret('ai_api_keys'), '') ~ '^\s*\['
    then public.nosih_ai_secret('ai_api_keys')::jsonb else '[]'::jsonb end;
  v_all jsonb;
  v_id uuid;
begin
  with raw as (
    select v_primary as k, true as is_primary
    union all select value, false from jsonb_array_elements_text(v_existing)
    union all select value, false from jsonb_array_elements_text(coalesce(p_keys, '[]'::jsonb))
  ), clean as (
    select k, bool_or(is_primary) as is_primary
      from raw
     where coalesce(trim(k), '') <> ''
     group by k
  )
  select coalesce(jsonb_agg(k order by is_primary desc, k), '[]'::jsonb) into v_all from clean;

  if jsonb_array_length(v_all) = 0 then
    return jsonb_build_object('keys', 0, 'primary_set', false);
  end if;

  select id into v_id from vault.secrets where name = 'ai_api_keys';
  if v_id is null then
    perform vault.create_secret(v_all::text, 'ai_api_keys', 'NOSIH AI key pool');
  else
    perform vault.update_secret(v_id, v_all::text);
  end if;

  -- Keep the legacy single secret usable when it was never set.
  if v_primary is null then
    select id into v_id from vault.secrets where name = 'xai_api_key';
    if v_id is null then
      perform vault.create_secret(v_all->>0, 'xai_api_key', 'NOSIH AI provider key');
    else
      perform vault.update_secret(v_id, v_all->>0);
    end if;
  end if;

  return jsonb_build_object('keys', jsonb_array_length(v_all), 'primary_set', true);
end $$;

create or replace function public.nosih_llm_post(p_payload jsonb, p_timeout_ms integer default 15000)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_keys jsonb := public.nosih_ai_keys();
  v_count integer := jsonb_array_length(v_keys);
  v_offset integer;
  v_i integer;
  v_key text;
  v_url text;
  v_model text;
  v_body jsonb;
  v_status integer;
  v_content text;
  v_last jsonb;
begin
  if v_count = 0 then
    return null;
  end if;

  -- Round-robin start spreads load; failures walk the rest of the pool.
  v_offset := ((nextval('public.nosih_ai_key_seq') - 1) % v_count)::integer;

  for v_i in 0..v_count - 1 loop
    v_key := v_keys->>((v_offset + v_i) % v_count);
    v_url := case when v_key like 'gsk\_%'
      then 'https://api.groq.com/openai/v1/chat/completions'
      else 'https://api.x.ai/v1/chat/completions' end;
    v_model := coalesce(
      nullif(public.nosih_ai_secret('llm_model'), ''),
      case when v_key like 'gsk\_%' then 'openai/gpt-oss-120b' else 'grok-4-fast' end);
    v_body := p_payload || jsonb_build_object('model', v_model);

    begin
      perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', greatest(1000, p_timeout_ms)::text);
    exception when others then
      null;
    end;

    v_status := null;
    v_content := null;
    begin
      select r.status, r.content into v_status, v_content
        from extensions.http(
          row('POST', v_url,
              array[
                extensions.http_header('Content-Type', 'application/json'),
                extensions.http_header('Authorization', 'Bearer ' || v_key)
              ],
              'application/json',
              v_body::text
          )::extensions.http_request) r;
    exception when others then
      v_status := null;
      v_content := null;
    end;

    begin
      perform extensions.http_reset_curlopt();
    exception when others then
      null;
    end;

    if v_status is not null and v_status between 200 and 299 then
      begin
        return v_content::jsonb;
      exception when others then
        return null;
      end;
    end if;

    v_last := jsonb_build_object('http_error', coalesce(v_status, 0),
                                 'body', left(coalesce(v_content, ''), 400));

    -- Only auth, quota, rate-limit and server faults move to the next key.
    if v_status is not null and v_status < 500
       and v_status not in (401, 403, 408, 409, 429) then
      return v_last;
    end if;
  end loop;

  return v_last;
end $$;

revoke all on function public.nosih_ai_keys() from public, anon, authenticated;
revoke all on function public.nosih_ai_key_count() from public, anon, authenticated;
revoke all on function public.nosih_register_ai_keys(jsonb) from public, anon, authenticated;
revoke all on function public.nosih_llm_post(jsonb, integer) from public, anon, authenticated;

do $$
begin
  if position('v_offset' in pg_get_functiondef('public.nosih_llm_post(jsonb, integer)'::regprocedure)) = 0
     or position('nosih_ai_keys' in pg_get_functiondef('public.nosih_llm_post(jsonb, integer)'::regprocedure)) = 0 then
    raise exception 'key pool patch incomplete';
  end if;
end $$;
