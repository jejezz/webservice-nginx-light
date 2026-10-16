import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, Send } from 'lucide-react';
import { useAuth } from '@/context/auth';
import { api, ApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { TopBar } from '@/components/TopBar';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// 서버가 돌려주는 오류 code → 사람이 읽는 안내. 중앙 서버는 틀림·만료·사용됨을 구분하지 않는다.
// 등록 코드와 서버 주소는 어떤 안내에도 싣지 않는다.
const ERRORS = {
  invalid_code: '등록 코드가 틀렸거나 만료됐거나 이미 사용됐습니다. 중앙 서버에서 새 코드를 받으세요 (코드는 1회용, 24시간).',
  rate_limited: '시도가 너무 많습니다. 15분 뒤에 다시 하세요.',
  network: '중앙 서버에 연결하지 못했습니다. 네트워크를 확인하세요. 코드를 이미 썼을 수 있으니 실패하면 새 코드를 받으세요.',
  server_error: '중앙 서버가 오류를 돌려줬습니다. 잠시 뒤 새 코드로 다시 하세요.',
  invalid_response: '중앙 서버의 응답이 예상과 다릅니다. 새 코드로 다시 하세요.',
  invalid_config: '등록 코드에 든 서버 주소가 HTTPS 가 아닙니다. 관리자에게 알리고 새 코드를 받으세요.',
  not_configured: '아직 등록되지 않아 전송하지 않습니다. 먼저 등록 코드로 등록하세요.',
  https_required: '이 화면을 https:// 로 열었을 때만 등록할 수 있습니다 (등록 코드가 평문으로 오가지 않게).',
  admin_role_required: '관리자(admin) 권한이 필요합니다.',
};

const RESULT_LABEL = {
  ok: '성공',
  throttled_or_server_error: '중앙 서버가 거절·오류 (재시도 예정)',
  rejected: '중앙 서버가 거절 (키·현장 설정 확인 필요)',
  network: '연결 실패',
};

function errorText(err) {
  if (err instanceof ApiError) return ERRORS[err.code] || '요청에 실패했습니다.';
  return '요청에 실패했습니다.';
}

export default function Central() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api.central.status());
      setError('');
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function run(fn, after) {
    setBusy(true);
    setError('');
    try {
      setStatus(await fn());
      after?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const last = status?.last;

  return (
    <div className="min-h-screen bg-background">
      <TopBar subtitle="에이전트 · 중앙 서버로 상태 보고" />

      <main className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-6">
        {error && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              에이전트
              {status && <Badge variant={status.enrolled ? 'success' : 'secondary'}>{status.enrolled ? '등록됨' : '미등록'}</Badge>}
            </CardTitle>
            <CardDescription>
              이 장비의 상태(서비스 점검, 자원, 인증서 만료)를 매시간 중앙 서버로 보냅니다. 중앙 서버는 이 장비를 조작하지 않고 판정·알림만 합니다.
              등록하기 전에는 아무것도 보내지 않습니다.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {!status ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            ) : status.enrolled ? (
              <dl className="grid grid-cols-[8rem_1fr] gap-y-2">
                <dt className="text-muted-foreground">현장 ID</dt>
                <dd className="font-mono">{status.site.siteId}</dd>
                <dt className="text-muted-foreground">정기 보고</dt>
                <dd>{status.running ? '돌고 있음 (매시간)' : '멈춰 있음 — manager 를 다시 시작하세요'}</dd>
                <dt className="text-muted-foreground">마지막 전송</dt>
                <dd className="flex items-center gap-2">
                  {last ? (
                    <>
                      {last.ok ? <CheckCircle2 className="size-4 text-success" /> : <AlertCircle className="size-4 text-destructive" />}
                      <span>
                        {formatDateTime(last.at)} · {RESULT_LABEL[last.result] || last.result}
                        {last.http ? ` (HTTP ${last.http})` : ''}
                      </span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">아직 없음 (manager 시작 직후에는 몇 초 걸립니다)</span>
                  )}
                </dd>
              </dl>
            ) : (
              <p className="text-muted-foreground">
                중앙 서버 웹(관리자 로그인 → ‘현장 등록’)에서 발급한 사이트 등록 코드를 입력하면 시작합니다.
              </p>
            )}

            {status?.enrolled && (
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={busy || !isAdmin} onClick={() => run(api.central.send)} title={isAdmin ? '' : '관리자(admin) 권한이 필요합니다'}>
                  {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
                  지금 보내기
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {status && (
          <Card>
            <CardHeader>
              <CardTitle>{status.enrolled ? '다시 등록 (서버가 바뀌었거나 키를 교체할 때)' : '등록'}</CardTitle>
              <CardDescription>
                서버 주소는 등록 코드 안에 들어 있어 따로 입력하지 않습니다. 코드는 1회용이며 24시간 안에 써야 합니다.
                응답을 못 받았거나 실패했다면 같은 코드를 다시 쓰지 말고 새 코드를 받으세요.
                {status.enrolled && ' 서버 주소가 바뀌면 새 코드로 다시 등록해 덮어씁니다.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!isAdmin ? (
                <p className="text-sm text-muted-foreground">관리자(admin) 권한이 있는 계정만 등록할 수 있습니다.</p>
              ) : (
                <form
                  className="space-y-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (code.trim()) run(() => api.central.enroll(code.trim()), () => setCode(''));
                  }}
                >
                  <div className="space-y-1.5">
                    <Label htmlFor="enroll-code">사이트 등록 코드</Label>
                    {/* 코드는 비밀번호처럼 가린다 — 화면에 그대로 남기지 않는다. */}
                    <Input
                      id="enroll-code"
                      type="password"
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      placeholder="wsc1.…"
                      autoComplete="off"
                      spellCheck={false}
                      className="font-mono"
                    />
                  </div>
                  <Button type="submit" disabled={busy || !code.trim()}>
                    {busy && <Loader2 className="size-4 animate-spin" />}
                    {status.enrolled ? '다시 등록' : '등록'}
                  </Button>
                </form>
              )}
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
