#!/usr/bin/env bash
#
# 클론한 직후 **처음 한 번** 돌리는 것. 여기서 시작하세요.
#
#   ./bootstrap.sh           안내 셸 — 화면 위에 "지금 할 일" 이 붙어 있고, 아래는 평소 셸
#   ./bootstrap.sh --check   무엇이 준비됐는지 보기만 한다 (아무것도 바꾸지 않음)
#   ./bootstrap.sh --apply   sudo 없이 되는 준비를 한 번에 한다 (manager 의존성·빌드·비밀번호·기동)
#   ./bootstrap.sh --expose-http    (sudo) nginx 를 구축하는 동안 평문 HTTP 로 열어 SSH 터널 없이 접속
#   ./bootstrap.sh --expose-https   (sudo) 같은 일을 구축용 사설 인증서로 HTTPS 로
#
# ── 이 스크립트가 하는 일과 하지 않는 일 ────────────────────────
# **여기서 하는 것은 "마법사까지 가는 길" 뿐입니다.** 실제 설치(MariaDB·nginx·
# 인증서)는 마법사가 단계별로 안내합니다. 그 편이 나은 이유는,
# 그 일들이 sudo 를 쓰고 장비마다 값이 다르며 순서가 있기 때문입니다 — 한 번에
# 몰아 돌리면 어디서 왜 멈췄는지 알 수 없습니다.
#
# **sudo 를 쓰지 않습니다.** 필요한 자리에서는 무엇을 실행해야 하는지 알려 주고
# 멈춥니다. 이 스크립트가 남의 장비에 root 로 무엇을 했는지 모르는 상태를
# 만들지 않기 위해서입니다.
#
# 여러 번 돌려도 안전합니다.
#
# ── 안내 셸 ──────────────────────────────────────────────────────
# 인자 없이 터미널에서 부르면 **평소 bash** 를 하나 띄우되, 화면 맨 위 몇 줄을
# 고정해 거기에 지금 상태와 **다음에 칠 명령 하나**를 보여 준다. 명령을 치고
# 끝나면 프롬프트가 돌아올 때마다 그 칸을 다시 계산한다 — 사람은 위를 읽고
# 아래에 치면 된다. 다 끝나면 그 칸이 마법사 주소로 바뀐다.
#
# 따로 깔 것이 없다. 스크롤 영역(tput csr)으로 위 줄들을 스크롤에서 빼고,
# PROMPT_COMMAND 가 프롬프트마다 다시 그린다 — mc 나 screen 이 상태줄을 붙드는
# 그 방법이다. 셸은 그대로 셸이라 탭 완성·히스토리·sudo 전부 평소처럼 된다.
#
# 설명은 단색이고 **칠 명령만** 반전색으로 강조한다. 색이 여러 개면 무엇을
# 읽어야 하는지가 흐려진다 — 눈이 가야 할 곳은 명령 하나뿐이다.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF="${ROOT}/bootstrap.sh"

MODE="guide"
for a in "$@"; do
    case "$a" in
        --check)  MODE="check" ;;
        --apply)  MODE="apply" ;;
        --expose-http)  MODE="expose-http" ;;
        --expose-https) MODE="expose-https" ;;
        --guide)  MODE="guide" ;;
        --header) MODE="header" ;;     # 안내 셸이 프롬프트마다 부른다 (내부용)
        -h|--help) sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "모르는 옵션: $a" >&2; exit 2 ;;
    esac
done

# 터미널이 아니면(파이프·CI) 안내 셸을 띄울 수 없다. 보고서로 대신한다.
# 안내 셸 안에서 또 부른 것도 마찬가지다 — 겹쳐 띄우면 칸이 둘이 된다.
if [[ "$MODE" == "guide" && ( ! -t 0 || ! -t 1 || -n "${BOOTSTRAP_GUIDE:-}" ) ]]; then
    MODE="check"
fi

