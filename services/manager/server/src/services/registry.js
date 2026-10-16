const fs = require('fs');
const path = require('path');
const config = require('../config');
const log = require('../logger');
const { loadRoutes } = require('../nginx-conf');
const gitignore = require('./gitignore');

/**
 * PM2 앱 목록을 읽는다. pm2/ecosystem.config.js 가 각 서비스의 pm2-conf 선언을
 * 스캔해 만든 배열이다.
 * Nginx 라우트가 없는 서비스(포트로 직접 접근하는 서비스)도 대시보드에 표시하기 위함이다.
 *
 * 각 앱의 env에서 다음 값을 사용한다.
 *   PORT                  : 기본 헬스 URL(http://127.0.0.1:PORT/health) 구성에 사용
 *   HEALTH_URL            : 헬스 URL을 직접 지정 (HTTPS 서비스 등)
 *   HEALTH_INSECURE_TLS   : 'true'면 자체 서명 인증서 검증을 건너뜀
 */
// 헬스 URL에서 대상 호스트/포트를 추출한다. (PORT 없이 HEALTH_URL만 지정된 서비스용)
function describeTarget(healthUrl) {
  if (!healthUrl) return null;
  try {
    const url = new URL(healthUrl);
    const protocol = url.protocol.replace(':', '');
    return {
      protocol,
      host: url.hostname,
      port: url.port ? Number(url.port) : protocol === 'https' ? 443 : 80,
    };
  } catch {
    return null;
  }
}

/**
 * 서비스 자체 대시보드의 공개 URL.
 * Nginx location과 서비스가 선언한 대시보드 경로를 합친다.
 * 둘 중 하나라도 없으면 브라우저에서 열 수 없으므로 null.
 */
function dashboardUrl(service, dashboardPath) {
  if (!dashboardPath || !service.location) return null;

  const base = service.location.replace(/\/+$/, '');
  const suffix = dashboardPath.startsWith('/') ? dashboardPath : `/${dashboardPath}`;
  return `${base}${suffix}`;
}

/**
 * pm2 앱의 cwd 에서 **서비스 폴더 이름**을 뽑는다.
 * ecosystem.config.js 가 services/<폴더>/pm2-conf/*.ini 를 훑어 cwd 를 그
 * 폴더(또는 그 아래 server/ 같은 하위 디렉토리)의 절대 경로로 채워 두므로,
 * services/ 기준 첫 조각이 폴더 이름이다. services/ 밖이면 null.
 */
function serviceDirOf(servicesDir, cwd) {
  if (!cwd) return null;
  const rel = path.relative(servicesDir, path.resolve(cwd));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep)[0] || null;
}

function loadEcosystem(ecosystemPath) {
  if (!ecosystemPath || !fs.existsSync(ecosystemPath)) return [];

  try {
    // 파일이 수정되면 재시작 없이 반영되도록 캐시를 지운다.
    delete require.cache[require.resolve(ecosystemPath)];
    const cfg = require(ecosystemPath);
    // ecosystem.config.js 의 SERVICES_DIR 과 같은 계산이다 (pm2/../services).
    const servicesDir = path.resolve(path.dirname(ecosystemPath), '..', 'services');

    return (cfg.apps || []).map((app) => {
      const env = app.env || {};
      const port = env.PORT ? Number(env.PORT) : null;
      const explicitHealthUrl = env.HEALTH_URL || null;

      const healthUrl = explicitHealthUrl || (port ? `http://127.0.0.1:${port}/health` : null);

      return {
        name: app.name,
        // 이 앱을 선언한 서비스 폴더. nginx 선언이 없는 앱을 폴더로 묶고
        // 기본/추가를 가를 때 쓴다.
        dir: serviceDirOf(servicesDir, app.cwd),
        port,
        script: app.script || null,
        explicitHealthUrl,
        healthUrl,
        target: describeTarget(healthUrl),
        insecureTls: String(env.HEALTH_INSECURE_TLS).toLowerCase() === 'true',
        // 서비스가 자체 대시보드를 제공하면 그 경로. (없으면 링크를 만들지 않는다)
        dashboardPath: env.DASHBOARD_PATH || null,
      };
    });
  } catch (err) {
    log.warn(`Failed to read ecosystem config (${ecosystemPath}): ${err.message}`);
    return [];
  }
}

