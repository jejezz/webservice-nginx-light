import { cn } from '@/lib/utils';
import { usageTone } from '@/lib/format';

const BAR = {
  default: 'bg-foreground/70',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
};

/** 사용률 막대. 색은 usageTone 기준 (75% 주의, 90% 위험). */
export function Meter({ percent, className }) {
  const pct = percent == null ? 0 : Math.max(0, Math.min(100, percent));
  return (
    <div
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-muted', className)}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className={cn('h-full rounded-full transition-all', BAR[usageTone(percent)])} style={{ width: `${pct}%` }} />
    </div>
  );
}
