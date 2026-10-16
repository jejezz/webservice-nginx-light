#!/usr/bin/env bash
#
# ./check-all.sh — 설치본이 저장소 선언과 어긋난 곳을 한 번에 본다.
#
# ── 무엇을 메우는가 ──────────────────────────────────────────────────
# 점검은 이미 곳곳에 있다. 문제는 **아무도 한 번에 묻지 않는다**는 것이다.
# 서비스를 고치고 나면 빌드·pm2·nginx 중 무엇이 남았는지 사람이 기억해야
# 하는데, 그 기억이 틀리면 증상은 조용하다 — 빈 화면, 404, "떠 있는데 중단".
#
# 2026-09-07 하루에 세 번 걸렸다.
#   · manager 의존성이 낡아 vite 가 엉뚱한 오류를 냈다
#   · manager 서버 코드는 새것인데 pm2 가 옛 코드를 돌아 /manager/docs 가 빈 화면
#   · 서비스를 깔고 pm2 까지 올렸는데 nginx 반영을 안 해 그 대시보드가 404
# 셋째는 nginx/install_nginx_stack.sh --check 가 **이미 알고 있었다.**
# 아무도 묻지 않았을 뿐이다.
#
# bootstrap.sh --check 는 이 자리가 아니다. 그것은 **빈 장비를 처음 세울 때**
# 필요한 것(node·npm·pm2·manager)을 보고 구축 마법사로 넘긴다. 이미 돌고 있는
# 장비가 선언과 어긋났는지는 보지 않는다.
#
# ── 새로 만든 판정은 없다 ────────────────────────────────────────────
# 전부 docs/guide/contracts.md '점검 규약' 의 `--json` 을 그대로 읽는다 (구현은
# lib/check-report.sh). 이 파일은 훑어서 모으고 순서대로 보여 줄 뿐이다.
# 판정을 여기서 다시 내리면 진짜가 둘이 된다.
#
# ── 부르는 명령은 전부 읽기 전용이다 ─────────────────────────────────
# 아래 표의 명령은 하나씩 확인했다. install.sh 계열은 MODE="check" 가 기본이고
# --apply 를 줘야만 쓴다. site/apply.sh 도 마찬가지다(--apply 로만 적용).
# **이 표에 --apply 나 --build 를 넣지 마라.** 점검이 반영으로 바뀐다.
#
# ── 일부러 뺀 것 ─────────────────────────────────────────────────────
#   nginx/public_ca/* · nginx/tls-decide.sh   인증서 발급 절차(사람이 정할 일)
#   */bootstrap.sh                            의존성 설치 단계
# 이것들은 "어긋났는가" 가 아니라 "지금 할 것인가" 를 묻는 단계다.
#
# set -e 는 쓰지 않는다 — 점검 하나가 1 로 끝나는 것은 정상이고(계약상
# complete 가 아니면 1), -e 면 거기서 조용히 멈춘다. 이 저장소가 이미 한 번
# 겪은 지뢰다 (커밋 abb4dc2).
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'

TIMEOUT=120
ONLY_BAD=0
MODE=text        # text | json — json 은 --one 이 줄 하나의 결과를 기계가 읽는 모양으로 낸다
ONE=""
LIST_JSON=0

usage() {
    cat <<'EOF'
Usage: ./check-all.sh [옵션]

  -q, --quiet    어긋난 것만 보여 준다 (정상은 줄이지 않고 아예 뺀다)
  --list-json    점검 줄의 목록(번호·이름)을 JSON 으로 낸다 (manager 화면용)
  --one N        N 번 줄 하나만 점검한다. --json 을 더하면 JSON 으로 낸다 (manager 화면용)
  -h, --help     이 도움말

아무것도 바꾸지 않습니다. 고치는 명령은 찾은 자리마다 보여 주기만 합니다.
종료 코드: 전부 정상이면 0, 하나라도 어긋났으면 1. (--list-json · --one --json 은 결과가
JSON 에 들어 있으므로 점검이 어긋나도 0 입니다.)
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -q|--quiet)  ONLY_BAD=1 ;;
        --list-json) LIST_JSON=1 ;;
        --one)       shift; ONE="${1:-}"
                     [[ "$ONE" =~ ^[0-9]+$ ]] || { echo "--one 은 줄 번호(0 부터)가 필요합니다" >&2; exit 2; } ;;
        --json)      MODE=json ;;
        -h|--help)   usage; exit 0 ;;
        *) echo "모르는 옵션: $1" >&2; usage >&2; exit 2 ;;
    esac
    shift
