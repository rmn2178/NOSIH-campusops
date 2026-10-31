-- ----------------------------------------------------------------------
-- 7. Department scope for the SLA console
-- ----------------------------------------------------------------------
-- The SLA board, the compliance report and the pause control are read through
-- SECURITY DEFINER functions, so they walk past the row level security that
-- already keeps a department manager inside their own spaces. The console now
-- follows the same rule as the table: a department manager reads the clocks
-- of their own department and may only stop or restart a clock that belongs
-- to it. The campus-wide roles keep the full view.

create or replace function public.nosih_sla_scope_visible(p_space_code text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
           when public.nosih_actor_role(null) not in ('DEPARTMENT_MANAGER', 'MAINTENANCE') then true
           when public.nosih_actor_department() is null then true
           else exists (
             select 1 from public.department_spaces ds
              where ds.space_code = p_space_code
                and ds.department_code = public.nosih_actor_department()
           )
         end
$$;

grant execute on function public.nosih_sla_scope_visible(text) to authenticated, service_role;

-- The board: the rows and the summary both follow the actor's scope.
do $$
declare
  v_def text;
  v_old text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.rpc_sla_board(text, integer)'::regprocedure);
  if position('nosih_sla_scope_board' in v_def) = 0 then
    v_old := $patch$
          from clock
      )
$patch$;
    v_new := $patch$
          from clock
         where public.nosih_sla_scope_visible(clock.space_code) -- nosih_sla_scope_board
      )
$patch$;
    if position(v_old in v_def) = 0 then
      raise exception 'sla board rows anchor not found';
    end if;
    v_def := replace(v_def, v_old, v_new);

    v_old := $patch$
          from public.sla_clocks s where s.target_type = 'WORK_ORDER'
      )
$patch$;
    v_new := $patch$
          from public.sla_clocks s where s.target_type = 'WORK_ORDER'
            and public.nosih_sla_scope_visible(s.space_code) -- nosih_sla_scope_board
      )
$patch$;
    if position(v_old in v_def) = 0 then
      raise exception 'sla board summary anchor not found';
    end if;
    execute replace(v_def, v_old, v_new);
  end if;
end
$$;

-- The compliance report: every grouping is scoped the same way.
do $$
declare
  v_def text;
  v_old text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.rpc_sla_compliance(integer)'::regprocedure);
  if position('nosih_sla_scope_compliance' in v_def) = 0 then
    v_old := $patch$
         where s.target_type = 'WORK_ORDER'
           and w.created_at > now() - make_interval(days => v_days)
$patch$;
    v_new := $patch$
         where s.target_type = 'WORK_ORDER'
           and w.created_at > now() - make_interval(days => v_days)
           and public.nosih_sla_scope_visible(s.space_code) -- nosih_sla_scope_compliance
$patch$;
    if position(v_old in v_def) = 0 then
      raise exception 'sla compliance anchor not found';
    end if;
    execute replace(v_def, v_old, v_new);
  end if;
end
$$;

-- Stopping and restarting a clock stays inside the department too.
do $$
declare
  v_def text;
  v_old text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.rpc_sla_pause_clock(integer, text, text)'::regprocedure);
  if position('nosih_sla_scope_pause' in v_def) = 0 then
    v_old := $patch$
  if v_clock.closed_at is not null then
    return jsonb_build_object('success', false, 'error', 'CLOCK_CLOSED');
  end if;
$patch$;
    v_new := $patch$
  if v_clock.closed_at is not null then
    return jsonb_build_object('success', false, 'error', 'CLOCK_CLOSED');
  end if;
  if public.nosih_sla_scope_visible(v_clock.space_code) is not true then
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN_DEPARTMENT_SCOPE');
  end if; -- nosih_sla_scope_pause
$patch$;
    if position(v_old in v_def) = 0 then
      raise exception 'sla pause anchor not found';
    end if;
    execute replace(v_def, v_old, v_new);
  end if;

  v_def := pg_get_functiondef('public.rpc_sla_resume_clock(integer, text)'::regprocedure);
  if position('nosih_sla_scope_resume' in v_def) = 0 then
    v_old := $patch$
  if v_clock.closed_at is not null then
    return jsonb_build_object('success', false, 'error', 'CLOCK_CLOSED');
  end if;
$patch$;
    v_new := $patch$
  if v_clock.closed_at is not null then
    return jsonb_build_object('success', false, 'error', 'CLOCK_CLOSED');
  end if;
  if public.nosih_sla_scope_visible(v_clock.space_code) is not true then
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN_DEPARTMENT_SCOPE');
  end if; -- nosih_sla_scope_resume
$patch$;
    if position(v_old in v_def) = 0 then
      raise exception 'sla resume anchor not found';
    end if;
    execute replace(v_def, v_old, v_new);
  end if;
end
$$;
