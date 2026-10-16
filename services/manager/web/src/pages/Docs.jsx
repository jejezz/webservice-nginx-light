import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AlertCircle, BookOpen, Download, ExternalLink, FileText, History, Loader2, RefreshCw } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/context/auth';
import { formatDateTime } from '@/lib/format';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TopBar } from '@/components/TopBar';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

// 읽는 순서. 여기 있는 문서는 이 순서와 묶음으로 보이고, 목록에 없는
// .md 는(plug-in 이 커밋한 문서 등) 그 뒤에 경로로 묶어 붙는다 — 새 문서가
// 생겨도 화면에서 빠지지는 않는다. 문서 체계는 README.md '문서 지도' 참고.
const DOC_ORDER = [
  ['README.md', '개요'],
  ['docs/services.md', '개요'],
  ['docs/guide/README.md', '구현 가이드'],
  ['docs/guide/install.md', '구현 가이드'],
  ['docs/guide/infrastructure.md', '구현 가이드'],
  ['docs/guide/contracts.md', '구현 가이드'],
  ['docs/guide/declarations.md', '구현 가이드'],
  ['docs/guide/rollout.md', '구현 가이드'],
  ['docs/dashboards.md', '참고'],
  ['docs/ports.md', '참고'],
];
const DOC_INDEX = new Map(DOC_ORDER.map(([p], i) => [p, i]));
const DOC_GROUP = new Map(DOC_ORDER);
const DEFAULT_DOC = 'README.md';

