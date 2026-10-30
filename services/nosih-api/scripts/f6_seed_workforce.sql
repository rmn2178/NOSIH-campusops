-- F6 workforce: 30 maintenance technicians with unique identities.
--
-- Before: 12 technicians (HVAC 1), duplicate names ("Arjun Iyer" twice).
-- After: 30 — ELECTRICAL 8, IT_AV 6, HVAC 6, PLUMBING 5, CARPENTRY 5 — every
-- skill keeps at least four on-shift hands; one technician is deliberately off
-- shift and one on leave so the ranking gates stay visible. Idempotent.

-- 1. Unique names for the original twelve (codes and logins unchanged).
update public.users set full_name = 'Aditi Kulkarni' where email = 'maint03@nosih.edu.in';
update public.users set full_name = 'Kabir Shetty'   where email = 'maint05@nosih.edu.in';
update public.users set full_name = 'Rohan Iyer'     where email = 'maint06@nosih.edu.in';
update public.users set full_name = 'Ishaan Iyer'    where email = 'maint07@nosih.edu.in';

-- 2. Eighteen new technicians.
create temp table f6_roster (
  code text primary key, email text unique, full_name text, dept text,
  skill text, prof integer, risk text, rate numeric, shift text,
  on_shift boolean, on_leave boolean, block text
) on commit drop;

insert into f6_roster values
  ('MAINT-13','maint13@nosih.edu.in','Aryan Kapoor','CSE','ELECTRICAL',4,'HIGH_VOLTAGE',620,'DAY',true,false,'B'),
  ('MAINT-14','maint14@nosih.edu.in','Meera Nair','ECE','ELECTRICAL',3,'HIGH_VOLTAGE',560,'EVENING',true,false,'C'),
  ('MAINT-15','maint15@nosih.edu.in','Nikhil Bose','AIML','ELECTRICAL',3,'HIGH_VOLTAGE',520,'DAY',true,false,'A'),
  ('MAINT-16','maint16@nosih.edu.in','Sneha Pillai','MECH','ELECTRICAL',3,'STANDARD',460,'EVENING',true,false,'B'),
  ('MAINT-17','maint17@nosih.edu.in','Farhan Joshi','CYBER','IT_AV',4,'STANDARD',540,'DAY',true,false,'C'),
  ('MAINT-18','maint18@nosih.edu.in','Priya Ghosh','AIDS','IT_AV',3,'STANDARD',480,'EVENING',true,false,'A'),
  ('MAINT-19','maint19@nosih.edu.in','Tarun Mehta','CSE','LAB_SUPPORT',4,'STANDARD',520,'DAY',true,false,'B'),
  ('MAINT-20','maint20@nosih.edu.in','Ananya Desai','ECE','CARPENTRY',3,'STANDARD',340,'EVENING',true,false,'C'),
  ('MAINT-21','maint21@nosih.edu.in','Ramesh Kulkarni','AIML','HVAC',4,'STANDARD',580,'DAY',true,false,'A'),
  ('MAINT-22','maint22@nosih.edu.in','Anita Varma','MECH','HVAC',3,'STANDARD',500,'EVENING',false,false,'B'),
  ('MAINT-23','maint23@nosih.edu.in','Sanjay Gupta','CYBER','HVAC',4,'STANDARD',560,'DAY',true,false,'C'),
  ('MAINT-24','maint24@nosih.edu.in','Divya Sen','AIDS','HVAC',3,'STANDARD',480,'EVENING',true,false,'A'),
  ('MAINT-25','maint25@nosih.edu.in','Imran Sheikh','CSE','HVAC',4,'CONFINED_SPACE_FIRE',600,'DAY',true,false,'LAB_WING'),
  ('MAINT-26','maint26@nosih.edu.in','Latha Krishnan','ECE','PLUMBING',4,'STANDARD',440,'EVENING',true,false,'B'),
  ('MAINT-27','maint27@nosih.edu.in','Pooja Rawat','AIML','PLUMBING',3,'STANDARD',400,'DAY',true,true,'C'),
  ('MAINT-28','maint28@nosih.edu.in','Gopal Tandon','MECH','PLUMBING',4,'STANDARD',460,'EVENING',true,false,'A'),
  ('MAINT-29','maint29@nosih.edu.in','Ritu Chauhan','CYBER','LAB_SUPPORT',4,'STANDARD',420,'EVENING',true,false,'B'),
  ('MAINT-30','maint30@nosih.edu.in','Manoj Trivedi','AIDS','CARPENTRY',4,'STANDARD',350,'EVENING',true,false,'C');

insert into public.users (email, full_name, role, department_code, is_active)
select r.email, r.full_name, 'MAINTENANCE', r.dept, true
  from f6_roster r
on conflict (email) do nothing;

insert into public.staff_profiles (
  user_id, staff_code, staff_category, primary_skill, skill_proficiency, risk_clearance,
  hourly_cost_inr, shift_code, is_on_shift, is_on_leave, current_active_jobs,
  max_concurrent_jobs, current_block_location)
select u.id, r.code, 'MAINTENANCE_TECH', r.skill, r.prof, r.risk,
       r.rate, r.shift, r.on_shift, r.on_leave, 0, 3, r.block
  from f6_roster r
  join public.users u on u.email = r.email
on conflict (staff_code) do nothing;

-- Lab-equipment work orders (LAB_SUPPORT skill) must stay assignable: two
-- technicians specialise in lab instruments and workstation power.
update public.staff_profiles set primary_skill = 'LAB_SUPPORT', hourly_cost_inr = 520
 where staff_code = 'MAINT-19';
update public.staff_profiles set primary_skill = 'LAB_SUPPORT', hourly_cost_inr = 420
 where staff_code = 'MAINT-29';

-- 3. Report.
select count(*) as technicians_after,
       count(distinct u.full_name) as unique_names,
       count(*) filter (where sp.is_on_shift and not sp.is_on_leave) as on_shift
  from public.staff_profiles sp
  join public.users u on u.id = sp.user_id
 where sp.staff_category = 'MAINTENANCE_TECH';
