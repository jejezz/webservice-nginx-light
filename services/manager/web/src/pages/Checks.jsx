import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle, CheckCircle2, Circle, Copy, HelpCircle, Loader2, MinusCircle, RefreshCw, Timer, XCircle,
} from 'lucide-react';
import { useAuth } from '@/context/auth';
import { api, ApiError } from '@/lib/api';
import { formatTime } from '@/lib/format';
import { CheckApply } from '@/components/CheckApply';
import { TopBar } from '@/components/TopBar';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

// check-all.sh 의 상태 → 화면. 여섯 가지를 그대로 옮기고 화면이 다시 판정하지 않는다.
const STATUS = {
  ok: { Icon: CheckCircle2, tone: 'text-success', badge: 'success', label: '정상', attention: false },
  problem: { Icon: XCircle, tone: 'text-destructive', badge: 'destructive', label: '어긋남', attention: true },
  pending: { Icon: Circle, tone: 'text-warning', badge: 'warning', label: '아직 안 함', attention: true },
  timeout: { Icon: Timer, tone: 'text-destructive', badge: 'destructive', label: '시간 초과', attention: true },
  optional: { Icon: MinusCircle, tone: 'text-muted-foreground', badge: 'secondary', label: '선택 · 안 함', attention: false },
  unreadable: { Icon: HelpCircle, tone: 'text-muted-foreground', badge: 'secondary', label: '읽지 못함', attention: false },
  error: { Icon: AlertCircle, tone: 'text-destructive', badge: 'destructive', label: '실행 실패', attention: true },
};

function CopyButton({ text }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-6 shrink-0"
      title="복사"
      onClick={async () => {
        try {
          // HTTP(비보안 컨텍스트)에서는 clipboard 가 없다 — 그때는 글자를 직접 고르면 된다.
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* 복사는 편의일 뿐이다 */
        }
      }}
    >
      {done ? <CheckCircle2 className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
    </Button>
  );
}

function CheckRow({ row, onRerun, busy }) {
  const { label, state, result, error } = row;
  const status = state === 'done' ? result.status : state === 'error' ? 'error' : null;
  const meta = status ? STATUS[status] : null;
  const lines = state === 'done' ? result.lines : [];
  const showFix = state === 'done' && result.fix && (status === 'problem' || status === 'pending' || status === 'timeout');
  // 반영 뒤 다시 점검하는 동안에는 줄 상태가 잠깐 비는데, 그때 반영 패널(과 그 로그)을 내리면 안 된다 —
  // 반영했는데도 여전히 어긋난 경우에 그 로그가 가장 필요하다. 그래서 재점검 중에는 직전 결과를 본다.
  const lastStatus = status || (state === 'running' ? result?.status : null);
  const offerApply = lastStatus === 'problem' || lastStatus === 'pending';

  return (
    <div className="border-b border-border/60 px-5 py-3 last:border-b-0">
      <div className="flex items-center gap-3">
        <div className="w-5 shrink-0">
          {meta ? (
            <meta.Icon className={cn('size-5', meta.tone)} />
          ) : state === 'running' ? (
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          ) : (
            <Circle className="size-5 text-muted-foreground/40" />
          )}
        </div>

        <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>

        {meta && <Badge variant={meta.badge}>{meta.label}</Badge>}
        {state === 'done' && (
          <span className="hidden shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-muted-foreground sm:block">
            {formatTime(result.checkedAt)} · {(result.durationMs / 1000).toFixed(1)}초
          </span>
        )}
        <Button variant="ghost" size="icon" className="size-7" title="이 줄만 다시 점검" onClick={onRerun} disabled={busy || state === 'running'}>
          <RefreshCw className={cn('size-3.5', state === 'running' && 'animate-spin')} />
        </Button>
      </div>

      {(lines.length > 0 || showFix || error || (row.apply && offerApply)) && (
        <div className="ml-8 mt-2 space-y-1">
          {error && <p className="font-mono text-xs text-destructive">{error}</p>}
          {lines.map((l, i) => (
            <p key={i} className="break-words font-mono text-xs text-muted-foreground">{l}</p>
          ))}
          {showFix && (
            <div className="mt-2 flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5">
              <span className="shrink-0 text-xs text-muted-foreground">반영 명령</span>
              <code className="min-w-0 flex-1 truncate font-mono text-xs" title={result.fix}>{result.fix}</code>
              <CopyButton text={result.fix} />
            </div>
          )}
          {offerApply && <CheckApply check={row} onFinished={onRerun} />}
        </div>
      )}
    </div>
  );
}

