-- Race-proof document numbers.
--
-- Tickets, work orders and incident numbers were count(*)+1 expressions. The
-- campus pulse cron injects every minute, so a cron tick running concurrently
-- with an interactive session computed the same number; work_orders.wo_number
-- then had two rows, and the maintenance pricing trigger's
-- "where wo_number = ... limit 1" resolved the wrong work order and priced the
-- repair at zero. One shared monotonic sequence replaces all four sites and
-- unique indexes turn any future collision into a loud error.

create sequence if not exists public.nosih_doc_number_seq;

do $$
declare
  v_max bigint;
begin
  select greatest(
    coalesce((select max(m) from (
      select (regexp_match(ticket_number, '([0-9]+)$'))[1]::bigint as m from public.complaints) s), 0),
    coalesce((select max(m) from (
      select (regexp_match(wo_number, '([0-9]+)$'))[1]::bigint as m from public.work_orders) s), 0),
    coalesce((select max(m) from (
      select (regexp_match(incident_number, '([0-9]+)$'))[1]::bigint as m from public.incidents) s), 0)
  ) into v_max;
  perform setval('public.nosih_doc_number_seq', greatest(v_max, 1), true);
end $$;

-- rpc_submit_complaint: ticket, incident and work order numbers.
do $$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_submit_complaint'
   limit 1;
  if v_def is null then
    raise exception 'rpc_submit_complaint not found';
  end if;
  if position('-- nosih_seq_ticket' in v_def) = 0 then
    v_def := replace(v_def,
      'select ''CMP-2026-'' || lpad((count(*) + 1)::text, 4, ''0'') into v_ticket from public.complaints;',
      'select ''CMP-2026-'' || lpad(nextval(''public.nosih_doc_number_seq'')::text, 4, ''0'') into v_ticket; -- nosih_seq_ticket');
  end if;
  if position('-- nosih_seq_wo' in v_def) = 0 then
    v_def := replace(v_def,
      '''WO-2026-'' || lpad(((select count(*) from public.work_orders) + 1)::text, 4, ''0''),',
      '''WO-2026-'' || lpad(nextval(''public.nosih_doc_number_seq'')::text, 4, ''0''), -- nosih_seq_wo');
  end if;
  if position('-- nosih_seq_inc' in v_def) = 0 then
    v_def := replace(v_def,
      '''INC-2026-'' || lpad(((select count(*) from public.incidents) + 1)::text, 4, ''0''),',
      '''INC-2026-'' || lpad(nextval(''public.nosih_doc_number_seq'')::text, 4, ''0''), -- nosih_seq_inc');
  end if;
  execute v_def;
end $$;

-- Any other function still deriving incident numbers by count (AI pipeline).
do $$
declare
  r record;
  v_def text;
begin
  for r in
    select p.oid
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname <> 'rpc_submit_complaint'
       and p.prokind = 'f'
       and strpos(pg_get_functiondef(p.oid), 'select count(*) from public.incidents) + 1') > 0
  loop
    v_def := pg_get_functiondef(r.oid);
    if position('-- nosih_seq_inc' in v_def) = 0 then
      v_def := replace(v_def,
        '''INC-2026-'' || lpad(((select count(*) from public.incidents) + 1)::text, 4, ''0''),',
        '''INC-2026-'' || lpad(nextval(''public.nosih_doc_number_seq'')::text, 4, ''0''), -- nosih_seq_inc');
      execute v_def;
    end if;
  end loop;
end $$;

-- Backstops: numbers are now sequence-issued; make any regression loud.
create unique index if not exists complaints_ticket_number_uq on public.complaints (ticket_number);
create unique index if not exists work_orders_wo_number_uq on public.work_orders (wo_number);
create unique index if not exists incidents_incident_number_uq on public.incidents (incident_number);

-- Patch completeness guards (fail loudly rather than silently half-apply).
do $$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rpc_submit_complaint' limit 1;
  if position('-- nosih_seq_ticket' in v_def) = 0
     or position('-- nosih_seq_wo' in v_def) = 0
     or position('-- nosih_seq_inc' in v_def) = 0 then
    raise exception 'rpc_submit_complaint document-number patch incomplete';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prokind = 'f'
         and strpos(pg_get_functiondef(p.oid), 'select count(*) from public.incidents) + 1') > 0) > 0 then
    raise exception 'a function still derives incident numbers from count(*)';
  end if;
end $$;
