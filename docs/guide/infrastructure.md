# 공통 기반 — 사이트 값 · nginx · 인증서 · pm2 · MariaDB

모든 서비스가 함께 기대는 바닥입니다. 서비스 하나를 고칠 때는 이 장을 볼 일이
드물지만, 호스트 이름을 바꾸거나 인증서를 옮기거나 재부팅 뒤 무언가 안 뜰 때는
여기서 시작합니다.

선언 파일(`nginx-conf/*.ini` · `pm2-conf/*.ini` · `db-conf/*.ini`)의 키와 규칙은
[declarations.md](declarations.md) 에 있습니다. 이 장은 그 선언을 **읽어서 실제 장비에
반영하는 쪽**을 다룹니다.

## 한눈에

| 층 | 누가 띄우나 | 선언 · 값 | 반영 | 점검 (sudo 불필요) |
|---|---|---|---|---|
| 사이트 값 | — | `site/settings.ini` | `./site/apply.sh --apply` | `./site/apply.sh` |
| nginx | systemd | `nginx/nginx-stack.conf` + `services/*/nginx-conf/*.ini` | `sudo nginx/install_nginx_stack.sh --skip-install` | `nginx/install_nginx_stack.sh --check` |
| 사설 인증서 | — | `nginx/cert/` | `nginx/generate_certs.sh` · `generate_client_certificates.sh` | `nginx/tls-decide.sh` |
| 공인 인증서 | certbot (systemd 타이머) | `nginx/public_ca/settings.ini` | `sudo nginx/public_ca/setup_letsencrypt.sh --prod` | `cert-status.sh` · `renew-status.sh` · `check-dns.sh` |
| node 서비스 | pm2 | `services/*/pm2-conf/*.ini` | `pm2 start pm2/ecosystem.config.js` · `pm2 save` | `node pm2/ecosystem.config.js --check` |
| MariaDB | systemd | `database/database.ini` + `database/settings.ini` + `services/*/db-conf/*.ini` | `sudo database/setup_mariadb.sh` | `database/check-database.sh` |

Kamailio · Janus · coturn 본체도 systemd 가 띄웁니다. 그 셋의 설정은 각 서비스의
`install.sh --apply` 가 쓰고, 이 장의 대상이 아닙니다([../services.md](../services.md)).

---

## 1. 사이트 값 — `site/settings.ini`

여러 곳이 **함께 쓰는** 값입니다. 항목 정의는 `site/settings-schema.json`
(커밋), 값은 `site/settings.ini`(커밋하지 않음), 마지막으로 반영한 값은
`site/.applied-settings` 입니다. 구축 마법사의 첫 단계 `site.settings` 의 폼이 이
파일을 씁니다. 손으로 적어도 됩니다 — 절 없이 `키 = 값` 입니다.

```ini
host       = manager.example.com
tls_mode   = auto
```

| 키 | 형식 | 쓰는 곳 |
|---|---|---|
| `host` | 점이 있는 호스트 이름 (스킴 없이) | nginx `server_name` · Let's Encrypt 발급 이름 · 서버 인증서의 이름 |
| `tls_mode` | `auto`(기본) · `public` · `private` | nginx 가 내밀 서버 인증서의 경로 (3절) |

**둘 이상이 쓰는 값만** 여기에 둡니다. 서비스 하나만 쓰는 값은 그 서비스의
`settings.ini` 에 둡니다.

**DB 가 아니라 파일인 이유.** nginx 는 systemd 가 띄우고 시작할 때 파일을 읽습니다.
DB 를 읽을 방법이 없고, DB 자체가 설정의 대상이기도 합니다. DB 는 런타임 상태(관리자
계정 · 승인 대기 · 감사 로그)를 맡습니다.

**서비스 설정이 이깁니다.** 사이트 값은 서비스 설정이 **비어 있을 때만** 쓰입니다.
`nginx-stack.conf` 의 `server_name` 도 적으면 그쪽이 이깁니다.

### 반영

```bash
./site/apply.sh            # 점검 — 값, 반영본과 같은지
./site/apply.sh --apply    # 반영 — sudo 불필요
```

`--apply` 가 하는 것은 **`.applied-settings` 갱신뿐**입니다. nginx 는 자기 설정 파일을
다시 쓸 때 이 값을 읽으므로 따로 반영해야 합니다. `--apply` 가 끝에 그 명령을 찍어 줍니다.

```bash
sudo ./nginx/install_nginx_stack.sh --skip-install
```

---

## 2. nginx

nginx 프로세스는 systemd 가 관리합니다(80/443 바인딩에 root 가 필요). **라우팅은
`nginx/` 에 없습니다.** 각 서비스가 자기 `nginx-conf/*.ini` 에 포트와 경로를
선언하고, 생성기가 그것을 모아 `/etc/nginx/conf.d/path-routing.conf` 하나를 만듭니다.

| 파일 | 역할 |
|---|---|
| `nginx/install_nginx_stack.sh` | **주 진입점.** 검사 → 생성 → 설치 → `nginx -t` → reload |
| `nginx/generate_nginx_conf.py` | 선언을 읽어 upstream · location 을 만들고, 충돌을 검사하고, 설치본과 견준다 |
| `nginx/nginx-stack.conf` | 서버 수준 값 — listen 포트 · TLS · mTLS · ACME · 포트 포워딩 · `default_route` |
| `nginx/server.conf.template` | 생성될 설정의 골격 |
| `nginx/tls-decide.sh` | 서버 인증서가 공인/사설 중 어느 쪽으로 갈리는지와 그 근거 |
| `nginx/install_nginx.sh` | nginx 패키지 설치 · 업데이트 (apt) |
| `nginx/generate_certs.sh` · `generate_client_certificates.sh` | 사설 CA (4절) |
| `nginx/public_ca/` | Let's Encrypt (5절) |
| `nginx/cert/` | 사설 인증서 원본 (git 제외). nginx 가 이 경로를 직접 읽습니다 |

### 2.1 설치

```bash
sudo apt-get install -y nginx
```

`nginx/install_nginx.sh install` 도 같은 패키지를 깔지만, 설치 직후 nginx 를 **멈춰
둡니다**(`systemctl stop` + `enable`). 그 뒤 `install_nginx_stack.sh` 의 마지막
`systemctl reload` 는 멈춘 유닛에 대해 실패하므로, 그 길로 갔다면
`sudo systemctl start nginx` 를 한 번 더 합니다. 스크립트의 끝 안내에 나오는
`setup_nginx.sh` 는 지금 없는 파일입니다.

### 2.2 반영 — `install_nginx_stack.sh`

```bash
cd nginx
./install_nginx_stack.sh --check           # 선언 검사 + 설치본 대조. 아무것도 쓰지 않음 (sudo 불필요)
./install_nginx_stack.sh --dry-run         # 만들어질 설정을 출력만
sudo ./install_nginx_stack.sh --skip-install   # 반영 (평소 쓰는 명령)
```

| 플래그 | 뜻 |
|---|---|
| `--check` | 파싱 · 충돌 검사 · 인증서 판정 · 설치본 대조. 쓰지 않음 |
| `--json` | 같은 검사를 기계가 읽는 형식으로 ([contracts.md](contracts.md)) |
| `--dry-run` | 만들어질 `path-routing.conf` 를 표준 출력으로 |
| `--skip-install` | apt 설치 단계를 건너뜀 (이미 설치된 장비에서 늘 씀) |
| `--skip-reload` | 설정만 쓰고 reload 하지 않음 |

반영은 이 순서로 진행되고, 어느 자리에서 실패하든 그 뒤로 가지 않습니다.

1. 선언을 검사합니다. 포트나 location 이 겹치거나 인증서 파일이 없으면 **아무것도
   쓰지 않고** 멈춥니다.
2. 임시 파일에 생성한 뒤 `/etc/nginx/conf.d/path-routing.conf` 로 설치합니다(root:root 0644).
3. 이관 전 구조의 `/etc/nginx/sites-enabled/reverse-proxy.conf` 와 배포판 기본
   `sites-enabled/default` 가 있으면 지웁니다 — 남아 있으면 `default_server` 가
   겹치거나 옛 라우트가 함께 살아납니다.
4. `nginx -t`. 실패하면 reload 하지 않고 멈춥니다.
5. `systemctl reload nginx`.

`sudo` 로 부르지 않아도 됩니다 — root 가 필요한 명령에만 스스로 `sudo` 를 붙입니다.

**선언만 보는 검사로는 부족합니다.** 선언을 고치고 반영을 잊으면 nginx 는 옛 라우트를
그대로 내보내고 어디에도 오류로 보이지 않습니다. 그래서 `--check` 는 지금 선언으로
만들 내용과 설치본을 견주어, 다르면 이렇게 말합니다.

