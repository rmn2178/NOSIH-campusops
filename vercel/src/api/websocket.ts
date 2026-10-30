import { rpc, supabase } from '@nosih/supabase-client';
import { mapComment, mapComplaint } from './client';
import type { Complaint, ComplaintComment } from './client';

export interface PortalSocketEvent {
  type: 'COMPLAINT_CREATED' | 'COMPLAINT_UPDATED' | 'COMMENT_CREATED' | 'TWIN_STATE_MUTATED' | string;
  complaint?: Complaint;
  complaint_id?: string;
  comment?: ComplaintComment;
  space_code?: string;
  visual_state?: Complaint['twin_state'];
  payload?: Record<string, unknown>;
}

type EventHandler = (event: PortalSocketEvent) => void;
type StatusHandler = (connected: boolean) => void;

/**
 * Supabase Realtime replaces the FastAPI WebSocket. The token argument is kept
 * for compatibility with the existing callers; Realtime authenticates from the
 * Supabase session.
 */
export function connectPortalSocket(_token: string, onEvent: EventHandler, onStatus: StatusHandler) {
  let disposed = false;

  const pushComplaint = async (id: unknown) => {
    try {
      const raw = await rpc.getComplaint(Number(id));
      if (!disposed) {
        onEvent({ type: 'COMPLAINT_UPDATED', complaint: mapComplaint(raw as Record<string, unknown>) });
      }
    } catch {
      // The next feed refresh will reconcile.
    }
  };

  const channel = supabase
    .channel('nosih-portal-feed')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'complaints', filter: 'moderation_status=eq.APPROVED' },
      (payload) => void pushComplaint((payload.new as Record<string, unknown>).id),
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'complaints', filter: 'moderation_status=eq.APPROVED' },
      (payload) => void pushComplaint((payload.new as Record<string, unknown>).id),
    )
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'complaint_comments' },
      (payload) => {
        if (disposed) return;
        const comment = mapComment(payload.new as Record<string, unknown>);
        onEvent({ type: 'COMMENT_CREATED', complaint_id: comment.complaint_id, comment });
      },
    )
    .subscribe((status) => {
      onStatus(status === 'SUBSCRIBED');
    });

  return () => {
    disposed = true;
    void supabase.removeChannel(channel);
    onStatus(false);
  };
}
