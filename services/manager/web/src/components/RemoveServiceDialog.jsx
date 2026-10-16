import { useEffect, useState } from 'react';
import { AlertCircle, Loader2, Trash2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/checks';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

/**
 * 추가한 서비스를 지운다. **지우지 않고 services/.removed/ 로 옮긴다** — 코드와 설정은 남고, 선언이 읽히지
 * 않아 이 화면에서 사라진다. 무슨 일이 일어나는지를 먼저 서버에 물어 보여 주고, 서비스 이름을 직접 쳐야
 * 지울 수 있다 (services/remove.js).
 *
 * folder 는 서비스가 든 폴더 이름(service.group)이다 — 서비스 이름과 다를 수 있다.
 */
export function RemoveServiceDialog({ service, folder, open, onOpenChange, onRemoved }) {
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  useEffect(() => {
    if (!open) return;
    setPlan(null);
    setError('');
    setConfirm('');
    setDone(null);
    api.wizard
      .removePlan(folder)
      .then(setPlan)
      .catch((err) => setError(err instanceof ApiError ? err.message : '확인하지 못했습니다.'));
  }, [open, folder]);

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await api.wizard.removeService(folder, confirm);
      setDone(result);
      onRemoved?.(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '지우지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} className="max-w-lg" labelledBy="remove-service-title">
      <DialogHeader>
        <DialogTitle id="remove-service-title">서비스 지우기 — {service.name}</DialogTitle>
        <DialogDescription>
          지우지 않고 휴지통(<code>services/.removed/</code>)으로 옮깁니다. 코드와 설정은 남아 있습니다.
        </DialogDescription>
      </DialogHeader>

      {error && (
        <Alert variant="destructive" className="mb-3">
          <AlertCircle />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {!done && !plan && !error && (
        <p className="text-sm text-muted-foreground">
          <Loader2 className="mr-1 inline size-3.5 animate-spin" />
          확인하는 중 …
        </p>
      )}

      {!done && plan && (
        <div className="space-y-3 text-sm">
          <ul className="list-disc space-y-1 pl-5">
            {plan.apps.length > 0 && (
              <li>
                pm2 에서 멈추고 목록에서 뺍니다: <span className="font-mono">{plan.apps.join(', ')}</span>
              </li>
            )}
            {plan.dir && (
              <li>
                <span className="font-mono">{plan.dir}</span> 을(를) <span className="font-mono">{plan.trash}</span>{' '}
                로 옮깁니다 (선언이 사라져 이 화면에서 빠집니다)
              </li>
            )}
          </ul>
          <p className="text-xs text-muted-foreground">
            nginx 라우트는 여기서 못 지웁니다 (sudo). 지운 뒤 nginx 를 다시 반영해야 빠집니다.
          </p>
          <div className="space-y-1">
            <label className="text-xs font-semibold text-muted-foreground" htmlFor="remove-confirm">
              확인하려면 폴더 이름 <span className="font-mono">{folder}</span> 을(를) 입력하세요
            </label>
            <Input id="remove-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
          </div>
        </div>
      )}

      {done && (
        <div className="space-y-3 text-sm">
          <Alert>
            <AlertDescription>
              지웠습니다{done.movedTo && (
                <>
                  {' '}— <span className="font-mono">{done.movedTo}</span> 로 옮겼습니다 (되돌리려면 그 폴더를{' '}
                  <span className="font-mono">services/{folder}</span> 로 옮기세요)
                </>
              )}
              .
            </AlertDescription>
          </Alert>
          <p className="text-xs text-muted-foreground">{done.next.text}</p>
          <div className="flex items-start gap-2">
            <pre className="flex-1 overflow-x-auto rounded-md border bg-muted/40 p-2 font-mono text-xs">{done.next.command}</pre>
            <CopyButton text={done.next.command} />
          </div>
        </div>
      )}

      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          {done ? '닫기' : '취소'}
        </Button>
        {!done && (
          <Button variant="destructive" disabled={busy || !plan || confirm !== folder} onClick={submit}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            지우기
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
