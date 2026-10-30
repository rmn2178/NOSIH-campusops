-- One accountable head per department. These profiles drive the scoped reads in
-- 20261030000028_department_scope.sql and the department-manager portal role.
-- Auth accounts are provisioned by scripts/seed_role_logins.py.

insert into public.users (email, full_name, role, department_code, is_active)
values
  ('hod.aids@nosih.edu.in',  'Dr. Lakshmi Venkatesan',  'DEPARTMENT_MANAGER', 'AIDS',  true),
  ('hod.aiml@nosih.edu.in',  'Dr. Suresh Balakrishnan', 'DEPARTMENT_MANAGER', 'AIML',  true),
  ('hod.cse@nosih.edu.in',   'Dr. Meenakshi Iyer',      'DEPARTMENT_MANAGER', 'CSE',   true),
  ('hod.cyber@nosih.edu.in', 'Dr. Aditi Rao',           'DEPARTMENT_MANAGER', 'CYBER', true),
  ('hod.ece@nosih.edu.in',   'Dr. Harish Menon',        'DEPARTMENT_MANAGER', 'ECE',   true),
  ('hod.mech@nosih.edu.in',  'Dr. Anil Deshpande',      'DEPARTMENT_MANAGER', 'MECH',  true)
on conflict (email) do update
  set full_name = excluded.full_name,
      role = excluded.role,
      department_code = excluded.department_code,
      is_active = excluded.is_active;
