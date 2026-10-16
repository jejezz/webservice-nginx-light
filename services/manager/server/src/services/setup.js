const path = require('path');
const fs = require('fs');
const config = require('../config');
const log = require('../logger');
const shared = require(path.join(config.repoRoot, 'lib', 'settings'));
const attest = require('./setup-attest');
const settings = require('./setup-settings');
const checkRunner = require('./check-runner');
const portMap = require('./port-map');
const auto = require('./setup-auto');

/**
 * 구축 마법사의 단계 정의와 점검 실행기.
 *
 * 설계는 docs/guide/install.md '8. 마법사가 일하는 방식', 점검 출력의 형식은 docs/guide/contracts.md '출력 형식' 에
 * 있습니다. 이 파일은 그 둘을 잇는 곳입니다 — 단계를 데이터로 적어 두고,
 * 각 단계가 가리키는 점검 스크립트를 돌려 `--json` 을 읽습니다.
 *
 * ── 경계 (docs/guide/install.md '8. 마법사가 일하는 방식' 의 실행 경계) ──────
 *
 *   1. 실행할 것은 아래 STEPS 에 **박혀 있는 것뿐**입니다. :stepId 는 이 표에서
 *      한 줄을 고르는 데만 쓰고, 문자열을 이어 붙여 명령을 만들지 않습니다.
 *   2. **점검 모드만** 돌립니다. --apply · --install 처럼 무언가를 바꾸는
 *      모드는 마법사가 실행하지 않습니다. sudo 도 부르지 않습니다.
 *   3. 셸을 거치지 않습니다 (execFile). 타임아웃과 출력 상한을 둡니다.
 *   4. 실행 파일은 저장소 안에 있어야 합니다.
 *
 * 실제 실행기(경로 봉쇄·환경 변수 추림·타임아웃)는 check-runner.js 에 있습니다
 * — 서비스 추가 마법사(services/register.js)도 같은 규약으로 돌아야 해서
 * 공용으로 뽑았습니다. 이 파일은 그 실행기에 STEPS 표의 각 단계를 흘려보내는
 * 자리로만 남습니다.
 */

/**
 * 포워딩 질문은 **포트 지도에서 만든다.**
 *
 * 예전에는 여기 문자열이 박혀 있었고, 그것이 포트 지도와 갈라졌습니다 —
 * 포트 지도에 없는 대역을 열라고 시키면서 정작 필요한 포트는 묻지 않았습니다. 사람이 두 표를 같이 고쳐 줄 것을
 * 기대하지 않고, 한쪽에서 뽑습니다: 설정에서 대역을 바꾸면 질문도 따라 바뀝니다.
 *
 * 목록은 포트 지도의 '공유기 포트 포워딩 체크리스트' 와 **같은 것**입니다
 * (docs/ports.md '5. 공유기 포트 포워딩'). 80/443 도 들어갑니다 — 집 밖 브라우저는 그리로
 * 들어와야 페이지를 받습니다.
 */
function forwardingPorts() {
  let rows = [];
  try {
    rows = portMap.build().forwardingChecklist;
  } catch (err) {
    log.warn(`setup: 포워딩 체크리스트를 만들지 못했습니다 (${err.message})`);
  }
  if (!rows.length) return null;
  return rows.map((r) => `${r.protocol} ${r.port}`).join(' · ');
}

function forwardingQuestion() {
  const list = forwardingPorts();
  if (!list) return '공유기에 포워딩을 열었습니까? (열어야 하는 목록은 포트 지도에 있습니다)';
  return `공유기에 ${list} 포워딩을 열었습니까? (포트 지도의 체크리스트와 같은 목록입니다)`;
}

/**
 * 단계 정의. 화면에 순서를 박지 않고 여기에 적는다 — 순서는 requires 에서 나온다.
 *
 *   check       점검 스크립트. 셸을 거치지 않으므로 file 과 args 를 나눠 적는다.
 *               interpreter: 'node' 면 node 로 돌린다 (pm2 선언은 셸 스크립트가 아니다).
 *   attest      사람만 확인할 수 있는 것. 있으면 사람의 확인까지 있어야 문이 열린다.
 *               question 은 함수여도 된다 — 값에서 나오는 질문은 굳혀 두지 않는다.
 *               subject 를 함께 두면 **무엇을 확인한 것인지**가 기록에 남고,
 *               그것이 나중에 바뀌면 예전 확인은 stale 이 된다.
 *   manualOnly  자동 점검이 아예 불가능한 단계 (check 가 없다).
 *   optional    선택 기능. **필수 단계**가 이것을 requires 로 걸지 않는다
 *               (선택 단계끼리는 건다 — 공인 인증서 넷이 그렇다).
 *               함수여도 된다 — (ctx) => boolean. ctx.tlsMode 는 1단계의
 *               tls_mode 다. 값에 따라 필수/선택이 바뀌는 단계에 쓴다.
 */
