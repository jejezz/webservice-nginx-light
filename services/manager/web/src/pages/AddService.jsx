import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  PackagePlus,
  FolderSearch,
  RefreshCw,
  Play,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/context/auth';
import { formatTime } from '@/lib/format';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { TopBar } from '@/components/TopBar';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CopyButton, CheckLines } from '@/components/checks';

/**
 * 서비스 추가 마법사.
 *
 * 1단계 — manager 가 services/<이름>/ 에 바로 pm2 로 띄울 수 있는 최소
 *         스켈레톤을 만든다. 실제 로직은 사람이 그 위에 채워 넣는다.
 * 2단계 — docs/guide/rollout.md '등록 순서' 의 절차를 복사용 명령으로 보여주고,
 *         읽기 전용 점검으로 반영 여부만 확인한다. **manager 는 아무
 *         명령도 대신 실행하지 않는다.**
 */

function NameField({ value, onChange, defaults, disabled }) {
  const pattern = defaults ? new RegExp(defaults.slugPattern) : null;
  const taken = defaults?.existingNames?.includes(value);
  const invalid = value.length > 0 && pattern && !pattern.test(value);

  let hint = '소문자로 시작하는 소문자·숫자·하이픈 조합 (예: stock-analyzer)';
  if (taken) hint = '이미 쓰이고 있는 이름입니다.';
  else if (invalid) hint = '형식이 맞지 않습니다.';

  return (
    <div className="space-y-1.5">
      <Label htmlFor="svc-name">서비스 이름</Label>
      <Input
        id="svc-name"
        value={value}
        onChange={(e) => onChange(e.target.value.trim())}
        placeholder="my-service"
        disabled={disabled}
        maxLength={defaults?.nameMaxLength || 40}
      />
      <p className={taken || invalid ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>{hint}</p>
    </div>
  );
}

function PortField({ value, onChange, defaults, disabled }) {
  const port = Number(value);
  const inUse = defaults?.usedPorts?.includes(port);
  const outOfRange =
    value !== '' && defaults && (!Number.isInteger(port) || port < defaults.portRange.min || port > defaults.portRange.max);

  return (
    <div className="space-y-1.5">
      <Label htmlFor="svc-port">포트</Label>
      <Input
        id="svc-port"
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        min={defaults?.portRange?.min}
        max={defaults?.portRange?.max}
      />
      <p className={inUse || outOfRange ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
        {inUse
          ? '이미 쓰이고 있는 포트입니다.'
          : outOfRange
            ? `${defaults?.portRange?.min}-${defaults?.portRange?.max} 사이여야 합니다.`
            : `내부 HTTP 포트 대역 (${defaults?.portRange?.min}-${defaults?.portRange?.max}) — docs/ports.md '내부 HTTP 포트 — 28080번대'`}
      </p>
    </div>
  );
}

function TrackField() {
  // 서비스 추가로 만드는 것은 plug-in 으로 고정이다 — 고를 것이 없으므로 안내만 둔다.
  return (
    <div className="space-y-1.5">
      <Label>추적 방식</Label>
      <p className="text-sm">별도 저장소 (plug-in)</p>
      <p className="text-xs text-muted-foreground">
        추가한 서비스는 plug-in 으로 붙습니다 — 이 저장소는 그 코드를 모르고, 선언 둘(nginx-conf · pm2-conf)만
        맞춥니다. <code>.gitignore</code> 는 그대로 두고 이 디렉터리는 계속 무시되니, 직접 <code>git init</code>{' '}
        하세요. 패키지에 포함되는 서비스는 이 화면으로 만들지 않습니다.
      </p>
    </div>
  );
}

function ScaffoldForm({ onCreated }) {
  const [defaults, setDefaults] = useState(null);
  const [name, setName] = useState('');
  const [port, setPort] = useState('');
  const track = 'plugin';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.wizard
      .defaults()
      .then((d) => {
        setDefaults(d);
        if (d.suggestedPort) setPort(String(d.suggestedPort));
      })
      .catch((err) => setError(err.message || '기본값을 불러오지 못했습니다.'));
  }, []);

  const canSubmit = useMemo(() => {
    if (!defaults || busy) return false;
    if (!name || !new RegExp(defaults.slugPattern).test(name)) return false;
    if (defaults.existingNames.includes(name)) return false;
    const p = Number(port);
    if (!Number.isInteger(p) || p < defaults.portRange.min || p > defaults.portRange.max) return false;
    if (defaults.usedPorts.includes(p)) return false;
    return true;
  }, [defaults, name, port, busy]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api.wizard.scaffold({ name, port: Number(port), track });
      onCreated(result);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError('만드는 중 오류가 났습니다.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <PackagePlus className="size-4" />
          1단계 — 기본 틀 만들기
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={submit}>
          <NameField value={name} onChange={setName} defaults={defaults} disabled={busy} />
          <PortField value={port} onChange={setPort} defaults={defaults} disabled={busy} />
          <TrackField />

          {error && (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Button type="submit" disabled={!canSubmit}>
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            services/{name || '<이름>'}/ 만들기
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ScaffoldResult({ result }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base text-success">
          <CheckCircle2 className="size-4" />
          {result.dir}/ 만들었습니다
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-muted-foreground">생성된 파일</p>
        <ul className="space-y-0.5 font-mono text-xs">
          {result.files.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function CommandBlock({ item }) {
  return (
    <div className="space-y-1.5 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{item.title}</p>
        <CopyButton text={item.run} />
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-xs">
        {item.cwd && item.cwd !== '.' ? `cd ${item.cwd}\n` : ''}
        {item.run}
      </pre>
    </div>
  );
}

function CheckItem({ item, name, port, track, result, onCheck, running }) {
  return (
    <div className="space-y-1.5 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{item.title}</p>
        <Button
          variant="outline"
          size="sm"
          disabled={running}
          onClick={() => onCheck(item.id, item.id === 'health.contract' ? port : undefined)}
        >
          {running ? <Loader2 className="size-3.5 animate-spin" /> : null}
          점검하기
        </Button>
      </div>
      <CheckLines result={result} />
    </div>
  );
}

/**
 * 플러그인 자체 진단. repo 가 package.json 에 doctor 스크립트를 두면 그것을 실행해 점검 규약 JSON 을 보여 준다.
 * **그 폴더의 코드를 실행**하는 유일한 자리라, 안내를 먼저 보이고 관리자가 버튼을 눌렀을 때만 돌린다.
 */
function SelfDiagnosis({ folder, entries, isAdmin }) {
  const [results, setResults] = useState({});
  const [running, setRunning] = useState(null);

  // 다른 폴더를 고르면 이전 결과를 비운다.
  useEffect(() => {
    setResults({});
    setRunning(null);
  }, [folder]);

  const run = async (cwd) => {
    setRunning(cwd);
    try {
      const r = await api.wizard.selfDiagnosis(folder, cwd);
      setResults((prev) => ({ ...prev, [cwd]: r }));
    } catch (err) {
      setResults((prev) => ({ ...prev, [cwd]: { error: err.message || '실행하지 못했습니다.', checks: [] } }));
    } finally {
      setRunning(null);
    }
  };

  if (!entries || entries.length === 0) return null;

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div>
        <h4 className="text-sm font-semibold">플러그인 자체 진단</h4>
        <p className="text-xs text-muted-foreground">
          이 repo 가 스스로 만든 진단(<code>package.json</code> 의 <code>doctor</code>)입니다. 위의 읽기 전용 진단이 못 보는
          것(DB 접속 · <code>.env</code> 값 · 서비스 응답)을 직접 확인합니다.{' '}
          <strong>실행하면 이 폴더의 코드가 돕니다</strong> — 믿는 repo 만 실행하세요.
        </p>
      </div>

      {entries.map((e) => (
        <div key={e.cwd || '.'} className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-mono text-xs">
              {e.cwd || '.'} → {e.script}
            </span>
            {e.runnable ? (
              <Button
                size="sm"
                variant="outline"
                disabled={!isAdmin || running === (e.cwd || '.')}
                title={isAdmin ? undefined : 'admin 권한이 필요합니다'}
                onClick={() => run(e.cwd || '.')}
              >
                {running === (e.cwd || '.') ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                자체 진단 실행
              </Button>
            ) : (
              <span className="text-xs text-warning">실행하지 않습니다 — {e.reason}</span>
            )}
          </div>

          {results[e.cwd || '.'] && (
            <div className="space-y-1">
              {results[e.cwd || '.'].durationMs != null && (
                <p className="text-xs text-muted-foreground">
                  {formatTime(results[e.cwd || '.'].ranAt)} · {results[e.cwd || '.'].durationMs} ms · 종료 코드{' '}
                  {results[e.cwd || '.'].exitCode ?? '—'}
                </p>
              )}
              <CheckLines result={results[e.cwd || '.']} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ExistingFolderPanel({ onReady }) {
  const { user } = useAuth();
  const [candidates, setCandidates] = useState(null);
  const [selected, setSelected] = useState('');
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.wizard
      .inspectCandidates()
      .then((r) => setCandidates(r.candidates))
      .catch((err) => setError(err.message || '목록을 불러오지 못했습니다.'));
  }, []);

  const inspect = async (name) => {
    setSelected(name);
    setReport(null);
    setError('');
    setBusy(true);
    try {
      setReport(await api.wizard.inspect(name));
    } catch (err) {
      setError(err.message || '진단하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FolderSearch className="size-4" />
          이미 받아 둔 폴더 등록 — 진단
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          <code>services/</code> 안에 직접 clone 해 둔 폴더가 서비스로 붙을 수 있는지 봅니다. <strong>읽기만 합니다</strong> —
          그 폴더의 코드를 실행하지도, 파일을 쓰지도 않습니다.
        </p>

        {error && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {!candidates && !error && <p className="text-xs text-muted-foreground">폴더를 찾는 중 …</p>}

        {candidates && candidates.length === 0 && (
          <p className="text-sm text-muted-foreground">
            등록할 폴더가 없습니다. <code>services/</code> 아래에 서비스 폴더를 clone 한 뒤 다시 열어 보세요
            (패키지에 포함된 서비스와 <code>.</code> 으로 시작하는 폴더는 나오지 않습니다).
          </p>
        )}

        {candidates && candidates.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {candidates.map((c) => (
              <Button
                key={c.name}
                size="sm"
                variant={selected === c.name ? 'default' : 'outline'}
                onClick={() => inspect(c.name)}
                disabled={busy}
                title={c.declared ? '선언(nginx-conf · pm2-conf)이 있습니다' : '선언이 아직 없습니다'}
              >
                {c.name}
                {!c.declared && <span className="ml-1 text-[10px] opacity-70">(선언 없음)</span>}
              </Button>
            ))}
          </div>
        )}

        {busy && (
          <p className="text-xs text-muted-foreground">
            <Loader2 className="mr-1 inline size-3 animate-spin" />
            진단하는 중 …
          </p>
        )}

        {report && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <h3 className="font-mono text-sm font-semibold">{report.dir}</h3>
              <Button size="sm" variant="ghost" onClick={() => inspect(report.name)} disabled={busy}>
                <RefreshCw className="size-3.5" />
                다시 진단
              </Button>
            </div>
            {report.detected.services?.length > 0 && (
              <p className="text-xs text-muted-foreground">
                이 폴더의 서비스 {report.detected.services.length}개:{' '}
                {report.detected.services.map((sv) => (
                  <span key={sv.name} className="mr-2 font-mono">
                    {sv.name}
                    {sv.ports?.length ? `:${sv.ports[0]}` : ''}
                  </span>
                ))}
              </p>
            )}
            <CheckLines result={{ checks: report.checks }} />
            <SelfDiagnosis folder={report.name} entries={report.detected.selfDiagnosis} isAdmin={user?.role === 'admin'} />
            {report.ready ? (
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={() => onReady({ name: report.name, port: report.detected.services?.length > 1 ? null : report.detected.port, track: 'plugin' })}>
                  다음 — 등록 점검
                </Button>
                <span className="text-xs text-muted-foreground">
                  선언이 있고 막는 것이 없습니다. <span className="font-mono">[--]</span> 항목은 다음 단계에서 하나씩 처리합니다.
                </span>
              </div>
            ) : (
              <Alert>
                <AlertCircle />
                <AlertDescription>
                  {report.detected.declared
                    ? '위의 [!!] 를 먼저 고친 뒤 다시 진단하세요.'
                    : '이 폴더에는 서비스 선언(nginx-conf/service.ini · pm2-conf/app.ini)이 없습니다. 위 감지 결과를 보고 두 파일을 만든 뒤 다시 진단하세요.'}
                </AlertDescription>
              </Alert>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RegisterPanel({ scaffolded }) {
  const { name, port, track } = scaffolded;
  const [commands, setCommands] = useState(null);
  const [items, setItems] = useState(null);
  const [results, setResults] = useState({});
  const [running, setRunning] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api.wizard.commands(name, { port, track }), api.wizard.checklist(name, track)])
      .then(([c, l]) => {
        setCommands(c.commands);
        setItems(l.items);
      })
      .catch((err) => setError(err.message || '불러오지 못했습니다.'));
  }, [name, port, track]);

  const runCheck = async (checkId, checkPort) => {
    setRunning(checkId);
    try {
      const result = await api.wizard.check(name, checkId, checkPort);
      setResults((prev) => ({ ...prev, [checkId]: result }));
    } catch (err) {
      setResults((prev) => ({ ...prev, [checkId]: { error: err.message || '점검하지 못했습니다.', checks: [] } }));
    } finally {
      setRunning(null);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">2단계 — 등록</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Alert>
            <AlertDescription>
              마법사는 이 명령을 실행하지 않습니다 — 터미널에서 직접 실행하세요 (docs/guide/rollout.md '등록 순서').
            </AlertDescription>
          </Alert>
          {error && (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {commands ? commands.map((item) => <CommandBlock key={item.id} item={item} />) : <p className="text-xs text-muted-foreground">불러오는 중…</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">무결성 확인</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {items
            ? items.map((item) => (
                <CheckItem
                  key={item.id}
                  item={item}
                  name={name}
                  port={port}
                  track={track}
                  result={results[item.id]}
                  onCheck={runCheck}
                  running={running === item.id}
                />
              ))
            : null}
        </CardContent>
      </Card>
    </div>
  );
}

export default function AddService() {
  const { user } = useAuth();
  const [scaffolded, setScaffolded] = useState(null);
  const [mode, setMode] = useState('new');   // new | existing
  const [adopted, setAdopted] = useState(false);   // 기존 폴더를 골라 2단계로 넘어온 경우

  return (
    <div className="min-h-screen bg-background">
      <TopBar subtitle="서비스 추가" />

      <main className="mx-auto max-w-3xl space-y-4 px-4 py-6 sm:px-6">
        {user && user.role !== 'admin' && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertDescription>
              이 계정은 admin 권한이 없어 서비스를 만들 수 없습니다. 점검·명령 미리보기만 볼 수 있습니다.
            </AlertDescription>
          </Alert>
        )}

        {!scaffolded && (
          <div className="flex gap-2">
            <Button size="sm" variant={mode === 'new' ? 'default' : 'outline'} onClick={() => setMode('new')}>
              <PackagePlus className="size-3.5" />
              새로 만들기
            </Button>
            <Button size="sm" variant={mode === 'existing' ? 'default' : 'outline'} onClick={() => setMode('existing')}>
              <FolderSearch className="size-3.5" />
              이미 받아 둔 폴더 등록
            </Button>
          </div>
        )}

        {!scaffolded ? (
          mode === 'existing' ? (
            <ExistingFolderPanel
              onReady={(s) => {
                setAdopted(true);
                setScaffolded(s);
              }}
            />
          ) : user && user.role === 'admin' ? (
            <ScaffoldForm onCreated={setScaffolded} />
          ) : (
            <Alert>
              <AlertDescription>admin 권한이 있는 계정으로 다시 로그인하세요.</AlertDescription>
            </Alert>
          )
        ) : (
          <>
            {adopted ? (
              <Card>
                <CardContent className="py-4 text-sm">
                  <span className="font-mono">services/{scaffolded.name}</span> — 이미 받아 둔 폴더를 등록합니다
                  {scaffolded.port ? ` (포트 ${scaffolded.port})` : ' (포트는 선언에서 읽습니다)'}.
                </CardContent>
              </Card>
            ) : (
              <ScaffoldResult result={scaffolded} />
            )}
            <RegisterPanel scaffolded={scaffolded} />
          </>
        )}
      </main>
    </div>
  );
}