# 색은 두 가지뿐이다. 명령은 반전(검정 글자 · 밝은 노랑 바탕)으로, 나머지는
# 단색. 부수 설명만 흐리게.
# --header 는 파이프로 읽히지만 결국 터미널에 그려지므로 색을 켠다.
if [[ -t 1 || "$MODE" == "header" ]]; then
    CMD=$'\033[1;30;103m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; OFF=$'\033[0m'
else
    CMD=""; DIM=""; BOLD=""; OFF=""
fi
cmd()  { printf '%s %s %s' "$CMD" "$*" "$OFF"; }      # 칠 명령을 강조해 돌려준다
ok()   { echo "  ✓ $*"; }
todo() { echo "  · $*"; }
bad()  { echo "  ✗ $*"; }
step() { echo; echo "${DIM}──${OFF} $*"; }

# ── 상태를 읽는다 — 아무것도 바꾸지 않는다 ───────────────────────
#
# 세 모드가 전부 이것을 본다. 판정을 한 곳에서 내려야 --check 가 말한 것과
# 안내 셸이 보여 주는 것이 어긋나지 않는다.
NODE_MAJOR=0; HAVE_NODE=0; HAVE_NPM=0; HAVE_PM2=0
HAVE_DEPS=0; HAVE_BUILD=0; HAVE_CONFIG=0; RUNNING=0
CONFIG="${ROOT}/services/manager/config.json"
EXAMPLE="${ROOT}/services/manager/config.example.json"

probe() {
    command -v node >/dev/null 2>&1 && HAVE_NODE=1
    command -v npm  >/dev/null 2>&1 && HAVE_NPM=1
    command -v pm2  >/dev/null 2>&1 && HAVE_PM2=1
    # node 20 미만이면 manager 가 뜨지 않는다 (fetch·AbortSignal.timeout 을 쓴다).
    [[ $HAVE_NODE -eq 1 ]] && NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    [[ -d "${ROOT}/services/manager/server/node_modules" ]] && HAVE_DEPS=1
    [[ -f "${ROOT}/services/manager/server/public/index.html" ]] && HAVE_BUILD=1
    [[ -f "$CONFIG" ]] && HAVE_CONFIG=1
    # pm2 에게 묻지 않고 pid 파일을 본다 — pm2 명령은 데몬이 없으면 띄워 버린다.
    # "보기만 한다" 는 약속을 지키려면 데몬을 깨우면 안 된다.
    local f pid
    for f in "${HOME}/.pm2/pids/manager-"*.pid; do
        [[ -r "$f" ]] || continue
        pid="$(tr -d '[:space:]' <"$f")"
        [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null && { RUNNING=1; break; }
    done
}

NODE_OK() { [[ $HAVE_NODE -eq 1 && $HAVE_NPM -eq 1 && "$NODE_MAJOR" -ge 20 ]]; }

MANAGER_PORT() {
    local p
    p="$(sed -n 's/^[[:space:]]*"port"[[:space:]]*:[[:space:]]*\([0-9]\{1,\}\).*/\1/p' "$EXAMPLE" 2>/dev/null | head -1)"
    echo "${p:-28084}"
}

# 배포판 패키지는 22.04 가 12, 24.04 가 18 이라 어느 쪽도 모자랍니다. npm 은 따로
# 설치하지 마세요 — NodeSource 의 nodejs 패키지가 이미 담고 있습니다.
NODE_HOW="sudo ./install-node.sh --apply"
PM2_HOW="./pm2/install_pm2.sh install"
APPLY_HOW="./bootstrap.sh --apply"

# ── --check: 보고서 ───────────────────────────────────────────────
report() {
    local problems=0
    step "필요한 도구"
    if [[ $HAVE_NODE -eq 1 ]]; then
        ok "node $(node --version 2>/dev/null)"
        if [[ "$NODE_MAJOR" -lt 20 ]]; then
            bad "node 20 이상이 필요합니다 (지금 ${NODE_MAJOR}) — manager 가 fetch 와 AbortSignal.timeout 을 씁니다"
            echo "      $(cmd "$NODE_HOW")   ${DIM}지울 것을 먼저 보여 주고 묻습니다. 배경은 docs/guide/install.md '4. Node.js 20'${OFF}"
            problems=$((problems + 1))
        fi
    else
        bad "node 가 없습니다 — 서비스가 node 로 돕니다"
        echo "      $(cmd "$NODE_HOW")   ${DIM}NodeSource 에서 20 을 설치합니다${OFF}"
        problems=$((problems + 1))
    fi
    if [[ $HAVE_NPM -eq 1 ]]; then
        ok "npm $(npm --version 2>/dev/null)"
    else
        bad "npm 이 없습니다 — 의존성을 받습니다"
        echo "      $(cmd "$NODE_HOW")   ${DIM}nodejs 패키지에 함께 들어 있습니다${OFF}"
        problems=$((problems + 1))
    fi
    if [[ $HAVE_PM2 -eq 1 ]]; then
        ok "pm2 $(pm2 --version 2>/dev/null)"
    else
        todo "pm2 가 없습니다 — 서비스를 띄우고 재부팅 뒤 되살리는 데 씁니다"
        echo "      $(cmd "$PM2_HOW")   ${DIM}sudo 로 전역 설치합니다${OFF}"
    fi

    # 마법사(/manager/setup)가 manager 안에 있다. 그래서 manager 하나만 세우면
    # 나머지는 화면을 보며 진행할 수 있다.
    step "관리 대시보드(manager) 준비"
    [[ $HAVE_DEPS -eq 1 ]]   && ok "server 의존성 있음"  || todo "server 의존성 없음"
    [[ $HAVE_BUILD -eq 1 ]]  && ok "화면 빌드 있음"      || todo "화면 빌드 없음"
    [[ $HAVE_CONFIG -eq 1 ]] && ok "config.json 있음"    || todo "config.json 없음 (관리자 콘솔 비밀번호를 받아 만듭니다)"
    if [[ $HAVE_PM2 -eq 0 ]]; then
        todo "pm2 가 없어 기동 여부를 볼 수 없습니다"
    elif [[ $RUNNING -eq 1 ]]; then
        ok "manager 떠 있음"
    else
        todo "manager 아직 떠 있지 않음"
    fi
    if [[ $HAVE_DEPS -eq 0 || $HAVE_BUILD -eq 0 || $HAVE_CONFIG -eq 0 || $RUNNING -eq 0 ]]; then
        echo "      $(cmd "$APPLY_HOW")   ${DIM}위 넷을 한 번에 합니다 (sudo 없음)${OFF}"
    fi

    echo
    if [[ $problems -gt 0 ]]; then
        echo "  먼저 위의 것들을 갖춘 뒤 다시 실행하세요."
        return 1
    fi
    [[ $HAVE_DEPS -eq 1 && $HAVE_BUILD -eq 1 && $HAVE_CONFIG -eq 1 && $RUNNING -eq 1 ]] && next_steps
    echo "  ${DIM}--check 라 아무것도 바꾸지 않았습니다.${OFF}"
    return 0
}

# ── 마법사 안내 (다 갖춰졌을 때) ─────────────────────────────────
# nginx 는 아직 없을 수 있다. 그때는 포트로 직접 들어가는 길을 알려 준다 —
# 마법사 안에 nginx 반영 단계가 있으므로, 그 전에도 화면은 열려야 한다.
next_steps() {
    local port ssh_host ssh_user
    port="$(MANAGER_PORT)"
    ssh_host="<이 서버>"; ssh_user="<사용자>"
    if [[ -n "${SSH_CONNECTION:-}" ]]; then
        # SSH 접속 중이면 서버가 보는 자기 주소를 그대로 채워 준다.
        ssh_host="$(awk '{print $3}' <<<"$SSH_CONNECTION")"
        ssh_user="$(id -un)"
    fi
    cat <<EOF

  브라우저로 구축 마법사를 여세요. SSH 터널 없이 이 서버 주소로 바로 들어가려면 먼저 (sudo):

      $(cmd "./bootstrap.sh --expose-http")    ${DIM}평문 HTTP — 가장 간단합니다 (구축하는 동안만)${OFF}
      $(cmd "./bootstrap.sh --expose-https")   ${DIM}구축용 사설 인증서로 HTTPS — 평문이 꺼림칙하면${OFF}

  아니면 아래 주소로 (이 서버에서 직접, 또는 SSH 터널로).

      ${BOLD}http://127.0.0.1:${port}/manager/setup${OFF}
      ${DIM}(nginx 를 이미 반영했다면 https://<이 서버>/manager/setup)${OFF}

  ${BOLD}SSH 로 접속해 구축 중이라 이 서버에서 브라우저를 못 여는 경우${OFF} —
  내 PC 의 새 터미널에서 포트를 터널링한 뒤, PC 브라우저로 같은 주소를 여세요.

      ${BOLD}ssh -L ${port}:127.0.0.1:${port} ${ssh_user}@${ssh_host}${OFF}
      ${DIM}그다음 PC 브라우저에서 http://127.0.0.1:${port}/manager/setup${OFF}

  처음에는 일반 로그인이 되지 않습니다. 관리자 계정은 MariaDB 의
  administrator 테이블에 있는데, ${DIM}그 테이블을 만드는 것이 마법사의 2단계입니다.${OFF}

  로그인 화면의 ${BOLD}설정 버튼(⚙)${OFF} → ${BOLD}sysadmin${OFF} 과 방금 정한 비밀번호
  → 헤더의 ${BOLD}구축 마법사${OFF} 로 들어가세요.
  ${DIM}관리자 콘솔은 config.json 만으로 인증되어 그 고리 밖에 있습니다.
  DB 를 세우고 자기 계정을 만든 뒤부터는 일반 로그인으로 들어가면 됩니다.${OFF}

  마법사가 나머지를 순서대로 안내합니다 — 사이트 값 → pm2 → DB → 서버 인증서 →
  nginx 라우트. 각 단계는 무엇을 왜 하는지와 점검 결과를
  함께 보여 주고, sudo 가 필요한 명령은 복사해 쓰도록 보여 주기만 합니다.

EOF
}

# ── --apply: sudo 없이 되는 준비를 한 번에 ───────────────────────
#
# 기본 비밀번호를 두지 않는다. 저장소에 커밋된 비밀번호는 바꾸지 않은 장비
# 전부에서 그대로 통하고, 이 콘솔은 관리자 계정을 만들고 지울 수 있다.
# 그래서 비어 있으면 콘솔이 아예 열리지 않는다(fail-closed).
#
# 대신 그 값을 여기서 받아 둔다 — 그러지 않으면 클론한 사람이 화면 앞에서
# 막히고, 왜 막혔는지 알 길이 없다.
set_admin_password() {
    local pw pw2
    while :; do
        read -rsp "  관리자 콘솔 비밀번호 (8자 이상): " pw; echo
        if [[ ${#pw} -lt 8 ]]; then
            bad "8자 이상이어야 합니다."
            continue
        fi
        read -rsp "  한 번 더: " pw2; echo
        if [[ "$pw" != "$pw2" ]]; then
            bad "두 번 입력한 값이 다릅니다."
            continue
        fi
        break
    done

    # 비밀번호를 인자로 넘기지 않는다 — 같은 장비의 다른 사용자에게 ps 목록으로
    # 그대로 보인다. 해시도 argv 대신 환경 변수로 넘긴다.
    local hash
    hash="$(printf '%s' "$pw" | node "${ROOT}/services/manager/server/tools/hash-password.js" --stdin)" \
        || { bad "해시 생성에 실패했습니다."; return 1; }
    unset pw pw2

    MANAGER_PW_HASH="$hash" node -e '
        const fs = require("fs");
        const [example, out] = process.argv.slice(1);
        const c = JSON.parse(fs.readFileSync(example, "utf8"));
        c.superAdmin = { ...c.superAdmin, passwordHash: process.env.MANAGER_PW_HASH };
        delete c.superAdmin.password;
        fs.writeFileSync(out, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
    ' "$EXAMPLE" "$CONFIG" || { bad "config.json 을 쓰지 못했습니다."; return 1; }

    chmod 600 "$CONFIG" 2>/dev/null || true
    ok "config.json 을 만들었습니다 (비밀번호는 해시로만 저장됩니다)"
}

# ── --expose-http: 구축하는 동안만 nginx 를 평문 HTTP 로 연다 ─────────
#
# SSH 터널(ssh -L)을 매번 열지 않고 http://<이 서버>/manager/setup 으로 바로 들어가기 위한 것이다.
# 인증서는 마법사가 뒤에서 만들므로(tls.decide) **그 전에는 HTTPS 가 설 수 없다.** 그래서 구축하는 동안은
# 평문으로 열고, 마법사의 nginx.routes 단계가 전체 설정을 반영하는 순간 80 이 HTTPS 로 넘어가며 바뀐다
# (같은 파일 /etc/nginx/conf.d/path-routing.conf 를 덮어쓴다).
#
# 평문이므로 **사설 대역에서만** 받는다 (allow 10/8 · 172.16/12 · 192.168/16 · 127/8, 나머지 deny).
# 그래도 로그인과 sudo 비밀번호가 평문으로 오가므로 믿는 내부망에서만 쓰세요.
#
# 이 모드만 sudo 를 쓴다 — nginx 설정은 root 가 아니면 쓸 수 없다. 바꾸는 것은 세 가지다:
# 위 파일, 기본 사이트 링크 제거, manager 의 쿠키 설정(평문에서도 로그인되게 'auto').
HTTP_CONF="/etc/nginx/conf.d/path-routing.conf"
HTTP_MARK="# BOOTSTRAP-HTTP (bootstrap.sh --expose-http)"

lan_ip() {
    ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1
}

expose() {
    local scheme="${1:-http}"   # http | https
    command -v nginx >/dev/null 2>&1 || {
        bad "nginx 가 없습니다."; echo "      $(cmd "sudo apt install -y nginx")"; return 1; }
    local port; port="$(MANAGER_PORT)"
    local tmp; tmp="$(mktemp)"
    local cert="${ROOT}/nginx/cert/server/server.crt" key="${ROOT}/nginx/cert/server/server.key"
    if [[ "$scheme" == "https" ]]; then
        # 구축용 사설 인증서. 이미 있으면 그대로 쓴다 (마법사의 tls.decide 가 같은 경로를 쓴다).
        if [[ ! -f "$cert" || ! -f "$key" ]]; then
            step "구축용 사설 인증서를 만듭니다 (이 서버의 LAN IP 가 들어갑니다)"
            ( cd "${ROOT}/nginx" && ./generate_certs.sh --auto "$(hostname -f 2>/dev/null || echo localhost)" >/dev/null 2>&1 ) \
                || { bad "인증서를 만들지 못했습니다: cd nginx && ./generate_certs.sh --auto <이름>"; rm -f "$tmp"; return 1; }
            [[ -f "$cert" && -f "$key" ]] || { bad "인증서 파일이 생기지 않았습니다: ${cert}"; rm -f "$tmp"; return 1; }
            ok "인증서: ${cert}"
        fi
    fi

    {
        echo "__MARK__"
        echo "# 구축하는 동안만 쓰는 입구(${scheme}). 마법사의 nginx.routes 단계가 이 파일을 전체 설정으로 바꾼다."
        cat <<'HEAD'
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

HEAD
        if [[ "$scheme" == "https" ]]; then
            cat <<'S80'
server {
    listen 80 default_server;
    server_name _;
    allow 127.0.0.0/8; allow 10.0.0.0/8; allow 172.16.0.0/12; allow 192.168.0.0/16; deny all;
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2 default_server;
    server_name _;
    ssl_certificate     __CERT__;
    ssl_certificate_key __KEY__;
    ssl_protocols TLSv1.2 TLSv1.3;
S80
        else
            cat <<'S80'
server {
    listen 80 default_server;
    server_name _;
S80
        fi
        cat <<'BODY'

    # 사설 대역에서만 받는다.
    allow 127.0.0.0/8;
    allow 10.0.0.0/8;
    allow 172.16.0.0/12;
    allow 192.168.0.0/16;
    deny  all;

    absolute_redirect off;
    location = / { return 302 /manager/setup; }

    location /manager {
        proxy_pass http://127.0.0.1:__PORT__;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
    }
}
BODY
    } >"$tmp"
    sed -i "s|__CERT__|${cert}|; s|__KEY__|${key}|" "$tmp"
    sed -i "s|__MARK__|${HTTP_MARK}|; s|__PORT__|${port}|" "$tmp"

    step "nginx 를 ${scheme} 로 엽니다 (sudo)"
    sudo -v || { bad "sudo 를 쓸 수 없습니다."; rm -f "$tmp"; return 1; }

    # 이 스크립트나 마법사가 만든 것이 아니면 덮기 전에 백업한다.
    local backup=""
    if [[ -f "$HTTP_CONF" ]] && ! grep -q "BOOTSTRAP-HTTP\|generate_nginx_conf.py" "$HTTP_CONF"; then
        backup="${HTTP_CONF}.bak.$(date +%Y%m%d-%H%M%S)"
        sudo cp -p "$HTTP_CONF" "$backup" && ok "기존 설정을 백업했습니다: ${backup}"
    fi
    sudo install -m 0644 -o root -g root "$tmp" "$HTTP_CONF" || { bad "설정을 쓰지 못했습니다."; rm -f "$tmp"; return 1; }
    rm -f "$tmp"

    # 같은 80 의 default_server 를 하나만 남긴다.
    local l
    for l in /etc/nginx/sites-enabled/default /etc/nginx/sites-enabled/reverse-proxy.conf; do
        if [[ -e "$l" || -L "$l" ]]; then sudo rm -f "$l" && ok "제거: $l"; fi
    done

    # 파이프로 sed 를 물리면 종료 코드가 sed 의 것이 된다 — 출력을 받아 두고 nginx -t 의 코드를 본다.
    local t_out t_rc=0
    t_out="$(sudo nginx -t 2>&1)" || t_rc=$?
    sed 's/^/      /' <<<"$t_out"
    if [[ $t_rc -ne 0 ]]; then
        bad "nginx -t 실패 — reload 하지 않았습니다."
        if [[ -n "$backup" ]]; then sudo cp -p "$backup" "$HTTP_CONF" && echo "      백업을 되돌렸습니다."; else sudo rm -f "$HTTP_CONF"; fi
        return 1
    fi
    sudo systemctl enable --now nginx >/dev/null 2>&1 || true
    sudo systemctl reload nginx || sudo systemctl restart nginx || { bad "nginx 를 reload 하지 못했습니다."; return 1; }
    ok "nginx 가 /manager 를 ${port} 로 넘깁니다 (${scheme})"

    # 평문 HTTP 에서도 로그인되게: Secure 쿠키는 평문에서 브라우저가 저장하지 않는다.
    if [[ "$scheme" == "http" && -f "$CONFIG" ]]; then
        node -e '
          const fs=require("fs"),p=process.argv[1];
          const c=JSON.parse(fs.readFileSync(p,"utf8"));
          if (c.cookieSecure!=="auto"){ c.cookieSecure="auto"; fs.writeFileSync(p, JSON.stringify(c,null,2)+"\n"); console.log("changed"); }
        ' "$CONFIG" | grep -q changed && {
            ok "manager 의 cookieSecure 를 auto 로 바꿨습니다 (https 요청에만 Secure)"
            command -v pm2 >/dev/null 2>&1 && pm2 restart manager --update-env >/dev/null 2>&1 && ok "manager 를 다시 시작했습니다"
        }
    fi

    local ip; ip="$(lan_ip)"
    if [[ "$scheme" == "https" ]]; then
        cat <<MSG

  이제 SSH 터널 없이 브라우저로 여세요.

      ${BOLD}https://${ip:-<이 서버>}/manager/setup${OFF}

  ${DIM}구축용 사설 인증서라 브라우저가 경고를 냅니다 — 이 서버가 맞는지 확인하고 계속하세요.
  사설 대역에서만 열립니다.${OFF}

MSG
    else
        cat <<MSG

  이제 SSH 터널 없이 브라우저로 여세요.

      ${BOLD}http://${ip:-<이 서버>}/manager/setup${OFF}

  ${DIM}구축하는 동안만 평문 HTTP 입니다 (사설 대역에서만 열립니다). 로그인과 sudo 비밀번호가 평문으로 오갑니다.
  마법사의 nginx.routes 단계를 마치면 80 이 HTTPS 로 넘어가므로 그때부터
  https://${ip:-<이 서버>}/manager/setup 으로 들어가세요. 평문이 꺼림칙하면 ./bootstrap.sh --expose-https 를 쓰세요.${OFF}

MSG
    fi
}

apply() {
    if ! NODE_OK; then
        bad "node 20 이상과 npm 이 먼저 있어야 합니다."
        echo "      $(cmd "$NODE_HOW")"
        return 1
    fi

    step "관리 대시보드(manager) 준비"
    if [[ $HAVE_DEPS -eq 1 ]]; then
        ok "server 의존성 있음"
    else
        echo "  npm install (services/manager/server) …"
        ( cd "${ROOT}/services/manager/server" && npm install --no-audit --no-fund >/dev/null 2>&1 ) \
            && ok "server 의존성 설치됨" \
            || { bad "server 의존성 설치 실패 — 직접 돌려 보세요:"
                 echo "      $(cmd "cd services/manager/server && npm install")"; return 1; }
    fi

    # 화면(web)은 빌드 결과를 server/public 으로 낸다. 없으면 대시보드가 빈 화면이다.
    if [[ $HAVE_BUILD -eq 1 ]]; then
        ok "화면 빌드 있음"
    else
        echo "  npm install + build (services/manager/web) …"
        ( cd "${ROOT}/services/manager/web" && npm install --no-audit --no-fund >/dev/null 2>&1 && npm run build >/dev/null 2>&1 ) \
            && ok "화면 빌드됨" \
            || { bad "화면 빌드 실패 — 직접 돌려 보세요:"
                 echo "      $(cmd "cd services/manager/web && npm install && npm run build")"; return 1; }
    fi

    step "관리자 콘솔 비밀번호"
    if [[ $HAVE_CONFIG -eq 1 ]]; then
        ok "config.json 있음"
    elif [[ ! -t 0 ]]; then
        # 파이프나 CI 로 돌린 경우. 비밀번호를 물을 수 없다.
        bad "config.json 이 없는데 입력을 받을 수 없습니다 (대화형 터미널이 아닙니다)"
        echo "      cp services/manager/config.example.json services/manager/config.json"
        echo "      cd services/manager/server"
        echo "      printf '%s' '<비밀번호>' | node tools/hash-password.js --stdin"
        echo "      ${DIM}그 값을 config.json 의 superAdmin.passwordHash 에 넣으세요.${OFF}"
        return 1
    else
        echo "  ${DIM}관리자 콘솔(로그인 화면의 설정 버튼)로 들어갈 비밀번호입니다."
        echo "  비밀번호는 저장되지 않고 해시만 config.json 에 들어갑니다.${OFF}"
        set_admin_password || return 1
    fi

    step "manager 기동"
    if [[ $HAVE_PM2 -eq 0 ]]; then
        todo "pm2 가 없어 띄우지 못했습니다. 먼저:"
        echo "      $(cmd "$PM2_HOW")"
        return 1
    fi
    if pm2 describe manager >/dev/null 2>&1; then
        pm2 restart manager --update-env >/dev/null 2>&1 && ok "manager 를 다시 띄웠습니다"
    else
        ( cd "${ROOT}/pm2" && pm2 start ecosystem.config.js --only manager >/dev/null 2>&1 ) \
            && { pm2 save >/dev/null 2>&1; ok "manager 를 띄웠습니다"; } \
            || { bad "manager 기동 실패 — 확인:"; echo "      $(cmd "pm2 logs manager")"; return 1; }
    fi

    step "다음"
    next_steps
}

# ── --header: 안내 셸이 프롬프트마다 그리는 칸 ───────────────────
#
# 줄 수를 늘 같게 맞춘다 (HEADER_LINES). 칸의 높이가 흔들리면 스크롤 영역도
# 흔들려 아래 출력이 한 줄씩 밀린다.
HEADER_LINES=8

header() {
    local cols="${COLUMNS:-$(tput cols 2>/dev/null || echo 80)}"
    local lines=() status what how tail1 tail2

    # 한 줄 요약 — 무엇이 됐고 무엇이 남았는지
    local s=""
    s+="$( [[ $HAVE_NODE -eq 1 && "$NODE_MAJOR" -ge 20 ]] && echo "✓ node" || echo "✗ node" )   "
    s+="$( [[ $HAVE_NPM -eq 1 ]]    && echo "✓ npm"  || echo "✗ npm" )   "
    s+="$( [[ $HAVE_PM2 -eq 1 ]]    && echo "✓ pm2"  || echo "· pm2" )   "
    s+="$( [[ $HAVE_DEPS -eq 1 ]]   && echo "✓ 의존성" || echo "· 의존성" )   "
    s+="$( [[ $HAVE_BUILD -eq 1 ]]  && echo "✓ 화면"   || echo "· 화면" )   "
    s+="$( [[ $HAVE_CONFIG -eq 1 ]] && echo "✓ 비밀번호" || echo "· 비밀번호" )   "
    s+="$( [[ $RUNNING -eq 1 ]]     && echo "✓ 기동"   || echo "· 기동" )"
    status="$s"

    # 첫 번째 남은 것 하나만 — 사람이 봐야 할 것은 다음 한 걸음이다.
    if [[ $HAVE_NODE -eq 0 || $HAVE_NPM -eq 0 ]]; then
        what="node 와 npm 이 없습니다. 서비스가 전부 node 로 돌고, 의존성은 npm 이 받습니다."
        how="$NODE_HOW"
        tail1="NodeSource 에서 node 20 을 설치합니다. 지울 배포판 패키지를 먼저 보여 주고 묻습니다."
    elif [[ "$NODE_MAJOR" -lt 20 ]]; then
        what="node ${NODE_MAJOR} 은 모자랍니다 — 20 이상이어야 합니다 (manager 가 fetch 를 씁니다)."
        how="$NODE_HOW"
        tail1="배포판 node 를 걷어내고 NodeSource 20 을 설치합니다. 지울 것을 먼저 보여 주고 묻습니다."
    elif [[ $HAVE_PM2 -eq 0 ]]; then
        what="pm2 가 없습니다. 서비스를 띄우고 재부팅 뒤 되살리는 데 씁니다."
        how="$PM2_HOW"
        tail1="sudo 로 전역 설치합니다 (npm install -g pm2)."
    elif [[ $HAVE_DEPS -eq 0 || $HAVE_BUILD -eq 0 || $HAVE_CONFIG -eq 0 || $RUNNING -eq 0 ]]; then
        local left=()
        [[ $HAVE_DEPS -eq 0 ]]   && left+=("의존성 설치")
        [[ $HAVE_BUILD -eq 0 ]]  && left+=("화면 빌드")
        [[ $HAVE_CONFIG -eq 0 ]] && left+=("관리자 콘솔 비밀번호")
        [[ $RUNNING -eq 0 ]]     && left+=("pm2 기동")
        local joined; joined="$(printf '%s · ' "${left[@]}")"
        what="관리 대시보드(manager)를 세울 차례입니다 — 남은 것: ${joined% · }."
        how="$APPLY_HOW"
        tail1="sudo 없이 됩니다. 비밀번호는 물어보고 해시로만 저장합니다. 몇 분 걸립니다."
    else
        what="준비가 끝났습니다. 브라우저로 구축 마법사를 여세요 — 나머지는 거기서 순서대로 안내합니다."
        how="http://127.0.0.1:$(MANAGER_PORT)/manager/setup"
        tail1="로그인 화면의 설정 버튼(⚙) → sysadmin 과 방금 정한 비밀번호 → 헤더의 구축 마법사."
    fi
    tail2="이 칸은 프롬프트마다 다시 계산됩니다. 나가려면 exit"

    lines+=("${BOLD}구축 준비${OFF}  ${DIM}${ROOT}${OFF}")
    lines+=("$status")
    lines+=("")
    lines+=("$what")
    lines+=("")
    lines+=("다음:  $(cmd "$how")")
    lines+=("${DIM}${tail1}${OFF}")
    lines+=("${DIM}${tail2}${OFF}")

    local l
    for l in "${lines[@]}"; do printf '%s\n' "$l"; done
}

# ── 안내 셸 ──────────────────────────────────────────────────────
#
# bash 를 --rcfile 로 띄운다. rc 는 사용자의 ~/.bashrc 를 먼저 읽고(PATH·별칭이
# 그대로다), PROMPT_COMMAND 에 그리기 함수를 앞세운다. 그 함수가 프롬프트마다
# `bootstrap.sh --header` 를 불러 위 칸을 다시 그리고 스크롤 영역을 그 아래로
# 잡는다. 화면을 지우는 명령(clear)은 아래 칸만 지우도록 덮는다.
guide() {
    if ! tput csr 0 1 >/dev/null 2>&1 || ! tput cup 0 0 >/dev/null 2>&1; then
        echo "이 터미널(TERM=${TERM:-없음})은 스크롤 영역을 지원하지 않습니다. 보고서로 대신합니다." >&2
        echo
        report
        return
    fi
    tput csr 0 "$(( $(tput lines) - 1 ))"     # 위 시험이 남긴 영역을 되돌린다

    local rc
    rc="$(mktemp)"
    cat >"$rc" <<'RC'
[[ -f ~/.bashrc ]] && source ~/.bashrc
shopt -s checkwinsize

__bs_header_lines=__HEADER_LINES__
__bs_self=__SELF__
export BOOTSTRAP_GUIDE=1

# 위 칸을 그리고 스크롤 영역을 그 아래로 잡는다. 커서는 있던 자리로 돌아간다.
__bs_draw() {
    local lines cols i h
    lines="$(tput lines)"; cols="$(tput cols)"
    hash -r     # 방금 설치한 node·pm2 를 셸이 옛 경로 기억 때문에 못 찾지 않게
    mapfile -t h < <(COLUMNS="$cols" "$__bs_self" --header 2>/dev/null)
    tput sc
    for ((i = 0; i < __bs_header_lines; i++)); do
        tput cup "$i" 0; tput el
        printf '%s' "${h[i]:-}"
    done
    tput cup "$__bs_header_lines" 0; tput el
    printf '%s' "$(printf '─%.0s' $(seq 1 "$cols"))"
    tput csr $((__bs_header_lines + 1)) $((lines - 1))
    tput rc
}

# 처음 한 번: 화면을 비우고 커서를 칸 아래에 둔다.
clear
__bs_draw
tput cup $((__bs_header_lines + 1)) 0

# clear 는 아래 칸만 지운다 — 통째로 지우면 커서가 위 칸으로 올라간다.
unalias clear 2>/dev/null
clear() { tput cup $((__bs_header_lines + 1)) 0; tput ed; }

# 창 크기가 바뀌면 영역도 다시 잡는다.
trap __bs_draw WINCH

# 나갈 때 스크롤 영역을 되돌린다. 안 그러면 다음 셸의 출력이 위 칸을 못 쓴다.
__bs_leave() { tput csr 0 "$(( $(tput lines) - 1 ))"; tput cup "$(( $(tput lines) - 1 ))" 0; echo; }
trap __bs_leave EXIT

PROMPT_COMMAND="__bs_draw${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
PS1="[구축] ${PS1:-\\w \\$ }"
RC
    sed -i "s|__HEADER_LINES__|${HEADER_LINES}|; s|^__bs_self=.*|__bs_self=$(printf '%q' "$SELF")|" "$rc"

    cd "$ROOT" || return 1
    bash --rcfile "$rc" -i
    local code=$?
    rm -f "$rc"
    return $code
}

probe
case "$MODE" in
    check)  report ;;
    apply)  apply ;;
    expose-http)  expose http ;;
    expose-https) expose https ;;
    header) header ;;
    guide)  guide ;;
esac
