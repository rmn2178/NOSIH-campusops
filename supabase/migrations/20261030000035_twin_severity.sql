-- Twin severity rubric: manageable faults glow light orange, major faults red.
--
-- Before, space colour followed complaint urgency, which the intake derived
-- from wording and target count — "the fan is not working at all" expanded to
-- four fans and painted the room red, while a dead smart board stayed orange.
-- Severity now follows materiality: safety overrides, critical asset types
-- (smart board, lab workstation, canteen appliance, bill-bot mechanism) and
-- critical urgency are MAJOR (FAULTY / red); everything else is MANAGEABLE
-- (DEGRADED / light orange). Intake, recompute and status resolution all use
-- the same rule.

-- 1. Asset criticality ---------------------------------------------------------
alter table public.assets add column if not exists criticality text not null default 'STANDARD';

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'assets_criticality_check'
                    and conrelid = 'public.assets'::regclass) then
    alter table public.assets
      add constraint assets_criticality_check check (criticality in ('CRITICAL', 'STANDARD'));
  end if;
end $$;

update public.assets
   set criticality = case
         when asset_type in ('SMART_BOARD', 'LAB_WORKSTATION', 'CANTEEN_APPLIANCE', 'BILL_BOT_MECHANISM')
           then 'CRITICAL'
         else 'STANDARD' end;

