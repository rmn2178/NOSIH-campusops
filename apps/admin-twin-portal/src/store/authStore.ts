import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api, signOutAdmin } from '../api/client';
import type { User } from '../types';

interface AuthState {
  user: User | null;
  token: string | null;
  initializing: boolean;
  authenticating: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  restore: () => Promise<void>;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(persist((set, get) => ({
  user: null,
  token: null,
  initializing: true,
  authenticating: false,
  error: null,
  login: async (email, password) => {
    set({ authenticating: true, error: null });
    try {
      const response = await api.auth.login(email.trim().toLowerCase(), password);
      set({ token: response.access_token, user: response.user, authenticating: false });
    } catch (error) {
      set({
        token: null,
        user: null,
        authenticating: false,
        error: error instanceof Error ? error.message : 'Sign in failed',
      });
      throw error;
    }
  },
  restore: async () => {
    set({ initializing: true });
    try {
      const user = await api.auth.me();
      set({ user, token: get().token, initializing: false, error: null });
    } catch {
      set({ user: null, token: null, initializing: false });
    }
  },
  logout: () => {
    void signOutAdmin();
    set({ user: null, token: null, error: null, initializing: false });
  },
}), {
  name: 'nosih.admin.session',
  partialize: (state) => ({ user: state.user, token: state.token }),
}));
