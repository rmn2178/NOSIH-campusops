import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { signOut } from '@nosih/supabase-client';
import { restoreSession, setApiAccessToken } from '../api/client';
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
    (set) => ({
      token: null,
      user: null,
      hasHydrated: false,
      initialize: async () => {
        try {
          const session = await restoreSession();
          setApiAccessToken(session?.access_token ?? null);
          set({ token: session?.access_token ?? null, user: session?.user ?? null });
        } finally {
          set({ hasHydrated: true });
        }
      },
      setSession: ({ access_token, user }) => {
        setApiAccessToken(access_token);
        set({ token: access_token, user, hasHydrated: true });
      },
      logout: () => {
        void signOut();
        setApiAccessToken(null);
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