export default function Checks() {
  const { logout } = useAuth();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);

  const mounted = useRef(true);
  // 새 점검을 시작하면 앞선 순차 실행은 멈춘다 (다시 점검을 연타해도 겹쳐 돌지 않는다).
  const generation = useRef(0);

  useEffect(() => () => {
    mounted.current = false;
  }, []);

  const patch = useCallback((id, next) => {
    if (!mounted.current) return;
    setRows((prev) => prev && prev.map((r) => (r.id === id ? { ...r, ...next } : r)));
  }, []);

  const runRow = useCallback(
    async (id) => {
      patch(id, { state: 'running', error: '' });
      try {
        const result = await api.checks.run(id);
        patch(id, { state: 'done', result });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          await logout();
          return;
        }
        // 프록시 시간 제한(504)처럼 줄 하나가 실패해도 나머지는 계속 본다.
        patch(id, { state: 'error', error: err.message || '점검을 실행하지 못했습니다.' });
      }
    },
    [logout, patch],
  );

  const runAll = useCallback(
    async (list) => {
      const mine = ++generation.current;
      setRunning(true);
      setRows((prev) => (prev || list).map((r) => ({ ...r, state: 'queued', result: null, error: '' })));
      // 한 줄씩 순서대로 — check-all.sh 의 순서(nginx 가 마지막)를 지키고, 점검끼리 장비를 다투지 않게.
      for (const r of list) {
        if (!mounted.current || generation.current !== mine) return;
        await runRow(r.id);
      }
      if (mounted.current && generation.current === mine) setRunning(false);
    },
    [runRow],
  );

  const start = useCallback(async () => {
    try {
      const { checks } = await api.checks.list();
      if (!mounted.current) return;
      const list = checks.map((c) => ({ ...c, state: 'queued', result: null, error: '' }));
      setRows(list);
      setError('');
      await runAll(list);
    } catch (err) {
      if (!mounted.current) return;
      if (err instanceof ApiError && err.status === 401) {
        await logout();
        return;
      }
      setError(err.message || '점검 목록을 불러오지 못했습니다.');
    }
  }, [logout, runAll]);

  useEffect(() => {
    start();
  }, [start]);

  const done = rows ? rows.filter((r) => r.state === 'done' || r.state === 'error') : [];
  const statusOf = (r) => (r.state === 'error' ? 'error' : r.result?.status);
  const attention = done.filter((r) => STATUS[statusOf(r)]?.attention).length;
  const okCount = done.filter((r) => statusOf(r) === 'ok').length;
  const finished = rows && done.length === rows.length;

  return (
    <div className="min-h-screen bg-background">
      <TopBar subtitle="점검 · 설치본이 저장소 선언과 같은가">
        <Button variant="outline" size="sm" onClick={start} disabled={running}>
          <RefreshCw className={cn('size-3.5', running && 'animate-spin')} />
          <span className="hidden sm:inline">전체 다시 점검</span>
        </Button>
      </TopBar>

      <main className="mx-auto max-w-4xl space-y-6 px-4 py-6 sm:px-6">
        {error && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {!rows ? (
          !error && <Skeleton className="h-96" />
        ) : (
          <>
            <Card>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5">
                <div>
                  <p className={cn('text-lg font-semibold', finished && (attention ? 'text-warning' : 'text-success'))}>
                    {!finished
                      ? `점검 중… ${done.length} / ${rows.length}`
                      : attention
                        ? `${attention}곳이 어긋나 있습니다`
                        : '설치본이 선언과 같습니다'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    정상 {okCount} · 확인할 곳 {attention}
                    {finished ? ` · 전체 ${rows.length}줄` : ''}
                  </p>
                </div>
                <p className="max-w-sm text-xs text-muted-foreground">
                  터미널의 <code className="font-mono">./check-all.sh</code> 와 같은 점검입니다. 아무것도 바꾸지 않고,
                  어긋난 곳의 반영 명령만 보여 줍니다. 위에서 아래 순서대로 처리하세요 — nginx 는 맨 마지막입니다.
                </p>
              </CardContent>
            </Card>

            <Card>
              {rows.map((r) => (
                <CheckRow key={r.id} row={r} busy={running} onRerun={() => runRow(r.id)} />
              ))}
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
