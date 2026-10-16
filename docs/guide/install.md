# 빈 장비에 설치하기

빈 우분투 장비에서 시작해 구축 마법사를 끝내고 `./check-all.sh` 가 초록이 되기까지의
절차입니다. 순서는 다음과 같습니다.

```
장비 밖 준비 → 장비·브랜치 고르기 → git clone → ./bootstrap.sh
  → node 20 (install-node.sh) → pm2 (install_pm2.sh) → ./bootstrap.sh --apply
  → 브라우저로 /manager/setup → 마법사 9단계 → ./check-all.sh
```

각 스크립트가 무엇을 만지는지(nginx 생성기, 인증서, pm2 부팅 복원, MariaDB 계정)의
자세한 내용은 [infrastructure.md](infrastructure.md) 에 있습니다. 이 장은 **순서와
각 자리에서 사람이 할 일**에 집중합니다.
---

## 1. 시작하기 전에 — 장비 밖에서 준비할 것

공인 인증서로 밖에서 접속하게 하려면 이 장비 안에서 만들 수 없는 것이 있습니다.
도메인 등록기관과 공유기 관리 화면에서 받아 오거나 설정해야 합니다. 이것들은 마법사의
해당 단계에 가서야 "없습니다" 로 드러나고, 그때 받으러 가면 하루가 끊깁니다(도메인
전파). CGNAT 회선이면 아예 받을 수 없습니다. **LAN 안에서만 쓴다면 아래 표에서 장비와
sudo 만 있으면 됩니다.**

| 준비물 | 공인 인증서(배포용) | LAN 전용 | 어디서 받나 | 어디에 넣나 | 없으면 |
|---|---|---|---|---|---|
| 우분투 장비, sudo, 설치 중 인터넷 | 필수 | 필수 | — | — | 설치 불가 |
| 소유한 도메인 + A 레코드 | 필수 | 불필요 | 등록기관 | 마법사 `site.settings` 의 `host` | 공인 인증서 불가 |
| 밖에서 80·443 이 열리는 공인 IP (CGNAT 아님) | 필수 | 불필요 | 회선 | 공유기 포워딩 | 인증서 발급(80)·접속(443) 불가 |
| 공유기 관리 권한 (80·443) | 필수 | 불필요 | 공유기 | 포워딩 | 밖에서 접속 불가 |
| 인증서 알림 메일 | 권장 | 불필요 | 자기 것 | `nginx/public_ca/settings.ini` | 아래 1.4 참고 |

공인 인증서로 가려면 도메인과 열리는 공인 IP 는 **대체 수단이 없습니다.** 못 갖추면
LAN 전용(`tls_mode = private`)으로 세우고, 나중에 `site.settings` 값을 바꿔 공인으로
옮길 수 있습니다(1.5).

### 1.1 인터넷 — 설치하는 동안

프록시나 방화벽이 있는 현장이면 다음을 미리 열어 둡니다.

| 무엇 | 어디서 | 누가 받나 |
|---|---|---|
| Node.js 20 | `deb.nodesource.com` | `install-node.sh` |
| mariadb · nginx · certbot | 배포판 apt 미러 | `install_mariadb.sh` · `install_nginx_stack.sh` |
| MariaDB 11.4 (권장, 2절) | `deb.mariadb.org`, `mariadb.org` | 사람이 저장소를 추가 |
| npm 패키지 | `registry.npmjs.org` | manager 의 `npm install` |

### 1.2 도메인과 A 레코드

소유한 도메인이어야 합니다. 공유기 DDNS 이름(`*.iptime.org`)은 그 존에 레코드를
만들 권한이 없어 Let's Encrypt 가 발급하지 않습니다.

1. 이름은 자유롭게 정합니다 (예: `manager.example.com`). 이 장비 하나에 이름 하나 ·
   인증서 하나이고 와일드카드로 묶지 않습니다.
2. 등록기관에서 그 이름의 **A 레코드**를 이 서버의 공인 IP 로 만듭니다. TTL 은
   600초 정도로 짧게 둡니다 — 유동 IP 회선에서 바뀌었을 때 빨리 퍼지게.
3. 확인합니다.

```bash
curl -s ifconfig.me          # 이 서버의 공인 IP
dig +short A <이름>          # 같은 값이 나와야 합니다
```

이 이름을 마법사 `site.settings` 의 `host` 에 넣으면 nginx `server_name` 과 인증서 이름이
여기서 나옵니다.

> 유동 IP 회선이면 A 레코드를 따라가는 장치가 없습니다. IP 가 바뀌면 접속이 즉시
> 안 되고 인증서 갱신도 조용히 실패합니다. 마법사 `public_ca.dns` 단계가 크론
> 예시를 줍니다 ([infrastructure.md](infrastructure.md) '유동 IP').

### 1.3 공유기 포워딩

전체 목록과 이유는 [../ports.md](../ports.md) 의 포워딩 체크리스트가 기준이고,
manager 의 **포트 지도** 화면이 실물 설정에서 같은 목록을 만듭니다. light 판은 둘뿐입니다.

| 프로토콜 | 포트 | 용도 |
|---|---|---|
| TCP | 80 | Let's Encrypt HTTP-01 검증(반드시 80), HTTPS 리다이렉트 |
| TCP | 443 | manager 와 모든 웹 화면 |