done
[[ "$MODE" == json && -z "$ONE" ]] && { echo "--json 은 --one 과 함께 씁니다" >&2; exit 2; }

# 이름 | 읽기 전용 명령 | 어긋났을 때 돌릴 것 | (선택) optional | (선택) 마법사 단계 id
#
# 넷째 칸 `optional` 은 **쓰지 않아도 되는 기능**이다. 아직 안 한 것(incomplete)은
# 어긋남으로 세지 않고, 한 뒤에 어긋난 것(problem)만 센다 — 안 쓰기로 한 기능이
# 빨갛게 남아 이 점검을 늘 실패시키면 사람이 결과를 읽지 않게 된다.
#
# 다섯째 칸 `단계 id` 는 이 줄을 고치는 단계다 — **구축 마법사의 단계**(services/manager 의 setup.js STEPS)이거나,
# 마법사로는 나타낼 수 없는 **점검 전용 반영**(같은 곳의 services/checks.js CHECK_ONLY. 예: 서비스별 재빌드).
# manager 점검 화면이 어긋난 줄에서 '자동으로 반영' 을 내밀 때 그 단계의 자동 실행 표를 쓴다 — 위
# '어긋났을 때 돌릴 것' 은 사람이 읽는 대화형 명령이고, 화면이 돌리는 것은 단계 표의 --yes 판이라 서로
# 다르다. 비워 두면 화면은 반영을 내밀지 않는다. pm2 줄과 manager 줄을 일부러 비웠다 — `pm2 save` 는
# 어긋난 설정을 굳히고, manager 를 재시작하면 그 화면이 끊긴다.
#
# 순서는 docs/guide/rollout.md 의 '등록 순서'를 따른다 — 선언 → DB → 서비스 →
# 대시보드 → nginx. nginx 가 맨 마지막인 것은 전체 라우팅을 다시 쓰는 유일한
# 단계이기 때문이다. 그래서 여기서도 마지막에 묻는다.
CHECKS=(
  "사이트 값|./site/apply.sh --json|./site/apply.sh --apply||site.settings"
  "데이터베이스|./database/check-database.sh --check --json|sudo ./database/setup_mariadb.sh||database.schema"
  "nginx 라우팅|./nginx/install_nginx_stack.sh --check --json|sudo ./nginx/install_nginx_stack.sh --skip-install||nginx.routes"
)


PROBLEMS=0

# ── 줄 하나의 결과를 내보내는 유일한 자리 ─────────────────────────────
# 판정은 아래 run_* 가 내리고, 이 함수는 **같은 판정을** 사람이 읽는 줄 또는 JSON 으로
# 보여 줄 뿐이다. manager 화면(/manager/checks)이 --json 으로 읽는 것도 이 출력이라, 화면과
# 터미널이 갈라질 수 없다.
#
#   report 상태 이름 반영명령 [상세 줄...]
#   상태: ok · problem(어긋남) · pending(아직 안 한 것) · optional(선택, 아직 안 함)
#         unreadable(결과를 못 읽음 — 어긋남으로 세지 않는다) · timeout
report() {
    local status="$1" label="$2" fix="$3"; shift 3

    if [[ "$MODE" == json ]]; then
        node -e '
            const [status, label, fix, ...lines] = process.argv.slice(1);
            console.log(JSON.stringify({
                status, label,
                fix: fix.replace(/\x1b\[[0-9;]*m/g, ""),
                lines: lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")),
            }));
        ' -- "$status" "$label" "$fix" "$@"
        return
    fi

    local text
    case "$status" in
        ok)
            [[ $ONLY_BAD -eq 1 ]] || echo "  ${GREEN}✓${OFF} ${label}" ;;
        timeout)
            echo "  ${RED}✗${OFF} ${label}  ${DIM}— ${TIMEOUT}초 안에 끝나지 않았습니다${OFF}"
            PROBLEMS=$((PROBLEMS + 1)) ;;
        unreadable)
            echo "  ${YELLOW}·${OFF} ${label}  ${DIM}— 점검 결과를 읽지 못했습니다 (직접 돌려 보세요)${OFF}"
            echo "        ${DIM}${1:-}${OFF}" ;;
        optional)
            [[ $ONLY_BAD -eq 1 ]] || echo "  ${DIM}-${OFF} ${label}  ${DIM}(선택 — 아직 안 했습니다)${OFF}" ;;
        problem|pending)
            if [[ "$status" == problem ]]; then
                echo "  ${RED}✗${OFF} ${label}"
            else
                echo "  ${YELLOW}·${OFF} ${label}  ${DIM}(아직 안 한 것)${OFF}"
            fi
            for text in "$@"; do
                [[ -z "$text" ]] && continue
                echo "        ${DIM}${text}${OFF}"
            done
            # 줄마다 자기 해결 명령을 이미 달고 있는 경우가 많다. 이것은 그 위에
            # 덧붙이는 **이 서비스의 반영 명령**이지, 위 모든 줄의 해법이 아니다.
            [[ -n "$fix" ]] && echo "        ${DIM}이 서비스의 반영 명령:${OFF} ${fix}"
            PROBLEMS=$((PROBLEMS + 1)) ;;
    esac
}

