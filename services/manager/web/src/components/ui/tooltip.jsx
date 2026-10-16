import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * 최소한의 툴팁 — 마우스를 올리거나 키보드 포커스가 오면 아래에 이름표를 띄운다.
 * 브라우저 기본 title 은 1초 안팎 뒤에 떠서 아이콘 메뉴에는 답답하다. 이것은 0.1초.
 * @radix-ui/react-tooltip 을 새로 들이지 않으려고 직접 만들었다 (dialog.jsx 와 같은 방침). CSS 만 쓴다.
 *
 *   align  'center'(기본) | 'end' — 화면 오른쪽 끝의 버튼은 이름표가 잘리지 않게 'end'.
 */
function Tooltip({ label, align = 'center', className, children }) {
  return (
    <span className="group relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={cn(
          'pointer-events-none absolute top-full z-20 mt-2 whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md',
          'opacity-0 transition-opacity duration-100 group-hover:opacity-100 group-hover:delay-100 group-focus-within:opacity-100',
          align === 'end' ? 'right-0' : 'left-1/2 -translate-x-1/2',
          className,
        )}
      >
        {label}
      </span>
    </span>
  );
}

export { Tooltip };