```
[--]  설치본이 지금 선언과 다릅니다 (20줄) — 반영하세요:
      sudo ./install_nginx_stack.sh --skip-install
```

생성된 설정은 `/etc/nginx/conf.d/` 에 남으므로 재부팅 때 다시 만들 필요는 없습니다.
`systemctl is-enabled nginx && systemctl is-active nginx` 로 확인합니다.

### 2.3 `nginx-stack.conf`

서버 수준 값만 담습니다. location 이나 upstream 을 여기 적지 마세요 — 생성기가
덮어씁니다. **이 파일은 커밋되므로 장비마다 다른 값을 적지 않습니다.**

| 키 | 지금 값 | 뜻 |
|---|---|---|
| `server_name` | (비움) | 비우면 `site/settings.ini` 의 `host`. 둘 다 없으면 `localhost` |
| `listen_port` / `ssl_port` | `80` / `443` | |
| `services_dir` | `../services` | `nginx-conf/` 를 훑을 곳 |
| `max_body` | `100m` | `client_max_body_size`. 비우면 nginx 기본 1m. 라우트별로는 서비스 선언의 `max_body` |
| `default_route` | (비움) | `/` 접속을 302 로 보낼 곳 (301 은 브라우저가 강하게 캐시해서 쓰지 않음). **intro 가 `/` 를 받으므로 비워 둔다** — 채우면 같은 `location = /` 가 둘이 된다 |
| `public_http_port` / `public_https_port` | (비움) | 공유기가 **비표준 포트**로 넘길 때만 (2.4) |
| `[tls] cert_dir` | `./cert` | 사설 인증서 위치. 이 파일 기준 상대 경로 |
| `[tls] cert_file` / `key_file` | (비움) | 비우면 `tls_mode` 에서 파생 (3절). 적으면 그것이 이김 |
| `[tls] client_ca` / `verify_client` | `ca/ca.crt` / `optional` | mTLS. 둘 다 있어야 검증 블록을 만듦 |
| `[tls] acme_webroot` | `/var/www/certbot` | HTTP-01 챌린지 자리. 비우면 예외를 만들지 않음 |

`max_body` 를 비우면 1m 가 되어, 100m 를 전제로 쓰인 plug-in 의 라우트가 조용히
413 으로 끊깁니다(nginx 가 거절하므로 앱 로그에는 아무것도 남지 않습니다).
라우트별 선언으로 내린 뒤에 비우는 것이 목표입니다.

생성된 설정에는 늘 두 가지가 들어갑니다. `absolute_redirect off`(리다이렉트가 포트를
443 으로 바꾸지 않게)와 `error_page 497 https://$http_host$request_uri`(HTTPS 포트에
평문으로 들어온 요청을 구제)입니다. 80 포트 서버는 `location /` 안에서 HTTPS 로
301 하고, 그 앞의 `location ^~ /.well-known/acme-challenge/` 만 평문으로 응답합니다.
301 을 server 레벨에 두면 ACME 예외에 닿지 못하기 때문입니다.

프록시하는 요청에는 클라이언트 인증서 검증 결과가 헤더로 붙습니다
(`X-SSL-Client-Verify` · `X-SSL-Client-DN`). 클라이언트가 같은 이름의 헤더를 보내
검사를 우회하지 못하도록 nginx 가 값을 덮어씁니다. 이것을 어떻게 쓰는지는 서비스가
정합니다.

### 2.4 공유기가 비표준 포트로 넘길 때

기본은 비워 둡니다. 공유기가 80 · 443 을 그대로 넘기는 배치가 정상입니다(운영 장비도
2026-08-29 부터 그렇습니다). **외부 28080 → 내부 80, 외부 28443 → 내부 443** 처럼
넘기는 환경에서만 두 값을 채웁니다. 생성기가 Host 의 포트를 보고 HTTPS 목적지를
정하는 `map` 을 만듭니다.

그런 환경에서 값이 비면 외부 HTTP 요청이 내부 443 으로 리다이렉트되어 끊기고,
반대로 표준 포워딩인데 값이 남아 있으면 80 요청을 죽은 포트로 보냅니다. 둘 다
조용히 깨지므로 **포워딩을 바꾸면 이 값을 함께 봅니다.** Let's Encrypt HTTP-01 은
비표준 포트 포워딩으로는 통과하지 않습니다.

---

## 3. 서버 인증서 — `tls_mode`

nginx 가 내미는 서버 인증서(`ssl_certificate`)의 경로는 `site/settings.ini` 의
`tls_mode` 에서 나옵니다. 예전에는 `nginx-stack.conf` 에 한 장비의 Let's Encrypt 경로가
박혀 있었고, 클론한 새 장비에서는 그 디렉터리가 없어 `nginx -t` 가 "설정이 틀렸다" 로
실패했습니다. 그래서 커밋되지 않는 사이트 값으로 옮겼습니다.

| `tls_mode` | 서버 인증서 |
|---|---|
| `private` | `nginx/cert/server/server.crt` · `server.key` (`generate_certs.sh`) |
| `public` | `/etc/letsencrypt/live/<host>/fullchain.pem` · `privkey.pem` |
| `auto` (기본) | 그 이름으로 발급받은 것이 있으면 `public`, 없으면 `private` |

- **`auto` 는 `/etc/letsencrypt/renewal/<host>.conf` 로 판정합니다.** `live/` 는
  `0700 root` 라 sudo 없이 읽을 수 없어, 파일 유무로 가르면 sudo 로 돌 때와 아닐 때
  판정이 달라집니다. `renewal/` 은 누구나 읽고, 그 파일은 발급의 결과로만 생깁니다.
- **`cert.pem` 이 아니라 `fullchain.pem`** 입니다. 중간 인증서가 빠지면 브라우저는
  멀쩡한데 일부 안드로이드 기기에서만 실패합니다. 생성기가 정하므로 손댈 곳이 없습니다.
- **어느 쪽으로 갈렸는지는 반영 · 점검할 때마다 한 줄로 나옵니다.** 조용히 사설로
  떨어지는 것이 가장 나쁘기 때문입니다. 사설 판정은 `problem` 이 아니라 `skip` 입니다
  (LAN 전용에서는 옳은 선택).
- **직접 적으면 그것이 이깁니다.** `[tls] cert_file` · `key_file` 을 **둘 다** 적습니다.
  하나만 적으면 공인 인증서에 사설 개인키가 짝지어져 nginx 가 `key values mismatch` 로
  거절합니다 — 생성기가 그 상태를 미리 `problem` 으로 잡습니다.
- **mTLS 는 이것과 직교합니다.** 클라이언트를 검증하는 CA(`ssl_client_certificate`)는
  `tls_mode = public` 이어도 사설 CA 그대로입니다. 서버 인증서는 앱이 OS 신뢰 저장소로
  검증하므로 공인이어야 하고, 클라이언트 인증서는 서버가 파일로 지정한 CA 로
  검증하므로 사설로 충분합니다.

```bash
python3 nginx/generate_nginx_conf.py --tls-mode   # 판정만 JSON 으로
nginx/tls-decide.sh                               # 판정 + 공인으로 갈 수 있는 장비인가
```

`tls-decide.sh` 는 판정을 다시 구현하지 않고 생성기에 물은 뒤, 사설로 갈린 장비에서
`host` · A 레코드 · certbot 설치 가능 여부를 봅니다. 여기의 판정은 전부 `skip` 입니다 —
공인으로 갈 수 없는 것은 잘못이 아니라 사실이기 때문입니다. 외부 80 도달 여부는
여기서 보지 않고 `public_ca.issue` 의 점검이 봅니다.

---

## 4. 사설 CA

### 4.1 처음 한 번 — `generate_certs.sh`

CA · 서버 인증서 · 기본 클라이언트 인증서를 한 벌로 만듭니다.

```bash
cd nginx
./generate_certs.sh --auto <host>                        # LAN·공인 IP 자동 감지 + 이름 (권장)
./generate_certs.sh <host>                               # 이름만
./generate_certs.sh --ip 192.168.0.10,10.0.0.1 <host>    # IP 를 직접
./generate_certs.sh --dns other.example <host>           # 이름 추가
```

`--auto` 는 LAN IPv4(도커 브릿지 대역 제외)와 공인 IP 를 SAN 에 넣습니다. CIDR 대역은
X.509 가 지원하지 않으므로 IP 를 하나씩 나열해야 합니다. 유효기간은 CA 10년,
서버·클라이언트 1년입니다.