create or replace function public.nosih_asset_type_criticality(p_type text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when p_type in ('SMART_BOARD', 'LAB_WORKSTATION', 'CANTEEN_APPLIANCE', 'BILL_BOT_MECHANISM')
      then 'CRITICAL'
    else 'STANDARD' end
$$;

-- 2. Space severity: recompute honours the rubric ------------------------------
do $$
declare
  v_def text;
  v_old text := $old$  select case when count(*) filter (where c.urgency in ('HIGH', 'CRITICAL')) > 0 then 'FAULTY'
              when count(*) > 0 then 'DEGRADED'
              else 'HEALTHY' end
    into v_state
    from public.complaints c
   where c.space_code = p_space_code
     and c.moderation_status = 'APPROVED'
     and c.status in ('OPEN', 'TRIAGED', 'IN_PROGRESS', 'BLOCKED_PARTS');$old$;
  v_new text := $new$  select case
           when exists (
             select 1 from public.complaints c
              where c.space_code = p_space_code
                and c.moderation_status = 'APPROVED'
                and c.status in ('OPEN', 'TRIAGED', 'IN_PROGRESS', 'BLOCKED_PARTS')
                and (
                  c.category = 'SAFETY_FIRE'
                  or c.urgency = 'CRITICAL'
                  or exists (
                    select 1
                      from jsonb_array_elements(
                             case when c.ai_extracted_json ~ '^\s*\{'
                                  then coalesce(c.ai_extracted_json::jsonb->'target_assets', '[]'::jsonb)
                                  else '[]'::jsonb end) t
                     where public.nosih_asset_type_criticality(t->>'asset_type') = 'CRITICAL')
                ))
           then 'FAULTY'
           when exists (
             select 1 from public.complaints c
              where c.space_code = p_space_code
                and c.moderation_status = 'APPROVED'
                and c.status in ('OPEN', 'TRIAGED', 'IN_PROGRESS', 'BLOCKED_PARTS'))
           then 'DEGRADED'
           else 'HEALTHY' end
    into v_state; -- nosih_severity_recompute$new$;
begin
  v_def := pg_get_functiondef('public.nosih_recompute_space_state(text)'::regprocedure);
  if position('nosih_severity_recompute' in v_def) = 0 then
    if position(v_old in v_def) = 0 then
      raise exception 'recompute severity anchor missing';
    end if;
    v_def := replace(v_def, v_old, v_new);
    execute v_def;
  end if;
end $$;

-- 3. Intake: urgency and initial colour follow materiality ---------------------
do $$
declare
  v_def text;
  v_old_urgency text := $old$when jsonb_array_length(v_target_assets) > 1 then 'HIGH'$old$;
  v_new_urgency text := $new$when exists (select 1 from jsonb_array_elements(v_target_assets) t
                          where public.nosih_asset_type_criticality(t->>'asset_type') = 'CRITICAL')
                          then 'HIGH' -- nosih_severity_urgency$new$;
  v_old_visual text := $old$v_visual := case when v_urgency in ('HIGH', 'CRITICAL') then 'FAULTY' else 'DEGRADED' end;$old$;
  v_new_visual text := $new$v_visual := case
    when v_category = 'SAFETY_FIRE' or v_urgency = 'CRITICAL' then 'FAULTY'
    when exists (select 1 from jsonb_array_elements(v_target_assets) t
                  where public.nosih_asset_type_criticality(t->>'asset_type') = 'CRITICAL')
      then 'FAULTY'
    else 'DEGRADED' end; -- nosih_severity_visual$new$;
  v_old_state text := $old$    if v_space_type = 'ROOM' then
      update public.rooms set visual_state = v_visual where code = v_space_code;
    elsif v_space_type = 'LAB' then
      update public.labs set visual_state = v_visual where code = v_space_code;
    elsif v_space_type = 'CANTEEN' then
      update public.canteens set visual_state = v_visual where code = v_space_code;
    elsif v_space_type = 'BILL_BOT' then$old$;
  v_new_state text := $new$    if v_space_type in ('ROOM', 'LAB', 'CANTEEN') then
      perform public.nosih_recompute_space_state(v_space_code); -- nosih_severity_intake
    elsif v_space_type = 'BILL_BOT' then$new$;
begin
  v_def := pg_get_functiondef('public.rpc_submit_complaint(jsonb)'::regprocedure);
  if position('nosih_severity_visual' in v_def) = 0 then
    if position(v_old_urgency in v_def) = 0 or position(v_old_visual in v_def) = 0
       or position(v_old_state in v_def) = 0 then
      raise exception 'intake severity anchor missing (urgency=% visual=% state=%)',
        position(v_old_urgency in v_def), position(v_old_visual in v_def), position(v_old_state in v_def);
    end if;
    v_def := replace(v_def, v_old_urgency, v_new_urgency);
    v_def := replace(v_def, v_old_visual, v_new_visual);
    v_def := replace(v_def, v_old_state, v_new_state);
    execute v_def;
  end if;
end $$;

-- 4. Status resolution recomputes through the same rubric ---------------------
do $$
declare
  v_def text;
  v_old text := $old$    v_state := case when v_open = 0 then 'HEALTHY' else 'FAULTY' end;
    if v_row.space_type = 'ROOM' then
      update public.rooms set visual_state = v_state where code = v_row.space_code;
    elsif v_row.space_type = 'LAB' then
      update public.labs set visual_state = v_state where code = v_row.space_code;
    end if;$old$;
  v_new text := $new$    if v_row.space_type in ('ROOM', 'LAB', 'CANTEEN') then
      perform public.nosih_recompute_space_state(v_row.space_code); -- nosih_severity_status
    end if;$new$;
begin
  v_def := pg_get_functiondef('public.rpc_update_complaint_status(integer, text, text)'::regprocedure);
  if position('nosih_severity_status' in v_def) = 0 then
    if position(v_old in v_def) = 0 then
      raise exception 'status severity anchor missing';
    end if;
    v_def := replace(v_def, v_old, v_new);
    execute v_def;
  end if;
end $$;

-- 5. Normalise every space under the rubric once -------------------------------
do $$
declare
  r record;
begin
  for r in
    select code from public.rooms
    union select code from public.labs
    union select code from public.canteens
  loop
    perform public.nosih_recompute_space_state(r.code);
  end loop;
end $$;

-- 6. Patch-completeness guards -------------------------------------------------
do $$
declare
  v_submit text := pg_get_functiondef('public.rpc_submit_complaint(jsonb)'::regprocedure);
  v_recompute text := pg_get_functiondef('public.nosih_recompute_space_state(text)'::regprocedure);
  v_status text := pg_get_functiondef('public.rpc_update_complaint_status(integer, text, text)'::regprocedure);
begin
  if position('nosih_severity_urgency' in v_submit) = 0
     or position('nosih_severity_visual' in v_submit) = 0
     or position('nosih_severity_intake' in v_submit) = 0 then
    raise exception 'intake severity patch incomplete';
  end if;
  if position('nosih_severity_recompute' in v_recompute) = 0 then
    raise exception 'recompute severity patch incomplete';
  end if;
  if position('nosih_severity_status' in v_status) = 0 then
    raise exception 'status severity patch incomplete';
  end if;
end $$;
