# webservice-nginx-light

장비 한 대에 **관리 대시보드(manager)** 와 그 기반(nginx · pm2 · MariaDB)을 세우고
관리하는 저장소입니다. 서비스를 선언으로 붙이고 떼는 구조, 구축 마법사, 점검 규약이
있어서 이 위에 다른 서비스를 plug-in 으로 붙일 수 있습니다.

## 목적

- **빈 장비에서 같은 결과를 다시 만들 수 있게.** 장비마다 다른 값은
  `settings.ini` 에만 두고 나머지는 전부 저장소가 소유합니다. 설치는
  `bootstrap.sh` 와 브라우저의 구축 마법사가 단계별 점검으로 안내하고,
  `check-all.sh` 가 "설치본이 저장소의 선언과 같은가" 를 언제든 확인합니다.
- **서비스를 선언으로 붙이고 뗀다.** 서비스 하나는 디렉터리 하나이고, 라우팅
  (`nginx-conf/`) · 프로세스(`pm2-conf/`) · DB(`db-conf/`) 를 선언하면 nginx 설정,
  pm2 앱 목록, DB 계정이 그 선언에서 만들어집니다.
- **한 곳에서 본다.** manager 대시보드 한 번 로그인으로 서비스의 상태·설정·문서를 봅니다.

## 구성

| 서비스 | 역할 | 경로 |
|---|---|---|
| manager | 관리 대시보드 · 구축 마법사 · 로그인 · 문서 화면 | `/manager` (루트 `/` 는 여기로 302) |

그 아래 기반은 nginx(443 에서 TLS 를 모두 끊는 리버스 프록시), pm2(프로세스),
MariaDB(관리자 계정·감사 로그) 입니다.

```
WebServices-light/
├── README.md    # 이 문서 — 개요와 문서 지도
├── docs/        # 문서 전부 (아래 '문서 지도')
├── site/        # 장비별 값 — 호스트 · tls_mode
├── nginx/       # nginx 생성기·설치 스크립트, 사설 CA, Let's Encrypt (public_ca/)
├── database/    # MariaDB 설치·공용 스키마·계정 (database.ini)
├── pm2/         # ecosystem.config.js (pm2-conf 를 훑어 앱 목록을 만든다), 부팅 복원
├── lib/         # 스크립트들이 공유하는 조각 — 점검 규약, ini·settings 파서, pm2 재시작
└── services/    # 서비스 하나 = 디렉터리 하나
    ├── manager/                       # 기본 서비스
    └── <plug-in>/                     # 자기 저장소를 가진 plug-in
```

디렉터리마다 담는 것의 경계는 이렇습니다. 새 파일을 어디 둘지 망설여지면 이 표를
따릅니다.

| 디렉터리 | 담는 것 | 담지 않는 것 |
|---|---|---|
| `docs/` | 문서 | 코드 |
| `site/` | 장비마다 다르고 여러 곳이 함께 쓰는 값 | 서비스 하나만 쓰는 값 (그 서비스의 `settings.ini`) |
| `nginx/` | TLS 설정과 인증서, listen 포트 등 서버 수준 설정, 설치 스크립트 | 라우팅(각 서비스가 선언), 서비스 코드 |
| `database/` | MariaDB 설치, 공용 스키마·계정 | plug-in 의 DB 선언 (그 서비스의 `db-conf/`) |
| `pm2/` | `ecosystem.config.js`, `pm2-boot.sh`, 부팅 로그 | 서비스 코드 |
| `lib/` | 스크립트들이 공유하는 조각 | 서비스 로직 |
| `services/` | 서비스별 소스와 각자의 선언·설정 | 오케스트레이션 설정 |

## 시작하기

> **설치 전에** 공인 인증서(Let's Encrypt)로 배포하려면 소유한 도메인과, 80·443 이
> 밖에서 열리는 공인 IP(CGNAT 불가)가 필요합니다. LAN 전용이면 우분투 장비와
> sudo 만 있으면 되고, 이때 `tls_mode` 는 `private` 로 둡니다.

```bash
./bootstrap.sh        # 안내 셸 — 지금 상태와 다음에 칠 명령 하나를 보여 준다
```

그 뒤는 브라우저의 구축 마법사(`/manager/setup`)가 단계별로 안내합니다.
단계는 사이트 값 → pm2 → MariaDB → 서버 인증서 결정 → nginx 라우트이고,
공인 인증서는 선택 단계 넷(발급 · nginx 반영 · 갱신 · DNS 점검)입니다.

서비스 코드를 고친 뒤에는 같은 두 명령으로 반영하고, 전체가 선언과 맞는지는
하나로 확인합니다.

```bash
cd services/<이름> && npm run build && npm run restart
```

```bash
./check-all.sh
```

## 문서 지도

| 문서 | 내용 | 이럴 때 |
|---|---|---|
| [README.md](README.md) | 개요 · 목적 · 문서 지도 | 처음 |
| [docs/services.md](docs/services.md) | 서비스 구성과 manager 의 역할 | 구조를 이해할 때 |
| [docs/guide/](docs/guide/README.md) | **구현 가이드** — 설치·기반·규약·선언·반영 | 장비 위에서 무언가를 할 때 |
| [docs/dashboards.md](docs/dashboards.md) | manager 의 화면과 기능 | 대시보드를 쓰거나 고칠 때 |
| [docs/ports.md](docs/ports.md) | 포트와 공유기 포워딩, 포트 바꾸는 법 | 포트를 열거나 바꿀 때 |

문서를 고칠 때의 약속:

- **코드가 기준입니다.** 문서와 코드가 다르면 코드가 맞고, 문서를 고칩니다.
- **새 문서 파일을 늘리지 않습니다.** 내용은 위 자리 중 맞는 곳에 넣습니다.
  계획·검토 메모도 따로 두지 않고, 결정된 것은 해당 문서에 적습니다.
- **코드 주석이 문서를 가리킬 때는 `docs/<파일> '<절 제목>'` 으로 적습니다.** 절
  제목을 바꾸면 `git grep` 으로 그 제목을 가리키는 주석도 함께 고칩니다.

## 알려진 한계

- MariaDB 는 배포판 기본 버전을 설치합니다. 22.04 의 10.6 은 지원이 끝났으므로 11.4 저장소를 손으로 추가해야
  합니다 ([docs/guide/install.md](docs/guide/install.md) 2.1). 이미 MySQL 이 있는 장비는
  [docs/guide/infrastructure.md](docs/guide/infrastructure.md) 7.9 를 따릅니다.
- `docs/guide/` 의 contracts · declarations · rollout 과 infrastructure 일부 장은 예시가 지금은 없는
  통화 시스템(Kamailio · Janus 등)에 기대어 있습니다. 규칙 자체는 그대로 맞습니다.
