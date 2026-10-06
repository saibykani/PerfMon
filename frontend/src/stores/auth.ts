import { create } from 'zustand';
import { api, tokenStore } from '@/services/api';

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  organizationId: string;
  organizationName: string;
  preferredView: string;
  roles: string[];
  permissions: string[];
}

interface AuthState {
  user: CurrentUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  load: () => Promise<void>;
  can: (perm: string) => boolean;
  setUser: (u: CurrentUser) => void;
}

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  loading: true,
  async login(email, password) {
    const res = await api.post<{ token: string; user: CurrentUser }>('/auth/login', { email, password });
    tokenStore.set(res.token);
    set({ user: res.user });
  },
  async logout() {
    try { await api.post('/auth/logout'); } catch { /* token may already be invalid */ }
    tokenStore.clear();
    set({ user: null });
  },
  async load() {
    if (!tokenStore.get()) return set({ loading: false, user: null });
    try {
      set({ user: await api.get<CurrentUser>('/auth/me'), loading: false });
    } catch {
      tokenStore.clear();
      set({ user: null, loading: false });
    }
  },
  can: (perm) => !!get().user?.permissions.includes(perm),
  setUser: (u) => set({ user: u }),
}));
