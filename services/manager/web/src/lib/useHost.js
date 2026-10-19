import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

// 장비 정보는 화면이 바뀌어도 그대로라 한 번만 받아 모두가 나눠 쓴다.
let cached = null;
let pending = null;

function load() {
  if (!pending) {
    pending = api.host()
      .then((h) => { cached = h; return h; })
      .catch(() => { pending = null; return null; });
  }
  return pending;
}

/** 이 장비의 {hostname, alias, address}. 받기 전이나 실패하면 null. */
export function useHost() {
  const [host, setHost] = useState(cached);
  useEffect(() => {
    if (cached) return undefined;
    let cancelled = false;
    load().then((h) => { if (!cancelled && h) setHost(h); });
    return () => { cancelled = true; };
  }, []);
  return host;
}
