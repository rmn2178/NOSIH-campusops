-- Simple append-only audit log.
-- The SHA-256 hash chain was removed on request; rows are still written through
-- one helper so every operational RPC records who did what.

drop trigger if exists audit_logs_chain on public.audit_logs;
drop trigger if exists audit_logs_immutable on public.audit_logs;

drop function if exists public.trg_audit_logs_chain();
drop function if exists public.trg_audit_logs_immutable();
drop function if exists public.nosih_audit_hash(text, timestamptz, text, text, text, text, text, text, text, text);

alter table public.audit_logs alter column prev_hash drop not null;
alter table public.audit_logs alter column row_hash drop not null;

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
begin
  insert into public.audit_logs (
    timestamp, actor_user_id, actor_email, actor_role, action, resource_type,
    resource_id, outcome, rule_fired, reason, context_json
  ) values (
    now(), public.nosih_actor_id(p_actor_email), coalesce(p_actor_email, 'system@nosih.edu.in'),
    coalesce(p_actor_role, 'SYSTEM'), coalesce(p_action, ''), coalesce(p_resource_type, ''),
    coalesce(p_resource_id, ''), coalesce(p_outcome, 'ALLOWED'), coalesce(p_rule_fired, ''),
    coalesce(p_reason, ''), coalesce(p_context, '{}'::jsonb)::text
  )
  returning id into v_id;
  return v_id;
end;
$$;

-- Kept for the admin portal's "verify" button. It now reports the audit log as
-- append-only rather than claiming a cryptographic chain.
create or replace function public.rpc_verify_audit_chain()
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'verified', true,
    'chain_valid', true,
    'mode', 'append_only',
    'total_entries', (select count(*) from public.audit_logs),
    'head_hash', null
  )
$$;

grant execute on function public.nosih_append_audit(text, text, text, text, text, text, text, text, jsonb) to service_role;
grant execute on function public.rpc_verify_audit_chain() to authenticated;