# --json 한 건을 돌려 판정한다. 어긋났으면 그 줄들도 붙인다.
run_json() {
    local label="$1" cmd="$2" fix="$3" optional="${4:-}" out
    out="$(timeout "$TIMEOUT" bash -c "$cmd" 2>/dev/null)"
    if [[ $? -eq 124 ]]; then
        report timeout "$label" "$fix"; return
    fi

    # state 와 어긋난 줄만 뽑는다. 파싱은 node 로 한다 — 이 저장소는 node 를
    # 이미 요구한다 (bootstrap.sh --check 가 먼저 그것을 본다).
    local parsed
    parsed="$(printf '%s' "$out" | node -e '
        let s = "";
        process.stdin.on("data", (d) => (s += d)).on("end", () => {
            const i = s.indexOf("{"), j = s.lastIndexOf("}");
            if (i < 0 || j < i) { console.log("PARSE"); return; }
            let o; try { o = JSON.parse(s.slice(i, j + 1)); } catch { console.log("PARSE"); return; }
            console.log(o.state);
            for (const c of o.checks || []) {
                if (c.level === "problem" || c.level === "pending") console.log(c.level + "\t" + c.text);
            }
        });
    ' 2>/dev/null)"

    local state; state="$(head -1 <<< "$parsed")"
    case "$state" in
        complete)
            report ok "$label" "$fix"; return ;;
        PARSE|"")
            # 못 읽은 것은 어긋남으로 세지 않는다 — 계약의 'skip' 과 같은 자세
            report unreadable "$label" "$fix" "${cmd% --json}"; return ;;
    esac

    # 선택 기능은 '아직 안 한 것' 으로 끝나면 통과다. 한 뒤에 어긋난 것(problem)만 센다.
    if [[ "$state" == "incomplete" && "$optional" == "optional" ]]; then
        report optional "$label" "$fix"; return
    fi

    local details=() level text
    while IFS=$'\t' read -r level text; do
        [[ -z "${text:-}" ]] && continue
        details+=("$text")
    done < <(tail -n +2 <<< "$parsed")

    if [[ "$state" == "problem" ]]; then
        report problem "$label" "$fix" "${details[@]}"
    else
        report pending "$label" "$fix" "${details[@]}"
    fi
}

# manager 는 --json 을 내지 않는다. 세 점검이 services/manager 의 node 스크립트로 붙어 있어서
# (package.json 의 prebuild·postbuild) 그대로 부르고 결과를 옮긴다. check-deps 는 종료 코드로,
# check-build 와 check-restart 는 출력 유무로 말한다 — 뒤 둘은 빌드를 막지 않으려고 일부러
# 늘 0 으로 끝난다.
run_manager() {
    local label="$1" script="$2" how="$3" out rc bad=0
    out="$(cd services/manager && node "$script" 2>&1)"; rc=$?
    if [[ "$how" == exit ]]; then
        [[ $rc -ne 0 ]] && bad=1
    else
        [[ -n "${out//[[:space:]]/}" ]] && bad=1
    fi

    if [[ $bad -eq 0 ]]; then
        report ok "$label" ""; return
    fi
    # 빈 줄은 버린다 — 색을 입히고 나서 거르면 이스케이프만 남은 줄이 된다.
    local details=()
    mapfile -t details < <(grep -v '^[[:space:]]*$' <<< "$out")
    report problem "$label" "" "${details[@]}"
}

