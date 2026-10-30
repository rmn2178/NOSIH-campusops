-- F4 seed realism: diversify staff surnames.
-- Before: 100/120 faculty surnamed "Ramachandran" (+20 "Sastry"), all 40 lab staff "Nayak".
-- After: 36-surname pool assigned deterministically (rn*7 mod 36, coprime) so no
-- surname exceeds ~4 occurrences per role. First/middle names are preserved.

update public.users u
set full_name = regexp_replace(u.full_name, '\s\S+$', '') || ' ' || pool.surname
from (
  select id,
         (array['Iyer','Menon','Reddy','Nair','Pillai','Rao','Desai','Joshi',
                'Kulkarni','Bose','Gupta','Sen','Das','Mehta','Ghosh','Shetty',
                'Srinivasan','Narayan','Chauhan','Bhandari','Malhotra','Agarwal',
                'Verma','Kaur','Sethi','Kapoor','Dutta','Trivedi','Unni','Varma',
                'Anand','Banerjee','Puri','Rawat','Tandon','Venkatesh'])
         [((rn * 7 + case when role = 'FACULTY' then 0 else 11 end) % 36) + 1] as surname
  from (
    select id, role, row_number() over (partition by role order by id) as rn
    from public.users
    where role in ('FACULTY', 'LAB_STAFF') and is_active
  ) ranked
) pool
where u.id = pool.id;