80 을 열 수 없는 회선이면 HTTP-01 이 불가능하고 DNS-01 로 가야 하는데, 이 저장소는 아직
DNS-01 절차를 갖고 있지 않습니다. **MariaDB(3306)는 포워딩하지 않습니다** — 기본으로
`127.0.0.1` 에서만 받습니다.

### 1.4 인증서 알림 메일

`nginx/public_ca/settings.ini` 의 `email` 입니다. certbot 계정 등록에 쓰입니다.

> Let's Encrypt 는 2025년에 만료 알림 메일 발송을 끝낸다고 공지했습니다. 이 메일에
> 기대지 말고 `renew-status.sh` · 대시보드 TLS 카드로 갱신을 확인하세요
> ([infrastructure.md](infrastructure.md) '갱신은 어떻게 도나').

### 1.5 LAN 전용과 공인 인증서 — 같은 마법사, 갈리는 자리

따로 된 안내서는 없습니다. 같은 마법사를 같은 순서로 돌고, 갈리는 것은
`site.settings` 에 넣는 값과 선택 단계를 하느냐입니다.

| 마법사 단계 | LAN 전용 | 공인 인증서 |
|---|---|---|
| `site.settings` | `host` 는 LAN 에서 풀리는 아무 이름, **`tls_mode = private`** | `host` 는 소유 도메인의 이름, `tls_mode = auto` |
| `tls.decide` | 사설 CA 로 통과 (`nginx/generate_certs.sh --auto <host>`) | 공인으로 간다고 정하고 지나감 (발급은 `public_ca.issue`) |
| `public_ca.*` 넷 | 건너뜀 | 전부 |

사설 CA 로도 TLS 는 돕니다. 다만 브라우저가 그 CA 를 믿게 만들어야 경고가 사라집니다.
LAN 전용에서 공인으로 옮기려면 `site.settings` 값을 바꾸고 `public_ca.issue` 부터 하면
됩니다.

---

## 2. 장비와 브랜치

| 장비 | 받을 브랜치 | MariaDB (배포판 기본) |
|---|---|---|
| Ubuntu 22.04 | `light` | 10.6 — **지원이 끝났습니다** (아래) |
| Ubuntu 24.04 | `light` | 10.11 — 2028-02 까지 |

자원은 CPU 1~2코어 · RAM 2GB · 디스크 10GB 이상이면 됩니다(빌드할 서비스가 manager 하나).
systemd 가 도는 환경이어야 합니다(nginx · MariaDB 가 systemd 유닛). VM 이나 LXD 는 되고,
Docker 는 권하지 않습니다.

```bash
sudo apt update && sudo apt install -y git curl
git clone -b light <이 저장소 주소> webservices
cd webservices
```

디렉터리 위치는 어디든 됩니다. 다만 나중에 옮기면 몇 군데 절대 경로가 남으므로
처음부터 자리를 정해 두는 편이 낫습니다 ([infrastructure.md](infrastructure.md)
'저장소를 옮길 때').

### 2.1 MariaDB 버전 — 22.04 는 저장소를 추가합니다

