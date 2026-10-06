import { create } from 'zustand';

type Theme = 'light' | 'dark';
const read = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

const initialTheme = (): Theme => {
  const saved = read('perfmon.theme', '');
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

interface UiState {
  theme: Theme;
  toggleTheme: () => void;
  sidebarOpen: boolean;
  setSidebar: (v: boolean) => void;
  projectId: string | null;
  setProject: (id: string | null) => void;
}

export const useUi = create<UiState>((set, get) => ({
  theme: initialTheme(),
  toggleTheme() {
    const theme = get().theme === 'dark' ? 'light' : 'dark';
    write('perfmon.theme', theme);
    document.documentElement.dataset.theme = theme;
    set({ theme });
  },
  sidebarOpen: false,
  setSidebar: (v) => set({ sidebarOpen: v }),
  projectId: read('perfmon.project', '') || null,
  setProject(id) { write('perfmon.project', id ?? ''); set({ projectId: id }); },
}));

document.documentElement.dataset.theme = useUi.getState().theme;
