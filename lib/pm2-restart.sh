#!/usr/bin/env bash
#
# 이 서비스 폴더가 선언한 pm2 앱을 다시 띄운다. 빌드 뒤에 부르는 그 명령이다.
#
#   npm run restart                 services/<이름>/package.json 이 이 파일을 부른다
#   ../../lib/pm2-restart.sh        직접 불러도 같다 (서비스 폴더에서)
#   ../../lib/pm2-restart.sh --dry-run   무엇을 할지만 보여 준다
#
# ── 왜 공용 스크립트인가 ──────────────────────────────────────────────
#
# 서비스마다 pm2 앱 이름이 다르다 — manager ·
# 붙인 서비스들 … 그 이름을 package.json 마다 적어 두면 pm2-conf 의 선언과
# 어긋날 수 있고(이름을 바꾸면 두 곳을 고쳐야 한다), 서비스를 고친 사람은
# "이 폴더의 앱 이름이 뭐였지" 부터 찾아야 한다.
#
# 이름은 이미 한 곳에 있다 — 그 폴더의 pm2-conf/*.ini 다. ecosystem.config.js
# 가 pm2 에 넘기는 것도 그 파일이다. 그래서 여기서도 그것을 읽는다. 결과로
# 어느 서비스에서든 `cd services/<이름> && npm run build && npm run restart`
# 가 같은 명령이 된다.
#
# ── 하지 않는 일 ──────────────────────────────────────────────────────
#
# · 등록되지 않은 앱을 띄우지 않는다. 처음 올리는 것은 pm2 save 까지 이어지는
#   별개의 절차라(docs/guide/infrastructure.md '6.2 앱 목록은 선언을 훑어서 만든다'), 명령만 알려 준다.
# · 선언(script·cwd·env)을 다시 읽지 않는다. `pm2 restart <이름>` 은 pm2 가
#   이미 들고 있는 정의를 그대로 다시 돌린다 — 선언을 바꿨다면
#   `node pm2/ecosystem.config.js --check` 가 그 자리의 명령을 알려 준다.
# · 데몬을 다시 띄우지 않는다. 보조 그룹(pm2-conf 의 groups)이 바뀐 것은
#   pm2/restart.sh 의 일이다.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

DRY_RUN=0
SERVICE_DIR="$PWD"
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        -h|--help) sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        -*) echo "모르는 옵션: $arg" >&2; exit 2 ;;
        *) SERVICE_DIR="$(cd "$arg" && pwd)" ;;
    esac
done

ok()   { echo "  [ok]   $*"; }
no()   { echo "  [--]   $*"; }
warn() { echo "  [!!]   $*"; }
die()  { echo "오류: $*" >&2; exit 1; }

CONF_DIR="${SERVICE_DIR}/pm2-conf"
[[ -d "$CONF_DIR" ]] || die "pm2-conf/ 가 없습니다: ${SERVICE_DIR} — 서비스 폴더에서 실행하세요"

# [app] 절의 한 키를 읽는다. pm2/restart.sh 의 collect_groups 와 같은 관용구다 —
# ecosystem.config.js 의 파서를 부르지 않는 이유도 같다 (여기에 필요한 것은
# 이름과 enabled 뿐이고, node 를 띄우지 않아도 된다).
ini_app_key() {
    awk -F= -v key="$2" '
        /^\[app\]/ { s = 1; next }
        /^\[/      { s = 0 }
        s && $1 ~ ("^[[:space:]]*" key "[[:space:]]*$") { gsub(/[[:space:]]/, "", $2); print $2; exit }
    ' "$1"
}

APPS=()
for ini in "$CONF_DIR"/*.ini; do
    [[ -f "$ini" ]] || continue
    enabled="$(ini_app_key "$ini" enabled)"
    [[ "${enabled,,}" == "false" ]] && continue      # systemd 가 띄우는 껍데기 선언
    name="$(ini_app_key "$ini" name)"
    [[ -n "$name" ]] || die "$(basename "$ini") 에 [app] name 이 없습니다"
    APPS+=("$name")
done

if [[ ${#APPS[@]} -eq 0 ]]; then
    no "이 폴더는 pm2 가 띄우는 앱을 선언하지 않습니다 (pm2-conf/*.ini 가 전부 enabled = false)"
    exit 1
fi

command -v pm2 >/dev/null 2>&1 || die "pm2 가 없습니다. pm2/install_pm2.sh 를 먼저 보세요."

# 등록돼 있는가. `pm2 id` 는 없는 이름에도 0 으로 끝나므로 출력을 본다.
registered() { [[ "$(pm2 id "$1" 2>/dev/null | tr -d '[:space:]')" != "[]" ]]; }

problems=0
for name in "${APPS[@]}"; do
    if ! registered "$name"; then
        no "${name} — pm2 에 등록돼 있지 않습니다. 처음 올리는 것이면:"
        echo "         cd ${PROJECT_ROOT}/pm2 && pm2 start ecosystem.config.js --only ${name} && pm2 save"
        problems=$((problems + 1))
        continue
    fi
    if [[ $DRY_RUN -eq 1 ]]; then
        ok "${name} — pm2 restart ${name}  (dry-run)"
        continue
    fi
    if pm2 restart "$name" >/dev/null; then
        ok "${name} — 다시 띄웠습니다"
    else
        warn "${name} — 재시작에 실패했습니다: pm2 logs ${name} --lines 50"
        problems=$((problems + 1))
    fi
done

if [[ $DRY_RUN -eq 0 && $problems -eq 0 ]]; then
    # 앱이 포트를 잡을 시간을 잠깐 준다. 바로 죽는 앱(↺ 가 늘어남)은 이 뒤의
    # 상태에서 보인다.
    sleep 2
    for name in "${APPS[@]}"; do
        status="$(pm2 jlist 2>/dev/null | node -e '
            let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
                const i = s.indexOf("["), j = s.lastIndexOf("]");
                let a = []; try { a = JSON.parse(s.slice(i, j + 1)); } catch {}
                const p = a.find((x) => x.name === process.argv[1]);
                if (p) console.log((p.pm2_env || {}).status + " " + (p.pm2_env || {}).restart_time);
            });' "$name" 2>/dev/null || true)"
        case "${status%% *}" in
            online) ok "${name} online (재시작 ${status#* }회)" ;;
            "")     ;;
            *)      warn "${name} ${status%% *} — pm2 logs ${name} --lines 50"; problems=$((problems + 1)) ;;
        esac
    done
fi

[[ $problems -eq 0 ]] || exit 1
