import { useCallback, useEffect, useState } from 'react';
import { api, type PublicAuthStatus } from './api';

export function useStatus() {
  const [status, setStatus] = useState<PublicAuthStatus>({ auth: 'signed_out' });
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.status());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  useEffect(() => {
    if (status.auth !== 'pending') return;
    const id = window.setInterval(() => void refresh(), 1000);
    return () => window.clearInterval(id);
  }, [status.auth, refresh]);

  return { status, error, refresh };
}
