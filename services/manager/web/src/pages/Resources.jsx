import { AlertCircle } from 'lucide-react';
import { TopBar } from '@/components/TopBar';
import { Meter } from '@/components/Meter';
import { Sparkline } from '@/components/Sparkline';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useMetrics } from '@/lib/useMetrics';
import { formatBytes, formatDateTime, formatPercent, formatRate, formatTime, formatUptime, usageTone } from '@/lib/format';

const TONE_TEXT = { default: 'text-foreground', warning: 'text-warning', destructive: 'text-destructive' };

function Section({ title, aside, children }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">{title}</CardTitle>
        {aside}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/50 py-1.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate font-mono text-xs">{value}</dd>
    </div>
  );
}

function CpuSection({ cpu, history }) {
  return (
    <Section
      title="CPU"
      aside={<span className="text-xs text-muted-foreground">{cpu.model}</span>}
    >
      <div className="grid gap-6 lg:grid-cols-[2fr_3fr]">
        <div className="space-y-3">
          <p className={`text-3xl font-semibold tabular-nums ${TONE_TEXT[usageTone(cpu.percent)]}`}>
            {formatPercent(cpu.percent, 1)}
          </p>
          <Sparkline values={history.map((h) => h.cpu)} max={100} height={64} className="stroke-foreground/70" />
          <p className="text-xs text-muted-foreground">최근 10분 · load average (1·5·15분) {cpu.loadAvg.map((v) => v.toFixed(2)).join(' · ')}</p>
        </div>

        <div>
          <p className="mb-2 text-xs text-muted-foreground">코어별 ({cpu.coreCount}개)</p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
            {cpu.cores.map((c, i) => (
              <div key={i} className="space-y-1">
                <div className="flex justify-between text-xs tabular-nums">
                  <span className="text-muted-foreground">#{i}</span>
                  <span>{formatPercent(c)}</span>
                </div>
                <Meter percent={c} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </Section>
  );
}

function MemorySection({ memory, history }) {
  const pct = memory.totalBytes ? (memory.usedBytes / memory.totalBytes) * 100 : null;
  const swapPct = memory.swapTotalBytes ? (memory.swapUsedBytes / memory.swapTotalBytes) * 100 : null;

  return (
    <Section title="RAM">
      <div className="grid gap-6 lg:grid-cols-[2fr_3fr]">
        <div className="space-y-3">
          <p className={`text-3xl font-semibold tabular-nums ${TONE_TEXT[usageTone(pct)]}`}>{formatPercent(pct, 1)}</p>
          <Sparkline values={history.map((h) => h.mem)} max={100} height={64} className="stroke-foreground/70" />
          <p className="text-xs text-muted-foreground">최근 10분</p>
        </div>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">사용 중</span>
              <span className="tabular-nums">{formatBytes(memory.usedBytes)} / {formatBytes(memory.totalBytes)}</span>
            </div>
            <Meter percent={pct} />
          </div>
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">스왑</span>
              <span className="tabular-nums">
                {memory.swapTotalBytes ? `${formatBytes(memory.swapUsedBytes)} / ${formatBytes(memory.swapTotalBytes)}` : '없음'}
              </span>
            </div>
            <Meter percent={swapPct} />
          </div>
          <dl className="grid grid-cols-2 gap-x-8">
            <Row label="사용 가능" value={formatBytes(memory.availableBytes)} />
            <Row label="캐시 · 버퍼" value={formatBytes(memory.cachedBytes)} />
          </dl>
          <p className="text-xs text-muted-foreground">
            캐시는 필요하면 커널이 되돌려 주는 메모리라 '사용 중' 에 넣지 않습니다. 사용률은 (전체 − 사용 가능) 입니다.
          </p>
        </div>
      </div>
    </Section>
  );
}

function StorageSection({ disks }) {
  return (
    <Section title="Storage">
      {disks.length === 0 ? (
        <p className="text-xs text-muted-foreground">읽을 수 있는 디스크가 없습니다.</p>
      ) : (
        <div className="space-y-4">
          {disks.map((d) => (
            <div key={d.device} className="space-y-1.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                <span className="font-mono text-sm">{d.mount}</span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {formatBytes(d.usedBytes)} / {formatBytes(d.totalBytes)} · 남은 {formatBytes(d.availBytes)} ·{' '}
                  <span className={TONE_TEXT[usageTone(d.percent)]}>{formatPercent(d.percent, 1)}</span>
                </span>
              </div>
              <Meter percent={d.percent} />
              <p className="font-mono text-xs text-muted-foreground">{d.device} · {d.fsType}</p>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function NetworkSection({ network, history }) {
  return (
    <Section title="Network">
      <div className="grid gap-6 lg:grid-cols-[2fr_3fr]">
        <div className="space-y-3">
          <div className="flex gap-8">
            <div>
              <p className="text-xs text-muted-foreground">수신 ↓</p>
              <p className="text-2xl font-semibold tabular-nums">{formatRate(network.rxBytesPerSec)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">송신 ↑</p>
              <p className="text-2xl font-semibold tabular-nums">{formatRate(network.txBytesPerSec)}</p>
            </div>
          </div>
          <Sparkline
            height={64}
            series={[
              { values: history.map((h) => h.rx), className: 'stroke-foreground/70' },
              { values: history.map((h) => h.tx), className: 'stroke-muted-foreground' },
            ]}
          />
          <p className="text-xs text-muted-foreground">
            최근 10분 · 진한 선 수신, 옅은 선 송신 · 누적 ↓ {formatBytes(network.rxTotalBytes)} ↑ {formatBytes(network.txTotalBytes)} (부팅 이후)
          </p>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>인터페이스</TableHead>
              <TableHead>링크</TableHead>
              <TableHead className="text-right">↓</TableHead>
              <TableHead className="text-right">↑</TableHead>
              <TableHead className="text-right">오류</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {network.interfaces.map((i) => (
              <TableRow key={i.name}>
                <TableCell className="font-mono text-xs">{i.name}</TableCell>
                <TableCell>
                  <Badge variant={i.state === 'up' ? 'success' : 'secondary'}>{i.state || '—'}</Badge>
                  {i.speedMbps && <span className="ml-2 text-xs text-muted-foreground">{i.speedMbps} Mbps</span>}
                </TableCell>
                <TableCell className="text-right text-xs tabular-nums">{formatRate(i.rxBytesPerSec)}</TableCell>
                <TableCell className="text-right text-xs tabular-nums">{formatRate(i.txBytesPerSec)}</TableCell>
                <TableCell className={`text-right text-xs tabular-nums ${i.errors ? 'text-destructive' : 'text-muted-foreground'}`}>
                  {i.errors}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Section>
  );
}

function ServicesSection({ systemd, pm2 }) {
  // pm2 앱과 systemd 유닛을 한 표로 — 메모리 큰 순. 어느 서비스가 장비를 먹고 있는지가 이 표의 질문이다.
  const rows = [
    ...pm2.map((p) => ({
      key: `pm2:${p.name}`,
      name: p.name,
      kind: 'pm2',
      running: p.status === 'online',
      status: p.status,
      cpu: p.cpu,
      memoryBytes: p.memoryBytes,
      note: p.restarts ? `재시작 ${p.restarts}회` : '',
    })),
    ...systemd.map((u) => ({
      key: `systemd:${u.name}`,
      name: u.name,
      kind: 'systemd',
      running: u.active,
      status: u.state,
      cpu: u.cpu,
      memoryBytes: u.memoryBytes,
      note: '',
    })),
  ].sort((a, b) => (b.memoryBytes ?? -1) - (a.memoryBytes ?? -1));

  const maxMem = Math.max(1, ...rows.map((r) => r.memoryBytes ?? 0));

  return (
    <Section title="서비스별 사용량" aside={<span className="text-xs text-muted-foreground">CPU 는 코어 하나를 100% 로 본 값</span>}>
      <div className="-mx-6 -mb-6">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>서비스</TableHead>
              <TableHead>관리</TableHead>
              <TableHead>상태</TableHead>
              <TableHead className="text-right">CPU</TableHead>
              <TableHead className="w-[40%]">메모리</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.key}>
                <TableCell className="font-mono text-xs">
                  {r.name}
                  {r.note && <span className="ml-2 text-muted-foreground">{r.note}</span>}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{r.kind}</TableCell>
                <TableCell>
                  <Badge variant={r.running ? 'success' : 'destructive'}>{r.status}</Badge>
                </TableCell>
                <TableCell className="text-right text-xs tabular-nums">
                  {r.running && r.cpu != null ? formatPercent(r.cpu, 1) : '—'}
                </TableCell>
                <TableCell>
                  {r.memoryBytes != null ? (
                    <div className="flex items-center gap-3">
                      <Meter percent={(r.memoryBytes / maxMem) * 100} className="flex-1" />
                      <span className="w-20 text-right text-xs tabular-nums">{formatBytes(r.memoryBytes)}</span>
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="mt-6 text-xs text-muted-foreground">
        막대는 이 표 안에서 가장 큰 것을 100% 로 둔 상대 크기입니다. systemd 유닛의 CPU 는 10초 간격의 차이로 재므로 처음 10초는 비어 있습니다.
      </p>
    </Section>
  );
}

export default function Resources() {
  const { data, error } = useMetrics(5000);

  return (
    <div className="min-h-screen bg-background">
      <TopBar
        subtitle={
          data ? (
            <>
              자원 · 부팅 후 {formatUptime(data.uptimeSec)} · 갱신 {formatTime(data.at)}
            </>
          ) : (
            '자원 · 불러오는 중…'
          )
        }
      />

      <main className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6">
        {error && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {!data ? (
          !error && (
            <div className="space-y-6">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-56" />
              ))}
            </div>
          )
        ) : (
          <>
            <CpuSection cpu={data.cpu} history={data.history} />
            <MemorySection memory={data.memory} history={data.history} />
            <StorageSection disks={data.disks} />
            <NetworkSection network={data.network} history={data.history} />
            <ServicesSection systemd={data.systemd} pm2={data.pm2} />
            <p className="pb-4 text-center text-xs text-muted-foreground">
              5초마다 재는 값이고 기록은 manager 가 재기동하면 비워집니다. 시작 {formatDateTime(data.history[0] && new Date(data.history[0].t).toISOString())}
            </p>
          </>
        )}
      </main>
    </div>
  );
}
