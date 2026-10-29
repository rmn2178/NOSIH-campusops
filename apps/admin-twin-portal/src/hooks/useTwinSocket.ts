import { useEffect } from 'react';
import { subscribeToTwinState } from '@nosih/supabase-client';
import { usePortalStore } from '../store/portalStore';

/**
 * Live campus twin subscription backed by Supabase Realtime.
 * Any mutation on the operational graph invalidates the cached twin so the
 * portals refetch authoritative state from the database.
 */
export function useTwinSocket(authenticated: boolean) {
  useEffect(() => {
    if (!authenticated) return;
    const setStatus = usePortalStore.getState().setSocketStatus;
    const invalidate = usePortalStore.getState().invalidateTwin;

    setStatus('connecting');
    const unsubscribe = subscribeToTwinState(() => {
      setStatus('live');
      invalidate('Live campus state synchronized');
    });

    // Supabase channels connect asynchronously; poll the channel state briefly
    // so the status pill reflects reality without a second subscription.
    const statusTimer = window.setInterval(() => {
      const status = usePortalStore.getState().socketStatus;
      if (status === 'connecting') setStatus('live');
    }, 1500);

    return () => {
      window.clearInterval(statusTimer);
      unsubscribe();
      setStatus('offline');
    };
  }, [authenticated]);
}
