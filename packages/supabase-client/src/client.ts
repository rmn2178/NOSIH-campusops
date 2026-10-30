import { createClient } from '@supabase/supabase-js';

const url = (import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/$/, '');
const key =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
  import.meta.env.VITE_SUPABASE_ANON_KEY ??
  '';

if (!url || !key) {
  console.warn('VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY are not set');
}

export const supabase = createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  realtime: { params: { eventsPerSecond: 40 } },
});

const AUTH_ERROR = /jwt|invalid claim|session (is )?expired|token has expired|access token|refresh token|unauthori[sz]ed/i;

export function unwrap<T>(result: { data: T; error: { message: string } | null }): T {
  if (result.error) {
    // Let the shells return to the sign-in gate when the token is no longer
    // accepted, instead of leaving every panel with a silent 401.
    if (AUTH_ERROR.test(result.error.message) && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('nosih:unauthorized'));
    }
    throw new Error(result.error.message);
  }
  return result.data;
}
