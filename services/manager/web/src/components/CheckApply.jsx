import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Lock, Play, Square, UserRound, Wrench } from 'lucide-react';
import { useAuth } from '@/context/auth';
import { api, ApiError } from '@/lib/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * 어긋난 점검 줄의 '자동으로 반영'.
 *
 * 돌리는 것은 서버가 정한다 — 점검 번호가 가리키는 구축 마법사 단계의 자동 실행 표(setup.js AUTO)뿐이다.
 * 이 컴포넌트가 보내는 것은 점검 번호와 sudo 비밀번호이고, 비밀번호는 상태에만 두었다가 보낸 즉시 비운다.
 * 끝나면 그 줄을 다시 점검한다(onFinished) — 고쳐졌는지는 점검이 정한다.
 *
 * HTTPS 가 아니면 서버가 거부한다. 여기서는 그 경우를 미리 알려 주고 단추를 막을 뿐이다.
 */

const SECURE =
  typeof window !== 'undefined' &&
  (window.location.protocol === 'https:' || ['127.0.0.1', 'localhost'].includes(window.location.hostname));

const LINE_TONE = { cmd: 'text-primary', err: 'text-warning', out: '' };
const POLL_MS = 1000;

export function CheckApply({ check, onFinished }) {
  const { user } = useAuth();
  const info = check.apply;
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [job, setJob] = useState(null);
  const [lines, setLines] = useState([]);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const nextRef = useRef(0);
  const logRef = useRef(null);
  const finishedRef = useRef(null);

  const running = job?.status === 'running';
  const isAdmin = user?.role === 'admin';

  const poll = useCallback(async () => {
    try {
      const { job: j } = await api.checks.applyStatus(check.id, nextRef.current);
      if (!j) return;
      if (j.lines.length) {
        setLines((prev) => [...prev, ...j.lines]);
        nextRef.current = j.next;
      }
      setJob(j);
    } catch {
      // nginx 반영처럼 연결이 잠깐 끊기는 작업이 있다 — 다음 주기에 이어서 읽는다.
    }
  }, [check.id]);

  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(poll, POLL_MS);
    return () => clearInterval(t);
  }, [running, poll]);

  // 화면을 새로 열었을 때 이미 돌고 있는 작업이 있으면 이어서 보여 준다 (예: 새로 고침, 다른 사람이 시작).
  useEffect(() => {
    if (!info?.available || !isAdmin) return;
    api.checks
      .applyStatus(check.id, 0)
      .then(({ job: j }) => {
        if (!j || j.status !== 'running') return;
        setOpen(true);
        setLines(j.lines);
        nextRef.current = j.next;
        setJob(j);
      })
      .catch(() => {});
  }, [check.id, info?.available, isAdmin]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines]);

  // 끝난 작업은 한 번만 다시 점검한다. 실패한 것은 고쳐지지 않았으므로 점검을 부르지 않는다.
  useEffect(() => {
    if (job && job.status !== 'running' && finishedRef.current !== job.id) {
      finishedRef.current = job.id;
      if (job.status === 'ok') onFinished();
    }
  }, [job, onFinished]);

  if (!info) return null;

  if (!info.available) {
    // 사람이 해야 하는 단계는 이유를 말해 준다. 단계가 아예 없는 줄(manager · pm2)은 아무것도 내밀지 않는다.
    return info.reason ? (
      <p className="mt-2 text-xs text-muted-foreground">
        <UserRound className="mr-1 inline size-3.5" />
        자동 반영 없음 — {info.reason}
      </p>
    ) : null;
  }

  const start = async () => {
    setError('');
    setStarting(true);
    try {
      const j = await api.checks.apply(check.id, info.needsSudo ? { sudoPassword: password } : {});
      setPassword('');
      finishedRef.current = null;
      nextRef.current = j.next;
      setLines(j.lines);
      setJob(j);
    } catch (err) {
      setPassword('');
      setError(err instanceof ApiError ? err.message : '시작하지 못했습니다.');
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    try {
      await api.checks.applyCancel(check.id);
    } catch {
      setError('중단 요청이 서버에 닿지 않았습니다 — 연결이 끊긴 것일 수 있습니다.');
    }
  };

  if (!open) {
    return (
      <div className="mt-2">
        <Button variant="outline" size="sm" onClick={() => setOpen(true)} disabled={!isAdmin} title={isAdmin ? '' : 'admin 권한이 필요합니다'}>
          <Wrench className="size-3.5" />
          자동으로 반영
        </Button>
        {!isAdmin && <span className="ml-2 text-xs text-muted-foreground">admin 권한이 필요합니다</span>}
      </div>
    );
  }

  const canStart = !running && !starting && SECURE && (!info.needsSudo || password);

  return (
    <div className="mt-3 space-y-3 rounded-md border bg-background p-3">
      <div>
        <p className="mb-1 text-xs font-medium">이 명령들을 순서대로 돌립니다</p>
        <ul className="space-y-0.5">
          {info.commands.map((c, i) => (
            <li key={i} className="font-mono text-xs text-muted-foreground">
              {c.text} <span className="opacity-60">(cd {c.cwd})</span>
            </li>
          ))}
        </ul>
      </div>

      {info.note && <p className="text-xs text-muted-foreground">{info.note}</p>}

      {info.changesOrigin && (
        <p className="text-xs text-warning">
          nginx 를 다시 읽혀 이 화면의 연결이 잠깐 끊기거나 주소가 바뀔 수 있습니다. 끊기면 다시 열어 이 줄을 점검하세요.
        </p>
      )}

      {!SECURE && (
        <Alert variant="destructive">
          <Lock />
          <AlertDescription>
            HTTPS 가 아닌 연결에서는 반영할 수 없습니다. sudo 비밀번호가 평문으로 오가지 않도록 서버가 거부합니다 —{' '}
            <code className="font-mono">https://</code> 주소로 다시 여세요.
          </AlertDescription>
        </Alert>
      )}

      {info.needsSudo && !running && (
        <div className="flex items-center gap-2">
          <Lock className="size-3.5 shrink-0 text-muted-foreground" />
          <Input
            type="password"
            autoComplete="off"
            placeholder="이 장비의 sudo 비밀번호"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && canStart && start()}
            className="h-8 max-w-xs text-xs"
          />
        </div>
      )}

      <div className="flex items-center gap-2">
        {running ? (
          <Button variant="outline" size="sm" onClick={cancel}>
            <Square className="size-3.5" />
            중단
          </Button>
        ) : (
          <Button size="sm" onClick={start} disabled={!canStart}>
            {starting ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
            실행
          </Button>
        )}
        {!running && !job && (
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            닫기
          </Button>
        )}
        {job && (
          <Badge variant={job.status === 'ok' ? 'success' : job.status === 'running' ? 'secondary' : 'destructive'}>
            {job.status === 'running' ? `실행 중 ${job.current}/${job.total}` : job.status === 'ok' ? '끝남 — 다시 점검합니다' : job.status === 'cancelled' ? '중단됨' : '실패'}
          </Badge>
        )}
        {running && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {lines.length > 0 && (
        <pre ref={logRef} className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs">
          {lines.map((l, i) => (
            <div key={i} className={cn('whitespace-pre-wrap break-words', LINE_TONE[l.stream])}>{l.text}</div>
          ))}
        </pre>
      )}
      {job?.truncated && <p className="text-xs text-muted-foreground">출력이 길어 일부만 보여 줍니다.</p>}
    </div>
  );
}
