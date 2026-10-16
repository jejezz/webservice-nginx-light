import { AlertTriangle, CheckCircle2, HelpCircle, MinusCircle, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

const MAP = {
  up: { label: '정상', variant: 'success', Icon: CheckCircle2 },
  degraded: { label: '주의', variant: 'warning', Icon: AlertTriangle },
  down: { label: '중단', variant: 'destructive', Icon: XCircle },
  unknown: { label: '알 수 없음', variant: 'secondary', Icon: HelpCircle },
  // 쓰지 않기로 한 선택 서비스(예: LAN 전용의 coturn). 고장이 아니다.
  optional: { label: '불필요', variant: 'outline', Icon: MinusCircle },
};

export function StatusBadge({ status, className, title }) {
  const { label, variant, Icon } = MAP[status] || MAP.unknown;

  return (
    <Badge variant={variant} className={className} title={title}>
      <Icon className="size-3" />
      {label}
    </Badge>
  );
}

export function StatusDot({ status }) {
  const color =
    status === 'up'
      ? 'bg-success'
      : status === 'degraded'
        ? 'bg-warning'
        : status === 'down'
          ? 'bg-destructive'
          : 'bg-muted-foreground';

  return (
    <span className="relative flex size-2.5">
      {status === 'up' && (
        <span className={`absolute inline-flex size-full animate-ping rounded-full ${color} opacity-60`} />
      )}
      <span className={`relative inline-flex size-2.5 rounded-full ${color}`} />
    </span>
  );
}
