import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Play, Square, Terminal, UserRound } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * 단계의 명령을 자동으로 돌릴지 사람이 직접 할지 고른다.
 *
 * 돌리는 것은 서버가 단계 표에서 정한 명령뿐이다 — 이 컴포넌트가 보내는 것은
 * 단계 id 와 sudo 비밀번호 둘이다. 비밀번호는 상태에만 두고, 보낸 즉시 비운다.
 * 끝나면 점검을 한 번 부른다(onFinished) — 통과 여부는 점검이 정한다.
 */

// 평문 HTTP 로 열린 화면(127.0.0.1 터널이 아닌 곳)에서는 비밀번호가 암호화되지 않고 오간다.
const PLAINTEXT =
  typeof window !== 'undefined' &&
  window.location.protocol === 'http:' &&
  !['127.0.0.1', 'localhost'].includes(window.location.hostname);

const LINE_TONE = { cmd: 'text-primary', err: 'text-warning', out: '' };
const POLL_MS = 1000;

export function AutoRunner({ step, mode, onMode, onFinished, blockedReason, children }) {
  const info = step.auto;
  const [password, setPassword] = useState('');
  const [dbUser, setDbUser] = useState('root');
  const [dbPassword, setDbPassword] = useState('');
  const [job, setJob] = useState(null);
  const [lines, setLines] = useState([]);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [pollFailures, setPollFailures] = useState(0);
  const nextRef = useRef(0);
  const logRef = useRef(null);
  const finishedRef = useRef(null);

  const running = job?.status === 'running';

  // 진행 읽기 — 이미 받은 줄 뒤만 가져온다.
  const poll = useCallback(async () => {
    try {
      const { job: j } = await api.setup.autoStatus(step.id, nextRef.current);
      if (!j) return;
      if (j.lines.length) {
        setLines((prev) => [...prev, ...j.lines]);
        nextRef.current = j.next;
      }
      setJob(j);
      setPollFailures(0);
    } catch {
      // 일시적인 끊김은 다음 주기에 이어서 읽는다. 계속 실패하면 아래에서 알린다.
      setPollFailures((n) => n + 1);
    }
  }, [step.id]);

  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(poll, POLL_MS);
    return () => clearInterval(t);
  }, [running, poll]);

  // 들어왔을 때 이미 돌고 있던 작업이 있으면 이어서 보여 준다.
  useEffect(() => {
    nextRef.current = 0;
    setLines([]);
    setJob(null);
    setError('');
    api.setup.autoStatus(step.id, 0).then(({ job: j }) => {
      if (!j) return;
      setLines(j.lines);
      nextRef.current = j.next;
      setJob(j);
      // 지난 작업은 다시 점검하지 않는다. 다만 화면이 끊긴 사이(예: nginx 반영으로 http → https)에 막 끝난
      // 성공 작업이면 점검을 한 번 부른다.
      const recentlyOk = j.status === 'ok' && j.endedAt && Date.now() - Date.parse(j.endedAt) < 15 * 60 * 1000;
      if (j.status !== 'running' && !recentlyOk) finishedRef.current = j.id;
    }).catch(() => {});
  }, [step.id]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines]);

  // 끝난 작업은 한 번만 점검을 부른다.
  useEffect(() => {
    if (job && job.status !== 'running' && finishedRef.current !== job.id) {
      finishedRef.current = job.id;
      if (job.status === 'ok') onFinished(step.id);
    }
  }, [job, onFinished, step.id]);

  const start = async () => {
    setError('');
    setStarting(true);
    try {
      const secrets = {};
      if (info.needsSudo) secrets.sudoPassword = password;
      // DB 관리자 칸은 선택이다 — 비워 두면 서버는 지금까지처럼 socket 인증으로 붙는다.
      if (info.needsDbAdmin && dbPassword) {
        secrets.dbAdminUser = dbUser;
        secrets.dbAdminPassword = dbPassword;
      }
      const j = await api.setup.autoStart(step.id, secrets);
      setPassword('');
      setDbPassword('');
      nextRef.current = j.next;
      setLines(j.lines);
      setJob(j);
    } catch (err) {
      setPassword('');
      setDbPassword('');
      setError(err instanceof ApiError ? err.message : '시작하지 못했습니다.');
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    try {
      await api.setup.autoCancel(step.id);
    } catch {
      setError('중단 요청이 서버에 닿지 않았습니다 — 연결이 끊긴 것일 수 있습니다 (위 안내 참고).');
    }
  };

  if (!info?.available) {
    return (
      <>
        {info?.reason && (
          <p className="mb-2 text-xs text-muted-foreground">
            <UserRound className="mr-1 inline size-3.5" />
            자동 실행 없음 — {info.reason}
          </p>
        )}
        {children}
      </>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-muted-foreground">이 단계를 어떻게 할까요?</span>
        <Button size="sm" variant={mode === 'auto' ? 'default' : 'outline'} onClick={() => onMode('auto')} disabled={running}>
          <Play className="size-3.5" /> 자동으로
        </Button>
        <Button size="sm" variant={mode === 'manual' ? 'default' : 'outline'} onClick={() => onMode('manual')} disabled={running}>
          <Terminal className="size-3.5" /> 직접 (명령 복사)
        </Button>
      </div>

      {mode !== 'auto' && children}

      {mode === 'auto' && (
        <div className="space-y-3 rounded-md border p-3">
          <div>
            <p className="mb-1 text-xs font-semibold text-muted-foreground">마법사가 순서대로 실행합니다</p>
            <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-xs">
              {info.commands.map((c) => `(cd ${c.cwd}) ${c.text}`).join('\n')}
            </pre>
          </div>

          {PLAINTEXT && (info.needsSudo || info.needsDbAdmin) && !running && (
            <Alert variant="warning">
              <AlertDescription>
                이 화면은 암호화되지 않은 HTTP 로 열려 있습니다. 아래 비밀번호가 <strong>평문으로 네트워크를 지납니다</strong> —
                믿는 내부망에서만 입력하세요. 불안하면 <code>./bootstrap.sh --expose-https</code> 로 HTTPS 로 여세요.
              </AlertDescription>
            </Alert>
          )}

          {info.needsSudo && !running && (
            <div className="space-y-1">
              <label className="text-xs font-semibold text-muted-foreground" htmlFor={`sudo-${step.id}`}>
                sudo 비밀번호 (이 서버 계정의 비밀번호)
              </label>
              <Input
                id={`sudo-${step.id}`}
                type="password"
                autoComplete="off"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && password && !starting && start()}
                className="max-w-xs"
              />
              <p className="text-xs text-muted-foreground">
                서버 메모리에만 두고 작업이 끝나면 버립니다. 파일·로그에 남기지 않습니다. 이 화면을 https 나
                SSH 터널(127.0.0.1)로 열었을 때만 입력하세요.
              </p>
            </div>
          )}

          {info.needsDbAdmin && !running && (
            <div className="space-y-1">
              <p className="text-xs font-semibold text-muted-foreground">
                DB 관리자 (MariaDB root 가 비밀번호 인증일 때만 입력)
              </p>
              <div className="flex flex-wrap gap-2">
                <Input
                  aria-label="DB 관리자 계정"
                  value={dbUser}
                  onChange={(e) => setDbUser(e.target.value)}
                  autoComplete="off"
                  className="w-32"
                />
                <Input
                  aria-label="DB 관리자 비밀번호"
                  type="password"
                  value={dbPassword}
                  onChange={(e) => setDbPassword(e.target.value)}
                  autoComplete="off"
                  placeholder="비워 두면 socket 인증"
                  className="w-64"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                자동 실행은 터미널이 없어 스크립트가 관리자 비밀번호를 물어볼 수 없습니다. 여기 넣으면 이 작업 동안만
                임시 폴더의 0600 파일로 두었다가 끝나면 지웁니다. <code>sudo mariadb -e 'SELECT 1;'</code> 이 되면
                비워 두세요.
              </p>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {!running ? (
              <Button onClick={start} disabled={starting || Boolean(blockedReason) || (info.needsSudo && !password)}>
                {starting ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                {job ? '다시 실행' : '실행'}
              </Button>
            ) : (
              <Button variant="destructive" onClick={cancel}>
                <Square className="size-4" /> 중단
              </Button>
            )}
            {running && (
              <span className="text-xs text-muted-foreground">
                <Loader2 className="mr-1 inline size-3 animate-spin" />
                {job.current}/{job.total} 실행 중 …
              </span>
            )}
            {job && !running && (
              <span
                className={cn(
                  'text-xs',
                  job.status === 'ok' ? 'text-success' : job.status === 'cancelled' ? 'text-muted-foreground' : 'text-destructive',
                )}
              >
                {job.status === 'ok' && '끝났습니다 — 점검을 이어서 돌렸습니다.'}
                {job.status === 'cancelled' && '중단했습니다.'}
                {job.status === 'failed' &&
                  `실패했습니다${job.failedCommand ? ` — ${job.failedCommand}` : ''}${job.exitCode != null ? ` (종료 코드 ${job.exitCode})` : ''}`}
              </span>
            )}
          </div>

          {info.changesOrigin && (
            <Alert variant="warning">
              <AlertDescription>
                nginx 설정을 반영하면 <strong>이 화면의 주소가 HTTP 에서 HTTPS 로 바뀝니다</strong>. 끝나면 화면이 멈춘
                것처럼 보일 수 있습니다 — 그때는 <span className="font-mono">https://{window.location.host}{window.location.pathname}</span>{' '}
                로 다시 여세요 (사설 인증서 경고는 계속 진행). 작업은 서버에서 계속 돌아 끝납니다.
              </AlertDescription>
            </Alert>
          )}

          {running && pollFailures >= 3 && (
            <Alert variant="destructive">
              <AlertDescription>
                진행을 읽지 못하고 있습니다 ({pollFailures}회). 작업은 서버에서 이미 끝났을 수 있습니다.
                {window.location.protocol === 'http:' && (
                  <>
                    {' '}nginx 반영으로 HTTPS 로 바뀐 것이라면{' '}
                    <a className="underline" href={`https://${window.location.host}${window.location.pathname}`}>
                      https 로 다시 열기
                    </a>
                    .
                  </>
                )}
              </AlertDescription>
            </Alert>
          )}

          {blockedReason && !running && <p className="text-xs text-warning">{blockedReason}</p>}

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {lines.length > 0 && (
            <pre ref={logRef} className="max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
              {lines.map((l, i) => (
                <div key={i} className={cn('whitespace-pre-wrap break-all', LINE_TONE[l.stream])}>
                  {l.text || ' '}
                </div>
              ))}
              {job?.truncated && <div className="text-warning">… 로그가 길어 뒤는 생략했습니다.</div>}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
