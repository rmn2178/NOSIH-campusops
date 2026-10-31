-- The login page narrows the campus directory by department and academic role.
-- The filters run in the database, so the list of names is the list of people
-- who can actually sign in, and the page keeps the two controls it always had.

drop function if exists public.rpc_search_directory(text, integer);

create or replace function public.rpc_search_directory(
  p_query text,
  p_limit integer default 8,
  p_department text default null,
  p_academic_role text default null
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'email', u.email,
    'full_name', u.full_name,
    'department', case u.department_code when 'AIDS' then 'AI&DS' when 'CYBER' then 'Cyber Security' else u.department_code end,
    'academic_role', case when u.role = 'STUDENT' then 'YEAR_' || coalesce(u.year_number, 1) else 'FACULTY_STAFF' end,
    'year_number', u.year_number
  ) order by u.email), '[]'::jsonb)
    from (
      -- The limit belongs on the source rows: an aggregate returns one row, so a
      -- limit outside would never trim the list.
      select u.email, u.full_name, u.department_code, u.role, u.year_number
        from public.users u
       where u.is_active
         and (
           u.email ilike coalesce(p_query, '') || '%'
           or u.full_name ilike '%' || coalesce(p_query, '') || '%'
         )
         and (p_department is null or p_department = '' or
              case u.department_code
                when 'AIDS' then 'AI&DS'
                when 'CYBER' then 'Cyber Security'
                else u.department_code end = p_department)
         and (p_academic_role is null or p_academic_role = '' or
              case when u.role = 'STUDENT' then 'YEAR_' || coalesce(u.year_number, 1) else 'FACULTY_STAFF' end = p_academic_role)
       order by u.email
       limit least(20, greatest(1, coalesce(p_limit, 8)))
    ) u
$$;

grant execute on function public.rpc_search_directory(text, integer, text, text) to anon, authenticated;
