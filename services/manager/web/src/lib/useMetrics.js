import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/context/auth';

/**
 * /api/metrics 를 주기적으로 읽는다. intervalMs 가 0 이면 한 번만.
 *
 * 자원 수치는 보조 정보라서 실패해도 화면을 막지 않는다 — error 만 돌려주고 마지막 값은 그대로 둔다.
 * 세션 만료(401)만 로그인으로 보낸다.
 */
export function useMetrics(intervalMs = 5000) {
  const { logout } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const mounted = useRef(true);

  useEffect(() => () => {
    mounted.current = false;
  }, []);

  const load = useCallback(async () => {
    try {
      const result = await api.metrics();
      if (!mounted.current) return;
      setData(result);
      setError('');
    } catch (err) {
      if (!mounted.current) return;
      if (err instanceof ApiError && err.status === 401) {
        await logout();
        return;
      }
      setError(err.message || '자원 사용량을 불러오지 못했습니다.');
    }
  }, [logout]);

  useEffect(() => {
    load();
    if (!intervalMs) return undefined;
    const timer = setInterval(load, intervalMs);
    return () => clearInterval(timer);
  }, [load, intervalMs]);

  return { data, error, reload: load };
}