const STEPS = [
  {
    id: 'site.settings',
    service: 'site',
    title: '사이트 값 (여러 곳이 함께 씁니다)',
    why:
      '호스트와 tls_mode 는 **nginx · 인증서 · manager 가 함께 쓰는 값**입니다. ' +
      '각자 자기 설정 파일에 적게 두면 언젠가 어긋나고, 그 어긋남은 조용합니다 — ' +
      '서버는 멀쩡히 돌고 브라우저만 엉뚱한 이름이나 인증서 경고를 만납니다.\n\n' +
      '여기서 한 번 받고 나머지가 그 값에서 나옵니다. **가장 먼저 채우세요.**\n\n' +
      'host 는 **이 장비 밖에서 먼저 정해져야 하는 값**입니다 — 공인 인증서를 쓰려면 ' +
      '소유한 도메인 아래의 이름이어야 하고(DDNS 불가) 등록기관에 A 레코드가 있어야 ' +
      '합니다. 무엇을 미리 받아 둘지는 docs/guide/install.md ' +
      '"1. 시작하기 전에 — 장비 밖에서 준비할 것" 에 한 장으로 있습니다.',
    // 아무것도 요구하지 않는다. 다른 단계들이 이 값을 쓰므로 맨 앞이어야 한다.
    requires: [],
    settings: { dir: 'site' },
    command: { cwd: '.', run: './site/apply.sh --apply' },
    check: { cwd: '.', file: './site/apply.sh', args: ['--check', '--json'] },
  },
  {
    id: 'tls.decide',
    service: 'nginx',
    title: '서버 인증서를 공인으로 갈지 사설로 갈지 정합니다',
    why:
      '**이 갈림길이 지금까지 아무 데도 없었습니다.** nginx 는 어느 쪽이든 멀쩡히 뜨고 ' +
      '브라우저만 사설 CA 에 경고를 냅니다. 그래서 사설로 떨어진 것을 **앱이 안 붙는다는 ' +
      '신고가 올 때까지 아무도 모릅니다.**\n\n' +
      '여기서 한 번 소리 내어 정하고 지나갑니다. 사설이 잘못된 것은 아닙니다 — LAN 전용 ' +
      '배치에서는 그쪽이 옳고, 도메인이 없거나 80 을 열 수 없는 장비가 실재합니다. ' +
      '잘못된 것은 **모르고 지나가는 것**입니다.\n\n' +
      '값은 1단계의 `tls_mode` 입니다 (`auto`·`public`·`private`). `auto` 로 두면 그 이름으로 ' +
      '발급받은 것이 있을 때 저절로 공인이 됩니다 — 발급이 끝나는 순간 이 단계의 판정도 ' +
      '따라 바뀝니다.\n\n' +
      '⚠️ **앱을 스토어로 배포하는 배치라면 사설 CA 는 선택지가 아닙니다.** 앱이 그 CA 를 ' +
      '믿게 만들 방법이 사실상 없습니다 (iOS 는 사용자가 손으로 신뢰를 켜야 하고, Android 는 ' +
      'API 24+ 부터 앱이 자기가 선언한 CA 만 씁니다).',
    // 이름이 정해져야 판정할 수 있다. host 가 곧 인증서 이름이다.
    requires: ['site.settings'],
    command: {
      cwd: 'nginx',
      run:
        '# 값은 1단계(site/settings.ini)의 tls_mode 로 바꿉니다.\n' +
        '# 사설로 간다면 인증서를 만듭니다:\n' +
        './generate_certs.sh --auto <host>',
      sudo: false,
    },
    check: { cwd: 'nginx', file: './tls-decide.sh', args: ['--check', '--json'] },
  },
  {
    id: 'database.schema',
    service: 'database',
    title: 'MariaDB 설치와 스키마 적용',
    why:
      'manager 의 로그인 계정과 감사 로그가 여기에 있습니다. DB 가 없으면 ' +
      '관리자가 로그인할 수 없으므로 manager 를 띄우기 전에 먼저 갖춥니다.',
    requires: [],
    // 장비마다 다른 [server] 값 — 열 주소·포트·버퍼 풀 (settings-schema.json).
    // 나머지 선언(스키마·계정)은 database.ini 가 갖고 그것은 커밋한다.
    settings: { dir: 'database' },
    command: { cwd: 'database', run: 'sudo ./setup_mariadb.sh', sudo: true },
    check: { cwd: 'database', file: './check-database.sh', args: ['--check', '--json'] },
  },
  {
    id: 'pm2.apps',
    service: 'pm2',
    title: 'pm2 설치와 부팅 등록',
    why:
      'node 서비스들이 여기서 뜹니다. 선언은 services/*/pm2-conf/app.ini 에 있고 ' +
      'ecosystem.config.js 가 그것을 모읍니다. ' +
      '**이 시점에는 manager 가 아직 빌드 전이라** `pm2 start` 가 ' +
      '"Script not found" 를 내거나 일부 앱이 errored 로 보일 수 있습니다 ' +
      '— 정상입니다. 빌드한 뒤 그 폴더의 `npm run restart` 로 살아납니다.',
    requires: [],
    command: {
      cwd: 'pm2',
      run: './install_pm2.sh install\npm2 start ecosystem.config.js\npm2 save',
      sudo: true,
    },
    // pm2 선언은 셸 스크립트가 아니라 node 모듈이고, --json 은 이미 다른 뜻으로
    // 쓰이고 있다 (docs/guide/contracts.md '예외 — --json 이 이미 다른 뜻이던 자리').
    check: {
      cwd: 'pm2',
      file: './ecosystem.config.js',
      args: ['--check-json'],
      interpreter: 'node',
    },
  },
  {
    id: 'nginx.routes',
    service: 'nginx',
    title: 'nginx 라우트 반영',
    why:
      '라우트는 서비스가 뜬 뒤에 반영합니다. 뒤집으면 /manager 가 502 로 뜨고 ' +
      '대시보드에는 "중단" 으로 보입니다.',
    // 서버 인증서(사설이면 tls.decide 가 만든다)가 없으면 이 점검이 problem 이다 — 그것이 앞이어야 한다.
    requires: ['pm2.apps', 'tls.decide'],
    command: { cwd: 'nginx', run: 'sudo ./install_nginx_stack.sh --skip-install', sudo: true },
    check: { cwd: 'nginx', file: './install_nginx_stack.sh', args: ['--check', '--json'] },
  },
  // ── 공인 인증서 (Let's Encrypt) ─────────────────────────────────────
  //
  // 사설 CA(nginx/generate_certs.sh)로도 TLS 는 돕니다. 아래 넷은 그것을
  // **공인 인증서로 옮기는** 절차입니다 — 브라우저가 CA 를 미리 믿지 않아도 되게.
  //
  // 넷 다 선택으로 둡니다. LAN 전용 설치는 사설 CA 로 계속 도는 것이 옳고,
  // 공인 이름을 받을 수 없는 배치(도메인 없음·80 포트 막힘)도 있기 때문입니다.
  // 배포용에서는 넷 다 해야 하고, 안 끝났다는 사실은 대시보드의 TLS 카드가
  // 사설 CA 를 계속 warn 으로 두어 잊히지 않게 합니다.
  {
    id: 'public_ca.issue',
    service: 'nginx',
    title: "공인 인증서 발급 (Let's Encrypt)",
    why:
      '사설 CA 는 브라우저마다 그 CA 를 믿게 만들어야 합니다. 공인 인증서로 ' +
      '옮기면 경고가 사라지고, 갱신은 90일마다 certbot 이 ' +
      '알아서 합니다. **staging 을 건너뛰지 마세요** — 같은 이름 조합에 주 5건 제한이 ' +
      '있고, 설정을 더듬다 보면 놀랄 만큼 빨리 소진됩니다. 한 번 걸리면 일주일을 ' +
      '기다립니다.',
    // HTTP-01 챌린지는 반드시 80 으로 들어오는데, 80 은 전부 HTTPS 로 301 합니다.
    // 그 예외(acme_webroot)를 만드는 것이 nginx.routes 입니다. 뒤집으면 챌린지가
    // 301 로 튕겨 발급이 통과하지 못합니다.
    // tls.decide 가 앞에 있는 이유는 순서가 아니라 **자각**입니다 — 공인으로 갈
    // 수 있는 장비인지(이름·A 레코드·certbot)를 발급을 시도하기 전에 봅니다.
    // 발급은 되돌리기 어려운 단계라 라우트가 선 뒤에 한다.
    requires: ['nginx.routes', 'tls.decide'],
    optional: true,
    // 장비·단지마다 다른 값 — 도메인·알림 메일 (settings-schema.json)
    settings: { dir: 'nginx/public_ca' },
    command: {
      cwd: 'nginx/public_ca',
      run:
        './setup_letsencrypt.sh --check\n' +
        'sudo ./setup_letsencrypt.sh --staging\n' +
        'sudo ./setup_letsencrypt.sh --prod',
      sudo: true,
    },
    check: { cwd: 'nginx/public_ca', file: './setup_letsencrypt.sh', args: ['--check', '--json'] },
  },
  {
    id: 'public_ca.nginx',
    service: 'nginx',
    title: '발급받은 인증서를 nginx 에 물리기',
    why:
      '**발급받은 것과 내밀고 있는 것은 다릅니다.** 발급은 certbot 이 ' +
      '/etc/letsencrypt/ 에 두는 것이고, nginx 는 반영해야 그것을 읽습니다.\n\n' +
      '경로를 손으로 적을 필요는 없습니다 — `tls_mode` 가 `auto` 면 발급이 끝나는 순간 ' +
      '생성기가 `/etc/letsencrypt/live/<host>/fullchain.pem` 으로 저절로 갈아탑니다. ' +
      '`cert.pem` 이 아니라 **`fullchain.pem`** 인 것도 생성기가 정합니다 — 중간 인증서가 ' +
      '빠지면 브라우저는 멀쩡한데 일부 안드로이드 기기에서만 실패하는, 찾기 아주 어려운 ' +
      '버그가 납니다.\n\n' +
      '**남은 것은 반영뿐입니다.** 점검은 파일이 아니라 **실제 접속해서** 무엇이 나가고 ' +
      '있는지 읽습니다.',
    requires: ['public_ca.issue'],
    optional: true,
    command: {
      cwd: 'nginx',
      run:
        '# tls_mode 가 auto 면 경로는 저절로 잡힙니다. 반영만 하면 됩니다.\n' +
        '#   python3 ./generate_nginx_conf.py --tls-mode   ← 어느 쪽으로 갈렸는지 확인\n' +
        'sudo ./install_nginx_stack.sh --skip-install',
      sudo: true,
    },
    check: { cwd: 'nginx/public_ca', file: './cert-status.sh', args: ['--check', '--json'] },
  },
  {
    id: 'public_ca.renew',
    service: 'nginx',
    title: '90일 자동 갱신',
    why:
      'certbot 은 설치될 때 자기 systemd 타이머를 함께 깝니다 — 유닛을 만들 필요가 ' +
      '없습니다. 문제는 **갱신 훅**입니다. 그것이 없으면 certbot 이 조용히 갱신해 두어도 ' +
      'nginx 는 메모리에 올린 옛 인증서를 계속 내밉니다. 파일은 최신인데 접속은 만료로 ' +
      '끊기는, 원인을 찾기 아주 어려운 상태가 됩니다. 셋 다 **터지기 전에는 아무 증상이 ' +
      '없어서** 만료를 기다리지 않고 지금 물어봅니다.',
    requires: ['public_ca.nginx'],
    optional: true,
    command: {
      cwd: 'nginx/public_ca',
      run:
        '# 타이머가 꺼져 있을 때만. 발급이 훅까지 함께 걸어 둡니다.\n' +
        'sudo systemctl enable --now certbot.timer\n' +
        '# 실제로 갱신되는지 미리 돌려 봅니다 (rate limit 을 쓰지 않습니다).\n' +
        'sudo certbot renew --dry-run',
      sudo: true,
    },
    check: { cwd: 'nginx/public_ca', file: './renew-status.sh', args: ['--check', '--json'] },
  },
  {
    id: 'public_ca.dns',
    service: 'nginx',
    title: '이름이 아직 이 서버를 가리키나',
    why:
      '이 회선은 유동 IP 인데 A 레코드는 등록기관에 고정값으로 들어 있고, 따라가는 장치가 ' +
      '없습니다. 어긋나면 앱이 **즉시, 전면** 못 붙고, certbot 갱신도 만료 30일 전부터 ' +
      '조용히 실패합니다. 앞엣것이 즉시 터지니 알아차리기는 하는데 **왜인지 모르는** ' +
      '상태가 됩니다. 이 점검이 그 답을 한 줄로 줍니다.',
    requires: ['public_ca.nginx'],
    optional: true,
    command: {
      cwd: 'nginx/public_ca',
      run:
        '# IP 가 바뀌면 등록기관에서 A 레코드를 고칩니다. TTL 이 600초라 10분 안에 퍼집니다.\n' +
        '# 크론에 걸어 두면 사람보다 먼저 압니다 (경로는 절대경로로):\n' +
        '#   */10 * * * * .../nginx/public_ca/check-dns.sh --quiet || echo "DNS 가 이 서버를 가리키지 않습니다" | logger -t dns-drift\n' +
        './check-dns.sh',
      sudo: false,
    },
    check: { cwd: 'nginx/public_ca', file: './check-dns.sh', args: ['--check', '--json'] },
  },
];

