import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertCircle, ExternalLink, Loader2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { TopBar } from '@/components/TopBar';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

/**
 * 다른 서비스의 대시보드를 Manager 의 바 아래에 iframe 으로 담는다.
 *
 * **패키지에 포함된(in-repo) 서비스만** 여기로 온다. 그것들은 같은 오리진에
 * 같은 SSO 세션을 쓰고, 프레임을 막는 헤더도 내지 않아 그대로 실린다.
 * plug-in 의 대시보드는 그 서비스의 웹이라 새 탭으로 연다 (ServiceTable) —
 * 주소로 직접 들어와도 여기서 담지 않고 새 탭 링크만 낸다.
 *
 * 한계: 주소창은 /view/<이름> 에 머문다. iframe 안에서 어디로 갔는지는
 * 주소에 남지 않아, 새로고침하면 그 대시보드의 첫 화면으로 돌아간다.
 */
export default function ServiceView() {
  const { name } = useParams();
  const [service, setService] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setService(null);
    setError('');

    api
      .service(name)
      .then((s) => {
        if (!cancelled) setService(s);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError && err.status === 404 ? `'${name}' 이라는 서비스가 없습니다.` : err.message);
      });

    return () => {
      cancelled = true;
    };
  }, [name]);

  const embeddable = service?.track === 'in-repo' && service?.dashboardUrl;

  return (
    <div className="flex h-screen flex-col bg-background">
      <TopBar subtitle={`${name} 대시보드`}>
        {service?.dashboardUrl && (
          <Button variant="outline" size="sm" asChild title="이 대시보드만 새 탭에서">
            <a href={service.dashboardUrl} target="_blank" rel="noopener">
              <ExternalLink className="size-3.5" />
              <span className="hidden sm:inline">새 탭</span>
            </a>
          </Button>
        )}
      </TopBar>

      {error ? (
        <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
          <Alert variant="destructive">
            <AlertCircle />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </div>
      ) : !service ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : embeddable ? (
        <iframe
          key={service.dashboardUrl}
          src={service.dashboardUrl}
          title={`${service.name} 대시보드`}
          className="w-full flex-1 border-0"
        />
      ) : (
        <div className="mx-auto w-full max-w-7xl space-y-3 px-4 py-6 text-sm sm:px-6">
          {service.dashboardUrl ? (
            <>
              <p>
                <span className="font-medium">{service.name}</span> 은(는) 나중에 붙인 서비스(plug-in)라 그 대시보드는
                자기 웹입니다. Manager 안에 담지 않고 새 탭에서 엽니다.
              </p>
              <Button asChild>
                <a href={service.dashboardUrl} target="_blank" rel="noopener">
                  <ExternalLink className="size-3.5" />
                  {service.dashboardUrl} 열기
                </a>
              </Button>
            </>
          ) : (
            <p>
              <span className="font-medium">{service.name}</span> 은(는) 자체 대시보드를 선언하지 않았습니다
              (nginx-conf 의 <code className="font-mono">dashboard_path</code>).
            </p>
          )}
          <p>
            <Link to="/dashboard" className="underline underline-offset-4">
              대시보드로 돌아가기
            </Link>
          </p>
        </div>
      )}
    </div>
  );
}
