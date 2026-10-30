-- Keep the community feed useful with a small limit: active work first, then
-- the most recent resolved history. The portal asks for 10 rows.
create or replace function public.rpc_list_complaints(
  p_zone text default 'ALL'::text,
  p_status text default null::text,
  p_category text default null::text,
  p_my_department boolean default false,
  p_limit integer default 100
)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_hash text;
  v_dept text;
  v_result jsonb;
begin
  v_hash := md5(coalesce(auth.uid()::text, 'anonymous'));
  select department_code into v_dept from public.users where auth_user_id = auth.uid() limit 1;

  select coalesce(jsonb_agg(public.nosih_complaint_json(c, v_hash)
                            order by (c.status not in ('RESOLVED', 'MERGED_DUPLICATE', 'CLOSED')) desc,
                                     c.created_at desc), '[]'::jsonb)
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
$function$;
