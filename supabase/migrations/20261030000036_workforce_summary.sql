-- F6: workforce summary for the dispatch workspace strip.
-- One campus-reader RPC; session RBAC like the other read models.

create or replace function public.rpc_workforce_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.nosih_is_campus_reader() then
    return jsonb_build_object('error', 'FORBIDDEN');
  end if;
  return (
    select jsonb_build_object(
      'success', true,
      'total', count(*),
      'on_shift', count(*) filter (where sp.is_on_shift and not sp.is_on_leave),
      'on_leave', count(*) filter (where sp.is_on_leave),
      'available', count(*) filter (where sp.is_on_shift and not sp.is_on_leave
                                     and sp.current_active_jobs < sp.max_concurrent_jobs),
      'by_skill', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'skill', s.skill,
                 'total', s.total,
                 'on_shift', s.on_shift,
                 'available', s.available) order by s.skill), '[]'::jsonb)
          from (
            select sp2.primary_skill as skill,
                   count(*) as total,
                   count(*) filter (where sp2.is_on_shift and not sp2.is_on_leave) as on_shift,
                   count(*) filter (where sp2.is_on_shift and not sp2.is_on_leave
                                      and sp2.current_active_jobs < sp2.max_concurrent_jobs) as available
              from public.staff_profiles sp2
             where sp2.staff_category = 'MAINTENANCE_TECH'
             group by sp2.primary_skill
          ) s)
    )
      from public.staff_profiles sp
     where sp.staff_category = 'MAINTENANCE_TECH'
  );
end
$$;

revoke all on function public.rpc_workforce_summary() from public, anon;
grant execute on function public.rpc_workforce_summary() to authenticated;