```
nginx/cert/
├── ca/      ca.key (절대 내보내지 않음) · ca.crt
├── server/  server.key · server.crt          ← tls_mode = private 일 때 nginx 가 읽음
└── client/  electron · android · ios / *.key *.crt *.pem *.p12 ca.crt
```

다시 만든 뒤에는 경로가 같아도 nginx 가 파일을 다시 읽어야 하므로 반영합니다.

```bash
./generate_certs.sh --auto <host> && sudo ./install_nginx_stack.sh --skip-install
```

> ⚠️ **운영 중인 장비에서 `generate_certs.sh` 를 다시 돌리지 마세요.** CA 부터 새로
> 만들기 때문에 이미 배포한 단말의 클라이언트 인증서가 전부 무효가 되고, relay 가
> 발급해 준 단말 인증서도 함께 무효가 됩니다(relay 는 `nginx/cert/ca/ca.key` 로 단말
> 인증서에 서명합니다). 서버 인증서만 갱신하려면 CA 를 두고 서버 인증서만 다시
> 서명해야 하는데, 지금은 그 모드가 없습니다.

`nginx/cert/ca/ca.key` 는 **따로 백업해야 하는 자산**입니다. 잃으면 같은 CA 로 다시
발급할 수 없고, 새면 누구나 이 단지 이름으로 인증서를 만들 수 있습니다. `cert/` 를
통째로 압축해 보내면 이 키가 딸려 가므로, 보낼 것은 `ca.crt` 와 그 단말의 번들뿐입니다.

### 4.2 단말이 늘 때 — `generate_client_certificates.sh`

**이미 있는 CA 로 서명만** 합니다. CA 와 서버 인증서는 건드리지 않고, nginx reload 도
필요 없습니다(`client_ca` 가 그 CA 를 이미 가리킵니다).

```bash
./generate_client_certificates.sh wallpad-102                 # cert/client/wallpad-102/
./generate_client_certificates.sh --days 730 intercom-3f
./generate_client_certificates.sh --p12-password 'secret' android-app
```

| 대상 | 산출물 |
|---|---|
| 웹 · Electron | `<name>.crt` · `<name>.key` · `<name>.pem` |
| Android | `<name>.p12` + `ca.crt` |
| iOS | `<name>.p12` + `ca.cer` (DER) |

CA 가 없으면 멈춥니다. 없다고 새로 만들지 않는 것이 의도입니다 — nginx 가 검증에 쓰는
CA 와 갈라지면 단말은 인증서를 가졌는데 서버가 거절하고, 그 실패는 TLS 단계에서 나
앱 로그에 남지 않습니다. `.p12` 비밀번호는 기본이 빈 값이며, 빈 비밀번호를 거부하는
단말에는 `--p12-password` 로 다시 발급합니다.

### 4.3 `tls_mode = private` 배치 — CA 배포

공인 인증서는 서버만 갖추면 끝나지만, 사설 CA 는 **단말마다 그 CA 를 심어야** 합니다.
심기 전에는 아무 앱도 붙지 못합니다.

| 대상 | 보낼 것 | 어떻게 |
|---|---|---|
| 브라우저 (관리 화면) | `ca/ca.crt` | OS · 브라우저의 신뢰할 수 있는 루트에 등록 |
| Android 앱 | `ca.crt` | `res/xml/network_security_config.xml` 에 넣고 앱에 빌드 |
| iOS 앱 | `ca.cer` | 구성 프로파일 설치 + 설정 → 일반 → 정보 → 인증서 신뢰 설정에서 켜기 |
| Electron | `ca.crt` | `https.Agent` 의 `ca` |

이 길은 스토어 앱에는 사실상 못 씁니다(iOS 는 사용자가 손으로 신뢰를 켜야 하고,
Android 는 API 24 부터 사용자 설치 CA 를 앱이 기본으로 믿지 않으며, 단지가 늘거나 CA 를
바꿀 때마다 스토어 심사가 따라옵니다). 그래서 `private` 는 LAN 전용과 개발기의
자리입니다. 사설 CA 로 도는 동안 `cert-status.sh` 와 대시보드 TLS 카드는 계속 `warn`
(`kind = private-ca`)을 냅니다 — 고장이 아니라 미완료 표시입니다.

---

## 5. 공인 인증서 — Let's Encrypt

인증서 파일은 저장소에 없습니다. certbot 이 `/etc/letsencrypt/` 에 두고 스스로
갱신합니다. `nginx/public_ca/` 에는 받아오는 절차와 점검만 있습니다.

| 파일 | 역할 |
|---|---|
| `settings-schema.json` · `settings.ini` | 도메인 · 알림 메일 (`settings.ini` 는 git 제외) |
| `setup_letsencrypt.sh` | 발급 (`--check` · `--staging` · `--prod`) |
| `cert-status.sh` | 지금 **실제로 내밀고 있는** 인증서 (로컬 TLS 포트에 접속해 읽음) |
| `renew-status.sh` | 90일 뒤에도 내밀 것인가 |
| `check-dns.sh` | 이름이 아직 이 서버를 가리키나 |

### 5.1 사전 조건

1. 소유한 도메인과 이 서버를 가리키는 A 레코드 (`dig +short A <host>` = `curl -s ifconfig.me`).
2. 외부 80 이 열려 있을 것. HTTP-01 검증은 **반드시 80** 으로 들어오고 포트를 바꿀 수
   없습니다. 80 을 열 수 없으면 DNS-01 이 필요한데, 이 저장소에는 그 절차가 아직 없습니다.
3. `nginx-stack.conf` 의 `acme_webroot` 가 반영되어 있을 것(`nginx.routes` 뒤).
   디렉터리는 `sudo mkdir -p /var/www/certbot && sudo chown root:www-data /var/www/certbot`.

### 5.2 발급

```ini
; nginx/public_ca/settings.ini — 비우면 site/settings.ini 의 host 를 씁니다
domain =
email  = you@example.com
```

```bash
cd nginx/public_ca
./setup_letsencrypt.sh --check          # DNS · 외부 80 · webroot · certbot. 아무것도 바꾸지 않음
sudo ./setup_letsencrypt.sh --staging   # 시험 발급 — 건너뛰지 마세요
sudo ./setup_letsencrypt.sh --prod      # 실제 발급
```

- **staging 을 먼저 합니다.** 같은 이름 조합에 주 5건 제한이 있고, 한 번 걸리면
  일주일을 기다립니다. staging 은 `<도메인>-staging` 이라는 별도 이름으로 받으므로
  `--prod` 로 넘어갈 때 지울 것이 없습니다. staging 인증서는 브라우저가 믿지 않으니
  nginx 에 물리지 않습니다.
- certbot 이 없으면 apt 로 깔고, `certonly --webroot` 로 받으며
  `--deploy-hook "systemctl reload nginx"` 를 함께 걸어 둡니다.
- `--prod` 가 성공하면 발급한 값을 `.applied-settings` 에 남깁니다. 도메인이나 메일을
  바꿔 놓고 다시 받지 않은 상태가 점검에서 `pending` 으로 드러납니다.
- `domain` 을 사이트 값과 다르게 적으면 `tls_mode = auto` 의 판정(`renewal/<site host>.conf`)
  과 어긋납니다. 특별한 이유가 없으면 비워 둡니다.

`--check` 의 80 포트 확인은 **없는 이름**을 불러 응답을 봅니다(sudo 없이 돌기 위해서).

| 응답 | 뜻 |
|---|---|
| `404` | 외부 80 으로 들어왔고, 평문으로 응답했고, ACME 예외가 살아 있다 |
| `301` | 예외가 아직 반영되지 않았다 → `sudo ../install_nginx_stack.sh --skip-install` |
| 연결 실패 | 외부 80 이 닫혔다 → 공유기 포워딩 |

### 5.3 nginx 에 물리기

`tls_mode` 가 `auto` 면 발급이 끝나는 순간 판정이 `public` 으로 바뀝니다. 경로를 적지
않고 반영만 합니다.

```bash
python3 ../generate_nginx_conf.py --tls-mode     # 어느 쪽으로 갈렸는지
sudo ../install_nginx_stack.sh --skip-install
./cert-status.sh                                 # 실제로 무엇이 나가는지
```

`cert-status.sh` 가 파일이 아니라 접속해서 읽는 이유는 **발급받은 것과 내밀고 있는
것이 다를 수 있기** 때문입니다(reload 를 잊은 경우). `--json` 은 대시보드용 형식,
`--check [--json]` 은 점검 규약 형식입니다.

| `kind` | `status` | 뜻 |
|---|---|---|
| `letsencrypt` | ok | 정상 (타이머가 꺼져 있으면 warn) |
| `private-ca` | warn | 아직 이관 전 |
| `letsencrypt-staging` | critical | 시험 인증서가 배포에 물림 |

