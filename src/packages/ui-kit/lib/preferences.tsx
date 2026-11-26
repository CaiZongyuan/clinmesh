import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from 'react';
import { z } from 'zod';

const preferencesSchema = z.object({ theme: z.enum(['light', 'dark', 'system']), fontScale: z.enum(['standard', 'larger', 'large']) });
type Preferences = z.infer<typeof preferencesSchema>;
const defaults: Preferences = { theme: 'system', fontScale: 'standard' };
const preferenceKey = 'clinmesh.ui.preferences.v1';
const PreferenceContext = createContext<(Preferences & { update: (change: Partial<Preferences>) => void }) | null>(null);

function readPreferences(): Preferences {
  try {
    const saved = window.localStorage.getItem(preferenceKey);
    return saved ? preferencesSchema.parse(JSON.parse(saved)) : defaults;
  } catch { return defaults; }
}

export function ThemeFontProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState(readPreferences);
  useLayoutEffect(() => {
    const { dataset } = document.documentElement;
    dataset.theme = preferences.theme;
    dataset.fontScale = preferences.fontScale;
  }, [preferences]);
  function update(change: Partial<Preferences>) {
    const next = { ...preferences, ...change };
    setPreferences(next);
    try { window.localStorage.setItem(preferenceKey, JSON.stringify(next)); } catch { /* Storage may be blocked by the browser. */ }
  }
  return <PreferenceContext.Provider value={{ ...preferences, update }}>{children}</PreferenceContext.Provider>;
}

export function useThemeFont() {
  const preferences = useContext(PreferenceContext);
  if (!preferences) throw new Error('useThemeFont requires ThemeFontProvider');
  return preferences;
}
