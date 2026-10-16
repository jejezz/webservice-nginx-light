# 서비스 규약 — /health · 점검 · 설정

서비스가 manager 와 구축 마법사, 그리고 서로에게 지켜야 하는 약속 셋을 모은
문서입니다. 셋 모두 "중앙이 서비스를 몰라도 되게" 하려는 장치입니다 — 서비스가
이 형식을 지키면 manager 를 고치지 않고도 대시보드·마법사·`check-all.sh` 에
나타납니다.

| 규약 | 누가 내는가 | 누가 읽는가 | 구현 |
|---|---|---|---|
| [/health 응답 규약](#health-응답-규약) | 떠 있는 서비스 프로세스 | manager 대시보드, 서비스 추가 마법사 | `services/manager/server/src/services/health.js` |
| [점검 규약](#점검-규약) | 점검 스크립트의 `--json` | 구축 마법사, 서비스 추가 마법사, `check-all.sh` | `lib/check-report.sh`, `lib/config-diff.sh` |
| [설정 규약](#설정-규약) | `settings-schema.json` | 구축 마법사의 폼, 서비스 대시보드, `--apply` | `lib/settings.js` |

선언 파일(`nginx-conf/` · `pm2-conf/` · `db-conf/`)의 스키마는
[declarations.md](declarations.md), 규약을 지킨 서비스를 어떤 순서로 반영하는지는
[rollout.md](rollout.md) 에 있습니다.

---

## /health 응답 규약

모든 HTTP 서비스는 `/health` 에 **같은 형태**로 응답합니다. manager 대시보드는
이 형태만 알면 되고, 서비스가 늘어도 대시보드를 고칠 필요가 없습니다. 대시보드는
nginx 를 거치지 않고 **루프백으로 백엔드에 직접** 호출합니다.

### 응답 형식

```json
{
  "service":   "websocket-relay",
  "status":    "ok",
  "version":   "1.0.0",
  "uptimeSec": 1234,
  "pid":       4321,
  "timestamp": "2026-08-18T10:23:45.797Z",
  "details":   { }
}
```

| 필드 | 필수 | 설명 |
|---|---|---|
| `service` | 예 | 서비스 이름. `nginx-conf` 의 `[service] name`, `pm2-conf` 의 `[app] name` 과 **같아야** 합니다 |
| `status` | 예 | 아래 표 |
| `timestamp` | 예 | 응답을 만든 시각 (ISO 8601) |
| `version` | | 보통 `package.json` 의 `version` |
| `uptimeSec` | | 프로세스가 뜬 뒤 흐른 초 |
| `pid` | | 프로세스 ID |
| `details` | | 서비스마다 다른 자유 형식. 대시보드가 상세 보기에서 그대로 펼칩니다 |

서비스 고유의 정보(DB 연결, 세션 수, 빌드 유무 …)는 **`details` 안에** 넣습니다.
최상위에 새 필드를 만들지 마세요 — 대시보드가 무시합니다.

서비스 추가 마법사(`services/register.js` 의 `health.contract`)는 `service` 가
디렉터리 이름과 같은지, `timestamp` 가 문자열로 있는지를 `problem` 으로 봅니다.
그래서 이 둘은 "있으면 좋은 것" 이 아니라 실제로 필수입니다.

### status 값과 HTTP 코드

| 값 | 뜻 | HTTP |
|---|---|---|
| `ok` | 정상 | 200 |
| `degraded` | 떠 있지만 온전하지 않음 (선택적 의존성 끊김, 빌드 결과 없음 등) | 200 |
| `error` | 핵심 의존성이 끊겨 요청을 처리할 수 없음 | 503 |

manager 는 하위 호환을 위해 `healthy` · `up` · `pass` · `ready` · `green` 도 정상으로
받고(`health.js` 의 `HEALTHY_VALUES`), **`status` 필드가 아예 없어도 정상**으로
봅니다. 새로 만드는 서비스는 `ok` 를 쓰세요.

### 대시보드의 판정

`health.js` 의 `checkOne()` 이 이렇게 가릅니다. 타임아웃은 `healthTimeoutMs`
(기본 3초), 응답 본문은 64KB 까지만 읽습니다.

| 판정 | 조건 |
|---|---|
| `up` (정상) | 2xx 이고 `status` 가 정상 값이거나 없음 |
| `degraded` (주의) | 2xx 이지만 `status` 가 정상 값이 아님 |
| `down` (중단) | 연결 실패 · 타임아웃 · 2xx 가 아닌 응답 |
| `unknown` | 헬스 URL 을 만들 수 없음 (`PORT` 도 `HEALTH_URL` 도 nginx 선언도 없음) |

`degraded` 에 503 을 쓰면 대시보드에는 **중단**으로 잡힙니다. "떠 있지만
이상함" 을 주의로 보이고 싶으면 200 + `"status": "degraded"` 로 응답하세요.
websocket-relay 가 이렇게 합니다 — DB 가 끊겨도 중계는 살아 있으므로 200 +
`degraded` 입니다(`src/health.ts`).

### 헬스 URL 이 정해지는 순서

`services/registry.js` 가 nginx 선언과 pm2 선언을 이름으로 합치면서 정합니다.
앞의 것이 이깁니다.

1. `pm2-conf` 의 `[env] HEALTH_URL` — 직접 지정 (websocket-relay 처럼 포트를 `.env` 에서 읽는 서비스)
2. `nginx-conf` 의 `[service]` `protocol://host:ports[0]` + `health_path`
3. `pm2-conf` 의 `[env] PORT` → `http://127.0.0.1:<PORT>/health`

TLS 검증은 nginx 선언의 `protocol = https` 이면 자동으로 건너뛰고, pm2 쪽에서
`HEALTH_URL` 을 줄 때는 `[env] HEALTH_INSECURE_TLS = true` 로 건너뜁니다.

`enabled = false` 인 선언은 양쪽 모두 이 계산에 들어가지 않습니다. 그래서
systemd 가 띄우는 kamailio · coturn 본체는 대시보드에 헬스 카드가 없고, janus
본체는 nginx 선언(`health_path = /janus-api/info`)으로만 헬스를 받습니다.

### 지켜야 할 것 (/health)

1. **인증 없이** 응답합니다. manager 는 루프백에서 인증 없이 호출합니다.
2. **IP 제한·인증 미들웨어보다 앞에** 둡니다. 뒤에 있으면 루프백 호출이 403 으로
   막히고, 대시보드에는 "떠 있는데 중단" 으로 보입니다.
3. **가볍게** 만듭니다. 대시보드가 주기적으로 부릅니다. 무거운 점검은 주기적으로
   갱신해 둔 값을 `details` 에 싣습니다 (websocket-relay 의 DB 상태가 그렇습니다).
4. 경로는 기본 `/health` 입니다. 다르면 `nginx-conf` 의 `health_path` 로 알립니다.
5. basePath 를 쓰는 서비스는 접두사 경로(`/relay/health`)도 열어 두는 편이
   좋습니다. 대시보드는 직접 호출하지만 사람은 nginx 를 거쳐 확인합니다.

### 최소 구현

manager 의 서비스 추가 마법사가 만드는 스켈레톤
(`services/manager/server/src/templates/service-skeleton/server/src/index.js.tmpl`)이
그대로 기준 구현입니다.

```js
const startedAt = Date.now();

app.get('/health', (req, res) => {          // 인증·바디파서보다 앞에
  res.status(200).json({
    service: 'my-service',
    status: 'ok',
    version: pkg.version,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    pid: process.pid,
    timestamp: new Date().toISOString(),
    details: {},
  });
});
```

### 규약에서 벗어난 곳

지금도 대시보드에는 정상으로 잡히지만(너그러운 판정 덕분), 규약 그대로는 아닌
자리입니다.

| 서비스 | 어긋난 점 |
|---|---|
| `kamailio` (본체, `kamailio-websocket.cfg`) | `{"service":"kamailio","status":"ok"}` 만 냅니다 — `timestamp` 없음. WebSocket 라우트가 꺼져 있어(`enabled = false`) 지금은 호출되지 않습니다 |
| `janus` (본체) | Janus 자체의 `/janus-api/info` 를 헬스로 씁니다. 규약의 필드가 없고 `status` 도 없어서 "없으면 정상" 규칙으로 통과합니다 |
| `manager` | 호출마다 `db.ping()` 을 합니다 — "가볍게" 원칙과 어긋납니다 |

---

## 점검 규약

점검 스크립트가 **기계에게** 결과를 말하는 형식입니다. 구축 마법사가 이것을 읽어
단계의 통과 여부를 정하고, 서비스 추가 마법사와 `./check-all.sh` 도 같은 것을
읽습니다. 셸 구현은 `lib/check-report.sh` 하나에 모여 있습니다.

### 종료 코드로는 안 됩니다

처음에는 종료 코드로 판정하려 했지만 안 됩니다. 기존 점검 스크립트들은 문제가
있어도 종료 코드 0 을 냅니다. 그 스크립트 입장에서는 옳습니다 — 종료 코드는
"점검을 정상적으로 마쳤다" 는 뜻이지 "모두 갖춰졌다" 가 아닙니다.

또 하나, 사람 화면의 `[--]` 하나가 두 가지를 뜻했습니다.

```
[--]  settings.ini 없음 — LAN 전용으로 설치됩니다          ← 안 해도 되는 것
[--]  secrets/ 없음 — 아직 install.sh --apply 를 안 돌렸습니다  ← 아직 안 한 것
```

앞은 통과여야 하고 뒤는 막아야 합니다. `--json` 에서 이 둘을 `skip` 과
`pending` 으로 가릅니다. **사람이 보는 출력은 둘 다 `[--]` 그대로입니다.**

### 출력 형식

```bash
./install.sh --check --json
```

```json
{
  "step": "janus.config",
  "state": "incomplete",
  "checks": [
    { "level": "ok",      "text": "바이너리: /opt/janus/bin/janus (1.4.1)" },
    { "level": "skip",    "text": "settings.ini 없음 — LAN 전용으로 설치됩니다" },
    { "level": "pending", "text": "secrets/ 없음 — install.sh --apply 를 돌리세요" },
    { "level": "problem", "text": "Kamailio 가 떠 있지 않습니다" }
  ]
}
```

stdout 에는 이 JSON **한 덩어리만** 나가야 합니다.

### level

| 값 | 사람 화면 | 뜻 | 판정에 |
|---|---|---|---|
| `ok` | `[ok]` | 됐다 | 영향 없음 |
| `skip` | `[--]` | **안 해도 되는 것**, 또는 **우리가 확인하지 못한 것** | 영향 없음 |
| `pending` | `[--]` | **아직 안 한 것** (해야 하는데 안 됨) | `incomplete` |
| `problem` | `[!!]` | 잘못된 것 | `problem` |

`pending` 과 `problem` 을 가르는 기준은 **순서 때문인가, 고장인가** 입니다.
아직 차례가 안 온 것은 `pending`, 차례가 지났는데 어긋난 것은 `problem` 입니다.
manager 는 이 네 값 밖의 레벨이 하나라도 있으면 출력 전체를 읽지 못한 것으로
봅니다(`check-runner.js` 의 `parseReport`).

### "확인할 수 없음" 은 skip 입니다

마법사는 **sudo 없이** 돕니다. root 만 읽을 수 있는 파일, root 소켓이 필요한 DB
같은 것은 확인하지 못하는 일이 흔합니다. 이것을 `problem` 으로 두면 그 단계가
**영원히 막힙니다** — 잘못된 것이 아니라 우리가 못 본 것뿐입니다.

| 문구가 말하는 것 | 레벨 |
|---|---|
| "…을 확인할 수 없습니다 / 읽지 못했습니다 (권한)" | `skip` |
| "…이 잘못돼 있습니다 / 없습니다 / 어긋납니다" | `problem` |

같은 점검이 터미널과 마법사에서 다르게 나올 수도 있습니다. 권한은 사용자가 아니라
**프로세스의 그룹 목록**이 정하고, 마법사를 돌리는 manager 는 pm2 데몬이 뜨던
시점의 그룹을 갖습니다. 예를 들어 `kamailio` 그룹이 있는 pm2 아래의 마법사는
`kamailio-local.cfg` 를 읽고, 그룹이 없는 터미널은 못 읽습니다. 둘 다 맞는
출력입니다. 이 점에서도 "확인 불가" 는 `problem` 이 될 수 없습니다.

`requires` 로 뒤 단계를 잠그는 점검에서 **영영 풀리지 않는 안내**("전환이
끝나면 지우세요" 같은 것)를 `pending` 으로 두면 뒤따르는 단계가 통째로 잠깁니다.
그런 줄은 `skip` 이나 `info` 로 둡니다.

### state 계산

`checks` 에서 기계적으로 나옵니다.

```
problem 이 하나라도 있으면   → "problem"
아니고 pending 이 있으면     → "incomplete"
둘 다 없으면                 → "complete"
```

**manager 는 스크립트가 적은 `state` 를 믿지 않습니다.** 같은 규칙으로
`checks` 에서 다시 계산하고(`deriveState`), 어긋나면 로그에 남긴 뒤 계산한 쪽을
씁니다. 그러니 `state` 를 손으로 적지 마세요 — `check_finish` 가 계산합니다.

### 종료 코드

**`--json` 일 때만** 판정을 따릅니다.

| `state` | 종료 코드 |
|---|---|
| `complete` | 0 |
| `incomplete` · `problem` | 1 |

사람이 보는 모드의 종료 코드는 스크립트마다 예전 그대로입니다. 판정이 필요하면
`--json` 을 쓰세요. (`node pm2/ecosystem.config.js --check` 는 예전부터 문제가
있으면 1 로 끝났고 지금도 그렇습니다.)

### step id

`step` 은 구축 마법사의 단계 id 와 **같아야** 합니다. manager 는 다른 `step` 을
보고한 출력을 그 단계에 붙이지 않고 `unknown` 으로 둡니다. 단계 정의는
`services/manager/server/src/services/setup.js` 의 `STEPS` 에 있습니다.

| step | 진입점 | 마법사가 넘기는 인자 | 비고 |
|---|---|---|---|
| `site.settings` | `site/apply.sh` | `--check --json` | |
| `tls.decide` | `nginx/tls-decide.sh` | `--check --json` | 확인 전용. 판정은 생성기(`--tls-mode`)에 묻습니다 |
| `database.schema` | `database/check-database.sh` | `--check --json` | 확인 전용 |
| `pm2.apps` | `pm2/ecosystem.config.js` | `--check-json` (node) | 아래 예외 |
| `kamailio.deps` | `services/kamailio/bootstrap.sh` | `--check --json` | |
| `kamailio.config` | `services/kamailio/install.sh` | `--check --json` | |
| `sip.accounts` | `services/kamailio/check-accounts.sh` | `--check --json` | 확인 전용 |
| `kamailio.dashboard` | `services/kamailio/setup-dashboard.sh` | `--json` | |
| `janus.deps` | `services/janus/bootstrap.sh` | `--check --json` | |
| `janus.build` | — | — | `manualOnly` — 사람의 확인으로 넘어갑니다 |
| `janus.config` | `services/janus/install.sh` | `--check --json` | |
| `janus.dashboard` | `services/janus/setup-dashboard.sh` | `--json` | |
| `coturn.config` | `services/coturn/install.sh` | `--check --json` | |
| `coturn.dashboard` | `services/coturn/setup-dashboard.sh` | `--json` | |
| `ntp.config` | `services/ntp/check-chrony.sh` | `--json` | 확인 전용. 고치는 것은 `npm run ntp:install` |
| `ntp.sidecar` | `services/ntp/check-sidecar.sh` | `--json` | 확인 전용. `/health` 가 `degraded` 인 것은 `pending` |
| `nginx.routes` | `nginx/install_nginx_stack.sh` | `--check --json` | 파이썬 생성기가 직접 냅니다 |
| `relay.service` | `services/websocket-relay/check-relay.sh` | `--check --json` | `npm run doctor` 를 감쌉니다 |
| `janus.verify.call` | `services/janus/verify-call.sh` | `--check --json` | |
| `janus.publicip` | `services/janus/check-public-ip.sh` | `--json` | |
| `push.incoming` | `services/kamailio/check-push.sh` | `--check --json` | 확인 전용 |
| `relay.directory` | `services/websocket-relay/check-directory.sh` | `--check --json` | 확인 전용 |
| `public_ca.issue` | `nginx/public_ca/setup_letsencrypt.sh` | `--check --json` | |
| `public_ca.nginx` | `nginx/public_ca/cert-status.sh` | `--check --json` | 아래 예외 |
| `public_ca.renew` | `nginx/public_ca/renew-status.sh` | `--check --json` | 확인 전용 |
| `public_ca.dns` | `nginx/public_ca/check-dns.sh` | `--check --json` | 확인 전용 |
| `janus.verify.bridge` | `services/janus/verify-bridge.sh` | — | 마법사 단계는 없고 손으로 돌립니다 |

"확인 전용" 은 적용 기능이 없는 스크립트라는 뜻입니다. 나머지는 적용도 하는
스크립트에 점검 모드가 함께 있습니다 — `--check` 이면 점검만 하고, 바꾸는 것은
`--apply` · `--build` · `--prod` 같은 명시적인 인자를 받았을 때뿐입니다.

### 스크립트에 붙이는 법

```bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../lib/check-report.sh"

check_init "janus.config"     # 마법사의 단계 id 와 같게
check_args "$@"               # --json 을 걸러낸다
set -- "${CHECK_REST[@]:-}"   # 남은 인자로 원래 파싱을 계속한다

info "Janus 설치"             # 제목 — 판정에 들어가지 않는다
ok   "바이너리: ${JANUS_BIN}"
skip "settings.ini 없음 — LAN 전용으로 설치됩니다"
pend "secrets/ 없음 — install.sh --apply 를 돌리세요"
warn "Kamailio 가 떠 있지 않습니다"

check_finish                  # --json 이면 여기서 출력하고 종료
```

`lib/check-report.sh` 가 주는 함수입니다.

| 함수 | 레벨 | 사람 화면 |
|---|---|---|
| `ok` | `ok` | `  [ok]   …` |
| `skip` | `skip` | `  [--]   …` |
| `pend` | `pending` | `  [--]   …` |
| `warn` | **`problem`** | `  [!!]   …` |
| `info` | (넣지 않음) | 그대로 찍음 |
| `judge <레벨> <문구>` | 지정한 레벨 | **찍지 않음** — 사람용 문구를 따로 갖고 있을 때 |
| `check_state` | — | 지금까지의 판정을 `complete`/`incomplete`/`problem` 으로 |

셸 쪽 `warn` 은 이름과 달리 `problem` 입니다. websocket-relay 의
`scripts/lib/ui.ts` 의 `Reporter.warn()` 은 `skip` 이고 `bad()` 가 `problem`
입니다 — 이름이 같아도 뜻이 다르니 옮겨 적을 때 조심하세요.

### 예외 — --json 이 이미 다른 뜻이던 자리

- **`pm2/ecosystem.config.js`** — `--json` 이 이미 "pm2 에 넘어가는 앱 객체를
  덤프한다" 는 뜻이라, 이 파일만 규약 플래그가 **`--check-json`** 입니다. node
  라서 `check-report.sh` 를 쓰지 못하고 같은 형식을 직접 냅니다.
- **`nginx/public_ca/cert-status.sh`** — `--json` 이 manager 대시보드가 읽는
  형식이라, 규약은 **`--check --json`** 일 때만 냅니다. 새로 만드는 스크립트가
  같은 처지라면 이쪽(`--check` 를 더해 가르기)을 따르세요. `--check-json` 은
  `--json` 을 빼앗을 수 없을 때의 마지막 수단입니다.
- **`nginx/generate_nginx_conf.py`** — 파이썬이라 같은 형식을 직접 냅니다.
  `install_nginx_stack.sh --json` 은 그쪽으로 넘기기만 합니다.
- **websocket-relay** — TypeScript 라 `Reporter.contract(step, asJson)` 가 같은
  형식을 냅니다.

### 지켜야 할 것 (점검)

- **`--json` 일 때 stdout 에 다른 것을 내지 마세요.** 오류·진단은 stderr 로.
- **제목·빈 줄에 생 `echo` 를 쓰지 말고 `info` 를 쓰세요.** `echo` 는 JSON
  모드에서도 나가 출력을 깨뜨립니다. 실제로 이것 때문에 파싱이 깨진 적이 있습니다.
- **`check_finish` 를 빠뜨리지 마세요.** 없으면 `--json` 이 조용히 무시됩니다.
- **`--json` 은 다른 인자 파싱보다 먼저** 걸러냅니다 (`check_args`).
- **판정을 바꾸는 것은 `pending` 과 `problem` 뿐입니다.** 안내를 늘리려면
  `info` 나 `skip` 을 쓰세요.
- 문구에 `|` 는 공백으로 바뀌고, 제어 문자는 이스케이프되지 않습니다. 문구는
  한 줄로 씁니다.
- 점검 모드는 **읽기 전용**이어야 합니다. 마법사와 `check-all.sh` 는 점검 모드를
  아무 때나 부릅니다.

### manager 가 점검을 읽는 법

구축 마법사(`services/setup.js`)와 서비스 추가 마법사(`services/register.js`)는
같은 실행기 `services/manager/server/src/services/check-runner.js` 를 씁니다.
점검 스크립트를 쓸 때 알아야 하는 실행 조건입니다.

| 조건 | 값 |
|---|---|
| 무엇을 도는가 | `STEPS` · `GLOBAL_CHECK_SPECS` 에 **박혀 있는 것뿐**. 요청 값으로 명령을 만들지 않습니다 |
| 어디서 | 실행 파일과 작업 디렉터리가 저장소 안이어야 합니다. 밖을 가리키면 거부합니다 |
| 어떻게 | 셸을 거치지 않는 `execFile`. `interpreter: 'node'` 면 manager 의 node 로 |
| 권한 | sudo 없음. manager 를 띄운 pm2 데몬의 사용자·그룹 |
| 환경 변수 | `PATH` · `HOME` · `USER` · `LOGNAME` · `LANG` · `LC_ALL` · `LC_MESSAGES` · `TZ` · `TERM` · `TMPDIR` 만 물려줍니다. manager 의 pm2 `[env]` 는 넘어가지 않습니다 |
| 시간 · 출력 | 기본 30초에 SIGKILL, stdout 1MB 상한 |
| 종료 코드 1 | 실패가 아니라 결과입니다. 판정은 JSON 으로만 합니다 |

결과는 `complete` · `incomplete` · `problem` 에 하나가 더 있습니다.
**`unknown`** 은 점검을 하지 못했다는 뜻입니다 — 스크립트가 없거나, 시간 안에
끝나지 않았거나, JSON 을 읽지 못했거나, 다른 `step` 을 보고한 경우입니다.
통과로도 실패로도 위장하지 않고, 화면은 이것을 보고 다음 단계를 열지 않습니다.

단계의 최종 상태는 점검 결과와 사람의 확인(`attest`)을 합친 것입니다. 사람의
확인은 점검을 이기지 못합니다 — 점검이 `problem` 이면 확인 기록이 있어도
`problem` 입니다. 점검 결과는 메모리에만 두고 저장하지 않습니다.

`./check-all.sh` 도 같은 `--json` 을 읽어 한 줄로 줄여 보여 줍니다. 판정을
새로 내리지 않고, 출력을 읽지 못한 점검은 어긋남으로 세지 않습니다
([rollout.md](rollout.md#check-allsh)).

---

## 설치본이 저장소와 같은가

점검이 "떠 있다" 고 말하는데 **떠 있는 것이 옛 설정**인 경우가 있습니다.
저장소에서 설정을 고치고 `--apply` 를 잊으면 그렇게 됩니다. 서비스는 멀쩡히
돌고 어디에도 오류로 보이지 않습니다.

| 무엇 | 어떻게 드러났나 |
|---|---|
| `/etc/kamailio/kamailio.cfg` 에 `wt_timer` 가 없었다 | 착신 푸시로 붙들어 둔 INVITE 가 5초에 사라짐. 훅이 있는지만 grep 하던 점검은 통과 |
| `/etc/nginx/conf.d/path-routing.conf` 에 `/sip/` 라우트가 남아 있었다 | 저장소에서 끈 지 오래인데 nginx 는 계속 서비스. 선언만 보던 점검은 통과 |

둘 다 **특정 줄만 grep 하는 검사**의 한계입니다. 그래서 설치본 **전체**를
저장소 원본과 맞춰 봅니다. 구현은 `lib/config-diff.sh` 입니다.

```bash
source "${SCRIPT_DIR}/../../lib/config-diff.sh"

report_config_diff "kamailio.cfg" "sudo $0 --apply" "$MAIN_CFG" "$MAIN_TEMPLATE"
```

### 판정

| 비교 결과 | 레벨 | 이유 |
|---|---|---|
| 같다 | `ok` | |
| 다르다 | `pending` | 고장이 아니라 **아직 반영하지 않은 것** |
| 설치본이 없다 | `pending` | 아직 설치하지 않았다 |
| 설치본을 읽을 수 없다 | `skip` | 권한일 뿐이다. 마법사는 sudo 없이 돈다 |
| 견줄 원본이 없다 | `problem` | 저장소가 깨졌다 |

값이 맞는지는 이 비교가 보지 않습니다. 그것은 `settings.ini` 와
`.applied-settings` 를 견주는 쪽의 일입니다
([저장은 됐지만 아직 반영 안 됨](#저장은-됐지만-아직-반영-안-됨)).
여기서 보는 것은 **구조가 낡았는가** 입니다.

### 자리표시자는 눌러서 비교합니다

설치본은 대개 템플릿을 치환해 만들므로 그대로 비교하면 늘 다릅니다. 그래서
**키를 기준으로 양쪽을 같은 모양으로 눌러** 비교합니다.

```bash
report_config_diff "kamailio-local.cfg" "sudo $0 --apply" \
    -n 's%^#!define DBURL .*%#!define DBURL «%' \
    -n 's%^alias=.*%alias=«%' \
    -x 'nat_1_1_mapping' \
    "$LOCAL_CFG" "$TEMPLATE"
```

| 옵션 | 뜻 |
|---|---|
| `-n <sed식>` | 양쪽에 똑같이 적용해 값 자리를 지웁니다 |
| `-x <정규식>` | 설치 때 지워질 수 있는 줄을 양쪽에서 뺍니다 (`/` 를 쓰지 마세요) |
| `-s <말+조사>` | 원본을 뭐라고 부를지. **조사까지** 적습니다 (`"database.ini 로 만든 것과"`) |

sed 식의 구분자로 `|` 를 쓰면 BRE 의 `\|` 와 부딪혀 식이 조용히 안 먹습니다.
`%` 같은 다른 구분자를 쓰세요.

### 비밀을 찍지 않습니다

설치본에는 비밀이 들어 있습니다(`DBURL` 의 비밀번호, `admin_secret` 따위).
`report_config_diff` 는 **저장소 쪽 줄만** 보여 주고(커밋된 파일이라
자리표시자뿐입니다), 설치본에만 있는 줄은 개수만 말합니다.

같은 이유로 **자리표시자를 주석에 적지 마세요.** 치환이 파일 전체를 훑으므로
주석의 `__DBURL__` 이 설치본에서 DB 비밀번호가 됩니다. 실제로 그랬습니다.

### 붙인 곳

| 점검 | 견주는 것 |
|---|---|
| `services/kamailio/install.sh` | `kamailio.cfg` · `kamailio-local.cfg` (· `rtpengine.conf`) |
| `services/janus/install.sh` | `.jcfg` 넷 · `janus.service` |
| `nginx/generate_nginx_conf.py` | `path-routing.conf` 를 **지금 선언대로 만든 것**과 (직접 구현) |
| `database/check-database.sh` | `99-project.cnf` 를 `database.ini` · `settings.ini` 로 만든 것과 |
| `pm2/ecosystem.config.js` | 선언 ↔ 실행 중 ↔ `dump.pm2` (아래) |

### pm2 는 셋을 견줍니다

pm2 는 파일이 아니라 프로세스라 볼 것이 셋입니다.

| 무엇 | 어디서 |
|---|---|
| 선언 | `services/*/pm2-conf/*.ini` |
| 실행 중 | `pm2 jlist` |
| 재부팅하면 살아날 것 | `~/.pm2/dump.pm2` (`pm2 save` 가 씀) |

선언만 고치고 재기동을 안 하면 둘째가, `pm2 save` 를 잊으면 셋째가 낡습니다.
**셋째는 재부팅 전까지 증상이 없습니다.** 견주는 값은 **선언이 정한 것만**
입니다 — `script` · `cwd` · `interpreter` · `watch` · 선언에 적힌 `env` 키.

어긋남마다 고치는 명령이 다릅니다. 점검이 줄마다 명령을 붙여 줍니다.

| 어긋남 | 할 일 |
|---|---|
| 선언돼 있는데 안 돎 | `cd pm2 && pm2 start ecosystem.config.js --only <이름> && pm2 save` |
| `script`·`cwd`·`interpreter`·`watch` 가 다름 | `pm2 delete <이름>` 뒤 위 명령 |
| `env` 만 다름 | `pm2 restart <이름> --update-env && pm2 save` |
| 돌고 있는데 선언에 없음 | `pm2 delete <이름> && pm2 save`, 또는 선언을 되살림 |
| 돌고 있는데 재부팅 목록에 없음 | `pm2 save` |
| 재부팅 목록에만 있음 | 지운 뒤 `pm2 save` 를 잊은 것 — `pm2 save` |
| 재부팅 목록의 설정이 옛것 | 실행 중인 것도 어긋났으면 **그것부터** 고칩니다. 아니면 `pm2 save` |

**`pm2 restart <이름>` 으로 고쳐지는 것은 `env` 뿐입니다.** 이 명령은 pm2 가
이미 들고 있는 정의를 다시 돌릴 뿐 `ecosystem.config.js` 를 다시 읽지 않습니다.
같은 이유로 실행 중인 것이 어긋난 상태에서 `pm2 save` 를 하면 그 어긋남이
재부팅 목록에 굳습니다. "돌고 있는데 선언에 없는" 앱에 `pm2 save` 를 권하지
않는 것도 같은 이유입니다.

---

## 설정 규약

**장비마다 다른 값**(공인 IP, 포트 범위, SIP 도메인 …)을 서비스가 어떻게
선언하고, 화면이 그것을 어떻게 받아 적고, 적용 스크립트가 어떻게 읽는지에 대한
규약입니다. 구현은 `lib/settings.js` 하나입니다.

값을 받는 화면이 둘(서비스 자신의 대시보드, 구축 마법사 `/manager/setup`)이라
항목 정의를 **서비스 디렉터리의 데이터 파일**로 내렸습니다. 둘이 각자 정의를
들고 있으면 언젠가 어긋나기 때문입니다.

### 세 파일

```
<디렉터리>/
├── settings-schema.json   항목 정의 — 커밋한다 (이것이 규약)
├── settings.ini           값 — 커밋하지 않는다 (장비마다 다르다)
└── .applied-settings      --apply 가 마지막으로 설치한 값 — 커밋하지 않는다
```

| 파일 | 누가 쓰는가 | 뜻 |
|---|---|---|
| `settings-schema.json` | 사람 (커밋) | **무엇을 받을 것인가** |
| `settings.ini` | 화면 · 편집기 (뼈대는 `--init`) | **사람이 정한 값** |
| `.applied-settings` | 적용 스크립트 (root) | **실제로 설치된 값** |

`services/` 아래일 필요는 없습니다. 세 파일이 한 디렉터리에 있고 스키마가
규약대로면 됩니다. 지금 이 규약을 쓰는 디렉터리는 여섯입니다 —
`site/` · `database/` · `nginx/public_ca/` · `services/kamailio/` ·
`services/janus/` · `services/coturn/`. `.gitignore` 는 `services/*/settings.ini`
와 `services/*/.applied-settings` 를 뿌리에서, 나머지는 각 디렉터리의
`.gitignore` 에서 막습니다.

파일 하나를 통째로 옮길 필요는 없습니다. `database/` 는 선언의 대부분을
커밋되는 `database.ini` 에 두고, **장비마다 다른 세 값만** `settings.ini` 로
뺐습니다. 가르는 기준은 "이 값이 다른 장비로 딸려 가도 되는가" 입니다.

### 스키마 필드

```json
{
  "service": "kamailio",
  "applyCommand": "sudo ./install.sh --apply",
  "settingsFile": "settings.ini",
  "appliedFile": ".applied-settings",
  "fields": [
    {
      "key": "sip_listen_addr",
      "label": "SIP 를 받을 주소",
      "help": "이 장비의 LAN 주소입니다. 장비마다 다르므로 기본값이 없습니다.",
      "placeholder": "192.168.0.252",
      "optional": false,
      "type": "ipv4",
      "pattern": "^\\d{1,3}(\\.\\d{1,3}){3}$",
      "patternHint": "IPv4 (예: 192.168.0.252)",
      "effect": "kamailio-local.cfg 의 listen=udp/tcp:<주소>:5060 이 됩니다."
    }
  ]
}
```

최상위:

| 키 | 기본값 | 뜻 |
|---|---|---|
| `service` | 디렉터리 이름 | 표시용 이름 |
| `applyCommand` | — | 반영 명령. 화면과 `settings.ini` 머리말에 그대로 나옵니다 |
| `settingsFile` | `settings.ini` | |
| `appliedFile` | `.applied-settings` | |
| `fields` | — (필수, 비면 오류) | 항목 목록 |

항목:

| 키 | 뜻 |
|---|---|
| `key` | `settings.ini` 의 키. 영문·숫자·`_` 만 |
| `label` · `help` · `placeholder` | 화면이 그대로 씁니다 |
| `optional` | 비워 둘 수 있는가 |
| `default` | 비어 있을 때 쓰는 값. 화면의 초깃값이 되고 `--init` 뼈대에 채워집니다 |
| `type` | 아래 표 |
| `pattern` · `patternHint` | 형식(정규식)과, 틀렸을 때 사람에게 보여 줄 말 |
| `conflicts` | `port_range` 전용. 겹치면 안 되는 범위들 `[{ "name", "lo", "hi" }]` |
| `effect` | **이 값이 어디로 흘러가는가.** 화면이 입력칸 밑에 보여 줍니다. 빼지 마세요 |

### type

`lib/settings.js` 가 `pattern` 에 더해 따로 보는 것은 둘뿐입니다.

| `type` | 형식 말고 더 보는 것 |
|---|---|
| `ipv4` | 각 자리가 255 이하인가 |
| `port_range` | 시작 < 끝, 1024~65535, `conflicts` 와 겹치지 않는가 |
| 그 밖 (`text` · `string` · `hostname` · `hex8` …) | 없음 — `pattern` 만 |

`site` 의 `hostname` · `hex8`, janus 의 `string` 은 이름만 있는 타입입니다.
형식 검사는 전부 그 항목의 `pattern` 이 합니다. **규칙은 전부 데이터입니다** —
`lib/settings.js` 에 서비스 이름이나 키 이름을 박지 않습니다.

### 검증은 두 번

```
화면(lib/settings.js) ──저장──▶ settings.ini ──읽기──▶ 적용 스크립트 (root)
        ①                                                 ②
```

① 은 오타를 **즉시** 알려 주기 위해, ② 는 화면을 우회해 파일을 손으로 고쳤을
때를 막기 위해서입니다. 둘 다 통과해야 설치됩니다. 저장은 임시 파일에 쓴 뒤
rename 하므로 root 스크립트가 쓰다 만 파일을 읽는 일은 없습니다.

**형식은 화면이, 현실은 스크립트가 봅니다.** `sip_listen_addr = 10.9.9.9` 는
IPv4 로는 멀쩡하지만 이 장비에 없는 주소면 Kamailio 가 바인딩에 실패해 죽습니다.
이런 검사는 장비를 아는 쪽, 즉 그 서비스의 스크립트(`install.sh` 의
`validate_settings`)가 합니다. 스키마에 "이 장비에 있는 주소" 같은 규칙을 넣으려
하지 마세요.

### 저장은 됐지만 아직 반영 안 됨

`settings.ini` 와 `.applied-settings` 가 다르면 "저장은 됐지만 아직 반영 안 됨"
입니다. 점검 스크립트가 그것을 `pending` 으로 보고하고, 마법사 단계는 통과하지
않습니다 — **적어 넣은 것과 반영한 것은 다르기 때문입니다.** 마법사 화면은
이 상태를 따로 계산하지 않고 점검 스크립트의 판정만 씁니다(규칙을 한 곳에).

`lib/settings.js` 의 `state()` 가 화면에 주는 규칙은 이렇습니다.

- `.applied-settings` 가 **아예 없으면** "다르다" 가 아니라 "모른다" 입니다.
  대기로 보고하지 않습니다(`everApplied = false`). 없는 것을 근거로 "아직 반영
  안 됨" 이라고 하면 늘 거짓 경보가 됩니다.
- **선택 항목을 비워 둔 것은 대기가 아닙니다.** 비운 것은 "자동으로 정하라" 는
  뜻이라, 자동으로 정해진 적용값과 늘 다릅니다. coturn 의 `public_ip` · `realm`
  이 영원히 '적용 대기' 로 떠 있던 일 때문에 생긴 규칙입니다.

점검 스크립트도 같은 규칙을 따라야 합니다. 그리고 **파일의 원본 값이 아니라
실제로 쓰이는 값**과 비교합니다 — `sip_domain` 처럼 사이트 층에서 오는 값은
서비스의 `settings.ini` 가 비어 있는 것이 정상이기 때문입니다
(`services/kamailio/install.sh` 의 `report_settings_pending`).

`.applied-settings` 는 `--apply` 가 **성공한 뒤에만** 씁니다. 되돌렸거나,
설정 파일만 쓰고 재시작하지 않았다면(`setup_mariadb.sh --no-restart`) 남기지
않습니다 — 그때 도는 것은 옛 값입니다.

### 뼈대 만들기

`settings.ini` 는 커밋하지 않으므로 새 장비에는 없습니다. 화면에서 저장하면
그때 만들어지고, 화면을 띄울 수 없는 장비를 위해 스키마에서 주석 달린 뼈대를
만드는 길이 있습니다.

```bash
node lib/settings.js --init  <디렉터리>   # 뼈대를 만든다
node lib/settings.js --print <디렉터리>   # 만들지 않고 보여만 준다
```

항목마다 `label` · `help` · `patternHint` · `effect` 가 주석으로 들어가고,
`default` 가 있는 항목만 값이 채워집니다. **이미 있는 파일은 덮지 않습니다.**

### 사이트 층

여럿이 함께 쓰는 값(`host` · `complex_id` · `sip_domain` · `tls_mode`)은
`site/` 에 있고 같은 규약을 씁니다. 서비스 단위로만 두면 그런 값이 여러 파일에
베껴 적히고 조용히 어긋납니다. 사이트 층에 올리는 기준은 **"둘 이상이 쓰는가"**
하나입니다. 자세한 것은 [infrastructure.md](infrastructure.md) 에 있습니다.

우선순위는 **서비스 값이 이기고, 비어 있을 때만 사이트 값**입니다.

| 언어 | 읽는 법 |
|---|---|
| 셸 | `source lib/site.sh` → `site_get host` |
| 파이썬 | `nginx/generate_nginx_conf.py` 의 `site_get` |
| TypeScript | `services/websocket-relay/src/libs/siteSettings.ts` (config 를 import 하지 않는 파일) |

### 스크립트에서 읽는 법

`settings.ini` 는 **절(section) 없이 `키 = 값`** 만 씁니다. node(`lib/settings.js`)
와 셸이 같은 파일을 파싱해야 하기 때문입니다.

```bash
SETTINGS_FILE="${SCRIPT_DIR}/settings.ini"
APPLIED_FILE="${SCRIPT_DIR}/.applied-settings"
source "${SCRIPT_DIR}/../../lib/site.sh"

settings_get() {
    local key="$1" fallback="${2:-}" v=""
    if [[ -r "$SETTINGS_FILE" ]]; then
        v="$(sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*\(.*\)$/\1/p" "$SETTINGS_FILE" | tail -1)"
        v="${v%%[;#]*}"
    fi
    v="${v//[[:space:]]/}"
    echo "${v:-$fallback}"
}

SIP_DOMAIN="$(settings_get sip_domain "$(site_get sip_domain 'pluto.org')")"
```

`--apply` 가 성공한 뒤에 무엇을 설치했는지 남깁니다.

```bash
{
    echo "; install.sh --apply 가 마지막으로 설치한 값. 손으로 고치지 마세요."
    echo "sip_domain = ${SIP_DOMAIN}"
} > "$APPLIED_FILE"
chmod 644 "$APPLIED_FILE"
```

주의할 것 둘.

- 셸의 `settings_get` 은 값의 **모든 공백을 지우고** 줄 뒤 `;`·`#` 주석을
  자릅니다. `lib/settings.js` 의 파서는 줄 뒤 주석을 자르지 않습니다. 값 옆에
  주석을 달지 말고 윗줄에 다세요. 공백이 든 값은 쓸 수 없습니다.
- `database/` 는 같은 일을 `database/lib_settings.sh` 로 합니다. 적용 스크립트와
  점검 스크립트가 **같은 함수**로 읽고 만듭니다.

### 누가 쓰고 누가 읽는가

| 무엇 | `settings.ini` 에 | `.applied-settings` 에 |
|---|---|---|
| 구축 마법사 (`setup-settings.js`) | 씀 — 단계의 `settings.dir` 로 정해진 파일만, 저장소 밖은 거부 | 읽음 |
| 서비스 대시보드 (janus · kamailio · coturn 의 `server/src/settings.js`) | 씀 | 읽음 |
| manager 포트 지도 (`port-map.js`) | 읽음 | — |
| 적용 스크립트 (`install.sh --apply` · `setup_mariadb.sh` · `setup_letsencrypt.sh --prod` · `site/apply.sh --apply`) | 읽음 | 씀 |
| 점검 스크립트 | 읽음 | 읽음 |

화면은 **sudo 를 부르지 않습니다.** 값을 적을 뿐 설정 파일(`.jcfg`,
`kamailio-local.cfg`)을 만지지 않고 서비스를 재기동하지도 않습니다. 반영은 사람이
터미널에서 합니다.

### 비밀은 settings.ini 에 두지 않습니다

`settings.ini` 는 커밋하지 않지만 **비밀을 두는 곳도 아닙니다.** 화면이 값을
그대로 보여 주고, 점검 출력이 값을 인용합니다. 비밀은 따로 둡니다.

| 비밀 | 자리 |
|---|---|
| DB 계정 비밀번호 | `database/secrets/<계정>.pw` (600) |
| 서비스의 API 시크릿 (janus `admin-secret`, coturn `static-auth-secret` …) | `services/<서비스>/secrets/` |
| 앱 환경 변수 | 그 서비스의 `.env` |
| 공유 세션 시크릿 | `services/.session-secret` |
| 인증서 개인키 | `nginx/cert/` |

전부 `.gitignore` 대상입니다. 점검은 비밀 파일이 있는지·권한이 맞는지만 보고
내용을 찍지 않습니다.

### 지켜야 할 것 (설정)

- **기본값을 함부로 두지 마세요.** 한 장비의 값을 다른 장비가 물려받을 수 없는
  것(LAN 주소)은 기본값 없이 두고, 없으면 `pending` 으로 보고합니다.
- **`settings.ini` 와 `.applied-settings` 를 커밋하지 마세요.** 스키마는 커밋합니다.
- **점검에 "아직 반영 안 됨" 을 넣으세요.** 없으면 값을 넣은 사람이 적용했다고
  착각합니다. `sip_push_url` 을 고쳐 두고 적용하지 않아 착신이 통째로 나가지 않은
  일이 실제로 있었습니다.
- 값을 늘리면 **스키마 · 적용 스크립트 · `.applied-settings` 기록 · 점검의 비교
  목록** 넷을 함께 고칩니다.

### 붙인 곳

| 디렉터리 | 항목 | 반영 명령 |
|---|---|---|
| `site` | `host` · `complex_id` · `sip_domain` · `tls_mode` | `./site/apply.sh --apply` |
| `database` | `bind_address` · `port` · `innodb_buffer_pool_size` | `sudo ./setup_mariadb.sh` |
| `nginx/public_ca` | `domain` · `email` | `sudo ./setup_letsencrypt.sh --prod` |
| `services/kamailio` | `sip_domain` · `sip_listen_addr` · `sip_push_url` · `media_port_range` · `media_public_ip` · `media_relay` · `reg_*` 다섯 | `sudo ./install.sh --apply` |
| `services/janus` | `public_ip` · `rtp_port_range` · `sip_rtp_port_range` · `sip_local_ip` · `lan_iface` | `sudo ./install.sh --apply` |
| `services/coturn` | `public_ip` · `realm` · `relay_port_range` · `listening_port` · `dashboard_port` | `sudo ./install.sh --apply` |

`websocket-relay` 와 `manager` 는 이 규약을 쓰지 않습니다. websocket-relay 는
자기 `.env` 와 사이트 층에서, manager 는 `config.json` 에서 값을 읽습니다.