/**
 * 단계별 "자동으로 실행" 정의. 사용자가 단계마다 자동/수동을 고르고, 자동을 고르면
 * 마법사가 아래 명령을 **순서대로** 돌린다 (setup-auto.js — 경계는 그 머리말).
 *
 *   commands  { cwd, argv, sudo?, allowFail? } 의 배열. 셸을 거치지 않으므로 파이프·&&·
 *             변수 치환은 쓸 수 없고, 한 줄에 한 명령이다. 화면에 보이는 `command.run`
 *             (복사해 쓰는 수동 경로)과 같은 일을 해야 한다.
 *   reason    commands 가 없는 단계가 왜 사람 손이 필요한지. 화면에 그대로 나온다.
 *
 * 대화형 스크립트에 묻지 않도록 `--yes` 같은 플래그를 붙인 것이 있다 — 자동을 고른
 * 것이 그 확인에 대한 동의다. 사람이 값을 정해야 하는 단계(.env · 계정 비밀번호 ·
 * 발급 · 소스 빌드)는 일부러 넣지 않았다.
 */
const AUTO = {
  'site.settings': { commands: [{ cwd: '.', argv: ['./site/apply.sh', '--apply'] }] },
  // 사설 인증서를 만든다 (공인으로 갈 때도 nginx 가 뜨려면 임시로 필요하다). 갈림길 자체(tls_mode)는
  // 1단계 폼에서 사람이 정한다 — 이 명령은 그것을 바꾸지 않는다. host 는 저장된 사이트 설정에서 읽는다.
  'tls.decide': { commands: [{ cwd: 'nginx', argv: ['./generate_certs.sh', '--auto', '{{site.host}}'] }] },
  'database.schema': {
    needsDbAdmin: true,
    commands: [{ cwd: 'database', argv: ['./setup_mariadb.sh', '--yes'], sudo: true }],
  },
  // pm2 는 install_pm2.sh 로 이미 깔려 있다(3절). 여기서는 목록 저장만 한다 —
  // `pm2 start ecosystem.config.js` 는 이 manager 자신까지 다시 띄우므로 자동 경로에 두지 않는다.
  'pm2.apps': { commands: [{ cwd: 'pm2', argv: ['pm2', 'save'] }] },
  'nginx.routes': {
    changesOrigin: true,
    commands: [{ cwd: 'nginx', argv: ['./install_nginx_stack.sh', '--skip-install'], sudo: true }],
  },
  'public_ca.issue': { reason: '인증서 발급은 한도(rate limit)가 있고 DNS · 80 포트가 준비되어야 합니다. 스테이징부터 사람이 보면서 합니다.' },
  'public_ca.nginx': {
    changesOrigin: true,
    commands: [{ cwd: 'nginx', argv: ['./install_nginx_stack.sh', '--skip-install'], sudo: true }],
  },
  'public_ca.renew': { reason: '갱신 시험(certbot renew --dry-run)을 사람이 보면서 합니다.' },
  'public_ca.dns': { reason: 'DNS 는 등록기관에서 사람이 고칩니다.' },
};

