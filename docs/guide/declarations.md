# 선언 파일 — nginx-conf · pm2-conf · db-conf · schema

이 저장소의 설계는 **서비스가 자기를 스스로 선언하고, 스캐너가 그것을 줍는
것**입니다. 서비스 디렉터리 안에 선언 파일을 두면 nginx 라우트, pm2 앱, DB 와
전용 계정, manager 대시보드의 카드가 저절로 생깁니다. 중앙 파일에 서비스 이름을
적을 일이 없고, 서비스를 옮기거나 지우면 선언도 함께 따라갑니다.

```
services/<이름>/
├── nginx-conf/*.ini   어떤 경로로 들어오는가       ← nginx 생성기 · manager
├── pm2-conf/*.ini     어떻게 띄우는가              ← pm2/ecosystem.config.js · manager
├── db-conf/*.ini      어떤 DB 가 필요한가 (plug-in) ← database/setup_mariadb.sh
└── schema/*.sql       그 DB 의 테이블              ← database/setup_mariadb.sh
```

장비마다 다른 값(`settings-schema.json`)은 선언이 아니라 설정입니다 —
[contracts.md](contracts.md#설정-규약). 선언을 반영하는 순서는
[rollout.md](rollout.md#안전한-반영-순서) 에 있습니다.

## 공통 규칙

- **스캔은 `services/*/<폴더>/*.ini` 한 단계만** 합니다. 하위 디렉터리에 둔
  선언은 발견되지 않습니다.
- 폴더 안의 `.ini` 는 **파일 이름순으로 전부** 읽습니다. 파일 이름은 자유입니다
  (`service.ini` · `dashboard.ini` · `app.ini` 가 관례).
- **한 디렉터리에 선언 여럿**을 둘 수 있습니다. 한 폴더가 서비스 둘을 담을 때
  씁니다 (아래 [한 디렉터리에 선언 여럿](#한-디렉터리에-선언-여럿)).
- 주석은 `;` 와 `#` 둘 다 됩니다. **줄 첫머리에서만** 주석입니다 — 값 뒤에
  붙인 `; …` 는 값의 일부로 읽혀 nginx 생성기가 "포트가 숫자가 아닙니다" 로
  멈춥니다. 주석은 윗줄에 다세요.
- 값에 따옴표를 쓰지 않습니다. 참·거짓은 `true`/`false`(`1`·`yes`·`on` 도 참).
- 이름 셋 — `nginx-conf` 의 `[service] name`, `pm2-conf` 의 `[app] name`,
  `/health` 의 `service` — 은 **같아야** 합니다. 다르면 manager 가 헬스를 그
  서비스와 짝짓지 못해 "떠 있는데 중단" 으로 보입니다.
- `enabled = false` 는 **선언을 지우지 않고 끄는** 수단입니다. nginx-conf 와
  pm2-conf 양쪽에 같은 이름으로 있고, 서비스를 잠시 내릴 때 둘 다 `false` 로 둡니다.

INI 파서는 세 벌입니다 — nginx 생성기(파이썬 `configparser`), `lib/ini.js`
(manager · janus 대시보드), `pm2/ecosystem.config.js` 의 자체 파서. 위 규칙은 셋이
공통으로 받아들이는 범위입니다.

---

## nginx-conf

각 서비스가 자기에게 필요한 포트·프로토콜·라우트를 적습니다.
`nginx/generate_nginx_conf.py` 가 `services/*/nginx-conf/*.ini` 를 전부 읽어
`/etc/nginx/conf.d/path-routing.conf` 하나를 만들고, manager 대시보드
(`services/manager/server/src/nginx-conf.js`)도 **같은 파일**을 읽어 서비스
목록을 만듭니다. 라우팅의 원본은 각 서비스 폴더에 있습니다.

허용되는 섹션은 `[service]` 하나와 `[route]`/`[route:<이름>]` 뿐입니다. 다른
섹션이 있으면 생성기가 멈춥니다.

### [service]

```ini
[service]
name        = websocket-relay
host        = 127.0.0.1
ports       = 28099
protocol    = http
health_path = /health
```

| 키 | 기본값 | 설명 |
|---|---|---|
| `name` | 폴더 이름 | 서비스 이름. upstream 이름(`<name>_backend`)도 여기서 나옵니다 |
| `host` | `127.0.0.1` | 백엔드 주소. **루프백에 묶어 두면** nginx 를 우회한 직접 접근이 막힙니다 |
| `ports` | — (필수) | 공백 구분. **둘 이상이면 `least_conn` 로드밸런싱**입니다 |
| `protocol` | `http` | `http` 또는 `https`. `https` 면 백엔드 인증서를 검증하지 않습니다(`proxy_ssl_verify off`) |
| `health_path` | `/health` | 대시보드가 직접 부를 경로 ([contracts.md](contracts.md#health-응답-규약)) |
| `dashboard_path` | — | 서비스 자체 관리 화면 경로. 있으면 대시보드에 링크 버튼이 생깁니다 |
| `enabled` | `true` | `false` 면 라우트를 만들지 않고, 대시보드 목록에서도 빠집니다 |

헬스 URL 은 `protocol://host:ports[0]` + `health_path` 입니다 — 첫 포트만 씁니다.

### [route:*]

섹션 하나가 nginx `location` 블록 하나가 됩니다.

```ini
[route:main]
location  = /relay/
timeout   = 30
```

| 키 | 기본값 | 설명 |
|---|---|---|
| `location` | — (필수) | nginx location 지시자 그대로. `/manager`, `= /relay/rtc`, `~ ^/x/(a\|b)$` 모두 됩니다 |
| `proxy_path` | (없음) | 백엔드에서의 경로. **비우면 원본 URI 가 그대로** 넘어갑니다 |
| `port` | (`[service]` 의 포트) | **같은 데몬의 다른 입구.** 이 라우트만 이 포트로 보냅니다 |
| `websocket` | `false` | `true` 면 `Upgrade`/`Connection` 헤더를 넘깁니다 |
| `buffering` | `on` | `off` 면 SSE 용으로 버퍼링·캐시를 끄고 chunked 를 켭니다 |
| `timeout` | `120` | `proxy_send_timeout` · `proxy_read_timeout` (초) |
| `max_body` | (서버 값) | `client_max_body_size`. 업로드가 큰 라우트에만 |
| `order` | `100` | 생성 순서 |

모든 라우트에 `X-SSL-Client-Verify` · `X-SSL-Client-DN` 헤더가 들어갑니다.
mTLS 를 쓰지 않아도 넣습니다 — 빼 두면 클라이언트가 같은 이름의 헤더를 위조해
보낼 수 있습니다.

#### proxy_path 를 비워 두는 것이 기본

기본 서비스의 라우트는 전부 `proxy_path` 가 비어 있어, nginx 가 location 접두사를
자르지 않고 원본 URI 를 넘깁니다. 그래서 manager 는 `/manager/...`, websocket-relay
는 `/relay/...` 를 **자기가 직접** 해석합니다(basePath). `proxy_path` 를 적으면
nginx 가 접두사를 잘라내고 그 경로를 붙이므로, 서비스 코드의 basePath 도 함께
바꿔야 합니다.

```ini
; /face/foo → 백엔드의 /api/v2/foo
; 접두사 location 이면 양쪽 다 / 로 끝나야 합니다 (/api/v2 로 두면 /api/v2foo)
location   = /face/
proxy_path = /api/v2/
```

정규식 location 에서는 캡처 그룹을 쓸 수 있습니다 (`proxy_path = /api/$1/events`).

#### port — 같은 데몬의 다른 입구

Janus 는 같은 API 를 REST(8088)와 WebSocket(8188) 두 곳으로 냅니다.

```ini
[service]
name        = janus
ports       = 8088
health_path = /janus-api/info

[route:api]
location  = /janus-api
buffering = off

[route:ws]
location  = /janus-ws
port      = 8188
websocket = true
timeout   = 3600
```

**`[service] ports` 에 8188 을 더하면 안 됩니다.** 둘 이상이면 로드밸런싱이
되는데, 여기 필요한 것은 "같은 것을 여러 벌" 이 아니라 "같은 데몬의 다른 입구"
입니다. `port` 를 쓴 라우트는 별도 upstream(`janus_ws_backend`)으로 나가고,
헬스는 여전히 `ports[0]`(8088)로 갑니다. Janus 의 WS 트랜스포트는 평범한 GET 에
응답하지 않으므로 헬스가 그쪽으로 가면 영원히 "중단" 입니다.

#### order 를 신경 써야 하는 때

nginx 는 `=` 정확 일치를 먼저 보고, 접두사 중 **가장 긴 것**을 기억한 뒤, 정규식을
**적힌 순서대로** 검사합니다. 접두사끼리는 순서가 상관없지만 **정규식끼리는
순서가 결과를 바꿉니다.** 먼저 걸려야 하는 정규식에 낮은 `order` 를 줍니다.
websocket-relay 는 `= /relay/rtc` · `= /relay/iot` 에 `order = 10` 을 줍니다.

### 충돌 검사

생성기는 반영 **전에** 다음을 보면 오류를 내고 멈춥니다. 조용히 덮어써 한쪽
서비스가 죽는 것보다 설정을 만들 때 터지는 편이 낫습니다.

| 검사 | 메시지 |
|---|---|
| 서로 다른 선언이 같은 location | `duplicate location '/manager'` + 두 파일 경로 |
| 서비스 이름 중복 | `duplicate service name` |
| upstream 이름 중복 (이름이 달라도 다듬으면 같아지는 경우) | `upstream 이름이 겹칩니다` |
| 서로 다른 서비스가 같은 `host:port` | `서로 다른 서비스가 같은 백엔드를 가리킵니다` |
| `[service]` 없음 · `ports` 없음 · 숫자 아님 · 범위 밖 · 모르는 `protocol` · 모르는 섹션 | 그 파일 경로와 이유 |

```bash
./nginx/install_nginx_stack.sh --check      # sudo 불필요
```

`--check` 는 선언이 옳은지에 더해 **설치본이 지금 선언과 같은지**도 봅니다
([contracts.md](contracts.md#설치본이-저장소와-같은가)). 다르면 `pending` 입니다.

### 서버 수준 설정은 nginx-stack.conf

TLS, listen 포트처럼 서비스 하나에 속하지 않는 값은 `nginx/nginx-stack.conf`
(`[general]` · `[tls]`)가 가집니다 — `server_name`(비우면 `site/settings.ini` 의
`host`), `listen_port`, `ssl_port`, `max_body`, `default_route`,
`public_http_port`/`public_https_port`, `services_dir`, `cert_dir`,
`cert_file`/`key_file`(비우면 `tls_mode` 에서 파생), `client_ca`/`verify_client`,
`acme_webroot`. 각 키의 뜻은 [infrastructure.md](infrastructure.md) 에 있습니다.

**location 이나 upstream 을 `nginx-stack.conf` 나 템플릿에 직접 적지 마세요.**
생성기가 덮어씁니다. 경로를 바꾸려면 그 서비스의 `nginx-conf` 를 고칩니다.

---

## pm2-conf

`pm2/ecosystem.config.js` 는 앱 목록을 **적어 두는** 파일이 아니라
`services/*/pm2-conf/*.ini` 를 **훑어서 만드는** 파일입니다. pm2 는 설정이 `.js`
면 그 실행 결과를 쓰므로, 파일 안에서 파싱해 `apps` 배열을 돌려주면 그대로
등록됩니다. 생성 단계도, 생성물 커밋도 없습니다.

```bash
cd pm2 && pm2 start ecosystem.config.js                  # 선언된 것 전부
cd pm2 && pm2 start ecosystem.config.js --only manager   # 하나만
node pm2/ecosystem.config.js --check                     # 해석 결과와 교차 검사
```

허용되는 섹션은 `[app]`, `[env]`, `[env:<이름>]` 뿐입니다. 다른 섹션이나 앱 이름
중복이 있으면 파일 자체를 읽지 못합니다(pm2 에 아무것도 넘어가지 않습니다).

### [app]

```ini
[app]
name   = manager
cwd    = server
script = src/index.js
```

경로 값은 모두 **그 서비스 디렉터리 기준 상대 경로**로 적습니다. 스캐너가 실행
시점에 절대 경로로 바꿔 pm2 에 넘기므로, 저장소를 통째로 옮겨도 선언을 고칠 곳이
없습니다.

| 키 | 기본값 | 설명 |
|---|---|---|
| `name` | 폴더 이름 | pm2 목록의 이름. **고유해야** 합니다 |
| `script` | — (필수) | 진입점. `cwd` 기준. `enabled = false` 여도 필수 |
| `cwd` | 서비스 디렉터리 | 예: `server` |
| `interpreter` | — | 서비스 디렉터리 기준 경로 → 절대 경로로 바뀝니다 (pm2 는 상대 경로를 `pm2` 를 실행한 위치 기준으로 찾기 때문) |
| `node_args` · `interpreter_args` | — | 같은 뜻 |
| `exec_mode` | `fork` | `cluster` 로 바꾸려면 앱이 스스로 클러스터링하지 않는지 먼저 확인 |
| `instances` | `1` | |
| `autorestart` | `true` | |
| `watch` | `false` | `true`/`false` 또는 공백 구분 경로 목록 |
| `ignore_watch` | `node_modules logs` | `watch` 가 켜졌을 때만 |
| `max_memory_restart` | `256M` | `none`(`off`·`0`)이면 상한 없음 |
| `min_uptime` · `max_restarts` · `restart_delay` · `kill_timeout` | — | pm2 의 같은 이름 옵션 (밀리초는 숫자) |
| `out_file` · `error_file` | `pm2/logs/<name>-{out,error}.log` | 비워 두기를 권합니다 |
| `merge_logs` | `true` | |
| `log_date_format` | `YYYY-MM-DD HH:mm:ss` | |
| `enabled` | `true` | `false` 면 `apps` 배열에서 빠집니다 |
| `groups` | — | 이 앱이 있어야 일하는 **보조 그룹** (쉼표 구분). pm2 에 넘어가지 않습니다 — 아래 |

### [env] 와 [env:*]

`[env]` 는 pm2 의 `env`, `[env:production]` 은 `env_production` 이 됩니다
(`pm2 start … --env production` 으로 고름). 값은 모두 문자열입니다.

manager 가 읽는 값:

| 변수 | 쓰임 |
|---|---|
| `PORT` | 기본 헬스 URL (`http://127.0.0.1:PORT/health`), 포트 교차 검사 |
| `HEALTH_URL` | 헬스 URL 직접 지정. 이것이 가장 먼저 이깁니다 |
| `HEALTH_INSECURE_TLS` | `true` 면 `HEALTH_URL` 의 자체 서명 인증서 검증을 건너뜀 |
| `DASHBOARD_PATH` | 서비스 관리 화면 경로. nginx-conf 의 `dashboard_path` 보다 **먼저** 쓰입니다 |

관리 화면 경로는 라우팅에 가까우므로 새 서비스는 nginx-conf 의 `dashboard_path`
를 쓰세요 (kamailio · janus · coturn 이 그렇습니다). websocket-relay 만
`DASHBOARD_PATH` 를 씁니다.

### PORT 는 두 곳에 적힌다

`pm2-conf` 의 `[env] PORT` 와 `nginx-conf` 의 `[service] ports` 는 **같아야**
합니다. 어긋나면 그 경로는 502 인데 어느 쪽도 혼자서는 알 수 없습니다. 그래서
`--check` 가 맞춰 봅니다.

```
  ok      manager          28084   manager                nginx 28084
  WARN    my-service       28090   my-service             pm2 PORT=28090 vs nginx ports=28091
  skip    kamailio         5080    kamailio               enabled = false
```

nginx 선언이 있는데 pm2 에 `PORT` 도 `HEALTH_URL` 도 없으면 역시 `WARN` 입니다.
nginx 선언 없이 pm2 선언만 있는 것은 경고가 아닙니다(포트 직결 서비스).
`--check` 는 이어서 **선언대로 돌고 있는가**(실행 중 · `dump.pm2`)도 봅니다 —
그 표는 [contracts.md](contracts.md#pm2-는-셋을-견줍니다) 에 있습니다.

### groups — 데몬을 띄우는 셸에 필요한 것

`kamailio-dashboard` 는 Kamailio 의 JSON-RPC FIFO 를 읽는데 `/run/kamailio` 가
`drwxrwx--- kamailio:kamailio` 입니다.

```ini
[app]
name   = kamailio-dashboard
cwd    = server
script = src/index.js
groups = kamailio
```

보조 그룹은 프로세스가 시작될 때 부모에게서 물려받는 것이라 pm2 가 앱마다 정해
줄 수 없습니다. 데몬이 그 그룹을 갖고 떠야 합니다. 그래서 이 값은 **데몬을 어떻게
띄워야 하는지**를 적는 자리이고, `pm2/restart.sh` 가 읽습니다.

```bash
pm2/restart.sh            # 데몬과 앱이 필요한 그룹을 갖췄는지 본다
pm2/restart.sh --restart  # 갖춰서 데몬째 다시 띄우고 확인한다
```

`pm2 restart <앱>` 이나 `npm run restart` 로는 바뀌지 않습니다.

### systemd 가 띄우는 서비스 — not-managed-by-pm2.sh

kamailio · janus · coturn 본체는 pm2 가 아니라 systemd 가 띄웁니다. 그래도
`pm2-conf/app.ini` 를 둡니다 — 이 자리가 비어 있으면 나중에 보는 사람이
"선언을 빠뜨린 것" 과 "pm2 대상이 아닌 것" 을 구별할 수 없기 때문입니다.

```ini
[app]
name    = kamailio
enabled = false
script  = pm2-conf/not-managed-by-pm2.sh

; nginx-conf/service.ini 의 ports 와 짝 — 교차 검사가 본다
[env]
PORT = 5080
```

관례는 셋입니다.

1. `enabled = false` 로 둡니다. 스캐너가 `apps` 에서 빼므로 pm2 는 이 항목을
   모르고, `lib/pm2-restart.sh` 도 건너뜁니다.
2. `script` 는 `enabled` 와 무관하게 필수라, **실행되면 이유를 설명하고 1 로
   끝나는** `pm2-conf/not-managed-by-pm2.sh` 를 가리킵니다. 누가 `enabled` 를
   `true` 로 바꿔도 이상하게 동작하는 대신 즉시 무엇이 잘못됐는지 알려 줍니다.
   스크립트는 systemd 로 다루는 명령(`systemctl status` · `journalctl -u`)을
   보여 줍니다.
3. 같은 디렉터리의 **진짜 프로세스**(관찰용 대시보드)는 `dashboard.ini` 에 따로
   선언합니다.

### 한 디렉터리에 선언 여럿

kamailio · janus · coturn 은 한 폴더가 서비스 둘을 담습니다 — systemd 가 띄우는
본체와 pm2 가 띄우는 대시보드. 둘은 따로 죽는 다른 프로세스라 헬스를 합칠 수
없지만 사람 눈에는 한 덩어리라, manager 는 폴더 이름으로 묶어 보여 줍니다.

| 폴더 | 파일 | name | 누가 띄우나 | 포트 | 라우트 |
|---|---|---|---|---|---|
| `kamailio` | `nginx-conf/service.ini` · `pm2-conf/app.ini` | `kamailio` | systemd | 5080 | `/sip/` (`enabled = false`) |
| | `nginx-conf/dashboard.ini` · `pm2-conf/dashboard.ini` | `kamailio-dashboard` | pm2 (`groups = kamailio`) | 28086 | `/kamailio/` |
| `janus` | `service.ini` · `app.ini` | `janus` | systemd | 8088 (+8188) | `/janus-api` · `/janus-ws` |
| | `dashboard.ini` · `dashboard.ini` | `janus-dashboard` | pm2 | 28087 | `/janus/` |
| `coturn` | `service.ini` · `app.ini` | `coturn` | systemd | 3478 | 없음 (`enabled = false`) |
| | `dashboard.ini` · `dashboard.ini` | `coturn-dashboard` | pm2 | 28090 | `/coturn/` |
| `manager` | `service.ini` · `app.ini` | `manager` | pm2 | 28084 | `/manager` |
| `websocket-relay` | `service.ini` · `app.ini` | `websocket-relay` | pm2 (`script = dist/index.js`, `HEALTH_URL`) | 28099 | `= /relay/rtc` · `= /relay/iot` · `/relay/` |

janus 본체의 nginx 선언은 `enabled = true` 입니다 — 라우트가 있어야 앱이
`/janus-ws` 로 붙기 때문입니다. kamailio 와 coturn 본체는 프록시할 HTTP 가 없어
`false` 입니다.

---

## db-conf

`db-conf/` 는 **이 저장소 밖에 자기 저장소를 가진 plug-in 서비스**가
`database/database.ini` 를 손대지 않고 DB 를 갖는 통로입니다.
`database/setup_mariadb.sh` 가 중앙 `database.ini` 를 적용한 **다음에**
(5단계 "서비스 선언 데이터베이스 (db-conf)") `services/*/db-conf/*.ini` 를 훑어
DB 와 전용 계정을 만듭니다.

```ini
; services/apartment-mgmt-server-node/db-conf/database.ini
[database]
name = apartment_management_db
user = huygens_server
```

```ini
; services/<plug-in>/db-conf/database.ini
[database]
name       = <plug_in_db>
schema_dir = schema
```

| 키 | 기본값 | 설명 |
|---|---|---|
| `name` | — (필수) | DB 이름. 영문·숫자·밑줄만 — **하이픈 불가** (`websocket-relay` ↔ `rtc_relay` 와 같은 이유) |
| `charset` · `collation` | `database.ini` `[server]` 값 | 보통 생략 |
| `schema_dir` | — | `*.sql` 을 이름순으로 실행할 디렉터리. **서비스 디렉터리(db-conf 의 부모) 기준**. 생략하면 앱이 스스로 테이블을 만든다고 보고 DB 와 계정만 만듭니다 |
| `user` | `name` 과 같음 | 전용 계정 이름 |
| `host` | `localhost, 127.0.0.1` | 그 계정이 붙을 호스트. 쉼표로 여럿 |

### 전용 계정

db-conf 로 만드는 계정은 **이 선언의 DB 하나에만** `ALL` 권한을 갖습니다. 범위가
스캔 시점에 고정돼 있어 더 넓어질 방법이 없으므로 사람이 grant 문을 매번 보지
않아도 자동으로 만들 수 있습니다. 반대로 `database.ini` 의 `[user:...]` 는
`databases = a, b, c` 처럼 사람이 범위를 정하고, 그 범위를 넓히는 것이 이 저장소에서
가장 위험한 조작이라 손으로만 합니다.

비밀번호는 `database/secrets/<user>.pw` 에 새로 만들고(권한 600, 이미 있으면 그대로
씁니다), 다시 돌리면 `ALTER USER` 로 그 값에 맞춥니다. 앱의 `.env` 는 이 계정으로
접속하게 `DB_USER` · `DB_PASSWORD` · `DB_NAME` 을 맞춰야 합니다 — 소스에 다른
계정을 하드코딩해 두면 전용 계정을 발급한 의미가 없습니다.

### 겹침과 남는 것

- 같은 DB 이름을 `database.ini` 와 db-conf(또는 db-conf 둘)가 각자 만들려 하면
  `데이터베이스 이름이 겹칩니다` 로 **아무것도 만들기 전에** 멈춥니다.
- `schema_dir` 이 있는데 디렉터리가 없으면 멈추지 않고 "건너뛴 스키마" 로 모아
  끝에 알린 뒤 종료 코드 1 로 끝납니다. 서버 설정 반영이 스키마 하나 때문에
  무산되지 않게 하려는 것입니다.
- `setup_mariadb.sh` 는 **추가와 갱신만** 합니다. 선언을 지워도 DB 와 계정은
  남습니다 — 지우려면 손으로 `DROP` 합니다 ([rollout.md](rollout.md#되돌리기)).

### 저장소 안의 서비스는 database.ini

`manager` · `kamailio` · `websocket-relay` 처럼 이 저장소에 이력째 들어와 있는
서비스는 db-conf 를 쓰지 않고 중앙 `database/database.ini` 에 `[database:...]`
절을 손으로 적습니다 ([rollout.md](rollout.md#손으로-고쳐야-하는-자리)). 공용 계정
(`webservices`)과 서비스 계정(`kamailio`)의 권한 범위를 사람이 계속 들여다봐야 하기
때문입니다.

```ini
; schema_dir 은 database.ini 기준 상대 경로
[database:rtc_relay]
schema_dir = ../services/websocket-relay/schema

[user:kamailio]
host       = localhost, 127.0.0.1, 10.10.0.%, 192.168.0.%
databases  = kamailio
privileges = ALL
```

`[database:...]` 에는 `schema_dir` 대신(또는 함께) 파일 하나를 가리키는
`schema_file` 도 쓸 수 있습니다. db-conf 에는 `schema_file` 이 없습니다.

---

## schema 디렉터리

DB 를 쓰는 서비스는 마이그레이션을 **자기 디렉터리의 `schema/`** 에 둡니다.
`setup_mariadb.sh` 가 그 안의 `*.sql` 을 (하위 디렉터리 없이) **이름순으로** 매번
실행합니다.

```
services/websocket-relay/schema/
├── 001-initial.sql
├── 002-sip-user.sql
├── …
└── 009-janus-token.sql
```

- 번호를 붙여 순서를 고정합니다 (`001-…`, `002-…`). 확장할 때는 다음 번호의 파일을
  더하고 다시 적용합니다. 이미 적용된 파일을 고치지 마세요.
- **모든 파일은 여러 번 실행해도 안전해야 합니다** (`CREATE TABLE IF NOT EXISTS`
  등). 실행 기록을 따로 두지 않고 매번 전부 돌리기 때문입니다.
- DB 이름과 디렉터리 이름은 다를 수 있습니다 (`websocket-relay` → `rtc_relay`).

| 서비스 | schema/ | 등록 |
|---|---|---|
| `manager` | `001-initial.sql` | `database.ini` `[database:manager]` |
| `kamailio` | `001-auth.sql` | `database.ini` `[database:kamailio]` |
| `websocket-relay` | `001` ~ `009` | `database.ini` `[database:rtc_relay]` |
| `coturn` | **비어 있음 (일부러)** | 없음 |
| `janus` | 없음 | 없음 |

### coturn 의 빈 schema/

coturn 은 DB 에 상태를 두지 않습니다. 자격 증명은 `use-auth-secret`(TURN REST
API) 방식이라 계정 테이블이 없고, 할당·세션 상태는 프로세스 메모리에만 있습니다.
그래서 `database.ini` 에 `[database:coturn]` 절도 없습니다.

그래도 **디렉터리는 비워 둔 채 남겨 둡니다.** DB 를 쓰는 서비스는 모두 이 자리에
마이그레이션을 둔다는 관례를 지켜, 나중에 테이블이 필요해졌을 때 자리부터 다시
정할 일이 없게 하려는 것입니다. git 은 빈 디렉터리를 추적하지 않으므로 `.gitkeep`
하나만 둡니다.

테이블이 필요해지면:

1. `services/coturn/schema/001-<이름>.sql` 을 더합니다 (`IF NOT EXISTS` 로).
2. `database/database.ini` 에 절을 더합니다.

   ```ini
   [database:coturn]
   schema_dir = ../services/coturn/schema
   ```

3. `.gitkeep` 은 지워도 됩니다.