### 5.4 갱신은 어떻게 도나

certbot 패키지가 자기 systemd 타이머를 함께 깝니다. 하루 두 번 깨어나 만료 30일
전부터 갱신합니다. 유닛을 따로 쓰지 않습니다.

```bash
systemctl list-timers certbot.timer
sudo systemctl enable --now certbot.timer    # 꺼져 있을 때만
sudo certbot renew --dry-run                 # 실제로 갱신되는지 (rate limit 을 쓰지 않음)
./renew-status.sh
```

`renew-status.sh` 가 보는 것은 넷입니다. 셋 다 **터지기 전에는 아무 증상이 없어서**
만료를 기다리지 않고 지금 묻습니다.

| 보는 것 | 없으면 |
|---|---|
| `certbot.timer` 활성 · 부팅 등록 | 갱신 자체가 안 돈다 |
| 갱신 훅 (`renewal/<이름>.conf` 의 `renew_hook`) | 갱신은 되는데 nginx 가 옛것을 계속 내민다 |
| 만료까지 남은 날 | 20일 아래면 열흘 넘게 갱신이 실패하고 있다 |
| 마지막 시도의 종료 코드 | 원인은 `journalctl -u certbot.service` |

Let's Encrypt 는 2025년에 만료 알림 메일을 끝낸다고 공지했습니다. `email` 은 계정
등록에만 쓰인다고 보고, 갱신 실패는 위 점검과 대시보드 TLS 카드로 알아챕니다.

### 5.5 유동 IP

A 레코드는 고정값이고 따라가는 장치가 없습니다. IP 가 바뀌면 앱이 즉시 · 전면 못
붙고, ICE 후보 주소가 틀어지고, certbot 갱신이 만료 30일 전부터 조용히 실패합니다.

```bash
./check-dns.sh             # 이름이 아직 이 서버를 가리키나
```

크론에 걸어 두면 사람보다 먼저 압니다(경로는 이 장비의 절대 경로로).

```
*/10 * * * * <저장소>/nginx/public_ca/check-dns.sh --quiet || echo "DNS 가 이 서버를 가리키지 않습니다" | logger -t dns-drift
```

TTL 이 600초면 A 레코드를 고친 뒤 10분 안에 퍼집니다. 근본 해결은 DNS 를 API 로 고칠
수 있게 만드는 것이고, 아직 하지 않았습니다.

### 5.6 승격과 강등

**승격 (`private` → `public`)** — 도메인이 생겼을 때.

```bash
# site/settings.ini 의 host 를 정하고 A 레코드를 맞춘 뒤
nginx/public_ca/check-dns.sh
nginx/tls-decide.sh
cd nginx/public_ca && ./setup_letsencrypt.sh --check
sudo ./setup_letsencrypt.sh --staging && sudo ./setup_letsencrypt.sh --prod
sudo ../install_nginx_stack.sh --skip-install && ./cert-status.sh
```

`tls_mode` 가 `auto` 면 손댈 필요가 없습니다. `private` 로 못박아 두었다면 `auto` 로
되돌려야 합니다 — 그대로 두면 발급이 성공해도 계속 사설을 내밉니다. 이미 사설 CA 를
심어 배포한 단말은 공인 인증서도 그대로 받아들입니다. 단, 앱이 커스텀 TrustManager 로
**사설 CA 만** 믿게 되어 있다면 그 코드를 먼저 걷어내야 합니다.

**강등 (`public` → `private`)** — 갱신이 계속 실패해 만료가 임박했을 때. certbot 은
만료 30일 전부터 하루 두 번 시도하므로 하루 이틀 어긋나는 것은 흡수됩니다.
`cert-status.sh` 의 `daysLeft` 가 7 아래이고 `certbot renew --dry-run` 이 계속 실패하면
강등합니다.

```bash
ls nginx/cert/server/server.crt || (cd nginx && ./generate_certs.sh --auto <host>)
# site/settings.ini:  tls_mode = private     ← auto 로 두면 renewal/ 이 남아 계속 public
sudo nginx/install_nginx_stack.sh --skip-install
nginx/public_ca/cert-status.sh               # kind = private-ca, status = warn
```

강등은 **관리 화면을 살리기 위한 것**입니다. 스토어 앱은 끊기고, 브라우저는 경고를
넘기면 들어가며, LAN 내부 통화와 mTLS 는 영향이 없습니다. 앱이 붙어야 하는 배치라면
강등이 아니라 원인(A 레코드 · 80 포트)을 고치는 것이 답입니다.

### 5.7 막히는 곳

| 증상 | 원인 | 할 일 |
|---|---|---|
| 챌린지 경로가 301 | ACME 예외가 반영되지 않음 | `acme_webroot` 확인 후 `install_nginx_stack.sh --skip-install` |
| `Connection refused` | 외부 80 이 닫힘 | 공유기 포워딩 |
| `NXDOMAIN` · 다른 IP | A 레코드 없음 · 낡음 | 등록기관에서 수정 |
| `too many certificates` | 주 5건 제한 소진 | 일주일 대기. 다음부터 staging 먼저 |
| 브라우저가 거부 | staging 인증서를 물림 | `--prod` 로 다시 받기 |
| 갱신됐는데 만료로 나옴 | 갱신 훅 누락 | `sudo certbot renew --force-renewal` 후 훅 확인 |

단지가 여럿이면 **단지마다 이름 하나 · 인증서 하나**입니다. 와일드카드로 묶으면
개인키가 모든 단지에 복사되고, 90일마다 전 단지에 실어 나르는 파이프라인을 따로
운영해야 하며, HTTP-01 로는 받을 수도 없습니다.

---

## 6. pm2

node 서비스(manager · 대시보드 셋 · websocket-relay · plug-in)는 pm2 가 띄웁니다.
Kamailio · Janus · coturn 본체와 nginx 는 systemd 가 띄우고 pm2 대상이 아닙니다.

### 6.1 설치

```bash
./pm2/install_pm2.sh install     # sudo npm install -g pm2 + pm2 startup systemd
./pm2/install_pm2.sh update      # 업데이트 (pm2 update 로 데몬도 갈아탐)
./pm2/install_pm2.sh uninstall
```

`/usr/local/bin/pm2` 에 깔립니다. 데몬은 처음 `pm2` 명령을 부르는 순간 떠서 상주합니다.

### 6.2 앱 목록은 선언을 훑어서 만든다

`pm2/ecosystem.config.js` 는 앱을 적어 두는 파일이 아니라 `services/*/pm2-conf/*.ini` 를
훑어 `apps` 배열을 만드는 파일입니다. 경로는 실행 시점에 이 파일 위치에서 절대 경로로
계산합니다. 서비스를 추가할 때 이 파일을 고칠 일은 없습니다
(선언 형식은 [declarations.md](declarations.md)).

```bash
cd pm2
pm2 start ecosystem.config.js                  # 선언된 것 전부
pm2 start ecosystem.config.js --only manager   # 하나만
pm2 save                                       # 재부팅 복원 목록(~/.pm2/dump.pm2) 갱신
node ecosystem.config.js --check               # 해석 결과 · nginx-conf 와 포트 교차 · 선언/실행/저장 대조
node ecosystem.config.js --check --json        # pm2 에 실제로 넘어가는 객체까지
```

마법사가 쓰는 점검 규약 형식은 `--check-json` 입니다(`--check --json` 은 위처럼 이미
다른 뜻으로 쓰이고 있습니다).

로그는 `pm2/logs/<앱>-{out,error}.log` 로 모입니다. 선언에 `out_file` · `error_file` 을
적으면 그쪽이 이깁니다.

### 6.3 선언 · 실행 중 · 재부팅 목록 — 셋을 견준다

pm2 는 파일이 아니라 프로세스라서, 어긋날 수 있는 자리가 셋입니다.

| 자리 | 무엇 | 어긋나면 |
|---|---|---|
| 선언 | `services/*/pm2-conf/*.ini` | — |
| 실행 중 | `pm2 jlist` | 선언을 고치고 다시 띄우지 않음 |
| 재부팅 목록 | `~/.pm2/dump.pm2` (`pm2 save`) | **재부팅 전까지 아무 증상이 없음** |

`pm2 resurrect` 가 되살리는 것은 마지막 `pm2 save` 시점의 목록입니다.
`node ecosystem.config.js --check` 가 셋을 견주고, 경우마다 다른 해결 명령을 줍니다.

