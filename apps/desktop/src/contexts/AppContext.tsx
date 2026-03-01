import { createContext, useContext } from 'react';
import type { AppInfo } from '@/types/desktop-bridge';

interface AppContextValue {
  apiBase: string;
  appInfo: AppInfo | null;
}

export const AppContext = createContext<AppContextValue>({
  apiBase: 'http://127.0.0.1:49732',
  appInfo: null,
});

export function useAppContext() {
  return useContext(AppContext);
}