for (const step of STEPS) step.auto = AUTO[step.id];

/**
 * 화면에 보일 순서를 **requires 에서 유도한다.**
 *
 * ── 왜 배열 순서를 쓰지 않나 ──────────────────────────────────────
 * 예전에는 STEPS 에 적힌 차례가 곧 화면의 차례였다. 정의 위쪽 주석은 "순서는
 * requires 에서 나온다" 고 말했지만 실제로는 사람이 손으로 맞춰 둔 것이었고,
 * 단계를 새로 끼울 때마다 **적는 자리와 의존이 어긋날 수 있었다.** 어긋나도
 * 아무 증상이 없다 — 잠금(blockedBy)은 따로 계산되므로 화면만 이상한 차례로
 * 보인다.
 *
 * ── 규칙 ─────────────────────────────────────────────────────────
 * 층(depth) = 의존이 없으면 0, 있으면 1 + 의존들의 최대 층.
 *
 *   의존이 없는 것            → 층 0   (site.settings · database.schema · pm2.apps)
 *   층 0 에만 기대는 것       → 층 1   (tls.decide · nginx.routes)
 *   층 0·1 에 기대는 것       → 층 2   …
 *
 * 같은 층 안에서는 **이 단계에 기대는 것이 많은 쪽을 먼저** 둔다. 먼저 끝낼수록
 * 다음이 더 많이 열리기 때문이다. 그래도 같으면 적힌 차례를 지킨다(안정 정렬) —
 * 같은 값끼리 화면이 흔들리지 않게.
 *
 * ── 선택 단계는 뒤로 모은다 ──────────────────────────────────────
 * 층으로만 세우면 공인 인증서 같은 선택 단계가 필수 단계 사이에 끼어든다.
 * **필수 단계는 선택 단계를 requires 로 걸지 않는다**는 규칙이 이미 있으므로
 * (정의 머리말 참고), 둘을 갈라도 의존이 깨지지 않는다 — 아래 assertOrder 가
 * 그 전제를 실제로 확인한다.
 *
 * ── 순환이 있으면 ────────────────────────────────────────────────
 * 정의의 버그다. 그래도 마법사가 통째로 죽으면 안 되므로, 의존이 적은 쪽(그래도
 * 같으면 기대는 것이 적은 쪽 — 바뀌었을 때 영향이 덜한 쪽)을 앞에 두어 끊고
 * **로그에 남긴다.** 조용히 넘어가면 순서만 이상해지고 원인을 찾을 수 없다.
 */
