# 서비스 수명주기 — 추가 · 반영 · 되돌리기

서비스를 붙이고, 고친 것을 반영하고, 잘못됐을 때 되돌리는 절차를 모은
문서입니다. 무엇을 써야 하는지(선언 파일의 스키마)는
[declarations.md](declarations.md), 서비스가 지켜야 할 형식(`/health` · 점검 ·
설정)은 [contracts.md](contracts.md) 에 있습니다. 여기서 다루는 것은 **순서**입니다.

## 기본 서비스와 plug-in 서비스

`services/` 아래의 서비스는 두 종류입니다.

| | 기본(Default) 서비스 | plug-in 서비스 |
|---|---|---|
| 무엇 | 이 저장소가 이력째 들고 다니는 것 | 자기 git 저장소를 가진 것 |
| 지금 | `manager` · `kamailio` · `janus` · `websocket-relay` · `coturn` · `ntp` · `intro` | 장비마다 다름 (예: `apartment-mgmt-server-node`) |
| 표시 | `.gitignore` 의 `!services/<이름>/` 예외 | 예외가 없음 — 이 저장소는 그 코드를 모릅니다 |
| DB | `database/database.ini` 에 손으로 등록 | 자기 `db-conf/` 로 선언 |
| 구축 마법사 | 단계가 있음 (`setup.js`). 단, `intro` 는 선택 기능이라 단계 없이 `check-all.sh` 로만 점검 | 없음 |
| `check-all.sh` | 표에 있음 | 없음 |

`.gitignore` 는 `services/*` 를 통째로 무시하고 기본 서비스만 예외로 엽니다.
manager 는 이 예외 목록을 그대로 읽어(`services/gitignore.js`) 대시보드를
**Default services** 와 **Plugged-in services** 로 나눕니다. 따로 목록을 적어 두지
않으므로 두 곳이 어긋날 일이 없습니다. 예외를 하나 더하면 그 순간부터 그 서비스는
기본 서비스로 읽힙니다.

plug-in 을 같이 추적하지 않는 이유는, 같은 파일이 두 저장소에 들어가기
때문입니다. plug-in 은 선언 둘(`nginx-conf/` · `pm2-conf/`)과 `/health` 만 맞추면
붙습니다.

---

## 서비스를 추가하는 길

### 가장 짧은 길

```
services/<이름>/
├── nginx-conf/service.ini   어떤 경로로 들어오는가
├── pm2-conf/app.ini         어떻게 띄우는가
└── (서버 코드)              /health 를 규약대로
```

```ini
[service]
name        = my-service
host        = 127.0.0.1
ports       = 28091
protocol    = http
health_path = /health

[route:main]
location = /my-service/
```

```ini
[app]
name   = my-service
cwd    = server
script = src/index.js

[env]
NODE_ENV = production
PORT     = 28091
```

