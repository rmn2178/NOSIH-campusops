import { supabase } from './client';

export type RealtimeChange = {
  table: string;
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  new: Record<string, unknown>;
  old: Record<string, unknown>;
};

export function subscribeToCampusFeed(
  onComplaint: (change: RealtimeChange) => void,
  onComment: (change: RealtimeChange) => void,
): () => void {
  const channel = supabase
    .channel('nosih-campus-feed')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'complaints', filter: 'moderation_status=eq.APPROVED' },
      (payload) => onComplaint(payload as unknown as RealtimeChange),
    )
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'complaint_comments' },
      (payload) => onComment(payload as unknown as RealtimeChange),
    )
    .subscribe();

  return () => {
    void supabase.removeChannel(channel);
  };
}

const TWIN_TABLES = [
  'rooms',
  'labs',
  'canteens',
  'bill_bots',
  'assets',
  'campus_clock_state',
  'timetable_slots',
  'incidents',
  'work_orders',
  'sla_clocks',
  'resource_locks',
] as const;

export function subscribeToTwinState(onChange: (change: RealtimeChange) => void): () => void {
  const channel = supabase.channel('nosih-live-twin');
  for (const table of TWIN_TABLES) {
    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table },
      (payload) => onChange(payload as unknown as RealtimeChange),
    );
  }
  channel.subscribe();
  return () => {
    void supabase.removeChannel(channel);
  };
}
