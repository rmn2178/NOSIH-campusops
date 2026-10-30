-- Demo conversation on the five live tickets. Idempotent: a comment is only
-- inserted when the same complaint does not already carry that body.
with seed(complaint_id, body, label, badge, created_at) as (
  values
    (678, 'Safety ticket received for C1-02. The block electrician is on the way; please keep the front row clear until the circuit is isolated.', 'Facilities control room', 'FACILITIES', timestamptz '2026-10-30 22:46:00+00'),
    (678, 'Inspected the fan regulator and light choke. Replaced the burnt connector and isolated the damaged switch; testing the circuit now.', 'Ravi Menon', 'MAINTENANCE', timestamptz '2026-10-30 23:05:00+00'),
    (678, 'The sparking has stopped. The fan is running again but still sounds a little rough.', 'Ananya Iyer', 'STUDENT', timestamptz '2026-10-30 23:24:00+00'),
    (344, 'Ordered the replacement sensor for instrument 14. Delivery is expected tomorrow morning; the bench stays tagged out until then.', 'Suresh Kumar', 'MAINTENANCE', timestamptz '2026-10-30 12:05:00+00'),
    (344, 'Please keep the Monday physics practical in mind — the batch has 42 students and this is the only working bench.', 'Dr. Meera Nair', 'FACULTY', timestamptz '2026-10-30 13:10:00+00'),
    (343, 'The warmer is switched off and the vendor is checking the thermostat. Cold items have been moved to the display chiller.', 'Canteen supervisor', 'FACILITIES', timestamptz '2026-10-30 11:40:00+00'),
    (343, 'The queue is moving again; sandwiches and cold drinks are back at the counter.', 'Sneha Mishra', 'STUDENT', timestamptz '2026-10-30 12:05:00+00'),
    (103, 'A technician has been assigned to the rattling fan. Please avoid the front row until the mount is secured.', 'Facilities control room', 'FACILITIES', timestamptz '2026-10-30 07:10:00+00'),
    (103, 'Still rattling during the 11 am lecture, especially when the fan is on full speed.', 'Aarav Sharma', 'STUDENT', timestamptz '2026-10-30 08:20:00+00'),
    (84, 'The projector lamp and fan mount are on the work order. C5-04 is available for the next period if the class needs to move.', 'Facilities control room', 'FACILITIES', timestamptz '2026-10-30 11:20:00+00')
)
insert into public.complaint_comments
  (complaint_id, body, is_anonymous, public_author_label, author_role_badge, moderation_status, created_at, ai_moderated)
select s.complaint_id, s.body, false, s.label, s.badge, 'APPROVED', s.created_at, true
  from seed s
 where exists (select 1 from public.complaints c where c.id = s.complaint_id)
   and not exists (
     select 1 from public.complaint_comments x
      where x.complaint_id = s.complaint_id and x.body = s.body
   );