function orderSteps(steps) {
  const map = new Map(steps.map((s) => [s.id, s]));
  const index = new Map(steps.map((s, i) => [s.id, i]));

  // 이 단계에 기대는 것의 수.
  const dependents = new Map(steps.map((s) => [s.id, 0]));
  for (const s of steps) {
    for (const r of s.requires) {
      if (dependents.has(r)) dependents.set(r, dependents.get(r) + 1);
    }
  }

  const cycles = [];
  const depth = new Map();
  const visiting = new Set();

  const depthOf = (id) => {
    if (depth.has(id)) return depth.get(id);
    const step = map.get(id);
    if (!step) return 0;                       // 없는 id — assertOrder 가 잡는다
    if (visiting.has(id)) { cycles.push(id); return 0; }
    visiting.add(id);
    const value = step.requires.length === 0
      ? 0
      : 1 + Math.max(...step.requires.map(depthOf));
    visiting.delete(id);
    depth.set(id, value);
    return value;
  };
  for (const s of steps) depthOf(s.id);

  if (cycles.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `[setup] requires 에 순환이 있습니다: ${[...new Set(cycles)].join(', ')} — ` +
      '의존이 적은 쪽을 앞에 두어 끊었습니다. 정의를 고치세요.');
  }

  return [...steps].sort((a, b) =>
    (a.optional ? 1 : 0) - (b.optional ? 1 : 0)
    || depth.get(a.id) - depth.get(b.id)
    // 같은 층이면 **기대는 것이 많은 쪽을 먼저.** 먼저 끝낼수록 다음이 더 많이 열린다.
    || dependents.get(b.id) - dependents.get(a.id)
    // 그래도 같으면 의존이 적은 쪽. 순환을 끊을 때 이 규칙이 앞으로 나온다 —
    // 층이 같아지기 때문이다.
    || a.requires.length - b.requires.length
    || index.get(a.id) - index.get(b.id));
}