**점검 대상은 이 저장소가 선언한 앱뿐입니다.** 같은 pm2 데몬에 다른 프로젝트의 앱이
떠 있어도 문제로 세지 않고, 재부팅 목록에서도 말하지 않고, 이름도 찍지 않습니다. 선언에
없다는 이유로 "`pm2 delete` 하세요" 라고 안내하면 남의 앱을 지우게 되기 때문입니다.
설치 중(마법사 `pm2.apps` 단계, `--check-json`)에는 더 좁혀 **manager 하나만** 봅니다.
선언은 했지만 `enabled = false` 로 끈 앱은 선언한 앱이므로, 그대로 떠 있으면 짚습니다.

```
선언대로 돌고 있는가
  ok      선언된 앱 8개 — 선언대로 돌고 있습니다
  ok      재부팅 목록도 같습니다 (선언된 앱 8개, pm2 save 됨)
```

같은 이유로 manager 의 자원 화면도 선언한 앱의 사용량만 보여 줍니다.

### 6.4 부팅 복원

길이 둘 있습니다. **하나만 씁니다.**

| | crontab `@reboot` (운영 장비) | systemd `pm2-<사용자>` |
|---|---|---|
| 등록 | 사용자 crontab 에 한 줄 (sudo 불필요) | `install_pm2.sh install` 이 자동으로 `pm2 startup systemd` 실행 |
| 데몬이 죽으면 | 되살리지 않음 | systemd 가 되살림 |
| 절대 경로 | crontab 줄에 `pm2-boot.sh` 경로 | 유닛에 `PM2_HOME` · PATH |

crontab 줄은 저장소 뿌리에서 다음으로 만듭니다.

```bash
echo "@reboot sleep 20 && /bin/bash $PWD/pm2/pm2-boot.sh >> $PWD/pm2/pm2-boot.log 2>&1"
crontab -e      # 위 출력을 넣습니다
crontab -l
```

cron 은 `PATH=/usr/bin:/bin` 으로 돌아 `/usr/local/bin/pm2` 를 못 찾습니다.
`pm2-boot.sh` 가 PATH 를 넓히고(nvm 이 있으면 함께 로드) `pm2 resurrect` 후
`pm2 list` 를 로그에 남깁니다.

`install_pm2.sh install` 로 깐 새 장비에는 systemd 유닛이 이미 등록되어 있습니다.
crontab 으로 가려면 `pm2 unstartup systemd` 로 유닛을 걷어낸 뒤 위 줄을 넣고,
systemd 로 가려면 crontab 줄을 넣지 않습니다. 확인은
`systemctl is-enabled pm2-$USER; crontab -l | grep pm2-boot` 입니다. 지금 어느 점검도
부팅 등록 자체는 보지 않으므로 사람이 확인해야 합니다.

재부팅 뒤 앱이 안 뜨면 `pm2/pm2-boot.log`(crontab) 또는
`journalctl -u pm2-$USER`(systemd)를 보고, 대개는 PATH 문제이거나 `pm2 save` 를 안 해
`dump.pm2` 가 낡은 경우입니다.

### 6.5 코드만 고쳤을 때 · 선언을 바꿨을 때 · 그룹이 바뀌었을 때

| 바뀐 것 | 명령 |
|---|---|
| 코드 | `cd services/<이름> && npm run build && npm run restart` |
| `pm2-conf` 의 script · cwd | `node pm2/ecosystem.config.js --check` 가 알려 주는 명령 (대개 `pm2 delete <앱>` → `pm2 start ecosystem.config.js --only <앱>` → `pm2 save`) |
| `pm2-conf` 의 env | `pm2 restart <앱> --update-env` 또는 delete 후 start (env 는 최초 fork 때 캐시됨) |
| 보조 그룹 (`groups`) | 다시 로그인 → `./pm2/restart.sh --restart` |

`npm run restart` 는 `lib/pm2-restart.sh` 로, 그 폴더의 `pm2-conf/*.ini` 에서 앱 이름을
읽어 `pm2 restart <이름>` 을 부릅니다. 등록되지 않은 앱을 띄우거나 선언을 다시 읽지는
않습니다. 자세한 반영 순서는 [rollout.md](rollout.md).

**보조 그룹.** kamailio-dashboard 는 `/run/kamailio`(`kamailio:kamailio`, 0770)의
JSON-RPC FIFO 를 읽으므로 `kamailio` 그룹이 필요합니다. 보조 그룹은 로그인할 때
정해져 자식에게 상속되므로 `usermod -aG` 뒤 `pm2 restart` 로는 바뀌지 않습니다 —
데몬 자체를 다시 띄워야 합니다.

**같은 pm2 데몬에 선언하지 않은 앱이 있으면 `--restart` 는 거부합니다.** 데몬을 내리면 그
앱들도 같이 내려가고, 이어지는 `pm2 save` 가 재부팅 목록에서도 지우는데, 이 스크립트는
선언한 앱만 다시 띄우기 때문입니다. 개수만 알려 주고 이름은 찍지 않습니다. 그런 장비에서
선언한 앱만 다시 띄우려면 데몬은 두고 `pm2 restart <앱 이름>` 을 씁니다(데몬의 그룹은 바뀌지
않으므로 `groups` 가 필요한 앱은 해당 장비에서 따로 다룹니다).

```bash
./pm2/restart.sh              # 점검 — 필요한 그룹, 지금 셸, 데몬, 앱
./pm2/restart.sh --restart    # pm2 kill → start → save → 잠시 뒤 확인 (선언하지 않은 앱이 있으면 거부)
./pm2/restart.sh --restart --sg   # 다시 로그인하지 않고 sg 로 감싸서 (임시 — 다음 부팅엔 안 남음)
```

### 6.6 자주 쓰는 명령

```bash
pm2 list
pm2 describe manager
pm2 logs manager --lines 100 --nostream
ss -ltnp 'sport = :28084'      # 포트를 누가 쥐고 있나
```

`↺`(재시작 횟수)가 계속 늘면 프로세스가 바로 죽고 있는 것입니다. 선언은 있는데
경로가 502 면 프로세스가 없다는 뜻입니다. pm2 앱은 포그라운드에서 끝나지 않고 떠
있어야 합니다 — `nohup … &` 로 곧바로 리턴하는 스크립트면 pm2 가 계속 재시작합니다.

---

## 7. MariaDB

`database/database.ini` 하나로 서버 설정 · 데이터베이스 · 사용자를 선언하고
`setup_mariadb.sh` 가 적용합니다. nginx 와 같은 방식입니다 — 선언 하나, 적용 스크립트
하나, 설치본이 선언과 같은지 보는 점검 하나.

| 파일 | 뜻 | 커밋 |
|---|---|---|
| `database.ini` | 어느 장비에서나 같은 선언 (`[server]` · `[security]` · `[database:*]` · `[user:*]`) | 한다 |
| `settings-schema.json` · `settings.ini` | 장비마다 다른 세 값 (`bind_address` · `port` · `innodb_buffer_pool_size`) | 스키마만 |
| `.applied-settings` | 실제로 반영한 값 | 안 한다 |
| `secrets/<계정>.pw` | 생성된 비밀번호 (600) | 안 한다 |
| `backups/` | 덤프와 이전 설정 | 안 한다 |
| `services/*/db-conf/*.ini` | plug-in 이 선언하는 DB ([declarations.md](declarations.md)) | 그 서비스 |

### 7.1 설치

```bash
cd database
./install_mariadb.sh install      # mariadb-server · client 설치, 서비스 등록·시작. 이미 있으면 중단
./install_mariadb.sh status       # 버전·서비스·포트 (sudo 로 부르면 DB 목록·크기·사용자까지)
./install_mariadb.sh update       # 패키지만 업그레이드 (확인 후, 버전이 바뀌면 mariadb-upgrade)
```

root 는 `unix_socket` 인증이라 비밀번호 없이 `sudo mariadb` 로 붙습니다. 배포판 기본은
22.04 가 10.6, 24.04 가 10.11 입니다. **10.6 은 2026-07-06 에 커뮤니티 지원이 끝났으므로**
22.04 에서는 MariaDB 11.4 저장소를 먼저 추가하길 권합니다
([install.md](install.md) 2.1). 저장소를 추가한 뒤에는 `install` 이 11.4 를 설치합니다
(apt 가 가장 높은 후보를 고릅니다).

### 7.2 적용 — `setup_mariadb.sh`

```bash
sudo ./setup_mariadb.sh --dry-run     # 무엇이 바뀌는지만
sudo ./setup_mariadb.sh               # 적용 (서버 설정이 바뀌면 재시작 전에 묻습니다)
sudo ./setup_mariadb.sh --yes         # 묻지 않고
sudo ./setup_mariadb.sh --no-restart  # 설정 파일만 쓰고 재시작하지 않음
```

