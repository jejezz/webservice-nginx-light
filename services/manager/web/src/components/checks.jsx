import { useState } from 'react';
import { AlertCircle, Check, Copy } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Setup.jsx(구축 마법사)에서 뽑아낸 것 — 서비스 추가 마법사도 같은 모양의
 * 점검 결과를 보여줘야 해서 공용으로 둔다. docs/guide/contracts.md 'level' 의 네
 * 레벨이 기준이다.
 */

// skip 과 pending 은 터미널에서 둘 다 [--] 로 보이지만 판정이 다르다 —
// 화면에서는 그것을 갈라 보여 준다.
export const LEVEL_STYLE = {
  ok: { mark: '[ok]', tone: 'text-success', note: '' },
  skip: { mark: '[--]', tone: 'text-muted-foreground', note: '안 해도 되는 것' },
  pending: { mark: '[--]', tone: 'text-warning', note: '아직 안 한 것' },
  problem: { mark: '[!!]', tone: 'text-destructive', note: '문제' },
};

export function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 클립보드를 쓸 수 없으면 사용자가 직접 고를 수 있게 그대로 둔다.
    }
  };

  return (
    <Button variant="outline" size="sm" onClick={copy}>
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? '복사됨' : '명령 복사'}
    </Button>
  );
}

export function CheckLines({ result }) {
  if (!result) return null;

  if (result.error) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertDescription>
          {result.error}
          {result.stderr && (
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-xs opacity-80">{result.stderr}</pre>
          )}
        </AlertDescription>
      </Alert>
    );
  }

  if (result.checks.length === 0) {
    return <p className="text-xs text-muted-foreground">점검 항목이 없습니다.</p>;
  }

  return (
    <ul className="space-y-1">
      {result.checks.map((check, i) => {
        const style = LEVEL_STYLE[check.level] || LEVEL_STYLE.problem;
        return (
          <li key={`${check.level}-${i}`} className="flex items-baseline gap-2 font-mono text-xs">
            <span className={cn('shrink-0 font-semibold', style.tone)}>{style.mark}</span>
            {/* 점검 문구는 칸을 띄워 열을 맞춘 것이 있다 (패키지명 | 설명). 그 공백을 살린다. */}
            <span className={cn('whitespace-pre-wrap', check.level === 'skip' && 'text-muted-foreground')}>
              {check.text}
            </span>
            {style.note && check.level !== 'ok' && (
              <span className="shrink-0 text-[10px] text-muted-foreground">— {style.note}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