/**
 * 정의가 스스로 모순되지 않는지 본다. **기동할 때 한 번** 돌린다 — 잘못된 정의로
 * 마법사가 조용히 이상한 차례를 보여 주는 것보다, 로그에 크게 남기는 편이 낫다.
 */
function assertOrder(steps) {
  const map = new Map(steps.map((s) => [s.id, s]));
  const problems = [];
  for (const s of steps) {
    for (const r of s.requires) {
      if (!map.has(r)) problems.push(`${s.id} 가 없는 단계를 요구합니다: ${r}`);
      // 필수가 선택에 기대면 선택을 뒤로 모으는 것이 의존을 깬다.
      else if (!s.optional && map.get(r).optional) {
        problems.push(`필수 단계 ${s.id} 가 선택 단계 ${r} 에 의존합니다`);
      }
    }
  }
  // eslint-disable-next-line no-console
  if (problems.length) console.error('[setup] 단계 정의 문제:\n  ' + problems.join('\n  '));
  return problems;
}

/**
 * optional 을 값으로 굳힌다. 함수인 것은 문맥으로 푼다.
 *
 * ctx.tlsMode 는 site/settings.ini 의 tls_mode (없으면 auto). **저장한 값**을
 * 본다 — 반영(.applied-settings)이 아니라. 이것은 "이 배치가 LAN 전용인가" 라는
 * 결정이고, 결정은 적는 순간 내려진 것이다.
 */
function siteContext() {
  let tlsMode = 'auto';
  try {
    const ini = shared.parseIni(fs.readFileSync(path.join(config.repoRoot, 'site', 'settings.ini'), 'utf8'));
    if (ini.tls_mode) tlsMode = String(ini.tls_mode).trim().toLowerCase();
  } catch {
    // 사이트 값이 아직 없다 — 1단계 전이다. auto 로 본다.
  }
  return { tlsMode };
}

function resolveSteps(steps, ctx) {
  return steps.map((s) => ({
    ...s,
    optional: typeof s.optional === 'function' ? Boolean(s.optional(ctx)) : Boolean(s.optional),
  }));
}

// 정의 검사는 문맥 양쪽에서 한다 — 어느 쪽에서든 필수가 선택에 기대면 안 된다.
for (const tlsMode of ['auto', 'private']) assertOrder(resolveSteps(STEPS, { tlsMode }));

/**
 * 화면과 API 가 쓰는 차례. STEPS 는 정의의 모음이고, 이것이 순서다.
 * 굳혀 두지 않는다 — 1단계에서 tls_mode 를 바꾸면 단계의 필수/선택이
 * 바뀌고 순서도 따라와야 한다. 26개라 매번 계산해도 값이 싸다.
 */
function orderedSteps() {
  return orderSteps(resolveSteps(STEPS, siteContext()));
}

/**
 * 지금 **선택 단계뿐인** 서비스 이름들. 지금은 공인 인증서 넷(public_ca.*)이 그렇다.
 * 일반 대시보드가 이 서비스를 안 떠 있다고 "중단" 으로 빨갛게 보이지 않고 "선택" 으로 보이게 하는 데 쓴다 —
 * 쓰지 않기로 한 것이 고장처럼 보이면 안 되기 때문이다. 필수 단계가 하나라도 있는 서비스는 들어가지 않는다.
 */
