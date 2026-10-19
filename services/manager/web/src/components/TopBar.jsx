import { Children } from 'react';
import { Link } from 'react-router-dom';
import { Activity, BookOpen, Gauge, RadioTower, ListChecks, ShieldCheck, LogOut, Network, PackagePlus } from 'lucide-react';
import { useAuth } from '@/context/auth';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { useHost } from '@/lib/useHost';

function Divider() {
  return <div className="h-5 w-px shrink-0 bg-border" aria-hidden="true" />;
}

/**
 * Manager 의 맨 위 바.
 *
 * 대시보드 화면과, 다른 서비스의 대시보드를 iframe 으로 담는 화면(ServiceView)이
 * 같은 바를 쓴다 — 그 안에 들어가 있어도 "여기가 Manager 다" 가 유지되고,
 * 왼쪽 제목을 누르면 늘 대시보드로 돌아온다.
 *
 *   subtitle  제목 아래 작은 글. 대시보드는 갱신 시각, 뷰는 서비스 이름.
 *   children  맨 왼쪽에 두고 구분선으로 나누는 화면 고유 조작 (자동 갱신 스위치 등).
 *             나머지는 어느 화면에서나 같고 순서는 children | 자원 · 점검 · 에이전트 · 포트 | 구축 | 서비스 추가 · 문서 · 로그아웃.
 */
export function TopBar({ subtitle, children }) {
  const { user, logout } = useAuth();
  const host = useHost();
  const machine = host?.alias || host?.hostname;

  return (
    <header className="sticky top-0 z-10 shrink-0 border-b bg-background/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <Link to="/dashboard" className="flex items-center gap-3 rounded-md outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring" title="Manager 대시보드로">
          <div className="flex size-9 items-center justify-center rounded-lg border bg-card">
            <Activity className="size-4" />
          </div>
          <div>
            <h1 className="whitespace-nowrap text-sm font-semibold leading-tight">
              Nginx Manager
              {machine && (
                <span className="ml-2 rounded border bg-muted px-1.5 py-0.5 align-middle font-mono text-[11px] font-normal text-muted-foreground" title={host.alias ? `${host.alias} (${host.hostname})` : host.hostname}>
                  {machine}
                </span>
              )}
            </h1>
            <p className="text-xs text-muted-foreground">{subtitle}</p>
          </div>
        </Link>

        <div className="flex items-center gap-2 sm:gap-3">
          {/* 화면 고유 조작 (자동 갱신 스위치, 새로고침)은 맨 왼쪽에 둔다. 없는 화면에서는 구분선도 그리지 않는다. */}
          {Children.toArray(children).length > 0 && (
            <>
              {children}
              <Divider />
            </>
          )}

          {/* 장비를 보는 화면: 서비스가 아니라 이 장비 자체에 대한 것이라 가장 앞에 둔다. */}
          <Tooltip label="자원 — CPU · RAM · 저장소 · 네트워크 사용량">
            <Button variant="outline" size="icon" asChild>
              <Link to="/resources" aria-label="자원">
                <Gauge className="size-4" />
              </Link>
            </Button>
          </Tooltip>

          <Tooltip label="점검 — 설치본이 저장소 선언과 같은가 (check-all.sh)">
            <Button variant="outline" size="icon" asChild>
              <Link to="/checks" aria-label="점검">
                <ShieldCheck className="size-4" />
              </Link>
            </Button>
          </Tooltip>

          <Tooltip label="에이전트 — 중앙 서버로 상태 보고">
            <Button variant="outline" size="icon" asChild>
              <Link to="/central" aria-label="에이전트">
                <RadioTower className="size-4" />
              </Link>
            </Button>
          </Tooltip>

          <Tooltip label="포트 지도 — 공유기 포워딩 확인">
            <Button variant="outline" size="icon" asChild>
              <Link to="/port-map" aria-label="포트">
                <Network className="size-4" />
              </Link>
            </Button>
          </Tooltip>

          <Divider />

          <Tooltip label="구축 마법사">
            <Button variant="outline" size="icon" asChild>
              <Link to="/setup" aria-label="구축">
                <ListChecks className="size-4" />
              </Link>
            </Button>
          </Tooltip>

          <Divider />

          <Tooltip label="서비스 추가 마법사">
            <Button variant="outline" size="icon" asChild>
              <Link to="/add-service" aria-label="서비스 추가">
                <PackagePlus className="size-4" />
              </Link>
            </Button>
          </Tooltip>

          <Tooltip label="문서 · 변경 이력">
            <Button variant="outline" size="icon" asChild>
              <Link to="/docs" aria-label="문서">
                <BookOpen className="size-4" />
              </Link>
            </Button>
          </Tooltip>

          <div className="hidden text-right md:block">
            <p className="text-xs font-medium leading-tight">{user?.displayName}</p>
            <p className="text-xs text-muted-foreground">{user?.username}</p>
          </div>

          <Tooltip label="로그아웃" align="end">
            <Button variant="ghost" size="icon" onClick={logout} aria-label="로그아웃">
              <LogOut className="size-4" />
            </Button>
          </Tooltip>
        </div>
      </div>
    </header>
  );
}
