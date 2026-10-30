-- Heal failed assets that outlived their complaint.
--
-- Reverted scenarios and pulse runs during the demo build left 13 fans, LEDs
-- and canteen appliances FAULTY in rooms that had no open complaint: the twin
-- painted the room green while its asset record listed failed equipment. This
-- restores those assets; only assets with no live complaint in their space are
-- touched, so intentional damage stays.

update public.assets a
   set status = 'OPERATIONAL'
 where a.status = 'FAULTY'
   and not exists (
     select 1
       from public.complaints c
      where c.space_code = a.parent_space_code
        and c.moderation_status = 'APPROVED'
        and c.status in ('OPEN', 'TRIAGED', 'IN_PROGRESS', 'BLOCKED_PARTS')
   );
