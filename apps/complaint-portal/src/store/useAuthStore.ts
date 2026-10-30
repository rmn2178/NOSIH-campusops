import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { signOut } from '@nosih/supabase-client';
import { readProfile, readSessionToken, setApiAccessToken } from '../api/client';
import type { LoginResponse, SessionProfile } from '../api/client';

interface AuthState {
  token: string | null;
  user: SessionProfile | null;
  hasHydrated: boolean;
  initialize: () => Promise<void>;
  setSession: (session: LoginResponse) => void;
  logout: () => void;
  setHydrated: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      user: null,
      hasHydrated: false,
      initialize: async () => {
        const cached = get().user;
        let token: string | null = null;
        try {
          token = await readSessionToken();
        } catch {
          token = null;
        }
        setApiAccessToken(token);
        // Paint with the cached profile immediately; the network refresh below
        // only corrects it. Waiting for rpc_my_profile here blocked every reload.
        set({ token, hasHydrated: true });
        if (!token) {
          set({ user: null });
          return;
        }
        try {
          set({ user: await readProfile() });
        } catch {
          if (!cached) set({ token: null, user: null });
        }
      },
      setSession: ({ access_token, user }) => {
        setApiAccessToken(access_token);
        set({ token: access_token, user, hasHydrated: true });
      },
      logout: () => {
        void signOut();
        setApiAccessToken(null);
        sessionStorage.removeItem('nosih.feed.snapshot.v1');
        set({ token: null, user: null });
      },
      setHydrated: () => set({ hasHydrated: true }),
    }),
    {
      name: 'nosih.portal.session',
      partialize: (state) => ({ user: state.user }),
    },
  ),
);
