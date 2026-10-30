-- F4 seed realism: redistribute maintenance history over the last 90 days.
-- Before: 50 records scattered 2025-11-02 .. 2026-01-27 (nine months stale).
-- After: same records, chronological order kept, spread evenly across the last
-- 90 days ending ~2 hours ago, so the twin's repair records look freshly lived-in.

with ordered as (
  select id, row_number() over (order by completed_at desc) as rn
  from public.maintenance_history
)
update public.maintenance_history mh
set completed_at = now() - interval '2 hours' - ((o.rn - 1) * 1.8) * interval '1 day'
from ordered o
where mh.id = o.id;
