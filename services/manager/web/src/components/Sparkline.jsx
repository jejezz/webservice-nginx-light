import { cn } from '@/lib/utils';

/**
 * 의존성 없는 작은 꺾은선. 값이 없는 구간(null)은 선을 끊는다.
 *
 *   values  숫자 배열 (오래된 것이 앞)
 *   max     세로 최대값. 없으면 values 의 최대값 — 퍼센트 그래프는 100 을 넘겨 눈금을 고정한다
 *   series  둘 이상을 겹칠 때 [{values, className}] (예: 수신/송신)
 */
export function Sparkline({ values, series, max, className, height = 36 }) {
  const lines = series || [{ values, className: 'stroke-foreground' }];
  const width = 120;
  const len = Math.max(...lines.map((l) => l.values.length), 2);
  const top =
    max ?? Math.max(1, ...lines.flatMap((l) => l.values.filter((v) => v != null)));

  const pathOf = (vals) => {
    let d = '';
    let pen = false;
    vals.forEach((v, i) => {
      if (v == null) {
        pen = false;
        return;
      }
      const x = (i / (len - 1)) * width;
      const y = height - 2 - (Math.min(v, top) / top) * (height - 4);
      d += `${pen ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cn('w-full', className)}
      style={{ height }}
      role="img"
      aria-hidden="true"
    >
      {lines.map((l, i) => (
        <path
          key={i}
          d={pathOf(l.values)}
          fill="none"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
          className={l.className || 'stroke-foreground'}
        />
      ))}
    </svg>
  );
}
