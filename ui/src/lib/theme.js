import { useEffect, useState } from 'react';

const KEY = 'aie2e:theme';
const media = () => window.matchMedia('(prefers-color-scheme: dark)');

/** @param {'system' | 'light' | 'dark'} pref */
function apply(pref) {
  const dark = pref === 'dark' || (pref === 'system' && media().matches);
  document.documentElement.classList.toggle('dark', dark);
}

/** Theme preference (system / light / dark), remembered per browser. */
export function useTheme() {
  const [pref, setPref] = useState(() => {
    try {
      return localStorage.getItem(KEY) || 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => {
    apply(pref);
    try {
      localStorage.setItem(KEY, pref);
    } catch {
      /* private mode */
    }
    if (pref !== 'system') return;
    const m = media();
    const on = () => apply('system');
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [pref]);
  return [pref, setPref];
}