이름 셋(`[service] name` · `[app] name` · `/health` 의 `service`)과 포트 둘
(`ports` · `PORT`)이 같아야 합니다. 내부 HTTP 포트는 28080번대에서 비어 있는 것을
고릅니다 ([../ports.md](../ports.md)). 반영은 [안전한 반영 순서](#안전한-반영-순서)
를 따릅니다.

### 서비스 추가 마법사

manager 대시보드의 **서비스 추가**(`/manager` → AddService)가 같은 일을 두
단계로 돕습니다. 관리자 권한이 필요합니다.

#### 이미 받아 둔 폴더 등록 (읽기 전용 진단)

`services/` 안에 직접 clone 해 둔 폴더는 새 틀 만들기가 거절하므로(이미 있는 디렉터리), **서비스 추가 →
이미 받아 둔 폴더 등록**에서 먼저 진단합니다(`services/manager/server/src/services/inspect.js`). **읽기만
합니다** — 그 폴더의 코드를 실행하지도 npm 을 부르지도 파일을 쓰지도 않습니다. 보는 것은 파일 이름과
`package.json` · ini 의 값, 그리고 선언된 포트에 대한 짧은 연결 시험 하나뿐입니다.

| 영역 | 보는 것 |
|---|---|
| 폴더 | 슬러그 · 패키지에 든 서비스가 아님 · 심볼릭 링크 아님 · 이 저장소 git 이 추적하지 않음 · 자기 `.git` |
| 선언 | `nginx-conf` · `pm2-conf` 유무, 이름 셋(폴더 · `[service] name` · `[app] name`) 일치, 라우트 수 |
| 포트 | 28080-28099 범위, nginx `ports` 와 pm2 `PORT` 일치, 다른 선언과 충돌, 지금 열려 있는지 |
| 진입 · 런타임 | `script` 파일 유무, `cwd`·`script` 가 폴더 밖을 가리키는지, node/python/go/java/rust 감지 |
| Node | `node_modules` · lockfile · `engines.node` 대 이 장비의 Node, `build` 스크립트, **설치 시 실행되는 스크립트**(preinstall · install · postinstall · prepare) |
| 환경 · DB | `.env.example` 만 있고 `.env` 가 없는지, `db-conf` 선언, 스키마 폴더만 있는 경우 |

**한 폴더에 서비스가 여럿일 수 있습니다.** 선언 파일을 전부 읽어(`nginx-conf/*.ini` · `pm2-conf/*.ini`) nginx 의
`[service] name` 과 pm2 의 `[app] name` 이 **같은 것끼리 짝**으로 봅니다(예: apartment-mgmt-server-node 는
`huygens-server` 28092 와 `web-cassini` 28093). 이름이 폴더 이름과 같을 필요는 없습니다 — 그 규칙은 서비스 추가가
만든 스켈레톤에만 해당합니다. 등록 점검(`names.match` · `health.contract`)과 복사용 명령(pm2 `--only a,b` · 포트별
`curl` · 선언된 cwd 마다 `npm ci && npm run build`)도 같은 방식으로 서비스마다 채워집니다.

**플러그인 자체 진단.** plug-in 은 자기 저장소를 가지므로 "뜰 준비가 됐는가" 를 스스로 가장 잘 압니다. repo 가
`package.json` 에 `doctor` 스크립트를 두고 [점검 규약](contracts.md#점검-규약) JSON(`{ step, state, checks: [{ level, text }] }`)을
내면, 진단 화면에 **플러그인 자체 진단** 영역이 생기고 **자체 진단 실행** 단추로 돌립니다(예: `npm run doctor -- --json`).
`.env` 의 예제 값, DB 접속, 서비스 응답처럼 바깥에서는 보이지 않는 것을 repo 가 직접 확인합니다.

이것은 **그 폴더의 코드를 실행**하는 유일한 자리라서 좁게 잡혀 있습니다.

| | |
|---|---|
| 누가 | 관리자만, 단추를 눌렀을 때만 (JSON 본문만 받음) |
| 무엇을 | `doctor` 스크립트가 `node <상대경로>.js` 꼴일 때만. npm 을 거치지 않아 `predoctor` · `postdoctor` 가 돌지 않고, 셸을 거치지 않습니다. 인자는 `--json` 하나만 붙입니다 |
| 어디서 | 파일은 pm2 가 선언한 cwd 안에 있어야 합니다. 요청이 경로를 정하지 않고 선언된 cwd 후보만 받습니다 |
| 얼마나 | 환경 변수는 `PATH` · `HOME` 등으로 추림, 타임아웃 30초, 출력 상한 1MB, 같은 폴더는 겹쳐 돌리지 않음 |

`predoctor`/`postdoctor` 가 있거나 `doctor` 가 셸 명령이면 실행하지 않고 이유를 보여 줍니다. 믿을 수 없는 repo 의
`doctor` 는 누를 때마다 그 코드가 돈다는 점을 안내문이 먼저 알립니다.

결과는 구축 마법사와 같은 레벨(`ok` · `skip` · `pending` · `problem`)로 나옵니다. 선언이 둘 다 있고 `problem` 이
없으면 **다음 — 등록 점검**으로 넘어가 아래 2단계(복사용 명령 + 점검)를 이어서 합니다. 선언이 없는 폴더는
진단까지만 되고, 두 파일을 만든 뒤 다시 진단합니다(자동 생성은 아직 없습니다).

#### 1단계 — 스켈레톤 만들기

`services/manager/server/src/services/scaffold.js` 가 `services/<이름>/` 에 바로
pm2 로 띄울 수 있는 최소 서비스를 만듭니다.

| 입력 | 규칙 |
|---|---|
| 이름 | 소문자로 시작하는 소문자·숫자·하이픈, 40자 이내. 이미 선언된 이름이면 거부 |
| 포트 | 28080 ~ 28099 의 정수. 이미 선언된 포트면 거부 (화면이 빈 것을 제안) |
| track | **`plugin`(자기 저장소)으로 고정**입니다. 패키지에 포함되는(`in-repo`) 서비스는 이 화면으로 만들지 않습니다 |

만들어지는 것은 `templates/service-skeleton/` 의 고정 템플릿뿐입니다.

```
services/<이름>/
├── README.md
├── nginx-conf/service.ini     location = /<이름>, ports = <포트>
├── pm2-conf/app.ini           cwd = server, script = src/index.js, PORT = <포트>
└── server/
    ├── package.json           express 하나
    └── src/index.js           /health 만 규약대로 응답
```

쓰기 범위는 좁습니다. 사용자 값은 `{{NAME}}` · `{{PORT}}` 자리를 채우는 데만
쓰고 경로를 만드는 데는 쓰지 않습니다. 임시 디렉터리에 전부 만든 뒤 rename
한 번으로 옮기므로, 중간에 실패하면 아무것도 남지 않습니다. 이미 있는 디렉터리는
건드리지 않습니다. plug-in 이라 `.gitignore` 는 건드리지 않습니다 — 이 디렉터리는 계속
무시되고, 서비스가 자기 저장소를 가집니다.

#### 2단계 — 등록과 무결성 확인

`services/register.js` 는 **아무것도 대신 실행하지 않습니다.** 하는 일은 둘입니다.

1. [등록 순서](#등록-순서)의 명령을 이 서비스 이름과 포트로 치환해 **복사용으로**
   보여 줍니다.
2. 이미 반영된 상태를 읽기 전용으로 확인합니다.

| 확인 | 무엇을 보나 |
|---|---|
| `names.match` | `nginx-conf/service.ini` · `pm2-conf/app.ini` 의 이름이 디렉터리 이름과 같은가 |
| `health.contract` | `127.0.0.1:<포트>/health` 가 규약대로(`service` · `timestamp`) 응답하는가. 응답이 없으면 `pending` |
| `nginx.check` | `generate_nginx_conf.py --check --json` — 저장소 전체 선언 |
| `pm2.check` | `ecosystem.config.js --check-json` — 저장소 전체 선언 |
| `gitignore.entry` | (`in-repo` 만) `.gitignore` 예외가 있는가 |

`nginx.check` 는 설치본이 선언과 같은지도 보므로, nginx 를 반영하기 전까지는
`pending` 이 남는 것이 정상입니다.

### 저절로 되는 것

| 무엇 | 누가 줍나 |
|---|---|
| nginx 라우트·upstream | `nginx/generate_nginx_conf.py` ← `services/*/nginx-conf/*.ini` |
| pm2 앱 | `pm2/ecosystem.config.js` ← `services/*/pm2-conf/*.ini` |
| 대시보드 카드·헬스·기본/추가 구분 | manager ← 같은 선언 + `.gitignore` |
| plug-in 의 DB·전용 계정 | `database/setup_mariadb.sh` ← `services/*/db-conf/*.ini` |
| 설정 입력 폼 | 그 디렉터리의 `settings-schema.json` ([contracts.md](contracts.md#설정-규약)) |
| 포트·경로·이름 충돌 검사 | 위 두 `--check` |
| 문서 화면 · 변경 이력 | manager ← git 이 추적하는 `*.md` · `git log` |

### 손으로 고쳐야 하는 자리

아직 스캔되지 않고 중앙 파일을 손으로 고쳐야 하는 자리가 넷 있습니다. 기본
서비스를 더하거나 뺄 때 이것을 빠뜨리면 조용히 어긋납니다.

**① DB 스키마 — `database/database.ini`**

이 저장소 안의 서비스가 DB 를 쓰면 `[database:<이름>]` 절을 손으로 더합니다.

```ini
[database:my_service]
schema_dir = ../services/my-service/schema
```

여기 없으면 `setup_mariadb.sh` 도 `check-database.sh` 도 그 스키마를 보지
못합니다. DB 이름에는 하이픈을 쓸 수 없습니다. 권한은 `[user:...]` 의
`databases` 에 사람이 더합니다. plug-in 은 여기가 아니라 자기 `db-conf/` 를 씁니다
([declarations.md](declarations.md#db-conf)).

**② 여럿이 쓰는 값 — `site/settings-schema.json`**

둘 이상의 서비스가 쓰는 값이면 사이트 층에 올리고, 그 서비스만 쓰는 값이면 자기
`settings-schema.json` 에 둡니다 ([contracts.md](contracts.md#사이트-층)).

**③ 구축 마법사의 단계 — `services/manager/server/src/services/setup.js`**

단계는 `STEPS` 배열에 손으로 적습니다.

```js
{
  id: 'my-service.install',
  service: 'my-service',
  title: '내 서비스 설치',
  why: '무엇을 왜 하는지. 사람이 읽고 판단할 수 있게.',
  requires: ['site.settings', 'pm2.apps'],
  command: { cwd: 'services/my-service', run: 'npm run setup' },
  check:   { cwd: 'services/my-service', file: './check.sh', args: ['--check', '--json'] },
}
```

- 점검은 [점검 규약](contracts.md#점검-규약)을 따르고 `step` 이 이 `id` 와 같아야
  합니다.
- 순서는 `requires` 로만 정합니다. 화면 순서는 `requires` 에서 계산되므로 배열
  위치에 기대지 마세요. **필수 단계는 선택(`optional`) 단계를 `requires` 로 걸 수
  없습니다** — 기동할 때 `assertOrder` 가 로그에 남깁니다.
- 영영 `complete` 가 되지 않는 줄을 `pending` 으로 두면 뒤 단계가 통째로 잠깁니다.
- 필요하면 `settings: { dir }`(폼), `attest`(사람의 확인), `manualOnly`, `optional`
  을 붙입니다.

단계만 중앙에 있는 이유는 **순서**입니다. 서비스마다 흩어 두면 "Kamailio 가 Janus
보다 먼저" 같은 관계와 순환을 한눈에 볼 수 없습니다.

**④ `./check-all.sh` 의 `CHECKS` 표**

`check-all.sh` 가 어느 점검을 어떤 순서로 부를지는 파일 안의 표에 손으로 적습니다
(`이름|읽기 전용 명령|어긋났을 때 돌릴 것|(선택) optional`). 넷째 칸 `optional` 은
쓰지 않아도 되는 기능이라, 아직 안 한 것(`incomplete`)은 어긋남으로 세지 않고
한 뒤에 어긋난 것(`problem`)만 셉니다(`ntp` 둘). 마법사의 단계와 별개라, 단계를 넣어도
여기 없으면 `check-all.sh` 는 그 서비스를 묻지 않습니다. 점검 명령은 반드시 읽기
전용이어야 합니다 — `--apply` · `--build` 를 넣지 마세요.

---

## 표준 npm 스크립트

기본 서비스 일곱은 폴더 뿌리의 `package.json` 에 같은 이름의 스크립트를 둡니다.
어느 폴더에서든 명령이 같고 `cd` 하는 자리만 다릅니다.

| 명령 | 하는 일 |
|---|---|
| `npm run setup` | 처음 한 번 — 의존성 설치 + 빌드 (+ 그 서비스에 필요한 준비) |
| `npm run check` | 점검만. 아무것도 바꾸지 않습니다 |
| `npm run build` | 소스를 고친 뒤 산출물을 다시 만듭니다 |
| `npm run restart` | 이 폴더가 `pm2-conf/*.ini` 에 선언한 pm2 앱을 다시 띄웁니다 |

| 서비스 | `setup` · `build` | `check` | 산출물 |
|---|---|---|---|
| `manager` | server·web `npm install` + web 빌드 | `check-deps.js` + `check-restart.js` | `server/public/` |
| `kamailio` · `janus` · `coturn` | `./setup-dashboard.sh --build` | `./setup-dashboard.sh` | `web/dist/` |
| `ntp` | `setup`: `scripts/setup.ts` (chrony 설치는 `npm run ntp:install`), `build`: `tsc` | `scripts/doctor.ts` | `dist/` |
| `websocket-relay` | `setup`: `scripts/setup.ts`, `build`: `tsc` + web 빌드 | `./check-relay.sh` | `dist/` · `web/dist/` |

`restart` 는 모두 `../../lib/pm2-restart.sh` 입니다. 앱 이름을 `package.json` 에
적지 않고 그 폴더의 `pm2-conf/*.ini` 에서 읽습니다 — 이름을 적는 자리는 한 곳입니다.
이 스크립트는

- `enabled = false` 인 선언(systemd 가 띄우는 본체)은 건너뜁니다.
- pm2 에 **등록되지 않은** 앱은 띄우지 않고, 처음 올리는 명령(`pm2 start … --only
  <이름> && pm2 save`)만 알려 줍니다.
- 선언(`script` · `cwd` · `env`)을 다시 읽지 않고, 데몬도 다시 띄우지 않습니다.
- `--dry-run` 으로 무엇을 할지만 볼 수 있습니다.

서비스 추가 마법사가 만든 스켈레톤에는 뿌리 `package.json` 이 없습니다. 이
스크립트들을 쓰려면 기본 서비스의 것을 본떠 더합니다.

## 고친 뒤 반영

무엇을 고쳤느냐에 따라 반영 명령이 다릅니다.

| 고친 것 | 반영 |
|---|---|
| 서비스 코드 | `cd services/<이름> && npm run build && npm run restart` |
| `pm2-conf` (`script` · `cwd` · `interpreter` · `watch`) | `pm2 delete <이름>` 뒤 `cd pm2 && pm2 start ecosystem.config.js --only <이름> && pm2 save` |
| `pm2-conf` (`env` 만) | `pm2 restart <이름> --update-env && pm2 save` |
| `pm2-conf` 의 `groups` | `pm2/restart.sh --restart` (데몬째) |
| `nginx-conf` · `nginx-stack.conf` | `sudo ./nginx/install_nginx_stack.sh --skip-install` |
| `settings.ini` · 템플릿 (`.jcfg` · `kamailio-local.cfg` · `turnserver.conf`) | 그 서비스의 `sudo ./install.sh --apply` |
| `site/settings.ini` | `./site/apply.sh --apply` 뒤, 그 값을 쓰는 서비스들의 `--apply` |
| `database.ini` · `database/settings.ini` · `schema/*.sql` · `db-conf` | `sudo ./database/setup_mariadb.sh` |

`npm run restart` 로 반영되는 것은 **코드뿐**입니다. 선언을 바꿨다면
`node pm2/ecosystem.config.js --check` 가 어긋난 앱마다 맞는 명령을 알려 줍니다.
`git pull` 뒤처럼 무엇이 바뀌었는지 모를 때는 [check-all.sh](#check-allsh) 하나로
봅니다.

---

## 안전한 반영 순서

파일을 써서는 아무것도 바뀌지 않습니다. 아래는 **기존 서비스를 고장내지 않는**
순서입니다. 세 시스템(nginx · pm2 · database) 모두 "추가" 가 원칙이지만 반영
방식이 달라서, 순서를 잘못 잡으면 새 서비스가 아니라 **엉뚱한 서비스가 먼저
죽습니다.**

### 세 가지 원칙

**nginx — 훑어서 하나로 합친다, 그래서 반영은 전부 다시 쓴다.**
`generate_nginx_conf.py` 는 전체 서비스의 선언을 한 번에 훑어 `path-routing.conf`
하나를 만듭니다. 서비스 하나를 추가해도 반영은 **모든 라우트를 다시 쓰고 reload**
합니다. 세 시스템 중 유일하게 "내 것만 바뀌는" 게 아닌 단계입니다. 대신 `--check`
가 충돌을 반영 전에 막고, `nginx -t` 가 실패하면 reload 하지 않습니다.

**pm2 — 훑어서 앱 목록을 만든다, 그래도 반영은 앱 하나만 건드릴 수 있다.**
`pm2 start ecosystem.config.js --only <이름>` 은 그 앱만 시작하고 떠 있는 다른 앱은
건드리지 않습니다. 새 서비스를 올릴 때는 반드시 `--only` 를 씁니다.

**database — 추가·갱신만 하고, 지우지 않는다.**
`setup_mariadb.sh` 는 선언에 없는 DB 나 사용자를 지우지 않습니다. 그래서 다시
돌리는 것 자체가 안전합니다 — 최악의 경우도 "아무 일도 안 일어남" 입니다.
db-conf 로 발급되는 계정은 그 DB 하나에만 권한이 있어 다른 서비스에 닿지 않습니다.

### 등록 순서

뒤로 갈수록 되돌리기 어렵거나 다른 서비스에 영향을 줄 수 있는 단계입니다. 서비스
추가 마법사 2단계가 보여 주는 명령이 이 표의 2~6단계입니다 (plug-in 이면 앞에
`git init` 이 붙습니다).

```bash
# 0. 선언만 쓴다 — 이 시점까지는 시스템에 아무 변화도 없다
#    services/<이름>/nginx-conf/service.ini
#    services/<이름>/pm2-conf/app.ini
#    services/<이름>/db-conf/database.ini   (plug-in 이 DB 를 쓰면)
#    database/database.ini 의 [database:...] (기본 서비스가 DB 를 쓰면)

# 1. 셋 다 검사만 한다
./nginx/install_nginx_stack.sh --check        # 포트·location·이름 충돌 (sudo 불필요)
node pm2/ecosystem.config.js --check          # PORT 교차 검사, 이름 중복 (sudo 불필요)
sudo ./database/setup_mariadb.sh --dry-run    # 무엇이 만들어질지만

# 2. 데이터베이스 — 추가·갱신만 하므로 가장 먼저 해도 안전하다
sudo ./database/setup_mariadb.sh
cat database/secrets/<계정>.pw                # db-conf 로 새로 발급됐다면 → 앱의 .env

# 3. pm2 — 새 서비스만 올린다
cd pm2 && pm2 start ecosystem.config.js --only <이름> && pm2 save && cd ..

# 4. 백엔드가 살아 있는지 먼저 확인한다 — nginx 에 알리기 전에
curl -s localhost:<포트>/health

# 5. nginx — 전체 라우팅을 다시 쓰는 유일한 단계이므로 맨 마지막
sudo ./nginx/install_nginx_stack.sh --skip-install

# 6. 반영 후 재확인 — "명령이 성공했다" 가 아니라 "설치본이 선언과 같다" 까지
./nginx/install_nginx_stack.sh --check
node pm2/ecosystem.config.js --check
curl -s localhost/<라우트>/health
```

| 단계 | 서비스 추가 마법사의 표시 |
|---|---|
| 2 | 1. 데이터베이스 |
| 3 | 2. pm2 |
| 4 | 3. 떠 있는지 먼저 확인 |
| 5 | 4. nginx |
| 6 | 5. 다시 확인 |

### 왜 이 순서인가

- **DB 가 먼저** — 안전한 조작이고, 앱이 DB 없이 뜨면 `/health` 가 `degraded` 로
  남아 4단계에서 바로 드러납니다. pm2 를 먼저 올리면 앱이 DB 접속 실패로 재시작을
  반복합니다.
- **pm2 에 `--only`** — 전체를 다시 올리면 선언과 실행 중인 값이 어긋나 있던
  **다른** 서비스까지 그 자리에서 바뀝니다.
- **nginx 는 마지막, 헬스 확인 뒤** — `--check` 는 선언끼리의 충돌만 걸러 줍니다.
  선언이 가리키는 백엔드가 실제로 살아 있는지는 nginx 가 모릅니다. 그리고 nginx
  반영의 실수(예: 잘못된 `default_route`)는 **모든** 서비스의 입구에 닿습니다.
- **반영 뒤에도 `--check`** — 선언만 보는 검사는 "선언은 고쳤는데 반영을 안 한"
  상태를 못 잡습니다. 두 `--check` 는 설치본과 실행 중인 것까지 견줍니다
  ([contracts.md](contracts.md#설치본이-저장소와-같은가)).

### 셋 사이의 어긋남

각 시스템의 문제 해결은 [infrastructure.md](infrastructure.md) 에 있습니다. 여기는
셋 사이에서만 나는 증상입니다.

| 증상 | 원인과 처치 |
|---|---|
| 대시보드에 "떠 있는데 중단" | 이름 셋이 다릅니다. `curl -s localhost:<포트>/health` 의 `service` 를 확인 |
| 새 라우트가 502 | `PORT` 와 `ports` 가 어긋났거나 프로세스가 죽었습니다. `node pm2/ecosystem.config.js --check`, `pm2 list` |
| 새 라우트가 404 | location 과 백엔드의 경로가 맞지 않습니다. `proxy_path` 를 비웠다면 백엔드가 `/<이름>/...` 를 직접 받아야 합니다 |
| `--check` 가 `duplicate location` 으로 멈춤 | 기존 서비스와 location 이 겹칩니다. 아직 아무것도 반영되지 않았으므로 새 선언만 고치면 됩니다 |
| `--check` 는 통과, 라우트는 안 열림 | 반영(5단계)을 안 했습니다. `--check` 가 "설치본이 지금 선언과 다릅니다" 로 알려 줍니다 |
| `데이터베이스 이름이 겹칩니다` | `database.ini` 와 db-conf 가 같은 DB 를 각자 만들려 합니다. 주인을 정해 한쪽을 지웁니다. 아직 아무 DB 도 만들지 않았습니다 |
| `schema_dir 없음` 이 계속 보임 | 스스로 테이블을 만드는 앱이면 정상입니다(`schema_dir` 을 지우세요). 아니면 경로(서비스 디렉터리 기준)를 확인 |
| 재부팅하면 앱이 사라짐 | `pm2 save` 를 잊었습니다. `--check` 가 "재부팅 목록에 없습니다" 로 미리 알려 줍니다 |

---

## check-all.sh

```bash
./check-all.sh          # 전부
./check-all.sh -q       # 어긋난 것만
```

설치본이 저장소 선언과 어긋난 곳을 한 번에 봅니다. 서비스를 올린 뒤, 그리고
`git pull` 뒤에 돌립니다. **아무것도 바꾸지 않습니다.**

- 판정을 새로 내리지 않습니다. 각 점검의 `--json` 을 읽어 한 줄로 줄이고, 어긋난
  줄과 **그 서비스의 반영 명령**을 붙입니다.
- 순서는 [등록 순서](#등록-순서)를 따릅니다 — 사이트 값 → DB → kamailio · janus ·
  coturn → 대시보드 셋 → websocket-relay → manager → **nginx 는 맨 마지막**.
- manager 는 `--json` 을 내지 않아 `check-deps.js`(종료 코드)와 `check-restart.js`
  (출력 유무)를 따로 읽습니다.
- 점검 하나에 120초 제한이 있고, 출력을 읽지 못한 점검은 어긋남으로 세지 않습니다.
- 종료 코드: 전부 같으면 0, 하나라도 어긋나면 1.
- 일부러 뺀 것: 시험 통화를 거는 `verify-*.sh`, 인증서 발급 단계, `bootstrap.sh`.
  이것들은 "어긋났는가" 가 아니라 "지금 할 것인가" 를 묻는 단계입니다.

표는 손으로 관리합니다 ([손으로 고쳐야 하는 자리](#손으로-고쳐야-하는-자리) ④).

## 서비스를 지울 때

선언이 서비스 디렉터리 안에 있으므로 **디렉터리를 지우면 대부분 따라갑니다.**
실행 중인 것과 손으로 적은 것은 남습니다.

```bash
pm2 delete <이름> && pm2 save                         # 프로세스와 재부팅 목록
rm -rf services/<이름>                                 # 선언과 코드
sudo ./nginx/install_nginx_stack.sh --skip-install     # 라우트 제거
```

손으로 정리할 것:

- `database/database.ini` 의 `[database:...]` 절과 `[user:...]` 의 `databases`
- `setup.js` 의 단계, 그리고 **다른 단계의 `requires` 에 있는 그 id**
- `check-all.sh` 의 `CHECKS` 행
- `.gitignore` 의 `!services/<이름>/` 예외 (기본 서비스였다면)
- `site/settings-schema.json` 에 그 서비스만 쓰던 값

DB 와 계정은 **선언을 지워도 서버에 남습니다** — [되돌리기](#되돌리기)의 DB 절.
지운 뒤 두 `--check` 를 다시 돌리세요.

---

## 되돌리기

값을 잘못 넣었거나 반영을 되돌리고 싶을 때 어디까지 돌아갈 수 있는지입니다.

### 마법사는 아무것도 바꾸지 않습니다

구축 마법사는 점검 스크립트를 **읽기 모드로** 돌려 결과를 보여 줄 뿐입니다.
`--apply` 를 실행하지 않고 sudo 도 부르지 않습니다. 구축 마법사가 쓰는 파일은
둘뿐입니다.

| 파일 | 무엇 |
|---|---|
| 각 디렉터리의 `settings.ini` | 폼에 넣은 값 |
| `services/manager/setup-attest.json` | 사람만 확인할 수 있는 것의 확인 기록 |

진행률은 저장하지 않고 열 때마다 다시 점검합니다. 그래서 **운영 중인 장비에서
마법사를 여는 것은 안전합니다.**

서비스 추가 마법사는 한 가지를 더 씁니다 — 1단계에서 `services/<이름>/` 새
디렉터리 하나. 되돌리려면 대시보드의 서비스 줄에서 **휴지통** 단추로 지웁니다 — pm2 에서 멈추고
폴더를 `services/.removed/<이름>-<시각>/` 로 옮깁니다(되돌릴 수 있습니다). **plug-in 만** 지울 수
있습니다: 패키지에 포함된 서비스(.gitignore 에 예외가 열린 폴더 — manager·kamailio·janus·coturn·
websocket-relay 등)는 다른 것과 얽혀 있어 거절하고, git 이 추적하는 폴더도 거절합니다.
nginx 라우트는 sudo 가 필요해 못 지우므로 지운 뒤 nginx 를 다시 반영하세요. 2단계는 아무것도 쓰지 않습니다.

실제로 장비를 바꾸는 것은 전부 **사람이 터미널에서 치는 명령**입니다.

### 세 층

| 층 | 무엇이 | 잘못 넣고 적용하면 | 고쳐서 다시 하면 |
|---|---|---|---|
| ① 값 | `settings.ini` | 아무 일도 안 일어남 | 고치면 끝 |
| ② 설정 파일 | `kamailio-local.cfg` · `.jcfg` · `turnserver.conf` · nginx | 파일이 통째로 다시 쓰임 | **수렴합니다** |
| ③ 만들어진 것 | DB · 계정 · pm2 목록 · systemd · 인증서 | 남습니다 | **수렴하지 않습니다** |

**① 값** — `settings.ini` 에 무엇을 넣어도 그것만으로는 아무 일도 일어나지
않습니다. 반대로 값을 고쳐 두고 `--apply` 를 잊으면 조용히 어긋난 채 돕니다.
점검이 '아직 반영되지 않았습니다' 로 알려 주니, 마법사의 `[--]` 부터 보세요.

**② 설정 파일** — `install.sh --apply` 는 템플릿에서 파일을 통째로 다시 씁니다.
이전 것은 `.bak.<시각>` 으로 백업합니다. kamailio · coturn 은 치환되지 않은
자리(`__FOO__`)가 남으면 설치를 취소하고 멈추며(janus 는 점검에서 경고만 합니다),
반쯤 만들어진 설정으로 재시작하지 않습니다. 잘못된 값으로 한 번 적용했어도 값을
고쳐 다시 `--apply` 하면 돌아옵니다.

```bash
sudo ./services/kamailio/install.sh            # 점검만
sudo ./services/kamailio/install.sh --apply    # 다시 씀
sudo ./services/kamailio/install.sh --remove   # 걷어내고 기본 상태로
```

janus · coturn 의 `install.sh` 도 같은 세 모드입니다. `--apply` 가 덮는 것 중에
**손으로 고쳐 둔 줄**이 있을 수 있습니다. 점검은 개수만 알려 주므로(비밀이 섞일
수 있어 내용은 찍지 않음) 덮기 전에 직접 봅니다.

```bash
sudo diff /etc/kamailio/kamailio.cfg services/kamailio/kamailio.cfg
```

nginx 는 **백업을 남기지 않습니다.** `install_nginx_stack.sh --skip-install` 은
`path-routing.conf` 를 선언에서 다시 만들어 덮어쓰므로, 되돌리는 법은 선언을
되돌리고 다시 반영하는 것입니다.

```bash
git checkout <이전 커밋> -- services/<이름>/nginx-conf/
./nginx/install_nginx_stack.sh --check
sudo ./nginx/install_nginx_stack.sh --skip-install
```

`nginx -t` 가 실패하면 reload 는 하지 않지만 **새 파일은 이미 설치돼 있습니다.**
도는 nginx 는 옛 설정을 메모리에 들고 있으니, 다음 reload 나 재시작 전에 위처럼
선언을 고쳐 다시 반영하세요.

**③ 만들어진 것** — 전부 지우고 처음부터 다시 하는 한 방은 없습니다. 각 스크립트가
자기 몫만 되돌립니다.

| 무엇 | 되돌리는 법 |
|---|---|
| DB · 계정 | `setup_mariadb.sh` 는 지우지 않습니다. 잘못 만든 것은 손으로: `sudo mariadb -e "DROP DATABASE <db>; DROP USER '<계정>'@'localhost', '<계정>'@'127.0.0.1';"`. 먼저 `--dry-run` 으로 무엇이 만들어질지 보세요 |
| MariaDB 서버 설정 | 새 설정으로 재시작이 실패하면 `setup_mariadb.sh` 가 이전 `99-project.cnf` 로 스스로 되돌립니다 |
| pm2 목록 | 선언과 재부팅 목록은 별개입니다. 선언에서 빼도 `save` 된 목록은 되살아납니다 — `pm2 delete <이름> && pm2 save` |
| systemd (kamailio · janus · coturn) | 각자의 `install.sh --remove` |
| 인증서 | `certbot` 의 `renewal/<이름>.conf` 는 만료돼도 남아 `tls_mode = auto` 가 계속 `public` 으로 판정합니다. 강등은 `tls_mode = private` 로 못박고, 되올라갈 때 그것을 되돌립니다 ([infrastructure.md](infrastructure.md)) |
| 마법사의 확인 기록 | `DELETE /manager/api/setup/attest/:stepId` — 터미널에서 되돌려 놓고 이 기록을 두면 화면은 계속 "완료" 입니다 |

### 운영 중인 장비에서는 시험이 되지 않습니다

이미 설치된 장비에서 마법사를 끝까지 돌려 전부 초록이 나와도, 새 소스가 옳아서가
아니라 예전에 해 놨기 때문일 수 있습니다. 재현성은 빈 장비나 VM 에서만 봅니다
([install.md](install.md)). 운영 중인 장비에서 얻는 것은 **어긋남의 발견** —
값과 설치본이 갈라진 자리 — 이고, 그것대로 정기적으로 볼 만합니다.

---

## 변경 이력

별도의 CHANGELOG 파일은 없습니다. **git 이력이 변경 이력입니다.** manager 의 문서
화면(`/manager/docs`)이 `GET /manager/api/changelog` 로 `git log` 를 보여 줍니다
(`services/manager/server/src/services/changelog.js`).

| 범위(`scope`) | 보여 주는 것 |
|---|---|
| (없음) | 저장소 전체 |
| `docs` | `docs/` 아래 |
| `<서비스>` | `services/<서비스>/` 아래 — 실제 있는 디렉터리만 |

최대 200건까지, 해시 · 날짜 · 작성자 · 제목을 보여 줍니다. plug-in 서비스는 자기
저장소의 이력이 따로 있어 이 화면에 나오지 않습니다.

그래서 커밋 제목이 곧 변경 이력의 문장입니다. 제목은 `<범위>: <무엇을 했나>`
(예: `websocket-relay: 대시보드에서 방의 클라이언트를 강제로 내보낸다`)로 쓰고,
반영에 사람의 손이 필요한 변경(`--apply` · nginx 반영 · `pm2 delete` 가 필요한 선언
변경)이면 본문에 그 명령을 적어 둡니다. `git pull` 한 사람은 `./check-all.sh` 로
남은 것을 확인합니다.
