# 포트 안내

nginx · MariaDB · manager 가 한 장비에서 같이 돌기 때문에 포트가 여러 곳에 흩어져
있습니다. 이 문서는 그 전체 그림과, 공유기에서 무엇을 열어야 하는지, 포트를
바꾸려면 어디를 고쳐야 하는지를 정리합니다.

숫자의 **최신값**은 manager 대시보드의 **포트 지도**(`/manager/port-map`)가 더
정확합니다. 그 화면은 각 서비스의 `settings.ini`(없으면 `settings-schema.json`
기본값)와 `nginx-conf/*.ini` 를 요청할 때마다 다시 읽습니다. 이 문서는 그 값들의
뜻과 바꾸는 법을 설명합니다.

## 1. 한눈에 보기

| 부류 | 어디서 받나 | 공유기 포워딩 |
|---|---|---|
| 웹 입구 (80 · 443) | 모든 인터페이스 — nginx | 공인 인증서로 밖에서 접속하면 필요 |
| 내부 포트 (manager 28084, MariaDB 3306) | 127.0.0.1 | 필요 없음 — 밖에서 닿지 않아야 함 |

웹으로 드러나는 것은 전부 443 하나로 들어와 nginx 가 경로로 나눕니다. 서비스가
TLS 를 직접 다루지 않고, nginx 가 TLS 를 끊은 뒤 루프백의 평문 HTTP 로 넘깁니다.

## 2. 밖에서 들어오는 포트

### 웹 (nginx)

| 포트 | 프로토콜 | 무엇 | 선언 위치 |
|---|---|---|---|
| 80 | TCP | HTTP. 전부 HTTPS 로 301 하되 Let's Encrypt HTTP-01 챌린지(`acme_webroot`)만 평문으로 응답 | `nginx/nginx-stack.conf` 의 `listen_port` |
| 443 | TCP | HTTPS. 모든 웹 · 대시보드 · API | `nginx/nginx-stack.conf` 의 `ssl_port` |

443 뒤에 있는 공개 경로는 각 서비스의 `nginx-conf/*.ini` 가 정합니다.

| 공개 경로 | 넘기는 곳 | 비고 |
|---|---|---|
| `/` | 302 → `/manager` | `nginx-stack.conf` 의 `default_route` |
| `/manager` | 127.0.0.1:28084 | 관리 대시보드 · 구축 마법사 · 문서 |

`public_http_port` · `public_https_port` 는 공유기가 바깥 포트를 다른 번호로 바꿔
넘길 때만 채웁니다. 표준 포트(80 · 443)를 그대로 넘기면 비어 있는 것이 정상입니다.

## 3. LAN 안에서만 쓰는 포트

이 판에는 없습니다. LAN 전용 포트(SIP · 미디어 릴레이 등)는 통화 시스템 서비스가
쓰던 것이라 함께 덜어 냈습니다. 서비스를 붙여 그런 포트가 생기면 이 절에 적습니다.

## 4. 내부 HTTP 포트 — 28080번대

서비스가 루프백에서 받는 평문 HTTP 포트입니다. 전부 `127.0.0.1` 이고 nginx 만 닿습니다.

| 포트 | 서비스 | 선언 위치 |
|---|---|---|
| 28084 | manager | `services/manager/nginx-conf/service.ini` 의 `ports`, `pm2-conf/app.ini` 의 `PORT`, `config.json` 의 `port` |

새 서비스는 28080번대에서 비어 있는 번호를 고릅니다. 포트 지도의 "내부 HTTP 포트"
표가 지금 쓰는 번호를 보여 줍니다.

MariaDB(3306)도 루프백입니다. 열 주소와 포트는 `database/settings.ini` 의
`bind_address` · `port` 로 정하며 기본값은 `127.0.0.1` · `3306` 입니다. 다른 장비에서
붙어야 하면 `bind_address` 와 `database.ini` 의 사용자 `host` 를 함께 고칩니다.

## 5. 공유기 포트 포워딩

밖에서 접속하려면 공유기에서 아래 두 포트를 이 장비로 넘깁니다.

| 프로토콜 | 포트 | 목적 |
|---|---|---|
| TCP | 80 | HTTP (Let's Encrypt 갱신 · 리다이렉트) |
| TCP | 443 | HTTPS — manager 와 모든 웹 · 대시보드 · API |

여기 없는 포트는 전부 LAN 전용이거나 루프백 전용입니다. 구축 마법사가 묻는
포워딩 확인 질문과 포트 지도의 체크리스트는 이 표와 **같은 목록**입니다.

## 6. 포트를 바꿀 때

| 바꾸려는 것 | 고칠 곳 |
|---|---|
| nginx 80 / 443 | `nginx/nginx-stack.conf` 의 `listen_port` · `ssl_port` 후 `sudo ./nginx/install_nginx_stack.sh --skip-install` |
| manager 28084 | `nginx-conf/service.ini` 의 `ports`, `pm2-conf/app.ini` 의 `PORT`, `config.json` 의 `port` — **셋이 같아야** 합니다. 이후 nginx 반영과 `npm run restart` |
| MariaDB 열 주소 · 포트 | `database/settings.ini` 후 `sudo ./database/setup_mariadb.sh`. 이 DB 에 붙는 서비스의 접속 설정도 같이 바꿉니다 |

## 7. 포트 지도 화면이 읽는 곳

`/manager/port-map` 은 값을 저장하지 않고 요청마다 다시 읽습니다.

- 내부 HTTP 포트: 각 서비스의 `nginx-conf/*.ini` (`services/manager/server/src/services/port-map.js` 의 `internalHttpRows`).
- 공유기 체크리스트: 80 · 443 은 고정값이고, 서비스가 UDP 대역 같은 포트를 가지면
  `port-map.js` 의 `rtpRows` · `controlRows` 에 행을 추가해 `forwarded: true` 로 표시합니다.
  이 판에서는 두 함수가 비어 있어서 화면의 해당 카드도 보이지 않습니다.
- 값을 `settings.ini` 에서 읽어야 하는 포트는 저장소 공용 구현(`lib/settings.js`)을 씁니다.
  스키마를 두 번 구현하면 언젠가 갈라지기 때문입니다 (`docs/guide/contracts.md` '설정 규약').
