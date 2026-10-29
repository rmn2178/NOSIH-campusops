-- Identity binding: privileged RPCs must resolve the actor from the session.
--
-- Before this migration every RPC trusted p_actor_email from the browser, so a
-- signed-in student could pass an administrator's email and inherit that role.
-- The email parameter is kept in the signatures for client compatibility, but
-- it is only honoured when there is no session (service-role / cron calls).

create or replace function public.nosih_actor_email()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select email from public.users
   where auth_user_id = auth.uid() and is_active
   limit 1
$$;

create or replace function public.nosih_actor_role(p_email text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.users
   where is_active
     and (
       (auth.uid() is not null and auth_user_id = auth.uid())
       or (auth.uid() is null and lower(email) = lower(coalesce(p_email, '')))
     )
   limit 1
$$;

create or replace function public.nosih_actor_id(p_email text)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select id from public.users
   where is_active
     and (
       (auth.uid() is not null and auth_user_id = auth.uid())
       or (auth.uid() is null and lower(email) = lower(coalesce(p_email, '')))
     )
   limit 1
$$;

-- Audit rows should name the session actor even if a forged email was passed.
create or replace function public.nosih_append_audit(
  p_actor_email text,
  p_actor_role text,
  p_action text,
  p_resource_type text,
  p_resource_id text,
  p_outcome text default 'ALLOWED',
  p_rule_fired text default '',
  p_reason text default '',
  p_context jsonb default '{}'
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id integer;
  v_session_email text := public.nosih_actor_email();
  v_session_role text;
  v_email text;
  v_role text;
begin
  if v_session_email is not null then
    select role into v_session_role from public.users
     where auth_user_id = auth.uid() and is_active limit 1;
    v_email := v_session_email;
    v_role := v_session_role;
  else
    v_email := coalesce(nullif(p_actor_email, ''), 'system@nosih.edu.in');
    v_role := coalesce(nullif(p_actor_role, ''), 'SYSTEM');
  end if;

  insert into public.audit_logs (
    timestamp, actor_user_id, actor_email, actor_role, action, resource_type,
    resource_id, outcome, rule_fired, reason, context_json
  ) values (
    now(), public.nosih_actor_id(v_email), v_email,
    coalesce(v_role, 'SYSTEM'), coalesce(p_action, ''), coalesce(p_resource_type, ''),
    coalesce(p_resource_id, ''), coalesce(p_outcome, 'ALLOWED'), coalesce(p_rule_fired, ''),
    coalesce(p_reason, ''), coalesce(p_context, '{}'::jsonb)::text
  )
  returning id into v_id;
  return v_id;
end;
$$;

grant execute on function public.nosih_actor_email() to anon, authenticated;
grant execute on function public.nosih_append_audit(text, text, text, text, text, text, text, text, jsonb) to service_role;