순서는 이렇습니다.

1. `[server]` 와 `settings.ini` 로 `/etc/mysql/mariadb.conf.d/99-project.cnf` 를 만듭니다.
   쓰기 전에 모든 키를 `mariadbd --verbose --help` 의 옵션 목록과 대조해, 오타가 있으면
   쓰지 않고 멈춥니다(10.6 에는 `--validate-config` 가 없습니다).
2. `[security]` — 익명 사용자 · test DB · 원격 root 를 지웁니다.
3. `[database:*]` 를 만들고(있으면 건너뜀) `schema_dir` 의 `*.sql` 을 이름순으로 실행합니다.
4. `[user:*]` 를 만들거나 갱신하고 권한을 줍니다.
5. `services/*/db-conf/*.ini` 를 훑어 plug-in DB 와 전용 계정을 같은 방식으로 적용합니다.
6. 서버 설정이 바뀐 경우에만 재시작합니다. 재시작 전에 연결된 클라이언트 수를 보여
   주고, 새 설정으로 서버가 뜨지 않으면 이전 설정으로 되돌리고 다시 시작합니다.

**추가와 갱신만 합니다.** ini 에 없는 DB 나 사용자를 지우지 않습니다. 스키마 디렉터리가
없는 DB 가 있어도 중간에 멈추지 않고 끝에서 모아 알린 뒤 종료 코드 1 로 끝납니다 —
예전에는 그 자리에서 멈춰 "설정 파일은 새 값인데 서버는 옛 값" 인 상태가 만들어졌습니다.

### 7.3 장비마다 다른 세 값

`database.ini` 는 커밋되므로 장비 값을 적으면 다음 `git pull` 과 부딪히거나 다른 단지로
딸려 갑니다. 그래서 셋만 `database/settings.ini` 가 갖습니다(마법사 `database.schema`
의 폼이 씁니다). 아무 데도 적지 않으면 스키마 기본값을 씁니다.

| 키 | 기본 | 주의 |
|---|---|---|
| `bind_address` | `127.0.0.1` | 여는 것은 장비별 결정입니다. `0.0.0.0` 으로 열면 방화벽으로 범위를 좁히세요 |
| `port` | `3306` | 바꾸면 이 DB 에 붙는 서비스의 접속 설정도 같이 바꿔야 합니다 |
| `innodb_buffer_pool_size` | `256M` | 물리 메모리보다 크게 잡으면 MariaDB 가 뜨지 않습니다(자동 롤백) |

예전 장비에서 올라와 `database.ini` 의 `[server]` 에 이 셋이 남아 있으면 그 값이 쓰이고,
`setup_mariadb.sh` 가 한 번 `settings.ini` 로 옮겨 담습니다. 옮긴 뒤 `database.ini` 에서
지우세요 — 두 곳에 있으면 점검이 알려 줍니다.

원거리에서 DB 에 닿아야 하면 3306 을 열지 말고 SSH 터널을 씁니다. 꼭 열어야 하는 시험
(예: 다른 PC 의 ODBC 클라이언트)은 7.5 의 '밖에서 붙는 클라이언트' 를 먼저 읽으세요.

```bash
ssh -L 3306:127.0.0.1:3306 <계정>@<서버>
```

### 7.4 데이터베이스와 계정

| DB | 서비스 | 스키마 위치 |
|---|---|---|
| `manager` | manager | `services/manager/schema/` — `administrator` · `admin_audit_log` · `schema_migrations` |

서비스를 붙이면 그 서비스의 `schema_dir` 이나 `db-conf/` 선언으로 DB 가 늘어납니다.
DB 이름에는 하이픈을 쓸 수 없어 서비스 이름의 하이픈은 밑줄로 바꿉니다.

| 계정 | host | 권한 | 쓰는 곳 |
|---|---|---|---|
| `root` | `localhost` 뿐 (`unix_socket`) | 전체 | `sudo` 로 하는 관리 작업 |
| `webservices` (공용) | `localhost, 127.0.0.1` | `manager` 에 ALL | manager · 점검 스크립트 |
| plug-in 전용 계정 | `db-conf` 선언대로 | 그 DB 하나 | 그 plug-in |

공용 계정 하나가 여러 DB 에 ALL 이면 범위를 넓히는 것이 이 계정에서 가장 위험합니다.
접속을 이 장비로 한정한 것은 manager 가 DB 와 같은 장비에서 돌기 때문입니다 — 다른
장비에서 붙어야 하면 7.5 를 보고 필요한 대역만 `host` 에 더합니다.

### 7.5 계정 정책 — "비밀번호가 틀렸다" 의 정체

MariaDB 는 **`user@host` 가 키**입니다. `webservices@localhost` 와 `webservices@127.0.0.1` 은 이름만
같은 별개 계정이고, 하나만 있으면 다른 쪽으로 붙는 순간 거부되는데 그 거부는
"비밀번호가 틀렸다" 로 보입니다. `localhost` 는 유닉스 소켓, `127.0.0.1` 은 TCP 입니다.

- **root 는 소켓으로만** 씁니다. TCP 에 두려면 비밀번호가 필요하고, 그것은 곧 네트워크에서
  시도 가능한 전권 계정입니다. 관리 스크립트는 `--no-defaults --protocol=socket -u root`
  로 붙습니다.
- **스키마 owner 는 세 자리 모두에** 둡니다. 데몬은 소켓, 점검 스크립트와 도구는 TCP,
  다른 장비는 사설 대역에서 붙습니다.
- **옵션 파일이 자격 증명을 가로챕니다.** `~/.my.cnf` 의 `[client]` 에 `password` 나
  `protocol = tcp` 가 있으면 그쪽이 이깁니다. sudo 로 돌면 `HOME` 이 `/root` 라 root 로
  실행할 때만 실패하는 자리가 생깁니다. 자격 증명을 확인하는 코드는 `--no-defaults` 를
  붙입니다.
- **범위를 좁히는 것은 값만 바꿔서는 안 됩니다.** 추가·갱신만 하므로 옛 계정이 남습니다.

```bash
sudo mariadb -e "SELECT user, host FROM mysql.user ORDER BY user, host;"
sudo mariadb -e "DROP USER 'webservices'@'%';"      # 지우기 전에 그 계정으로 붙는 것이 없는지 확인
```

`setup_mariadb.sh` 는 관리자 접속을 차례로 넷까지 시도합니다 — root 소켓(옵션 파일
무시), 기본 옵션 파일, `/etc/mysql/debian.cnf`, 그래도 안 되면 대화형 터미널에서만
계정·비밀번호를 묻습니다.

넷이 다 막혔다면(`sudo mariadb` 가 `ERROR 1045 … (using password: NO)` 로 거부) 서버가
죽은 것이 아니라 `root@localhost` 가 `unix_socket` 인증을 잃은 것입니다.
`/etc/mysql/debian.cnf` 는 22.04 에서 비밀번호 없는 스텁이라 도움이 되지 않습니다.
인증이 열린 채 방치되는 구간이 없는 `--init-file` 로 복구합니다.

```bash
sudo tee /root/mariadb-fix-root.sql >/dev/null <<'SQL'
CREATE USER IF NOT EXISTS 'root'@'localhost' IDENTIFIED VIA unix_socket;
ALTER USER 'root'@'localhost' IDENTIFIED VIA unix_socket;
GRANT ALL PRIVILEGES ON *.* TO 'root'@'localhost' WITH GRANT OPTION;
FLUSH PRIVILEGES;
SQL
sudo systemctl set-environment MYSQLD_OPTS="--init-file=/root/mariadb-fix-root.sql"
sudo systemctl restart mariadb && sudo mariadb -e "SELECT CURRENT_USER();"
sudo systemctl unset-environment MYSQLD_OPTS && sudo systemctl restart mariadb
sudo rm -f /root/mariadb-fix-root.sql
```

**밖에서 붙는 클라이언트 — 출발지는 NAT 뒤에서 달라집니다.** 다른 PC 의 클라이언트를
붙이려고 `bind_address` 를 열고 그 PC 의 IP 로 계정을 만들었는데 `Host '…' is not allowed
to connect to this MariaDB server`(오류 1130)로 거부될 수 있습니다. 서버가 보는 출발지는 PC
의 IP 가 아니라 **그 사이의 NAT/게이트웨이 주소**일 수 있기 때문입니다. 서버 로그가
알려 줍니다.

```bash
sudo journalctl -u mariadb --since '-30min' | grep -i 'aborted connection'
# ... user: 'unauthenticated' host: '_gateway' (closed normally without authentication)
getent hosts _gateway          # 게이트웨이 IP — 이름이 이 주소를 가리킨다
```