function optionalServices() {
  const all = new Map();   // 서비스 → { onlyOptional, reason }
  for (const step of orderedSteps()) {
    if (!step.service) continue;
    const prev = all.get(step.service) || { onlyOptional: true, reason: '' };
    all.set(step.service, {
      onlyOptional: prev.onlyOptional && Boolean(step.optional),
      reason: prev.reason || (step.optional && step.optionalReason) || '',
    });
  }
  const out = new Map();
  for (const [name, v] of all) {
    if (v.onlyOptional) out.set(name, v.reason || '지금 설정에서는 선택 기능이라 필요하지 않습니다.');
  }
  return out;   // 이름 → 왜 필요하지 않은가
}

const byId = new Map(STEPS.map((s) => [s.id, s]));

// 마지막 점검 결과. **메모리에만 둡니다** — 진행률을 저장하면 실물과 어긋나기
// 시작합니다 (docs/guide/install.md '8. 마법사가 일하는 방식' — 상태를 저장하지 않습니다). 재기동하면 비고,
// 화면이 들어올 때 다시 점검합니다.
//
// 사람의 확인 기록만 파일에 남습니다 (setup-attest.js) — 그것은 매번 다시
// 물어볼 수 없는 것이기 때문입니다.
const lastResults = new Map();

// 같은 단계를 두 번 겹쳐 돌리지 않는다.
const inFlight = new Map();

function find(stepId) {
  return byId.get(stepId) || null;
}

/** 화면에 보여 줄 점검 명령. 실행은 check-runner.resolveSpec 이 만든 것으로만 한다. */
function checkCommandText(step) {
  if (!step.check) return null;
  return checkRunner.commandText(step.check);
}

const deriveState = checkRunner.deriveState;
const parseReport = checkRunner.parseReport;

function runScript(step) {
  return checkRunner.runScript(step.check);
}

/**
 * 한 단계를 점검한다. 결과는 늘 같은 모양이다.
 *
 *   state : complete | incomplete | problem | unknown
 *
 * `unknown` 은 **점검을 하지 못했다**는 뜻이다 (스크립트가 없거나, 매달렸거나,
 * 출력을 읽지 못했거나). 통과로도 실패로도 위장하지 않는다 — 화면은 이것을
 * 보고 다음 단계를 열지 않는다.
 */
async function check(stepId) {
  const step = find(stepId);
  if (!step) throw new Error(`unknown step: ${stepId}`);
  if (!step.check) throw new Error(`step has no check: ${stepId}`);

  if (inFlight.has(stepId)) return inFlight.get(stepId);

  const promise = (async () => {
    let run;
    try {
      run = await runScript(step);
    } catch (err) {
      log.error(`setup check ${stepId} could not start: ${err.message}`);
      return record(stepId, {
        state: 'unknown',
        checks: [],
        error: `점검을 실행하지 못했습니다: ${err.message}`,
        exitCode: null,
        durationMs: 0,
      });
    }

    const base = { exitCode: run.exitCode, durationMs: run.durationMs };

    if (run.timedOut) {
      log.warn(`setup check ${stepId} timed out`);
      return record(stepId, {
        ...base,
        state: 'unknown',
        checks: [],
        error: `점검이 ${Math.round((step.check.timeoutMs || checkRunner.DEFAULT_TIMEOUT_MS) / 1000)}초 안에 끝나지 않았습니다.`,
      });
    }

    if (run.spawnError) {
      return record(stepId, {
        ...base,
        state: 'unknown',
        checks: [],
        error: `점검 스크립트를 실행할 수 없습니다 (${run.spawnError}): ${path.join(step.check.cwd, step.check.file)}`,
      });
    }

    const report = parseReport(run.stdout);
    if (!report) {
      log.warn(`setup check ${stepId}: unreadable --json output`);
      return record(stepId, {
        ...base,
        state: 'unknown',
        checks: [],
        error: '점검 출력을 읽지 못했습니다. --json 이 JSON 한 덩어리만 내는지 확인하세요.',
        stderr: run.stderr || null,
      });
    }

    // step id 가 다르면 우리가 다른 것을 돌린 것이다. 결과를 붙이지 않는다.
    if (report.step && report.step !== stepId) {
      return record(stepId, {
        ...base,
        state: 'unknown',
        checks: report.checks,
        error: `이 스크립트는 다른 단계를 보고했습니다: "${report.step}"`,
      });
    }

    const derived = deriveState(report.checks);
    if (report.state && report.state !== derived) {
      log.warn(`setup check ${stepId}: reported "${report.state}" but checks derive "${derived}"`);
    }

    return record(stepId, {
      ...base,
      state: derived,
      checks: report.checks,
      error: null,
      stderr: run.stderr || null,
    });
  })().finally(() => inFlight.delete(stepId));

  inFlight.set(stepId, promise);
  return promise;
}

function record(stepId, result) {
  const full = { stepId, ranAt: new Date().toISOString(), ...result };
  lastResults.set(stepId, full);
  return full;
}

