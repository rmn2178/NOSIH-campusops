-- F5 clean demo state: revert any COMPLETED (i.e. still active) scenario runs so
-- the demo starts from the living-campus baseline. Pulse events are left alone —
-- the cron owns that state and C5-05 stays as the live twin showcase.
select public.rpc_reset_scenario(id, 'facilities@nosih.edu.in') as reset_result
from public.scenario_runs
where status = 'COMPLETED';

select id, scenario_key, status, summary_json->>'ticket_number' as ticket
from public.scenario_runs order by id;
