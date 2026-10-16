import { Link } from 'react-router-dom';
import { ArrowRight, Cpu, HardDrive, MemoryStick, Network } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Meter } from '@/components/Meter';
import { Sparkline } from '@/components/Sparkline';
import { formatBytes, formatPercent, formatRate, usageTone } from '@/lib/format';
import { cn } from '@/lib/utils';

const TONE_TEXT = { default: 'text-foreground', warning: 'text-warning', destructive: 'text-destructive' };

function ResourceCard({ label, Icon, value, tone = 'default', hint, children }) {
  return (
    <Card>
      <CardContent className="space-y-3 p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
            <p className={cn('text-2xl font-semibold tabular-nums', TONE_TEXT[tone])}>{value}</p>
            <p className="text-xs text-muted-foreground tabular-nums">{hint}</p>
          </div>
          <Icon className={cn('size-5 shrink-0', TONE_TEXT[tone])} />
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

/**
 * 대시보드에 올리는 장비 자원 요약 넷. 코어별·디스크별·NIC 별·서비스별 상세는 /resources 에 있다.
 * metrics 가 아직 없으면(첫 로딩, 측정 실패) 아무것도 그리지 않는다 — 서비스 상태가 이 화면의 본론이다.
 */
export function ResourceCards({ metrics }) {
  if (!metrics) return null;

  const { cpu, memory, disks, network, history } = metrics;
  const memPct = memory.totalBytes ? (memory.usedBytes / memory.totalBytes) * 100 : null;
  // 저장소는 가장 찬 디스크 하나만 올린다 — 평균은 가득 찬 디스크를 가린다.
  const fullest = disks.reduce((a, b) => (a && a.percent >= b.percent ? a : b), null);

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">장비 자원</h2>
        <Link to="/resources" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          자세히 <ArrowRight className="size-3" />
        </Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <ResourceCard
          label="CPU"
          Icon={Cpu}
          value={formatPercent(cpu.percent)}
          tone={usageTone(cpu.percent)}
          hint={`${cpu.coreCount}코어 · load ${cpu.loadAvg.map((v) => v.toFixed(2)).join(' ')}`}
        >
          <Sparkline values={history.map((h) => h.cpu)} max={100} className="stroke-foreground/70" />
        </ResourceCard>

        <ResourceCard
          label="RAM"
          Icon={MemoryStick}
          value={formatPercent(memPct)}
          tone={usageTone(memPct)}
          hint={`${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}`}
        >
          <Sparkline values={history.map((h) => h.mem)} max={100} className="stroke-foreground/70" />
        </ResourceCard>

        <ResourceCard
          label="Storage"
          Icon={HardDrive}
          value={fullest ? formatPercent(fullest.percent) : '—'}
          tone={usageTone(fullest?.percent)}
          hint={fullest ? `${fullest.mount} · ${formatBytes(fullest.usedBytes)} / ${formatBytes(fullest.totalBytes)}` : '디스크 없음'}
        >
          <Meter percent={fullest?.percent} className="mt-5" />
        </ResourceCard>

        <ResourceCard
          label="Network"
          Icon={Network}
          value={formatRate((network.rxBytesPerSec ?? 0) + (network.txBytesPerSec ?? 0))}
          hint={`↓ ${formatRate(network.rxBytesPerSec)} · ↑ ${formatRate(network.txBytesPerSec)}`}
        >
          <Sparkline
            series={[
              { values: history.map((h) => h.rx), className: 'stroke-foreground/70' },
              { values: history.map((h) => h.tx), className: 'stroke-muted-foreground' },
            ]}
          />
        </ResourceCard>
      </div>
    </section>
  );
}
