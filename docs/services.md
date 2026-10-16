# 서비스 — manager 가 하는 일과 서비스가 붙는 방식

이 문서는 기본(Default) 서비스 하나 — manager — 가 **무엇을 하고, 어떻게 떠 있고,
다른 서비스와 무엇을 주고받는지**를 한 자리에 모은 것입니다. 설치 순서와 규약의
세부는 여기 적지 않고 [구현 가이드](guide/README.md)로 넘깁니다. 포트 숫자는
[ports.md](ports.md) 가 유일한 출처입니다.

## 한눈에 보기

| 서비스 | 한 줄 역할 | 본체를 띄우는 주체 | pm2 가 띄우는 것 | 밖에서 닿는 경로 |
|---|---|---|---|---|
| manager | 관리 대시보드 · 구축 마법사 · 로그인(SSO) | pm2 | `manager` (28084) | `/manager` (루트 `/` 는 여기로 302) |

nginx · pm2 · MariaDB 는 서비스가 아니라 **기반**입니다. TLS 는 nginx 가 443 에서
모두 끊고, 서비스들은 전부 `127.0.0.1` 에서 평문 HTTP 로 듣습니다
([guide/infrastructure.md](guide/infrastructure.md)).

## 전체 구조

```
브라우저 ──443──▶ nginx (TLS 종단)
                    │  /          302 → /manager
                    │  /manager   ──▶ 127.0.0.1:28084  manager (pm2)
                    ▼                                     │
              services/*/nginx-conf/*.ini                 ▼
              가 라우트를 선언                       MariaDB (127.0.0.1:3306)
                                                   manager.administrator · admin_audit_log
```

서비스는 디렉터리 하나이고, 자기 폴더에 **선언**을 둡니다.

| 선언 | 만들어지는 것 |
|---|---|
| `nginx-conf/*.ini` | nginx 라우트 (`nginx/generate_nginx_conf.py` 가 합친다) |
| `pm2-conf/*.ini` | pm2 앱 목록 (`pm2/ecosystem.config.js` 가 훑는다) |
| `db-conf/` · `schema/` | DB 와 스키마 (`database/database.ini` 가 가리킨다) |

형식은 [guide/declarations.md](guide/declarations.md) 에 있습니다.

## manager

### 하는 일

- **관리 대시보드** (`/manager`) — `services/*/nginx-conf/*.ini` 의 라우트와
  `pm2/ecosystem.config.js` 가 훑어 낸 pm2 앱을 합쳐 서비스 목록을 만들고, 각
  서비스의 `/health` 를 직접 불러 pm2·nginx 상태와 함께 보여 줍니다. 목록은
  기본 서비스(`.gitignore` 의 `!services/<이름>/` 예외)와 plug-in 으로 나뉩니다.
- **로그인과 SSO** — 계정은 MariaDB `manager.administrator` 에 있고, 로그인은
  manager 한 곳에서만 합니다. 발급한 `manager_session` 쿠키를 다른 서비스들이
  공유 시크릿(`services/.session-secret`)으로 검증합니다. 서비스들은 계정을 두지
  않습니다.
- **비밀번호 재확인** — `POST /manager/api/verify-password`. 다른 서비스가 되돌리기
  어려운 일 앞에서 **서버끼리** 묻는 자리입니다.
- **구축 마법사** (`/manager/setup`) — 각 서비스의 점검 스크립트를 `--check --json`
  으로 돌려 단계별 판정을 보여 주고, 장비별 값을 그 서비스의 `settings.ini` 에
  씁니다. sudo 는 부르지 않습니다 — 바꾸는 명령은 화면이 보여 주고 사람이
  터미널에서 돌립니다 ([guide/install.md](guide/install.md)).
- **서비스 추가 마법사 · 포트 지도 · 문서 뷰어**.

### 어떻게 떠 있나

pm2 앱 하나(`manager`, `server/src/index.js`, 28084)입니다. 화면(`web/`)은 빌드
결과가 `server/public/` 에 떨어지고 express 가 그대로 내보냅니다. 설정은
`config.json`(커밋 제외)과 `MANAGER_*` 환경 변수입니다. 관리자 콘솔
(`superAdmin`, `manager_admin` 쿠키)은 DB 없이 `config.json` 만으로 인증되며,
빈 장비에서 DB 를 세우기 전에도 마법사에 들어갈 수 있게 하는 입구입니다.

### 데이터

MariaDB 의 `manager` 스키마(`services/manager/schema/001-initial.sql`)에 테이블이 셋입니다.

| 테이블 | 담는 것 |
|---|---|
| `administrator` | 관리자 계정 (이메일, scrypt 해시, 승인 여부, 로그인 횟수). 등록되지 않은 이메일로 로그인하면 `approved=0` 인 승인 요청 행이 생깁니다 |
| `admin_audit_log` | 로그인 · 승인 · 폐기 · 비밀번호 변경의 기록 |
| `schema_migrations` | 스키마 버전 |

DB 접속은 `mysql2` 드라이버와 표준 SQL 만 씁니다. 계정은 `database/database.ini` 의
`[user:webservices]` 이 `manager` DB 에만 권한을 갖고, 이 장비(`localhost`, `127.0.0.1`)에서만 붙습니다.

## 서비스를 붙일 때

이 판의 목적은 manager 와 기반을 갖춘 뒤 필요한 서비스를 **선언으로 붙이는** 것입니다.
서비스를 붙이는 절차(서비스 추가 마법사, 선언 둘, 반영 순서, 되돌리기)는
[guide/rollout.md](guide/rollout.md) 에, 선언 형식은
[guide/declarations.md](guide/declarations.md) 에, `/health` 와 점검 출력의 약속은
[guide/contracts.md](guide/contracts.md) 에 있습니다.

붙이는 서비스가 지켜야 하는 것:

- `127.0.0.1` 에서 평문 HTTP 로 듣는다. TLS 는 nginx 가 끊는다.
- `GET /health` 에 응답한다 — manager 가 이것으로 상태를 보여 줍니다.
- 로그인이 필요하면 직접 계정을 두지 않고 `manager_session` 쿠키를 검증한다.
- 장비마다 다른 값은 `settings.ini`, 받을 항목은 커밋하는 `settings-schema.json` 에 둔다.

## 더 읽을 곳

- 설치부터 운영까지: [guide/README.md](guide/README.md)
- 화면과 기능: [dashboards.md](dashboards.md)
- 포트: [ports.md](ports.md)