`user: 'unauthenticated'` 로 끊긴 접속은 비밀번호가 틀린 것이 아니라 **호스트 단계에서 거절**된
것입니다(비밀번호가 틀리면 `Access denied` 로 남습니다). `host:` 에 찍힌 주소나 이름이
계정의 `host` 와 맞는지 보세요. 한 대만 허용하는 것이 가장 좋지만 출발지를 알 수 없으면
대역(`'계정'@'10.10.0.%'`)으로 허용하고, 시험이 끝나면 닫습니다. 계정을 복제할 때는 기존
계정의 해시를 서버 안에서 옮기면 비밀번호를 다시 입력하지 않아도 됩니다.

```bash
HASH=$(sudo mariadb -N -e "SELECT Password FROM mysql.user WHERE User='<계정>' AND Host='127.0.0.1'")
printf "CREATE USER IF NOT EXISTS '<계정>'@'10.10.0.%%' IDENTIFIED BY PASSWORD '%s';\nGRANT ALL PRIVILEGES ON <DB>.* TO '<계정>'@'10.10.0.%%';\nFLUSH PRIVILEGES;\n" "$HASH" | sudo mariadb; unset HASH
```

방화벽(`ufw`)이 꺼져 있으면 계정의 `host` 가 접근 통제의 전부입니다. 이 방식으로 연 3306 은
`bind-address = 0.0.0.0` 을 별도 설정 파일(`99-temp-remote.cnf` 같은)에 두면 파일 하나를
지우고 재시작해서 닫을 수 있습니다. 단 `99-project.cnf` 와 같은 폴더의 `99-` 파일은 **파일
이름 순서**로 덮이므로 이름에 주의하세요.

### 7.6 비밀번호 — `database/secrets/`

`database.ini` 에는 비밀번호를 쓰지 않습니다.

| 방법 | 선언 | 비밀번호의 자리 |
|---|---|---|
| 자동 생성 (기본) | 아무것도 적지 않음 | `secrets/<계정>.pw` 에 32자 생성 (600). 있으면 그 값을 씀 |
| 파일 지정 | `password_file = ./secrets/appuser.pw` | 그 파일 |
| 환경 변수 | `password_env = APPUSER_PASSWORD` | `sudo APPUSER_PASSWORD='…' ./setup_mariadb.sh` |

다시 실행할 때마다 기존 사용자의 비밀번호를 현재 값으로 다시 설정합니다(`ALTER USER`).
비밀번호를 바꾸려면 `secrets/<계정>.pw` 를 고치고 다시 적용한 뒤, 그 파일을 읽는
서비스를 재시작합니다.

| 파일 | 읽는 곳 |
|---|---|
| `secrets/webservices.pw` | manager (`config.json` 의 `database.passwordFile`) · `check-database.sh` |
| `secrets/<plug-in 계정>.pw` | 그 plug-in (자기 설정에 옮겨 적어야 함) |

### 7.7 스키마 파일 작성 규칙

스키마 SQL 은 각 서비스 디렉터리가 소유합니다. `setup_mariadb.sh` 는 매번 `schema_dir`
의 모든 `*.sql` 을 이름순으로 실행하므로 **여러 번 실행해도 안전하게** 씁니다
(`CREATE TABLE IF NOT EXISTS`, `INSERT IGNORE`, 기존 표를 바꿀 때는 `ALTER` 를 고치지
말고 번호를 붙인 새 파일). 번호가 실행 순서를 고정합니다.

서비스가 자기 마이그레이션 도구로 같은 파일을 적용하는 경우(각 파일이 마지막 줄에
`schema_migrations` 기록을 남기고 안 된 것만 돌리는 방식)에도 어느 길로 가도 결과가
같도록 파일은 멱등이어야 합니다.

이미 있는 DB 의 문자셋은 바꾸지 않습니다. 필요하면 직접 `ALTER DATABASE` 를 합니다.

### 7.8 점검 · 백업 · 제거

```bash
./check-database.sh          # 서비스 · 99-project.cnf 가 선언과 같은지 · 계정 로그인 · 스키마
./check-database.sh --check --json
```

점검은 **공용 계정으로 TCP** 로 붙습니다. root 소켓 인증을 쓰면 sudo 가 필요해져
마법사에서 늘 "확인 불가" 가 되기 때문입니다.

```bash
sudo mariadb-dump --all-databases --single-transaction --routines --events | gzip > backup.sql.gz
gunzip -c backup.sql.gz | sudo mariadb
./install_mariadb.sh uninstall   # 패키지만 제거, /var/lib/mysql 유지 (덤프 후 'uninstall' 입력)
./install_mariadb.sh purge       # 데이터까지 삭제 (덤프 후 'DELETE ALL DATA' 입력)
```

서버가 정말 죽었는지는 `systemctl is-active mariadb` · `ss -ltn | grep 3306` ·
`sudo journalctl -u mariadb -n 50` 로 가립니다. 로그의 `Access denied` 줄은 누군가
접속을 시도했다가 거부된 기록이지 장애가 아닙니다.

### 7.9 MySQL 8.0 에서 MariaDB 로 옮기기

이미 MySQL 8.0 이 도는 장비에 이 저장소를 올릴 때의 순서입니다. 2026-10-16 에 Ubuntu
22.04 의 MySQL 8.0.46 에서 MariaDB 11.4.13 으로 옮기며 확인했습니다(옮긴 DB 하나, 7개
테이블, 약 1만 행). **제자리 전환은 되지 않습니다** — 두 패키지는 apt 에서 충돌하고
데이터 파일 형식도 다르므로 덤프로 옮깁니다.

**먼저 범위를 정합니다.** 서버에 있는 DB 를 전부 옮길 이유가 없습니다. 실제로 쓰는 것만
옮기세요. 앱의 DB 접속 설정과 지금 붙어 있는 연결을 봅니다.

```bash
ss -tn state established '( sport = :3306 )'      # 누가 붙어 있나 (127.0.0.1 말고 있는지)
sudo mysql -N -e "SELECT user,host,plugin FROM mysql.user WHERE user NOT LIKE 'mysql.%'"
```

**MariaDB 가 읽지 못하는 것.** 덤프를 그대로 넣으면 실패하거나 엉뚱하게 실행되는 자리입니다.
`database/convert-for-mariadb.sh in.sql out.sql` 이 고치고, 남은 위험 요소를 센 보고서를 냅니다.

| MySQL 8 덤프에 있는 것 | 왜 문제인가 | 변환 |
|---|---|---|
| `/*!80016 DEFAULT ENCRYPTION='N' */` 같은 `/*!8xxxx … */` | MariaDB 는 자기 버전 번호(11.4 는 110400)가 더 크다고 보고 이 주석을 **실행하려 들어** 구문 오류가 납니다 | 제거 |
| `utf8mb4_0900_ai_ci` · `_as_cs` · `_as_ci` | MariaDB 에 없는 콜레이션(`Unknown collation`) | 11.3+ 는 `utf8mb4_uca1400_ai_ci` 등. 10.x 는 `utf8mb4_unicode_ci` 로 바꿔야 합니다 |
| `utf8mb4_0900_bin` | 위와 같음 | `utf8mb4_bin` |
| `SET @@GLOBAL.GTID_PURGED` | MariaDB 의 GTID 는 형식이 다름 | 제거 (`--set-gtid-purged=OFF` 로 덤프하면 처음부터 없음) |

`utf8mb3` · `eucjpms` 같은 문자셋은 MariaDB 도 지원해서 그대로 들어갔습니다. 이번 DB 에는
JSON 컬럼 · 프로시저 · 트리거 · 이벤트가 없었으므로 **그것들은 이 절차로 검증되지 않았습니다.**
있으면 복원 뒤에 하나씩 동작을 확인하세요(MariaDB 의 JSON 은 LONGTEXT 별칭입니다).

**A. 준비 — 서비스를 멈추지 않고 합니다.**

```bash
# 1) 계정 · 권한 · 행 수를 적어 둔다 (옮긴 뒤 대조용)
sudo mysql -N -e "SHOW GRANTS FOR '<앱 계정>'@'<host>'"
sudo mysql -N -e "SELECT table_name FROM information_schema.tables WHERE table_schema='<DB>' AND table_type='BASE TABLE' ORDER BY 1" \
  | while read t; do printf "%s\t%s\n" "$t" "$(sudo mysql -N -e "SELECT COUNT(*) FROM <DB>.\`$t\`")"; done > rowcounts.before.txt
# 2) 덤프하고 변환한다
sudo mysqldump --databases <DB> --single-transaction --routines --events --triggers --set-gtid-purged=OFF > db.mysql.sql
database/convert-for-mariadb.sh db.mysql.sql db.mariadb.sql
# 3) MariaDB 저장소를 추가한다 (install.md 2.1) — 설치는 아직 하지 않는다
```

