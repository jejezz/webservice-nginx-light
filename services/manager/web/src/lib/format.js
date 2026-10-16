export function formatUptime(sec) {
  if (sec === null || sec === undefined) return '—';
  if (sec < 60) return `${sec}초`;

  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);

  if (d > 0) return `${d}일 ${h}시간`;
  if (h > 0) return `${h}시간 ${m}분`;
  return `${m}분`;
}

export function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('ko-KR', { hour12: false });
}

export function formatDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ko-KR', { hour12: false });
}

export function formatLatency(ms) {
  if (ms === null || ms === undefined) return '—';
  return `${ms} ms`;
}

export function formatBytes(bytes, digits = 1) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = Math.abs(bytes);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  // 바이트는 소수점이 의미 없다. 100 이상이면 자릿수도 줄인다 (예: 234 MB, 12.3 GB).
  const d = i === 0 || v >= 100 ? 0 : digits;
  return `${(bytes < 0 ? -v : v).toFixed(d)} ${units[i]}`;
}

/** 초당 바이트를 사람이 읽는 전송률로. 네트워크는 관례상 비트가 아니라 바이트로 보여 준다. */
export function formatRate(bytesPerSec) {
  if (bytesPerSec === null || bytesPerSec === undefined) return '—';
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatPercent(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

/** 사용률에 따른 색. 같은 기준을 막대·숫자·배지가 함께 쓴다. */
export function usageTone(percent) {
  if (percent == null) return 'default';
  if (percent >= 90) return 'destructive';
  if (percent >= 75) return 'warning';
  return 'default';
}