/**
 * 이 서비스가 **패키지에 포함된 것**인가, **나중에 붙인 것**인가.
 *
 *   'in-repo'  저장소가 이력째 들고 다니는 서비스. .gitignore 에 예외가
 *              열려 있는 폴더가 그것이다 (manager).
 *   'plugin'   자기 저장소를 가진 서비스. 선언 둘(nginx-conf·pm2-conf)만
 *              맞춰 붙었고, 이 저장소는 그 코드를 모른다.
 *
 * 값 이름은 서비스 추가 마법사의 track 과 같다 (scaffold.js). 마법사에서
 * "이 저장소에 함께 커밋" 을 고르면 .gitignore 에 줄이 생기고, 그 순간부터
 * 여기서도 in-repo 로 읽힌다 — 두 곳이 같은 파일을 보기 때문이다.
 *
 * 폴더를 모르면(nginx 선언도 없고 cwd 도 services/ 밖) null. 화면은 이것을
 * 추가 서비스 쪽에 둔다 — 패키지에 든 것이라는 근거가 없기 때문이다.
 */
function trackOf(bundled, group) {
  if (!group) return null;
  return bundled.has(group) ? 'in-repo' : 'plugin';
}

/**
 * nginx-conf 라우트와 PM2 앱 목록을 이름 기준으로 합친다.
 * 각 서비스의 sources에 'nginx' / 'pm2'가 표시된다.
 */
function loadServices() {
  const { server, routes, source } = loadRoutes(config.nginxStackPath);
  const apps = loadEcosystem(config.ecosystemPath);
  const bundled = gitignore.listEntries();

  const byName = new Map();

  for (const route of routes) {
    byName.set(route.name, {
      ...route,
      track: trackOf(bundled, route.group),
      // HTTPS 백엔드는 대개 자체 서명 인증서를 쓰므로 검증을 건너뛴다.
      insecureTls: route.target?.protocol === 'https',
      // pm2 앱에서 DASHBOARD_PATH를 선언한 경우 아래 루프에서 채워진다.
      dashboardUrl: null,
      sources: ['nginx'],
    });
  }

  for (const app of apps) {
    const existing = byName.get(app.name);

    if (existing) {
      existing.sources.push('pm2');
      // ecosystem에 헬스 URL이 명시돼 있으면 그쪽을 우선한다.
      if (app.explicitHealthUrl) {
        existing.healthUrl = app.explicitHealthUrl;
        existing.insecureTls = app.insecureTls;
      }
      existing.dashboardUrl = dashboardUrl(existing, app.dashboardPath || existing.dashboardPath);
      continue;
    }

    byName.set(app.name, {
      name: app.name,
      // nginx 선언이 없어도 pm2 cwd 로 폴더는 안다. 그 폴더의 다른 서비스와
      // 한 묶음으로 서고, 기본/추가도 같은 기준으로 갈린다.
      group: app.dir,
      track: trackOf(bundled, app.dir),
      location: null,
      proxyPass: null,
      websocket: false,
      healthPath: '/health',
      target: app.target,
      healthUrl: app.healthUrl,
      publicPath: null,
      insecureTls: app.insecureTls,
      // Nginx 라우트가 없으면 브라우저에서 열 수 없으므로 링크를 만들지 않는다.
      dashboardUrl: null,
      sources: ['pm2'],
    });
  }

  return {
    server,
    services: [...byName.values()],
    source: {
      ...source,
      ecosystemPath: fs.existsSync(config.ecosystemPath) ? config.ecosystemPath : null,
    },
  };
}

module.exports = { loadServices, loadEcosystem };