function groupOf(path) {
  if (DOC_GROUP.has(path)) return DOC_GROUP.get(path);
  if (!path.includes('/')) return '기타';
  const m = path.match(/^services\/([^/]+)\//);
  if (m) return `서비스 — ${m[1]}`;
  return path.split('/').slice(0, -1).join('/');
}

function docRank(path) {
  return DOC_INDEX.has(path) ? DOC_INDEX.get(path) : DOC_ORDER.length;
}

// 문서 안의 상대 링크(`../ports.md#절`)를 저장소 루트 기준 경로로 푼다.
function resolveDocPath(from, href) {
  const parts = from.split('/').slice(0, -1);
  for (const seg of href.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

// GitHub 와 같은 규칙으로 제목에 id 를 붙인다 — 문서가 `#절-제목` 으로 서로를
// 가리키므로 저장소에서 보든 이 화면에서 보든 같은 앵커가 통해야 한다.
function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function textOf(node) {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value;
  return (node.children || []).map(textOf).join('');
}

function remarkHeadingIds() {
  return (tree) => {
    const seen = new Map();
    const walk = (node) => {
      if (node.type === 'heading') {
        const base = slugify(textOf(node));
        const n = seen.get(base) || 0;
        seen.set(base, n + 1);
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id: n ? `${base}-${n}` : base } };
      }
      (node.children || []).forEach(walk);
    };
    walk(tree);
  };
}

function DocsBrowser() {
  const [files, setFiles] = useState(null);
  const [error, setError] = useState('');
  const [searchParams, setSearchParams] = useSearchParams();
  const selected = searchParams.get('path');
  const [anchor, setAnchor] = useState('');
  const [content, setContent] = useState('');
  const [contentError, setContentError] = useState('');
  const [loadingContent, setLoadingContent] = useState(false);
  const [filter, setFilter] = useState('');
  const mounted = useRef(true);

  useEffect(() => () => {
    mounted.current = false;
  }, []);

  useEffect(() => {
    api.docs
      .list()
      .then((r) => {
        if (!mounted.current) return;
        const sorted = [...r.files].sort((a, b) => docRank(a.path) - docRank(b.path) || a.path.localeCompare(b.path));
        setFiles(sorted);
        if (!searchParams.get('path') && sorted.length) {
          const first = sorted.some((f) => f.path === DEFAULT_DOC) ? DEFAULT_DOC : sorted[0].path;
          setSearchParams({ path: first }, { replace: true });
        }
      })
      .catch((err) => mounted.current && setError(err.message || '문서 목록을 불러오지 못했습니다.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openDoc = useCallback(
    (path, hash = '') => {
      if (path !== selected) {
        setAnchor(hash);
        setSearchParams({ path });
        return;
      }
      // 같은 문서 안 — 다시 불러올 것이 없으니 바로 옮긴다.
      const el = hash && document.getElementById(hash);
      if (el) el.scrollIntoView({ block: 'start' });
      else window.scrollTo({ top: 0 });
    },
    [selected, setSearchParams]
  );

  // 문서가 바뀌었거나 같은 문서 안의 절로 갈 때 — 내용이 그려진 뒤에 옮긴다.
  useEffect(() => {
    if (loadingContent) return;
    if (!anchor) {
      window.scrollTo({ top: 0 });
      return;
    }
    const el = document.getElementById(anchor);
    if (el) el.scrollIntoView({ block: 'start' });
  }, [anchor, content, loadingContent]);

  const markdownComponents = useMemo(() => {
    const known = new Set((files || []).map((f) => f.path));
    return {
      a({ href = '', children, node: _node, ...props }) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
          return (
            <a href={href} target="_blank" rel="noreferrer" {...props}>
              {children}
            </a>
          );
        }
        const [rawPath, rawHash = ''] = href.split('#');
        const hash = decodeURIComponent(rawHash);
        const target = rawPath ? resolveDocPath(selected || '', decodeURIComponent(rawPath)) : selected;
        if (known.has(target)) {
          return (
            <a
              href={`?path=${encodeURIComponent(target)}${hash ? `#${encodeURIComponent(hash)}` : ''}`}
              onClick={(e) => {
                e.preventDefault();
                openDoc(target, hash);
              }}
              {...props}
            >
              {children}
            </a>
          );
        }
        // 문서가 아닌 저장소 파일(스크립트·설정)은 이 화면에서 열 수 없다 — 경로만 보인다.
        return (
          <span className="underline decoration-dotted" title={target}>
            {children}
          </span>
        );
      },
    };
  }, [files, selected, openDoc]);

  useEffect(() => {
    if (!selected) return;
    setLoadingContent(true);
    setContentError('');
    api.docs
      .content(selected)
      .then((r) => mounted.current && setContent(r.content))
      .catch((err) => mounted.current && setContentError(err.message || '문서를 불러오지 못했습니다.'))
      .finally(() => mounted.current && setLoadingContent(false));
  }, [selected]);

  const grouped = useMemo(() => {
    if (!files) return [];
    const q = filter.trim().toLowerCase();
    const matched = q
      ? files.filter((f) => f.path.toLowerCase().includes(q) || f.title.toLowerCase().includes(q))
      : files;

    const groups = new Map();
    for (const f of matched) {
      const g = groupOf(f.path);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(f);
    }
    // files 가 이미 읽는 순서로 정렬돼 있으므로 묶음도 처음 나온 순서를 따른다.
    return [...groups.entries()];
  }, [files, filter]);

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  if (!files) return <Skeleton className="h-96" />;

  return (
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      <Card className="h-fit lg:sticky lg:top-20">
        <CardContent className="space-y-3 p-3">
          <Input
            placeholder="파일·제목 검색…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-8 text-xs"
          />
          <nav className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
            {grouped.map(([group, items]) => (
              <div key={group}>
                <p className="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {group}
                </p>
                <ul className="space-y-0.5">
                  {items.map((f) => (
                    <li key={f.path}>
                      <button
                        type="button"
                        onClick={() => openDoc(f.path)}
                        className={cn(
                          'block w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-accent',
                          selected === f.path && 'bg-accent font-medium'
                        )}
                        title={f.path}
                      >
                        {f.title}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {grouped.length === 0 && <p className="px-1 text-xs text-muted-foreground">일치하는 문서가 없습니다.</p>}
          </nav>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-6">
          {contentError ? (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertDescription>{contentError}</AlertDescription>
            </Alert>
          ) : loadingContent ? (
            <Skeleton className="h-96" />
          ) : (
            <>
              <p className="mb-4 font-mono text-xs text-muted-foreground">{selected}</p>
              <div className="overflow-x-auto">
                <article className="prose prose-sm max-w-none dark:prose-invert prose-code:before:content-none prose-code:after:content-none [&_:is(h1,h2,h3,h4)]:scroll-mt-20">
                  <ReactMarkdown remarkPlugins={[remarkGfm, remarkHeadingIds]} components={markdownComponents}>
                    {content}
                  </ReactMarkdown>
                </article>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ChangelogBrowser() {
  const [scopeOptions, setScopeOptions] = useState(null);
  const [scope, setScope] = useState('');
  const [commits, setCommits] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const mounted = useRef(true);

  useEffect(() => () => {
    mounted.current = false;
  }, []);

  const load = useCallback((s) => {
    setLoading(true);
    setError('');
    api
      .changelog(s)
      .then((r) => {
        if (!mounted.current) return;
        setCommits(r.commits);
        if (!scopeOptions) setScopeOptions(r.scopes);
      })
      .catch((err) => mounted.current && setError(err.message || '변경 이력을 불러오지 못했습니다.'))
      .finally(() => mounted.current && setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load(scope);
  }, [scope, load]);

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">범위</span>
          <Button variant={scope === '' ? 'default' : 'outline'} size="sm" onClick={() => setScope('')}>
            전체
          </Button>
          <Button variant={scope === 'docs' ? 'default' : 'outline'} size="sm" onClick={() => setScope('docs')}>
            docs/
          </Button>
          {(scopeOptions?.services || []).map((s) => (
            <Button key={s} variant={scope === s ? 'default' : 'outline'} size="sm" onClick={() => setScope(s)}>
              {s}
            </Button>
          ))}
          <Button variant="ghost" size="icon" className="ml-auto" onClick={() => load(scope)} disabled={loading}>
            <RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
          </Button>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {!commits ? (
          <Skeleton className="h-96" />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>날짜</TableHead>
                  <TableHead>커밋</TableHead>
                  <TableHead>지은이</TableHead>
                  <TableHead>내용</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {commits.map((c) => (
                  <TableRow key={c.hash}>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatDateTime(c.date)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{c.hash}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{c.author}</TableCell>
                    <TableCell className="text-sm">{c.subject}</TableCell>
                  </TableRow>
                ))}
                {commits.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-xs text-muted-foreground">
                      커밋이 없습니다.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// 설치 가이드 PDF — 소개 페이지(공개)에는 싣지 않고, 로그인한 사람에게만 내려 준다.
function GuidesBrowser() {
  const [files, setFiles] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const mounted = useRef(true);

  useEffect(() => () => {
    mounted.current = false;
  }, []);

  useEffect(() => {
    api.guides
      .list()
      .then((r) => mounted.current && setFiles(r.files))
      .catch((err) => mounted.current && setError(err.message || '가이드 목록을 불러오지 못했습니다.'));
  }, []);

  const download = async (f) => {
    setBusy(f.name);
    setError('');
    try {
      const blob = await api.guides.download(f.name);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) {
      if (mounted.current) {
        setError(err.status === 401 ? '세션이 만료되었습니다. 다시 로그인한 뒤 받아 주세요.' : err.message || '내려받지 못했습니다.');
      }
    } finally {
      if (mounted.current) setBusy('');
    }
  };

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <BookOpen className="size-4" />
            설치 가이드 (PDF)
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            이 장비를 빈 상태에서부터 세우는 방법입니다. 이 장비를 구성할 사람에게만 로그인 뒤에 내려 줍니다.
          </p>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {!files && !error ? (
          <Skeleton className="h-24" />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {(files || []).map((f) => (
              <li key={f.name} className="flex items-center gap-3 rounded-lg border p-3">
                <FileText className="size-8 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{f.title}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground" title={f.name}>
                    {f.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatSize(f.size)} · {formatDateTime(f.updatedAt)}
                  </p>
                </div>
                <Button size="sm" onClick={() => download(f)} disabled={busy === f.name}>
                  {busy === f.name ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                  <span>받기</span>
                </Button>
              </li>
            ))}
            {files && files.length === 0 && (
              <li className="text-xs text-muted-foreground sm:col-span-2">
                가이드 파일이 없습니다. <code className="font-mono">docs/downloads/*.pdf</code> 에 두면 여기에 나타납니다.
              </li>
            )}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default function Docs() {
  const { logout } = useAuth();
  const [tab, setTab] = useState('docs');

  // 세션 만료는 두 탭 모두 같은 방식으로 처리한다 — 자식이 401 을 던지면
  // 여기서 잡지 않고 자기가 로그인 화면으로 보내므로, 이 컴포넌트는
  // 그냥 logout 을 물려주기만 한다. (지금은 각 브라우저가 자체 처리)
  void logout;

  return (
    <div className="min-h-screen bg-background">
      <TopBar subtitle="문서 · 설치 가이드 · 변경 이력">
        <Button variant={tab === 'docs' ? 'default' : 'outline'} size="sm" onClick={() => setTab('docs')}>
          <FileText className="size-3.5" />
          <span className="hidden sm:inline">문서</span>
        </Button>
        <Button variant={tab === 'guides' ? 'default' : 'outline'} size="sm" onClick={() => setTab('guides')}>
          <BookOpen className="size-3.5" />
          <span className="hidden sm:inline">설치 가이드</span>
        </Button>
        <Button variant={tab === 'log' ? 'default' : 'outline'} size="sm" onClick={() => setTab('log')}>
          <History className="size-3.5" />
          <span className="hidden sm:inline">변경 이력</span>
        </Button>
      </TopBar>

      <main className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6">
        {tab === 'docs' ? <DocsBrowser /> : tab === 'guides' ? <GuidesBrowser /> : <ChangelogBrowser />}

        <p className="pb-4 text-center text-xs text-muted-foreground">
          <ExternalLink className="mr-1 inline size-3" />
          여기 뜨는 문서는 git 이 추적하는 <code className="font-mono">.md</code> 파일 전부입니다 — 비밀·장비별 값(settings.ini·secrets/)은
          이 저장소 관례상 커밋되지 않으므로 애초에 목록에 오르지 않습니다.
        </p>
      </main>
    </div>
  );
}