**B. 컷오버 — 앱을 멈춘 뒤 합니다.** 이 순서를 바꾸지 마세요. 덤프와 데이터 폴더 보존이
앞이고 패키지 제거가 뒤입니다.

1. 앱을 멈춥니다 (`pm2 stop <앱>`). `ss` 로 3306 의 연결이 0 인지 봅니다.
2. **최종 덤프**를 다시 받고 변환합니다 (A-2). 행 수를 다시 적습니다.
3. MySQL 을 멈추고 **데이터 폴더를 이름만 바꿔 보존**합니다.
   `sudo systemctl disable --now mysql && sudo mv /var/lib/mysql /var/lib/mysql.mysql8-bak`
4. MySQL 패키지를 제거합니다. 먼저 시뮬레이션으로 목록을 봅니다 —
   **`apt-get -s purge` 는 제거 대상을 `Remv` 가 아니라 `Purg` 로 표시합니다.**
   `apt-get -s purge … | grep -E '^(Purg|Remv)'`. `autoremove` 는 MariaDB 를 올린 뒤로 미룹니다
   (먼저 하면 MariaDB 가 쓸 라이브러리를 지웠다 다시 깝니다).
5. `sudo apt install -y mariadb-server mariadb-client` — 22.04 에서는 저장소를 추가한 뒤.
   `ss -tln | grep 3306` 이 `127.0.0.1:3306` 이어야 합니다 (MariaDB 의 기본은 로컬만).
6. 복원합니다. 덤프가 `DROP TABLE IF EXISTS` 로 시작해서 **여러 번 실행해도 안전**합니다.
   `sudo mariadb < db.mariadb.sql 2> restore.err; echo rc=$?; cat restore.err`
7. 앱 계정을 **새로 만듭니다.** MySQL 8 의 `caching_sha2_password` 는 MariaDB 에 없으므로
   `mysql_native_password` 로 만듭니다. 이 장비에서는 앱이 `127.0.0.1` 로 붙으므로
   `localhost` 와 `127.0.0.1` 두 자리를 다 만들고, 권한은 그 DB 하나로 좁힙니다
   (예전 계정이 서버 전체 권한에 `%` 였더라도 옮기지 마세요).

   ```bash
   read -rs -p '비밀번호: ' PW; echo
   printf "CREATE USER IF NOT EXISTS '<앱 계정>'@'localhost' IDENTIFIED VIA mysql_native_password USING PASSWORD('%s');\nCREATE USER IF NOT EXISTS '<앱 계정>'@'127.0.0.1' IDENTIFIED VIA mysql_native_password USING PASSWORD('%s');\nGRANT ALL PRIVILEGES ON <DB>.* TO '<앱 계정>'@'localhost', '<앱 계정>'@'127.0.0.1';\nFLUSH PRIVILEGES;\n" "$PW" "$PW" | sudo mariadb 2>&1; echo "rc=${PIPESTATUS[1]}"; unset PW
   ```

   비밀번호에 `'` 나 `\` 가 있으면 이 방법은 쓰지 마세요.
8. **행 수를 대조합니다.** MariaDB 에서 같은 방식으로 세어 2번의 기록과 `diff` 합니다.
   출력이 없어야 합니다. 테이블 이름 목록도 같아야 합니다.
9. 앱을 켭니다 (`pm2 start <앱>`) 그리고 **앱이 실제로 DB 를 읽는 요청**으로 확인합니다.
   연결 풀은 첫 요청 때 연결하므로 `3306` 연결 수 0 은 아직 판정이 아닙니다.

**되돌리기.** 6~9 에서 막히면: 앱을 멈추고 `sudo apt purge -y 'mariadb-*'`, 새로 생긴
`/var/lib/mysql` 을 치우고 `/var/lib/mysql.mysql8-bak` 을 `/var/lib/mysql` 로 되돌린 뒤
MySQL 서버를 다시 설치합니다. **같은 8.0 패치 버전**을 깔아야 합니다 — 배포판의
`mysql-server` 가 같은 번호(8.0.46)인지 `apt-cache policy mysql-server` 로 먼저 봅니다.
데이터 폴더 보존 전에 이 전환을 시작하지 마세요.

**실제로 겪은 사고 — 순서를 건너뛴 purge.** 위 B-3 과 덤프 없이 4번의 `purge` 만 먼저
실행되어 MySQL 서버 · 클라이언트가 한꺼번에 사라진 적이 있습니다(`mysqldump` 도 함께).
`/var/lib/mysql` 은 남아 있어서 복구했습니다.

1. 앱을 멈추고 데이터 폴더를 **냉동 복사**합니다 (`sudo cp -a /var/lib/mysql <백업>`, 크기 대조).
2. 배포판 `mysql-server` 를 설치해 그 데이터 폴더로 기동합니다. MariaDB 저장소가 이미 있으면
   `mysql-common` 을 가로채서 설정이 실패합니다 — `sudo apt install --allow-downgrades
   mysql-common=5.8+1.0.8 && sudo dpkg --configure -a` 로 풀립니다.
3. 최종 덤프를 받고 B-3 부터 다시 합니다.

여러 줄 명령(`<<EOF` 히어 도큐먼트)을 붙여 넣는 터미널에서 줄이 끊겨 일부만 실행되는 일도 있었습니다.
위의 `printf … | sudo mariadb` 처럼 한 줄로 쓰면 그런 일이 없습니다.

---

## 8. 공유 세션 시크릿 — `services/.session-secret`

로그인은 manager 한 곳에서만 합니다. 세션 쿠키는 `Path=/` 로 발급되고, 대시보드들
(kamailio · janus · coturn · websocket-relay)은 같은 시크릿으로 그 쿠키의 HMAC 을
검증합니다.

- manager 가 처음 뜰 때 `services/.session-secret` 이 없으면 32바이트 난수로 만듭니다
  (600, git 제외). 쓰지 못하면 임시 시크릿으로 돌고, 그러면 재시작마다 세션이 끊기고
  대시보드가 세션을 검증하지 못합니다.
- 경로는 `SESSION_SECRET_FILE` 환경 변수로 바꿀 수 있습니다. 바꾸면 모든 서비스에 같게
  줘야 합니다.
- manager 의 `config.json` 에 `sessionSecret` 을 적거나 `MANAGER_SESSION_SECRET` 을 주면
  manager 만 그 값을 쓰고 다른 대시보드는 파일을 읽으므로 **SSO 가 깨집니다.** 비워 둡니다.
- 파일을 지우거나 바꾸면 모든 로그인 세션이 끊깁니다. 다시 로그인하면 됩니다.

---

## 9. 저장소를 옮길 때

저장소 안에는 절대 경로를 적어 두지 않습니다. 스크립트는 전부 자기 위치 기준이고,
`pm2/ecosystem.config.js` 도 실행 시점에 경로를 계산합니다. 절대 경로가 **박혀서
남는** 곳은 저장소 밖입니다. 디렉터리를 옮기거나 이름을 바꿨다면 다음을 다시 만듭니다.

| 박히는 곳 | 다시 만드는 법 |
|---|---|
| 사용자 crontab 의 `@reboot` 줄 (`pm2-boot.sh` 경로) | 6.4 의 `echo` 로 새 줄을 만들어 `crontab -e` |
| pm2 가 들고 있는 앱 정의와 `~/.pm2/dump.pm2` (`cwd` · `script`) | `node pm2/ecosystem.config.js --check` 가 앱마다 알려 주는 대로 지우고 다시 띄운 뒤 `pm2 save` |
| `/etc/nginx/conf.d/path-routing.conf` (사설 인증서 · `client_ca` 경로) | `sudo nginx/install_nginx_stack.sh --skip-install` |
| `/etc/systemd/system/janus-public-ip.service` (`check-public-ip.sh` 경로) | `cd services/janus && sudo ./install.sh --apply` |
| `check-dns.sh` 크론 줄을 걸어 두었다면 그 경로 | `crontab -e` |
| manager `config.json` 의 `database.passwordFile` 등을 절대 경로로 바꿔 두었다면 | 상대 경로(`../../database/secrets/webservices.pw`)로 되돌림 |

옮긴 뒤에는 이것으로 확인합니다.

```bash
./check-all.sh
node pm2/ecosystem.config.js --check
crontab -l
```

실제로 예전에 디렉터리를 옮기면서 crontab 경로가 그대로 남아 재부팅 복원이 끊긴 적이
있습니다. 증상은 재부팅 전까지 없습니다.
