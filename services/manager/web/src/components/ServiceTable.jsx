import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Box, ChevronDown, ChevronRight, ExternalLink, Package, PackagePlus, PanelTop, Plug, RefreshCw, Trash2 } from 'lucide-react';
import { StatusBadge, StatusDot } from '@/components/StatusBadge';
import { Badge } from '@/components/ui/badge';
import { RemoveServiceDialog } from '@/components/RemoveServiceDialog';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatLatency, formatTime, formatUptime } from '@/lib/format';
import { cn } from '@/lib/utils';

function Pm2Cell({ pm2 }) {
  if (!pm2) return <span className="text-muted-foreground">—</span>;

  const online = pm2.status === 'online';

  return (
    <div className="flex items-center gap-2">
      <Badge variant={online ? 'success' : 'destructive'}>{pm2.status}</Badge>
      {online && (
        <span className="text-xs text-muted-foreground tabular-nums">
          {pm2.cpu ?? 0}% · {pm2.memoryMb ?? 0}MB
        </span>
      )}
    </div>
  );
}

function DetailRow({ service }) {
  const { health, pm2, target } = service;

  const items = [
    ['Health URL', service.healthUrl || '—'],
    ['등록 위치', (service.sources || []).map((s) => (s === 'nginx' ? 'nginx-conf' : 'pm2-conf')).join(' + ') || '—'],
    ['Nginx location', service.location || '— (라우트 없음)'],
    ['proxy_pass', service.proxyPass || '—'],
    ['WebSocket', service.websocket ? '사용' : '미사용'],
    ['대상 호스트', target ? `${target.host}:${target.port}` : '—'],
    ['HTTP 상태', health.httpStatus ?? '—'],
    ['응답 시간', formatLatency(health.latencyMs)],
    ['마지막 확인', formatTime(health.checkedAt)],
  ];

  if (pm2) {
    items.push(
      ['PM2 PID', pm2.pid ?? '—'],
      ['PM2 가동 시간', formatUptime(pm2.uptimeSec)],
      ['PM2 재시작 횟수', pm2.restarts],
    );
  }

  return (
    <TableRow className="bg-muted/30 hover:bg-muted/30">
      <TableCell colSpan={7} className="p-0">
        <div className="space-y-4 p-5">
          <dl className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
            {items.map(([label, value]) => (
              <div key={label} className="flex items-baseline justify-between gap-4 border-b border-border/50 py-1">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="truncate font-mono text-xs">{String(value)}</dd>
              </div>
            ))}
          </dl>

          {health.error && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 font-mono text-xs text-destructive">
              {health.error}
            </p>
          )}

          {health.body && (
            <div>
              <p className="mb-1 text-xs text-muted-foreground">/health 응답</p>
              <pre className="max-h-56 overflow-auto rounded-md border bg-background p-3 font-mono text-xs">
                {typeof health.body === 'string' ? health.body : JSON.stringify(health.body, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

/**
 * 같은 서비스 폴더가 선언한 것들을 한 덩어리로 묶는다.
 *
 * **헬스를 합치는 것이 아니다.** services/janus 는 janus(8088, systemd)와
 * janus-dashboard(28087, pm2)를 함께 선언하는데, 둘은 서로 독립적으로 죽는
 * 다른 프로세스다. 선언을 하나로 합치면 헬스도 하나가 되어 둘 중 한쪽의
 * 고장이 보이지 않게 된다 — Janus 가 죽었는데 행이 초록인 상태가 그것이다.
 *
 * 그래서 **보이는 것만** 묶는다. 줄은 그대로 둘이고, 그 둘이 한 묶음이라는
 * 사실만 화면에 드러낸다.
 *
 * 폴더는 전부 같은 아이콘(Box)으로 시작한다 — 독립된 프로세스 하나라는 뜻이다.
 * 둘 이상을 선언한 폴더는 그 아이콘 줄이 머리글이고 서비스가 아래로 들어간다.
 * 하나뿐인 폴더는 머리글을 따로 내지 않는다 — 이름을 두 번 적게 되어 알려
 * 주는 것이 없다. 대신 그 서비스 행 자체가 아이콘을 달고 폴더 자리에 선다.
 */
function groupServices(services) {
  const groups = [];
  const index = new Map();

  for (const service of services) {
    // 그룹이 없는 것(pm2 전용 행)은 자기 혼자 선다. 이름이 겹치지 않게 접두사를 둔다.
    const key = service.group || `\u0000${service.name}`;
    let group = index.get(key);
    if (!group) {
      group = { key, name: service.group || null, services: [] };
      index.set(key, group);
      groups.push(group);
    }
    group.services.push(service);
  }

  return groups;
}

/** 묶음 머리글에 띄울 상태 — **가장 나쁜 것**을 고른다. */
const SEVERITY = { down: 3, degraded: 2, unknown: 1, up: 0, optional: 0 };

function worstStatus(services) {
  // 묶음이 전부 "선택(미사용)" 이면 머리글도 그렇게 — 정상으로 보이면 떠 있는 것처럼 읽힌다.
  if (services.length > 0 && services.every((s) => s.health?.status === 'optional')) return 'optional';
  return services.reduce((worst, s) => {
    const status = s.health?.status || 'unknown';
    return (SEVERITY[status] ?? 1) > (SEVERITY[worst] ?? 1) ? status : worst;
  }, 'up');
}

/**
 * 서비스를 크게 둘로 나눈다.
 *
 *   Default    패키지에 포함된 것. 저장소가 이력째 들고 다니는 일곱 폴더
 *              (kamailio·janus·coturn 과 각 대시보드, manager, websocket-relay, ntp, intro).
 *   Plugged-in 나중에 붙인 것. 자기 저장소를 가진 plug-in — 선언 둘만 맞추고
 *              들어왔고, 이 저장소는 그 코드를 모른다.
 *
 * 어느 쪽인지는 서버가 정한다 (registry.js 의 track — .gitignore 예외 목록이
 * 근거다). 화면은 그 값을 나눠 보여 줄 뿐이다. track 이 없는 것(폴더를 모르는
 * pm2 전용 행)은 패키지에 들었다는 근거가 없으니 Plugged-in 쪽에 둔다.
 *
 * Plugged-in 이 비어 있어도 머리글은 낸다 — "붙일 자리가 있다" 는 사실 자체가
 * 운영자에게 알려 줄 정보다.
 */
const CATEGORIES = [
  {
    key: 'in-repo',
    title: 'Default services',
    hint: '패키지에 포함된 서비스',
    Icon: Package,
    match: (s) => s.track === 'in-repo',
  },
  {
    key: 'plugin',
    title: 'Plugged-in services',
    hint: '나중에 붙인 서비스 — 자기 저장소를 가진 plug-in',
    Icon: Plug,
    match: (s) => s.track !== 'in-repo',
  },
];

function CategoryHead({ category, services, first }) {
  return (
    <TableRow className="border-b-0 hover:bg-transparent">
      <TableCell colSpan={7} className={cn('pb-1', first ? 'pt-4' : 'pt-8')}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <div className="flex items-center gap-2">
            <category.Icon className="size-4 text-muted-foreground" />
            <span className="text-sm font-semibold">{category.title}</span>
            <Badge variant="secondary" className="tabular-nums">
              {services.length}
            </Badge>
            {services.length > 0 && <StatusBadge status={worstStatus(services)} />}
          </div>
          <span className="text-xs text-muted-foreground">{category.hint}</span>
        </div>
      </TableCell>
    </TableRow>
  );
}

function EmptyCategoryRow() {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={7} className="py-4 pl-11 text-xs text-muted-foreground">
        <span>아직 없습니다.</span>{' '}
        <Link to="/add-service" className="inline-flex items-center gap-1 underline underline-offset-4 hover:text-foreground">
          <PackagePlus className="size-3" />
          서비스 추가
        </Link>
        <span> 마법사가 선언 파일 둘(nginx-conf · pm2-conf)을 만들어 줍니다.</span>
      </TableCell>
    </TableRow>
  );
}

export function ServiceTable({ services, onRecheck, rechecking, onRemoved }) {
  const [expanded, setExpanded] = useState(() => new Set());
  const [removing, setRemoving] = useState(null);   // 지우려는 서비스

  function toggle(name) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  }

  if (services.length === 0) {
    return (
      <div className="p-10 text-center text-sm text-muted-foreground">
        nginx-conf에 정의된 라우트가 없습니다.
      </div>
    );
  }

  return (
    <>
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10" />
          <TableHead>서비스</TableHead>
          <TableHead>상태</TableHead>
          <TableHead className="hidden md:table-cell">Location</TableHead>
          <TableHead className="hidden lg:table-cell">대상</TableHead>
          <TableHead className="hidden sm:table-cell">PM2</TableHead>
          <TableHead className="text-right">응답</TableHead>
        </TableRow>
      </TableHeader>

      <TableBody>
        {CATEGORIES.map((category, ci) => {
          const members = services.filter(category.match);

          return [
            <CategoryHead key={`${category.key}-head`} category={category} services={members} first={ci === 0} />,

            members.length === 0 && <EmptyCategoryRow key={`${category.key}-empty`} />,

            ...groupServices(members).map((group) => {
              const grouped = group.services.length > 1;

              return [
                // 한 폴더가 둘 이상을 선언했을 때만 머리글을 낸다. 아이콘은 첫
                // 칸에 두어 하나뿐인 폴더의 행과 같은 자리에 오게 한다.
                grouped && (
                  <TableRow key={`${group.key}-head`} className="border-b-0 hover:bg-transparent">
                    <TableCell className="pb-1 pr-0 pt-4">
                      <Box className="size-4 text-muted-foreground" />
                    </TableCell>
                    <TableCell colSpan={6} className="pb-1 pt-4">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">{group.name}</span>
                        <span>· 서비스 {group.services.length}개</span>
                        <StatusBadge status={worstStatus(group.services)} className="ml-1" />
                      </div>
                    </TableCell>
                  </TableRow>
                ),

                ...group.services.map((service) => {
                  const open = expanded.has(service.name);

                  return [
                    <TableRow
                      key={service.name}
                      className={cn('cursor-pointer', open && 'bg-muted/30')}
                      onClick={() => toggle(service.name)}
                    >
                      {/* 묶음 안의 행은 들여쓴 화살표, 혼자인 행은 폴더 아이콘. */}
                      <TableCell className={cn('pr-0', grouped && 'pl-7')}>
                        {grouped ? (
                          open ? (
                            <ChevronDown className="size-4 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="size-4 text-muted-foreground" />
                          )
                        ) : (
                          <Box className="size-4 text-muted-foreground" />
                        )}
                      </TableCell>

                      <TableCell>
                        <div className="flex items-center gap-2.5">
                          <StatusDot status={service.health.status} />
                          <div>
                            <div className="flex items-center gap-1 font-medium">
                              {service.name}
                              {/* 화살표 자리를 아이콘이 차지했으니 펼침 표시는 이름 옆에 */}
                              {!grouped &&
                                (open ? (
                                  <ChevronDown className="size-3.5 text-muted-foreground" />
                                ) : (
                                  <ChevronRight className="size-3.5 text-muted-foreground" />
                                ))}
                            </div>
                            <div className="text-xs text-muted-foreground md:hidden">
                              {service.location || (service.target ? `:${service.target.port}` : '—')}
                            </div>
                            {service.health.status === 'optional' && service.health.optionalReason && (
                              <div className="max-w-md text-xs text-muted-foreground">{service.health.optionalReason}</div>
                            )}
                          </div>
                          {service.websocket && (
                            <Badge variant="outline" className="hidden sm:inline-flex">
                              WS
                            </Badge>
                          )}
                          {!service.location && (
                            <Badge variant="secondary" className="hidden sm:inline-flex" title="nginx 라우트 없이 포트로 직접 접근">
                              직결
                            </Badge>
                          )}
                        </div>
                      </TableCell>

                      <TableCell>
                        <StatusBadge status={service.health.status} title={service.health.optionalReason} />
                      </TableCell>

                      <TableCell className="hidden font-mono text-xs md:table-cell">
                        {service.location || <span className="text-muted-foreground">—</span>}
                      </TableCell>

                      <TableCell className="hidden font-mono text-xs text-muted-foreground lg:table-cell">
                        {service.target ? `${service.target.host}:${service.target.port}` : '—'}
                      </TableCell>

                      <TableCell className="hidden sm:table-cell">
                        <Pm2Cell pm2={service.pm2} />
                      </TableCell>

                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <span className="tabular-nums text-xs text-muted-foreground">
                            {formatLatency(service.health.latencyMs)}
                          </span>
                          {/*
                            자체 대시보드를 선언한 서비스만 링크를 낸다.
                            패키지에 든 것은 Manager 의 바 아래에 담아 열고(/view),
                            plug-in 은 자기 웹이니 새 탭으로 연다.
                          */}
                          {service.dashboardUrl &&
                            (service.track === 'in-repo' ? (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 gap-1.5"
                                asChild
                                onClick={(e) => e.stopPropagation()}
                              >
                                <Link to={`/view/${encodeURIComponent(service.name)}`} title={`${service.name} 대시보드 — Manager 안에서 열기`}>
                                  <PanelTop className="size-3.5" />
                                  <span className="hidden lg:inline">대시보드</span>
                                </Link>
                              </Button>
                            ) : (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 gap-1.5"
                                asChild
                                onClick={(e) => e.stopPropagation()}
                              >
                                <a href={service.dashboardUrl} target="_blank" rel="noopener" title={`${service.name} 대시보드 — 새 탭에서 열기`}>
                                  <ExternalLink className="size-3.5" />
                                  <span className="hidden lg:inline">대시보드</span>
                                </a>
                              </Button>
                            ))}
                          {/* 지울 수 있는지는 서버가 정한다(removable). 패키지에 든 다섯은 단추가 없다. */}
                          {service.removable && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8 text-muted-foreground hover:text-destructive"
                              title="서비스 지우기 (휴지통으로 이동)"
                              onClick={(e) => {
                                e.stopPropagation();
                                setRemoving(service);
                              }}
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            title="다시 확인"
                            disabled={rechecking === service.name}
                            onClick={(e) => {
                              e.stopPropagation();
                              onRecheck(service.name);
                            }}
                          >
                            <RefreshCw className={cn('size-3.5', rechecking === service.name && 'animate-spin')} />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>,

                    open && <DetailRow key={`${service.name}-detail`} service={service} />,
                  ];
                }),
              ];
            }),
          ];
        })}
      </TableBody>
    </Table>
    {removing && (
      <RemoveServiceDialog
        service={removing}
        folder={removing.group}
        open
        onOpenChange={(v) => {
          if (!v) setRemoving(null);
        }}
        onRemoved={onRemoved}
      />
    )}
    </>
  );
}
