#!/usr/bin/env bash
#
# 사이트 값 — **여러 곳이 함께 쓰는 것들**을 한 곳에서 받는다.
#
#   ./site/apply.sh              지금 상태를 본다 (아무것도 바꾸지 않는다)
#   ./site/apply.sh --check --json   구축 마법사용 (docs/guide/contracts.md '점검 규약')
#   ./site/apply.sh --apply      값을 반영한다 (sudo 불필요)
#
# ── 왜 서비스 위에 층이 하나 더 있나 ────────────────────────────
# 설정 규약(docs/guide/contracts.md '사이트 층')의 단위는 서비스 하나다. 그래서 nginx 와
# 인증서와 manager 가 함께 쓰는 host 를 둘 자리가 없으면 각자 자기 파일에 베껴 적게 되고,
# 어긋나도 서버는 멀쩡히 돌고 로그도 조용하다. 여기서 한 번 받고 나머지가 그 값에서 나온다.
#
# ── 무엇을 여기 두고 무엇을 안 두나 ─────────────────────────────
# **둘 이상이 쓰는 값만** 여기 둔다 (host · tls_mode). 한 서비스만 쓰는 것은 그 서비스의
# settings.ini 에 그대로 둔다.
#
# ── 왜 DB 가 아닌가 ─────────────────────────────────────────────
# nginx 는 systemd 가 띄우고 **시작할 때 파일을 읽는다.** DB 를 읽을 방법이 없다. 게다가
# DB 자체가 설정된 대상이라(database.ini) 설정의 출처가 설정을 필요로 하게 된다.
# DB 는 **런타임 상태**를 맡는다 — 관리자 계정·승인 대기·감사 로그.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SETTINGS="${SCRIPT_DIR}/settings.ini"
APPLIED="${SCRIPT_DIR}/.applied-settings"

source "${REPO_ROOT}/lib/check-report.sh"
check_init "site.settings"
check_args "$@"
set -- "${CHECK_REST[@]:-}"

MODE="check"
for a in "$@"; do
    case "$a" in
        --apply) MODE="apply" ;;
        --check|"") ;;
        -h|--help) sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "모르는 옵션: $a" >&2; exit 2 ;;
    esac
done

# `키 = 값` 만 읽는다. 섹션은 쓰지 않는다 — 항목이 몇 개뿐이고, 규약의 다른
# settings.ini 들도 평평하다.
value_of() {
    [[ -r "$2" ]] || return 0
    sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\(.*\)$/\1/p" "$2" | tail -1 | sed 's/[[:space:]]*$//'
}

HOST="$(value_of host "$SETTINGS")"

if [[ "$MODE" == "apply" ]]; then
    [[ -n "$HOST" ]] || { echo "host 를 먼저 채우세요: ${SETTINGS}" >&2; exit 1; }

    # 반영이라고 할 수 있는 것은 반영본을 남기는 일뿐이다. nginx 는 자기 설치
    # 스크립트가 설정 파일을 다시 쓸 때 이 값을 읽는다 — 그건 sudo 가 필요해
    # 여기서 하지 않는다. 무엇이 남았는지는 아래에 적는다.
    cp -f "$SETTINGS" "$APPLIED"
    echo "반영했습니다: ${APPLIED}"
    echo
    echo "아직 남은 것 (nginx 가 sudo 로 자기 파일을 다시 씁니다):"
    echo "  sudo ./nginx/install_nginx_stack.sh --skip-install"
    exit 0
fi

# ── 점검 ────────────────────────────────────────────────────────
info "사이트 값 (여러 곳이 함께 쓰는 것)"

if [[ ! -f "$SETTINGS" ]]; then
    pend "아직 값이 없습니다: site/settings.ini — 마법사에서 채우세요"
    check_finish
    exit 1
fi

if [[ -n "$HOST" ]]; then ok "host = ${HOST}"; else pend "host 가 비어 있습니다"; fi

# 저장은 했는데 아직 반영하지 않은 상태를 가른다.
if [[ -n "$HOST" ]]; then
    if [[ ! -f "$APPLIED" ]]; then
        pend "저장한 값을 아직 반영하지 않았습니다 → ./site/apply.sh --apply"
    elif ! diff -q "$SETTINGS" "$APPLIED" >/dev/null 2>&1; then
        pend "저장한 값이 반영본과 다릅니다 → ./site/apply.sh --apply"
    else
        ok "반영본과 같습니다"
    fi
fi

check_finish
echo
echo "값을 고치려면 ${SETTINGS} 를 편집하거나 마법사에서 입력한 뒤 --apply 하세요."