22.04 의 배포판 MariaDB 는 10.6 인데 **10.6 은 2026-07-06 에 커뮤니티 지원이
끝났습니다** (마지막 릴리스 10.6.28). 지원 중인 LTS 는 10.11(2028-02 까지) · 11.4(2029-05
까지) · 11.8(2028-06 까지)이고 22.04 에서는 MariaDB 자체 저장소에서 받아야 합니다
([MariaDB 공지](https://mariadb.org/mariadb-server-10-6-reaches-end-of-life-on-july-6th/),
[일정](https://www.endoflife.date/mariadb)). **11.4 를 권합니다.** 아래는 22.04 에서
확인한 절차입니다(2026-10, 11.4.13).

```bash
sudo install -d -m 0755 /etc/apt/keyrings
sudo curl -fsSL -o /etc/apt/keyrings/mariadb-keyring.pgp https://mariadb.org/mariadb_release_signing_key.pgp
gpg --show-keys --with-fingerprint /etc/apt/keyrings/mariadb-keyring.pgp | sed -n 1,2p
```

첫 줄 아래의 지문이 `177F 4010 FE56 CA33 3630 0305 F165 6F24 C74C D1D8` 과 같아야 합니다.
이 키는 만료일이 없습니다. 다르면 멈추고 알아보세요. 같으면 저장소를 켭니다.

```bash
echo 'deb [signed-by=/etc/apt/keyrings/mariadb-keyring.pgp] https://deb.mariadb.org/11.4/ubuntu jammy main' | sudo tee /etc/apt/sources.list.d/mariadb.list
sudo apt update && apt-cache policy mariadb-server | sed -n 1,4p     # Candidate: 1:11.4.x+maria~ubu2204
```

24.04 는 배포판 10.11 로도 지원 안에 있어 저장소가 필요 없습니다. 11.4 를 쓰려면 위
줄의 `jammy` 를 `noble` 로 바꾸되, 이 저장소는 22.04 에서만 확인했습니다.

> **주의 — 같은 장비에 MySQL 도 있으면 이 저장소가 `mysql-common` 을 가로챕니다.**
> MariaDB 저장소도 `mysql-common` 이라는 패키지를 내놓는데 버전이 `1:11.4…` 라 배포판의
> `5.8+1.0.8` 보다 높게 평가됩니다. 이 상태에서 배포판 `mysql-server` 를 깔면
> `/usr/share/mysql-common/configure-symlinks: No such file or directory` 로 설정이 실패합니다.
> `sudo apt install --allow-downgrades mysql-common=5.8+1.0.8 && sudo dpkg --configure -a` 로
> 풀립니다. MySQL 을 MariaDB 로 옮기는 장비라면 [infrastructure.md](infrastructure.md) 7.9 의
> 순서를 따르세요 — MySQL 을 먼저 지우고 MariaDB 를 설치합니다.

---

## 3. `bootstrap.sh` — 마법사까지 가는 길

```bash
./bootstrap.sh            # 안내 셸
./bootstrap.sh --check    # 보고서만. 아무것도 바꾸지 않음
./bootstrap.sh --apply    # sudo 없이 되는 준비를 한 번에
```

`bootstrap.sh` 가 하는 일은 **manager 하나를 세우는 것까지**입니다. 실제 설치
(MariaDB · nginx · 인증서)는 sudo 가 필요하고 장비마다 값이 다르며
순서가 있어서 마법사가 단계별로 안내합니다. `bootstrap.sh` 자신은 sudo 를 쓰지
않습니다 — 필요한 자리에서는 명령을 알려 주고 멈춥니다.

**안내 셸.** 인자 없이 터미널에서 부르면 평소 bash 가 하나 뜨고, 화면 위 여덟 줄이
고정되어 지금 상태와 **다음에 칠 명령 하나**(노란 바탕)를 보여 줍니다. 명령이
끝나 프롬프트가 돌아올 때마다 위 칸이 다시 계산됩니다. 나가려면 `exit` 입니다.
터미널이 아니거나 스크롤 영역을 지원하지 않는 터미널이면 `--check` 보고서로
대신합니다.

위 칸의 한 줄 요약은 `node · npm · pm2 · nginx · MariaDB · 의존성 · 화면 · 비밀번호 · 기동`
이고, 칠 명령은 차례로 다섯입니다.

| 순서 | 명령 | 하는 일 |
|---|---|---|
| 1 | `sudo ./install-node.sh --apply` | NodeSource 에서 node 20 설치 (4절) |
| 2 | `./pm2/install_pm2.sh install` | pm2 전역 설치 (5절) |
| 3 | `sudo apt-get install -y nginx` | nginx 설치만 — 라우트·인증서 설정은 마법사 (9절) |
| 4 | `sudo ./database/install_mariadb.sh install` | MariaDB 설치만 — DB·계정은 마법사 (2.1 의 저장소를 먼저) |
| 5 | `./bootstrap.sh --apply` | manager 의존성 · 화면 빌드 · 관리자 콘솔 비밀번호 · pm2 기동 (6절) |

다섯이 끝나면 위 칸이 마법사 주소로 바뀝니다.

---

## 4. Node.js 20

모든 서비스가 node 로 돌고, manager 는 `fetch` 와 `AbortSignal.timeout` 을
씁니다. 그 아래 버전에서는 설치도 `npm install` 도 지나간 다음 **띄우는 순간**
`fetch is not defined` 로 죽습니다. 그래서 `bootstrap.sh` 가 20 미만을 미리 막습니다.
배포판 기본값은 22.04 가 12, 24.04 가 18 이라 **어느 쪽도 그대로는 안 됩니다.**

```bash
./install-node.sh                 # 점검만 — 지금 node, 부딪히는 패키지, 저장소 상태
sudo ./install-node.sh --apply    # 설치. 지울 패키지가 있으면 먼저 보여 주고 묻습니다
sudo ./install-node.sh --apply -y # 묻지 않고 진행
sudo ./install-node.sh --remove   # 되돌리기
NODE_MAJOR=22 sudo -E ./install-node.sh --apply   # 20 보다 올리고 싶을 때
```

**NodeSource 를 쓰고 nvm 은 쓰지 않습니다.** pm2 는 재부팅 뒤 systemd 나 cron 이
되살리는데, 둘 다 로그인 셸이 아니라 `~/.bashrc` 를 읽지 않습니다. nvm 은 바로
거기에 `PATH` 를 심으므로 **터미널에서는 node 20 이 보이는데 재부팅하면 서비스가
죽는** 상태가 됩니다.

`install-node.sh` 가 피해 가는 함정은 둘입니다.

- **`libnode-dev` 충돌.** 배포판 node 12 가 깔려 있던 22.04 에서는 설치가
  `trying to overwrite '/usr/include/node/common.gypi'` 로 멈춥니다. NodeSource
  패키지는 `nodejs-dev` 를 비켜 가도록 선언돼 있는데 우분투가 그것을
  `libnode-dev` 로 개명했기 때문입니다. 스크립트는 이름이 아니라 **실제로 부딪히는
  파일의 주인**을 찾아 보여 주고, 동의를 받아 그 패키지만 지웁니다. `nodejs`
  런타임은 지우지 않습니다 — 거기에 기대는 다른 패키지가 딸려 나갈 수 있습니다.
- **`npm` 을 따로 깔지 않습니다.** npm 은 NodeSource `nodejs` 패키지 안에 있습니다
  (`dpkg -S /usr/bin/npm` → `nodejs`). 배포판 `npm` 패키지를 얹으려 하면 node 12 시절
  의존성을 끌고 오다 `held broken packages` 로 실패합니다.

저장소 줄의 `nodistro` 는 오타가 아닙니다. NodeSource 는 배포판 코드명으로 나누지
않아 22.04 와 24.04 가 같은 줄을 씁니다. dist-upgrade 를 거친 장비라면
`/etc/apt/sources.list.d/nodesource.list.distUpgrade` 로 꺼진 채 남아 보안 업데이트가
오지 않을 수 있는데, 점검이 그것도 짚고 `--apply` 가 되살립니다.

손으로 해야 할 때(스크립트가 멈춘 자리를 짚을 때):

```bash
sudo apt-get install -y ca-certificates curl gnupg
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/nodesource.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | sudo tee /etc/apt/sources.list.d/nodesource.list
sudo apt-get update && sudo apt-get install -y nodejs
```

확인은 `node -v && npm -v && ./bootstrap.sh --check` 입니다.

---

## 5. pm2

```bash
./pm2/install_pm2.sh install
```

`sudo npm install -g pm2` 로 전역 설치하고, **부팅 시 pm2 를 되살리는 crontab
`@reboot`**(`pm2/pm2-boot.sh` → `pm2 resurrect`)을 등록합니다. 이미 설치돼 있으면
`update` 를 쓰라고 하고 멈춥니다. 되살아나는 것은 마지막 `pm2 save` 목록입니다.

부팅 복원은 crontab `@reboot` 하나로 통일했습니다. `pm2 startup systemd` 를 함께
두지 마세요 — 둘이 겹치면 `resurrect` 가 두 번 돕니다(`check-all.sh` 와 마법사가 알립니다).
자세한 것은 [infrastructure.md](infrastructure.md) 'pm2 — 부팅 복원'.

---

## 6. `bootstrap.sh --apply` — manager 세우기

```bash
./bootstrap.sh --apply
```

sudo 없이 넷을 합니다. 이미 된 것은 건너뜁니다.

1. `services/manager/server` 의존성 설치
2. `services/manager/web` 의존성 설치 + 빌드 → `server/public/`
3. **관리자 콘솔 비밀번호**를 물어(8자 이상, 두 번) 해시만
   `services/manager/config.json`(600)의 `superAdmin.passwordHash` 에 넣습니다.
   기본 비밀번호는 없습니다 — 둘 다 비어 있으면 콘솔은 늘 로그인에 실패합니다.
4. `pm2 start pm2/ecosystem.config.js --only manager` 후 `pm2 save`

대화형 터미널이 아니면 비밀번호를 물을 수 없어 멈추고, 손으로 하는 법을 알려
줍니다.

```bash
cp services/manager/config.example.json services/manager/config.json
cd services/manager/server
printf '%s' '<비밀번호>' | node tools/hash-password.js --stdin   # 출력을 superAdmin.passwordHash 에
```

## 7. 마법사에 들어가기

manager 는 `127.0.0.1:28084` 에만 붙습니다. nginx 는 아직 없으므로 밖에서 바로 열리지
않습니다. 원격 장비라면 SSH 터널을 씁니다.

```bash
ssh -L 28084:127.0.0.1:28084 <계정>@<설치 장비>     # 내 PC 에서
```

브라우저로 `http://127.0.0.1:28084/manager/setup` 을 엽니다.

**터널 없이 이 서버 주소로 바로 들어가려면** nginx 를 구축하는 동안만 먼저 엽니다 (sudo).

```bash
./bootstrap.sh --expose-http     # 평문 HTTP — http://<이 서버>/manager/setup
./bootstrap.sh --expose-https    # 구축용 사설 인증서로 HTTPS (브라우저가 경고를 냅니다)
```

둘 다 사설 대역(10/8 · 172.16/12 · 192.168/16 · 127/8)에서만 받고, 마법사의 `nginx.routes`
단계가 같은 파일(`/etc/nginx/conf.d/path-routing.conf`)을 전체 설정으로 덮어쓰는 순간 80 이
HTTPS 로 넘어갑니다. `--expose-http` 는 manager 의 `cookieSecure` 를 `auto`(https 요청에만
Secure)로 바꾸고 manager 를 다시 시작합니다 — 평문에서는 Secure 쿠키를 브라우저가 저장하지
않아 로그인이 되지 않기 때문입니다. 평문에서는 로그인과 sudo 비밀번호가 암호화되지 않으므로
믿는 내부망에서만 쓰세요.

**일반 로그인은 아직 되지 않습니다.** 로그인 계정은 MariaDB 의 `administrator`
테이블에 있는데, 그 테이블을 만드는 것이 마법사의 `database.schema` 단계입니다.
대신 로그인 화면의 **설정 버튼(⚙)** 을 누르고 `sysadmin` 과 6절의 비밀번호로 관리자
콘솔에 들어간 뒤, 헤더의 **구축 마법사** 를 누릅니다. 콘솔은 `config.json` 만으로
인증되므로 이 고리 밖에 있고, `/setup*` API 는 콘솔 세션도 받습니다.

콘솔 세션은 30분입니다. 끊기면 같은 길로 다시 들어오면 됩니다 — 진행 상태는
저장하지 않고 들어올 때마다 전부 다시 점검하므로 잃는 것이 없습니다.

DB 가 선 뒤에는 일반 계정을 만듭니다. 로그인 화면에서 자기 이메일로 로그인을
시도하면 승인 요청이 생기고, 콘솔(`/manager/admin`)이나 CLI 로 승인합니다.

```bash
cd services/manager/server && npm run admin -- approve you@example.com
```

---

## 8. 마법사가 일하는 방식

한 단계는 **설명 → 입력 → 명령 → 확인 → 점검**으로 되어 있습니다.

- **설명**: 무엇을 왜 하는지, 뒤집으면 무슨 일이 나는지.
- **입력**: 장비마다 다른 값이 있으면 폼이 뜹니다. **값 저장**은 그 서비스의
  `settings.ini` 에 적는 것뿐이고 반영이 아닙니다. 반영은 사람이 그 단계의
  `--apply` 를 돌려야 일어나며, 그 사이에는 점검이 "아직 반영되지 않았습니다" 로
  말합니다.
- **명령**: 실행할 명령과 복사 단추 — **직접** 할 때입니다. 단계마다 **자동으로** 를
  고를 수도 있고, 그러면 마법사가 정해진 명령을 순서대로 돌려 로그를 보여 줍니다
  (아래 '자동으로 실행'). 기본은 직접입니다.
- **확인**: "했습니다 — 점검하기" 를 누르면 그 단계의 점검 스크립트를
  `--check --json` 으로 돌립니다. 누른 것은 점검을 부르는 방아쇠일 뿐입니다.
- **점검**: 결과가 통과해야 다음 단계가 열립니다.

| 상태 | 뜻 |
|---|---|
| 통과 (`complete`) | 점검이 됐다고 답했습니다 |
| 사람이 확인함 (`attested`) | 기계가 볼 수 없는 부분을 사람이 확인했습니다. 누가 언제 눌렀는지 남습니다 |
| 아직 (`incomplete`) | 할 일이 남았습니다 |
| 문제 (`problem`) | 잘못된 것이 있습니다. 사람의 확인으로 덮이지 않습니다 |
| 확인 못함 (`unknown`) | 점검을 마치지 못했습니다(스크립트 없음 · 30초 초과 · 출력 해석 실패). 다음 단계는 열리지 않습니다 |

사람의 확인은 "그때 그것" 에 대한 것입니다. 포워딩 목록처럼 확인한 대상이 뒤에
바뀌면 예전 확인은 없는 것으로 보고 다시 묻습니다. 확인 기록은
`services/manager/setup-attest.json` 에 남습니다(커밋하지 않음).

화면 위의 **전체 점검**은 모든 단계를 다시 돌립니다(대개 몇 초). 단계 하나를 가리키려면
`/manager/setup?step=nginx.routes` 처럼 주소에 붙입니다.

마법사가 하지 않는 것: 사용자가 **자동으로** 를 고르지 않은 단계의 실행, 사람이 값을
정해야 하는 단계(인증서 발급 등)의 실행, 되돌리기, 진행률 저장, 다른 장비 구축.

**자동으로 실행.** 단계 카드에서 **자동으로** 를 고르면 그 단계의 명령을 마법사가
돌립니다. 끝나면 점검을 이어서 돌리고, 통과 여부는 점검이 정합니다. 경계는 이렇습니다
(`services/manager/server/src/services/setup-auto.js`).

| | |
|---|---|
| 무엇을 | `setup.js` 의 `AUTO` 표에 박힌 명령만. 요청이 정하는 것은 단계 id 와 sudo 비밀번호뿐 |
| 어떻게 | 셸을 거치지 않는 `spawn`. 한 번에 하나, 명령당 30분 상한, `중단` 가능 |
| sudo | 화면에서 비밀번호를 받습니다. 메모리에만 두고 파일·환경 변수·인자·로그에 싣지 않습니다. 작업마다 0700 임시 폴더에 `sudo` 래퍼와 askpass 소켓을 만들었다가 끝나면 지웁니다. 먼저 `sudo -v` 로 맞는지 보고, 틀리면 아무것도 돌리지 않습니다 |
| DB 관리자 | MariaDB root 가 unix_socket 이 아니라 비밀번호 인증인 장비는 터미널 없는 자동 실행이 관리자로 붙지 못합니다. DB 를 만지는 단계(`database.schema`)에는 **DB 관리자** 칸이 있고, 넣으면 같은 0700 임시 폴더의 0600 옵션 파일로 두었다가 끝나면 지웁니다. 경로만 `sudo` 래퍼가 `MARIADB_ADMIN_DEFAULTS_FILE` 로 넘기고 `database/lib_mariadb.sh` 가 가장 먼저 시도합니다. `sudo mariadb -e 'SELECT 1;'` 이 되면 비워 둡니다 |
| 자동이 없는 단계 | 사람이 값을 정해야 하는 단계. 카드에 이유가 적힙니다 |

비밀번호가 오가므로 이 화면은 **https 나 SSH 터널(127.0.0.1)** 로만 여세요. 접근은 일반
관리자 로그인이나 관리자 콘솔 세션이 있어야 하고, JSON 본문만 받습니다. `--yes` 를 붙이는
단계(MariaDB 설정 적용)는 자동을 고른 것이 재시작 확인에 대한 동의입니다.

**실행 경계.** manager 가 셸 스크립트를 돌리는 자리는 여기와 서비스 추가 화면뿐이고,
좁게 잡혀 있습니다(`services/manager/server/src/services/check-runner.js`).

| | |
|---|---|
| 무엇을 | `STEPS` 표에 박힌 점검만. URL 의 `:stepId` 는 표에서 한 줄을 고르는 데만 씁니다 |
| 어떻게 | `execFile` — 셸을 거치지 않고, 사람 입력으로 인자를 만들지 않습니다 |
| 어디까지 | 실행 파일이 저장소 밖이면 거부합니다 |
| 얼마나 | 타임아웃 30초, 출력 상한 1MB, 같은 단계는 겹쳐 돌지 않습니다 |
| 파일 쓰기 | `services/manager/setup-attest.json` 과 각 단계의 `settings.ini` 둘뿐입니다 |

**상태를 저장하지 않습니다.** 마지막 점검 결과는 manager 프로세스 메모리에만 있고,
재기동하면 비었다가 화면에 들어올 때 다시 점검합니다. 터미널에서 되돌린 것이 화면에
"완료" 로 남지 않게 하기 위해서입니다. 확인 기록이 DB 가 아니라 파일인 것도 같은
이유입니다 — DB 를 세우는 것이 `database.schema` 단계라 그 전에는 기록할 곳이 없습니다.

---

## 9. 마법사 단계

순서는 각 단계의 `requires` 에서 매번 계산됩니다(`services/manager/server/src/services/setup.js`
의 `STEPS`). **단계는 id 로 부르세요.** 필수가 다섯, 선택이 넷(공인 인증서)입니다.

### 필수 단계

| # | id | 하는 일 | 사람이 칠 명령 | 점검 |
|---|---|---|---|---|
| 1 | `site.settings` | 여러 곳이 함께 쓰는 값 | 폼에 `host` · `tls_mode` → `./site/apply.sh --apply` | `site/apply.sh --check --json` |
| 2 | `pm2.apps` | pm2 와 부팅 등록, 선언된 앱 기동 | `cd pm2 && pm2 start ecosystem.config.js && pm2 save` | `node pm2/ecosystem.config.js --check-json` |
| 3 | `database.schema` | MariaDB 설치, DB·계정·스키마 | (빈 장비) `sudo database/install_mariadb.sh install` → 폼 → `sudo database/setup_mariadb.sh` | `database/check-database.sh` |
| 4 | `tls.decide` | 서버 인증서를 공인/사설 중 어느 쪽으로 | 사설이면 `cd nginx && ./generate_certs.sh --auto <host>` | `nginx/tls-decide.sh` |
| 5 | `nginx.routes` | 선언된 라우트를 nginx 에 반영 | (빈 장비) `sudo apt-get install -y nginx` → `cd nginx && sudo ./install_nginx_stack.sh --skip-install` | `install_nginx_stack.sh --check --json` |

### 선택 단계 (공인 인증서로 갈 때 전부 합니다)

| # | id | 하는 일 | 사람이 칠 명령 | 점검 |
|---|---|---|---|---|
| 6 | `public_ca.issue` | Let's Encrypt 발급 | 폼 → `cd nginx/public_ca && ./setup_letsencrypt.sh --check` → `sudo ./setup_letsencrypt.sh --staging` → `--prod` | `setup_letsencrypt.sh` |
| 7 | `public_ca.nginx` | 발급한 인증서를 nginx 가 내밀게 | `cd nginx && sudo ./install_nginx_stack.sh --skip-install` | `public_ca/cert-status.sh` (실제 접속) |
| 8 | `public_ca.renew` | 90일 자동 갱신 | `sudo systemctl enable --now certbot.timer` · `sudo certbot renew --dry-run` | `public_ca/renew-status.sh` |
| 9 | `public_ca.dns` | 이름이 아직 이 서버를 가리키나 | `nginx/public_ca/check-dns.sh` (크론 권장) | `check-dns.sh` |

### 단계별로 알아 둘 것

**`site.settings`.** 가장 먼저 채웁니다. `host` 는 스킴 없는 이름, `tls_mode` 는 `auto` ·
`public` · `private` 입니다. `--apply` 는 값을 `.applied-settings` 로 굳힐 뿐이고, nginx 는
자기 설치 스크립트가 다시 쓸 때 이 값을 읽습니다.

**`pm2.apps`.** pm2 는 이미 5절에서 깔았으므로 `install_pm2.sh install` 은 "이미 설치됨" 으로
멈춥니다. 점검은 선언 · 실행 중 · 재부팅 목록(`~/.pm2/dump.pm2`) 셋을 견줍니다.
**설치 중에는 manager 하나만 점검 대상**이고, 같은 pm2 에 떠 있는 이 저장소가 선언하지 않은
앱은 어떤 점검에서도 보지 않습니다(그 앱들이 있어도 이 단계는 통과합니다).

> **pm2 는 설정 파일을 다시 읽지 않습니다.** `pm2 restart <이름>` 이나 재부팅은 처음 띄울
> 때 저장된 환경을 그대로 씁니다. 앱의 `*.config.js` 나 거기서 읽는 `*.local.js` 의 환경
> 변수를 고쳤다면 `pm2 delete <이름> && pm2 start <config> && pm2 save` 로 다시 만들어야
> 반영됩니다. (실제로 `AUTH_SECRET` 을 파일에만 추가하고 프로세스를 다시 만들지 않아
> 로그인이 `서버에 AUTH_SECRET 이 설정되어 있지 않습니다` 로 막힌 일이 있었습니다.)

**`database.schema`.** 장비의 상태에 따라 셋으로 갈립니다.

- **빈 장비.** 22.04 라면 먼저 2.1 의 저장소를 추가합니다. 그다음
  `sudo ./install_mariadb.sh install` 로 설치하고, 폼의 세 값(`bind_address` 기본
  `127.0.0.1` · `port` · `innodb_buffer_pool_size`)을 `database/settings.ini` 에 넣은 뒤
  `sudo ./setup_mariadb.sh` 를 돌립니다. 끝나면 `database/secrets/webservices.pw` 가 생기고
  manager 가 그 파일을 읽습니다.
- **MariaDB 가 이미 있는 장비.** `install_mariadb.sh install` 은 "이미 설치되어 있습니다" 로
  멈추므로 건너뛰고 `setup_mariadb.sh` 만 돌립니다. `database.ini` 에 없는 DB 와 사용자는
  **지우지 않습니다**(추가·갱신만). 다만 두 가지는 확인하세요. `[security]` 가 익명 사용자 ·
  test DB · 원격 root 를 지우므로 그것에 기대는 것이 없어야 하고, 서버 설정을
  `/etc/mysql/mariadb.conf.d/99-project.cnf` 로 쓰므로 같은 폴더의 `99-` 로 시작하는 다른
  파일이 **파일 이름 순서**로 이깁니다(예: `99-temp-remote.cnf` 의 `bind-address` 가
  `99-project.cnf` 의 값을 덮습니다).
- **MySQL 8.0 에서 옮기는 장비.** [infrastructure.md](infrastructure.md) 7.9 의 순서를
  따릅니다. 덤프 변환과 계정 호스트 범위가 걸립니다.

**`tls.decide`.** 사설로 간다면 인증서를 만들어 둡니다. 마법사의 `--auto` 는 **이 장비의 LAN IP 만**
인증서에 넣고 인터넷 조회는 하지 않습니다. 공인 IP 까지 넣어야 한다면 `--external` 을 더하세요
(`./generate_certs.sh --auto --external <host>` — ifconfig.me 등에 요청을 보냅니다). `<host>` 를 IP
주소로 적으면 그 IP 가 IP SAN 으로 들어갑니다(브라우저는 IP 접속에 IP SAN 만 봅니다).
이 스크립트는 **다시 실행하면 CA 부터 새로 만들어 덮어씁니다** — 클라이언트에 CA 를 신뢰 등록한
뒤에는 다시 만들지 마세요. 사설 서버 인증서의 유효 기간은 1년입니다(`openssl x509 -enddate -noout -in nginx/cert/server/server.crt`). `nginx.routes` 점검이 서버 인증서
파일이 없으면 문제로 보고하므로 그것이 앞이어야 합니다.

**`nginx.routes`.** 라우트는 서비스가 뜬 뒤에 반영합니다. 뒤집으면 `/manager` 가 502 입니다.
빈 장비에는 nginx 자체가 아직 없습니다. 마법사가 보여 주는 명령은 `--skip-install` 이라
nginx 를 깔지 않으므로, 먼저 `sudo apt-get install -y nginx` 로 설치해 둡니다.
`--skip-install` 을 빼고 부르면 `install_nginx.sh` 가 설치 직후 nginx 를 멈춰 두기 때문에
마지막 `systemctl reload` 가 실패합니다. 이 단계 뒤로는 `https://<host>/manager/` 로도
들어올 수 있고, 루트 `/` 는 `/manager` 로 302 됩니다. 이 장비에 **Apache 가 80 포트를
쓰고 있으면** nginx 와 겹치므로 먼저 내립니다(`ss -tln | grep ':80 '` 으로 확인).

**`public_ca.*`.** 반드시 staging 을 먼저 합니다(같은 이름 조합 주 5건 제한).
`tls_mode = auto` 면 발급이 끝나는 순간 생성기가 공인 인증서 경로로 갈아타므로
경로를 손으로 적지 않고 반영만 합니다. 절차 전체는
[infrastructure.md](infrastructure.md) '공인 인증서'.

---

## 10. 서비스별 `npm run setup`

기본 서비스는 manager 하나이고, 마법사의 단계가 안에서 이것을 부르거나 같은 일을 합니다.

| 서비스 | `npm run setup` 이 하는 일 | 먼저 있어야 하는 것 |
|---|---|---|
| manager | server · web 의존성 설치 + web 빌드 (`bootstrap.sh --apply` 가 같은 일) | node 20 |

나머지 명령도 같은 이름입니다. `npm run check`(점검만), `npm run build`(고친 뒤 산출물
재생성), `npm run restart`(이 폴더가 `pm2-conf` 에 선언한 앱 재기동). plug-in 서비스를
붙이면 같은 이름의 명령을 두는 것이 관례입니다. 운영 중에 쓰는 법은 [rollout.md](rollout.md).

---

## 11. 끝났는지 확인 — `check-all.sh`

```bash
./check-all.sh         # 전부
./check-all.sh -q      # 어긋난 것만
```

설치본이 저장소의 선언과 같은지 한 번에 봅니다. 아무것도 바꾸지 않고, 어긋난
자리마다 그 서비스의 반영 명령을 붙여 줍니다. 전부 같으면 종료 코드 0 입니다.

보는 순서는 사이트 값 → 데이터베이스 → manager 의존성 · 화면 빌드 · 프로세스 → **nginx
라우팅** → pm2 부팅 등록입니다. nginx 가 서비스 뒤인 것은 전체 라우팅을 다시 쓰는 유일한
단계라, 앞의 것이 어긋난 채로 nginx 만 반영하면 라우트는 열리는데 뒤에 아무도 없는 상태가
되기 때문입니다.

일부러 빼 둔 것이 있습니다 — 인증서 발급 절차(`public_ca/*` · `tls-decide.sh`)와 의존성
설치(`*/bootstrap.sh`)입니다. 이것들은 "어긋났는가" 가 아니라 "지금 할 것인가" 를 묻는
단계입니다. 아래는 따로 봅니다.

```bash
node pm2/ecosystem.config.js --check        # 선언 · 실행 중 · 재부팅 목록
nginx/public_ca/cert-status.sh --check      # 지금 무엇을 내밀고 있나
nginx/public_ca/renew-status.sh             # 90일 뒤에도 내밀 것인가
```

단계 하나만 터미널에서 보고 싶으면 9절 표의 점검 명령을 그대로 부르면 됩니다.
모두 sudo 가 필요 없습니다.

---

## 12. 빈 장비 설치 시험

이미 설치된 장비에서는 재현성을 증명할 수 없습니다. 무엇을 돌려도 "이미 돼 있어서
통과한 것" 과 구분되지 않기 때문입니다. 그래서 가끔 빈 장비에서 처음부터 돌려
봅니다. **막힌 자리는 실패가 아니라 이 시험의 결과물**이고, 그 자리가 다음에 고칠
곳입니다.

**환경.** VM(Multipass · VirtualBox · KVM) 또는 LXD(`lxc launch ubuntu:22.04 light-test`).
Docker 는 systemd 가 없어 쓰지 않습니다. 시작 전과 `database.schema` 직후에 스냅샷을 찍어
두면 중간부터 다시 할 수 있습니다.

**절차.** 이 장의 2~11절을 그대로 따릅니다. 각 단계에서 확인할 것은 셋입니다.

1. **왜 하는지** 설명이 이해되는가 — 안 되면 그 문구가 고칠 대상입니다.
2. 명령을 그대로 복사해 돌렸을 때 **끝나는가**.
3. 점검이 초록으로 바뀌는가 — 안 바뀌면 점검의 문구가 다음에 할 일을 알려 주는가.

**시험 장비에서 안 되는 것** (실패로 치지 않음): 공인 인증서 넷(실재하는 도메인과
외부 80 이 필요). `site.settings` 의 `host` 는 `manager.example.test` 같은 아무 이름이나
넣고 `tls_mode = private` 으로 둡니다.

**합격선.** 필수 다섯 단계가 끝나고 `./check-all.sh` 가 종료 코드 0 이며, 브라우저로
`https://<host>/manager/` 에 로그인되면 재현된 것입니다. 문서 기준으로는, 막힌 자리마다
**화면이 다음에 할 일을 알려 주었는가** 를 봅니다. 알려 주지 못한 자리가 진짜 결함입니다.

**기록.** 시험자 · 날짜 · 환경(LXD/VM, Ubuntu 버전) · node · pm2 · MariaDB 버전을 적고,
단계마다 결과(ok / 막힘 / 건너뜀) · 걸린 시간 · **막혔을 때 화면에 나온 문구 그대로**를
남깁니다. 막힌 자리는 이 문서의 13절에 보태고, 고친 뒤 같은 시험을 처음부터 다시 합니다.

**지금까지.** 이 저장소는 빈 장비에서 끝까지 시험한 적이 없습니다.

---

## 13. 막히는 곳

| 증상 | 원인 | 할 일 |
|---|---|---|
| `bootstrap.sh` 가 `✗ node` 에서 안 넘어감 | 배포판 node 12/18 | `sudo ./install-node.sh --apply` |
| node 설치가 `common.gypi` 덮어쓰기로 멈춤 | `libnode-dev` 충돌 | `install-node.sh` 가 지울 것을 보여 주고 묻습니다 |
| 마법사 로그인이 503 | DB 가 아직 없음 | 설정 버튼(⚙) → 관리자 콘솔로 들어갑니다 |
| 관리자 콘솔 로그인이 늘 실패 | `config.json` 에 비밀번호 해시 없음 | `./bootstrap.sh --apply` 또는 `hash-password.js` |
| 단계가 "확인 못함" | 점검 스크립트 실행 실패 · 30초 초과 | 화면의 점검 명령을 터미널에서 직접 돌려 봅니다 |
| `nginx.routes` 에서 인증서 파일이 없다 | 사설 인증서를 안 만듦 | `cd nginx && ./generate_certs.sh --auto <host>` |
| nginx 가 뜨지 않거나 80 이 이미 쓰인다 | Apache 등이 80 을 잡고 있음 | `ss -tlnp \| grep ':80 '` 으로 찾아 내립니다 |
| DB 비밀번호가 "틀렸다" | `user@host` 자리 누락 | [infrastructure.md](infrastructure.md) 'MariaDB — 계정 정책' |
| 외부 클라이언트가 `Host '…' is not allowed to connect` | 계정의 허용 호스트에 접속 출발지가 없음. NAT 를 거치면 서버에는 게이트웨이 IP 로 보임 | `journalctl -u mariadb` 의 `host:` 값을 보고 [infrastructure.md](infrastructure.md) 7.5 |
| `apt install mysql-server` 가 `configure-symlinks` 없음으로 실패 | MariaDB 저장소의 `mysql-common` 이 이김 | 2.1 의 주의 상자 |
| 환경 변수를 고쳤는데 앱이 옛 값으로 돎 | pm2 가 처음 띄울 때의 환경을 재사용 | 9절 `pm2.apps` 의 안내 상자 |