# ── 점검 줄의 순서 ───────────────────────────────────────────────────
# 표의 순서를 지키되 nginx 는 맨 마지막에 묻는다 (docs/guide/rollout.md '세 가지 원칙'):
# 훑어서 하나로 합치는 유일한 단계라서, 앞의 것들이 어긋난 채로 nginx 만 반영하면 라우트는
# 열리는데 뒤에 아무도 없는 상태가 된다. 그 뒤에 pm2 를 묻는 것은, 반영이 끝나도 재부팅하면
# 사라지면 소용없기 때문이다 (판정은 pm2/ecosystem.config.js 가 낸다 — 마법사 '3. pm2 설치와
# 부팅 등록' 과 같은 것).
#
# 번호(0 부터)가 줄의 id 다 — --one N 과 manager 화면이 이 번호로 부른다. 화면은 명령을 보내지
# 않고 번호만 보내므로, 여기 없는 명령은 돌릴 수 없다.
#
# 줄 = 종류|이름|명령|반영 명령|optional
ROWS=()
for row in "${CHECKS[@]}"; do
    [[ "${row%%|*}" == "nginx 라우팅" ]] && continue
    ROWS+=("json|$row")
done
ROWS+=("manager|manager 의존성|check-deps.js exit||")
ROWS+=("manager|manager 화면 빌드|check-build.js output||")
ROWS+=("manager|manager 프로세스|check-restart.js output||")
for row in "${CHECKS[@]}"; do
    [[ "${row%%|*}" == "nginx 라우팅" ]] && ROWS+=("json|$row")
done
ROWS+=("json|pm2 부팅 등록·재부팅 목록|node pm2/ecosystem.config.js --check-json|pm2 save  ${DIM}그리고 위 줄이 알려 주는 부팅 등록 명령${OFF}|")

run_row() {
    local kind label cmd fix optional step
    IFS='|' read -r kind label cmd fix optional step <<< "$1"
    case "$kind" in
        json)    run_json "$label" "$cmd" "$fix" "$optional" ;;
        manager) run_manager "$label" "${cmd% *}" "${cmd#* }" ;;
    esac
}

if [[ $LIST_JSON -eq 1 ]]; then
    labels=() ; optionals=() ; steps=()
    for row in "${ROWS[@]}"; do
        IFS='|' read -r _ label _ _ optional step <<< "$row"
        labels+=("$label"); optionals+=("${optional:--}"); steps+=("${step:--}")
    done
    node -e '
        const a = process.argv.slice(1), n = a.length / 3;
        console.log(JSON.stringify({ checks: Array.from({ length: n }, (_, i) => ({
            id: i, label: a[i], optional: a[n + i] === "optional", step: a[2 * n + i] === "-" ? null : a[2 * n + i],
        })) }));
    ' -- "${labels[@]}" "${optionals[@]}" "${steps[@]}"
    exit 0
fi

if [[ -n "$ONE" ]]; then
    if (( ONE >= ${#ROWS[@]} )); then
        echo "줄 번호가 범위를 벗어났습니다: $ONE (0..$(( ${#ROWS[@]} - 1 )))" >&2
        exit 2
    fi
    run_row "${ROWS[$ONE]}"
    [[ "$MODE" == json ]] && exit 0
    [[ $PROBLEMS -eq 0 ]] && exit 0 || exit 1
fi

echo
echo "${DIM}──${OFF} 설치본이 선언과 같은가"
echo

for row in "${ROWS[@]}"; do
    run_row "$row"
done

echo
if [[ $PROBLEMS -eq 0 ]]; then
    echo "  ${GREEN}설치본이 선언과 같습니다.${OFF}"
    echo
    exit 0
fi
echo "  ${YELLOW}${PROBLEMS}곳이 어긋나 있습니다.${OFF} ${DIM}위 순서대로 처리하세요 — nginx 가 맨 마지막입니다.${OFF}"
echo "  ${DIM}자세한 순서와 되돌리는 법: docs/guide/rollout.md '안전한 반영 순서' · '되돌리기'${OFF}"
echo
exit 1