/**
 * 한 단계의 상태. 점검 결과와 사람의 확인을 합친다.
 *
 *   complete    기계가 다 됐다고 본 것
 *   attested    **사람이 확인한 것.** 기계로는 확인되지 않았다 — 통과로 위장하지
 *               않되, 다음 단계는 열어 준다 (아니면 마법사가 여기서 멈춘다)
 *   incomplete  아직 남은 것이 있다 (사람의 확인이 아직 없는 경우 포함)
 *   problem     어긋난 것이 있다
 *   unknown     점검을 마치지 못했다
 *   null        아직 점검하지 않았다
 *
 * 사람의 확인이 점검을 이기지 못한다는 것이 중요하다 — 점검이 problem 이면
 * 확인 기록이 있어도 problem 이다.
 */
function stepState(step, result, attestation) {
  if (step.manualOnly) return attestation ? 'attested' : null;
  if (!result) return null;
  if (result.state !== 'complete') return result.state;
  if (step.attest) return attestation ? 'attested' : 'incomplete';
  return 'complete';
}

function isPassed(state) {
  return state === 'complete' || state === 'attested';
}

// 질문이 함수면 지금 만든다 — 화면에는 문자열만 나간다. 값이 바뀌면 다음
// 새로고침에서 질문이 따라 바뀌는 것이 핵심이라 미리 굳혀 두지 않는다.
function resolveAttest(step) {
  if (!step.attest) return null;
  const out = { ...step.attest };
  if (typeof out.question === 'function') out.question = out.question();
  if (typeof out.subject === 'function') out.subject = out.subject();
  return out;
}

/**
 * **확인한 뒤에 확인 대상이 바뀌었는가.**
 *
 * 사람의 확인은 "그때 그 목록"에 대한 것입니다. 포워딩 목록이 늘거나 대역이
 * 바뀌면 예전 체크는 새 목록을 가리키지 않는데, 화면에는 그대로 '사람이 확인함'
 * 으로 남아 있었습니다 — 조용히 틀린 통과입니다. 그래서 확인 시점의 subject 를
 * 기록에 함께 적고(setup-attest.js), 지금 것과 다르면 확인이 없는 것으로 봅니다.
 *
 * 지금 subject 를 만들 수 없으면(설정을 못 읽는 등) 비교하지 않습니다 —
 * 읽기 실패를 사람의 잘못으로 돌리지 않기 위해서입니다.
 * subject 가 없던 시절의 기록은 stale 입니다. 그 시절 목록이 실제로 틀렸으므로
 * (예전 질문에는 없던 포트가 이제 필요합니다) 다시 묻는 것이 맞습니다.
 */
function attestationStale(resolved, attestation) {
  if (!attestation || !resolved || !resolved.subject) return false;
  return (attestation.subject || null) !== resolved.subject;
}

/**
 * 단계 정의 + 마지막 점검 결과 + 사람의 확인 기록.
 *
 * 잠금(blockedBy)은 **여기 한 곳에서만** 계산한다. 화면이 따로 계산하면 규칙이
 * 두 곳이 된다.
 */
function overview() {
  const attestations = attest.readAll();
  const states = new Map();

  const steps = orderedSteps().map((step) => {
    const result = lastResults.get(step.id) || null;
    const attestObj = resolveAttest(step);
    const record = attestations[step.id] || null;
    // 낡은 확인은 **지우지 않고** 확인이 없는 것으로 친다 — 누가 언제 무엇을
    // 확인했는지는 화면에 남아야 다시 물을 때 무엇이 달라졌는지 보인다.
    const stale = attestationStale(attestObj, record);
    const attestation = record ? { ...record, subject: record.subject || null, stale } : null;
    const state = stepState(step, result, stale ? null : record);
    states.set(step.id, state);

    return {
      id: step.id,
      service: step.service,
      title: step.title,
      why: step.why,
      requires: step.requires,
      optional: step.optional,
      optionalReason: step.optional ? step.optionalReason || null : null,
      manualOnly: Boolean(step.manualOnly),
      command: step.command || null,
      auto: auto.describe(step),
      guide: step.guide || null,
      attest: attestObj,
      attestation,
      checkCommand: checkCommandText(step),
      checkCwd: step.check ? step.check.cwd : null,
      // 파라미터 폼. 판정에는 들어가지 않는다 — '저장했는데 아직 반영 안 됨' 은
      // 점검 스크립트가 직접 보고 pending 으로 낸다 (규칙을 한 곳에 둔다).
      settings: settings.read(step),
      state,
      result,
    };
  });

  for (const step of steps) {
    step.blockedBy = step.requires.filter((id) => !isPassed(states.get(id)));
  }

  const passed = steps.filter((s) => isPassed(s.state));

  return {
    steps,
    total: steps.length,
    complete: passed.length,
    required: {
      total: steps.filter((s) => !s.optional).length,
      complete: passed.filter((s) => !s.optional).length,
    },
    attestFile: attest.file,
    updatedAt: new Date().toISOString(),
  };
}

module.exports = { STEPS, find, check, overview, optionalServices, deriveState, parseReport, stepState, isPassed, resolveAttest, saveSettings: settings.save };
