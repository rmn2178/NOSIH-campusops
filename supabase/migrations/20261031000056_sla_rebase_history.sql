-- Re-base the existing clocks onto the operating calendar.
--
-- The historical clocks were measured on the wall clock by the old engine, and
-- their targets come from the new matrix, so the two were never comparable.
-- Two corrections:
--
--   * The elapsed time of every clock is recomputed as operational minutes
--     between the work order and its closure - the same basis the tick now
--     uses, so old and new requests can be read together.
--   * The response deadline needs evidence. A completed repair is evidence:
--     the technician started work at completed_at minus the recorded downtime,
--     and that is the moment the request was answered. Clocks that are still
--     open have no answer yet and keep their running response clock.

update public.sla_clocks s
   set elapsed_active_mins = public.nosih_sla_operating_minutes(
         w.created_at, coalesce(s.closed_at, w.completed_at, now()), s.is_24x7),
       last_tick_at = now()
  from public.work_orders w
 where s.target_type = 'WORK_ORDER'
   and s.target_id = w.id
   and s.closed_at is not null;

update public.sla_clocks s
   set elapsed_active_mins = public.nosih_sla_operating_minutes(
         w.created_at, now(), s.is_24x7),
       last_tick_at = now()
  from public.work_orders w
 where s.target_type = 'WORK_ORDER'
   and s.target_id = w.id
   and s.closed_at is null;

-- The acknowledgement of a request that was repaired.
with answered as (
  select s.id as clock_id,
         mh.completed_at - make_interval(mins => mh.downtime_mins) as answered_at,
         w.created_at as raised_at,
         s.response_target_mins as response_target,
         s.is_24x7 as is_24x7
    from public.sla_clocks s
    join public.work_orders w on w.id = s.target_id
    join public.maintenance_history mh on mh.work_order_number = w.wo_number
   where s.target_type = 'WORK_ORDER' and s.first_response_at is null
)
update public.sla_clocks s
   set first_response_at = answered.answered_at,
       response_elapsed_mins = public.nosih_sla_operating_minutes(
         answered.raised_at, answered.answered_at, answered.is_24x7),
       response_breach_state = case
         when public.nosih_sla_operating_minutes(
                answered.raised_at, answered.answered_at, answered.is_24x7)
              <= answered.response_target then 'MET'
         else 'BREACHED_100' end
  from answered
 where s.id = answered.clock_id;

-- The derived states follow the re-based elapsed time: a request that is
-- inside its target again is no longer a breach, and its escalation tier
-- falls back to the first tier.
update public.sla_clocks s
   set breach_state = case
         when s.elapsed_active_mins > s.resolution_target_mins then 'BREACHED_100'
         when s.elapsed_active_mins >= s.resolution_target_mins * 0.75 then 'WARNING_75'
         else 'HEALTHY' end,
       current_escalation_tier = case
         when s.elapsed_active_mins > s.resolution_target_mins then 2
         else 1 end,
       escalated_at = case
         when s.elapsed_active_mins > s.resolution_target_mins then coalesce(s.escalated_at, now())
         else null end
  from public.work_orders w
 where s.target_type = 'WORK_ORDER'
   and s.target_id = w.id
   and s.closed_at is null;
