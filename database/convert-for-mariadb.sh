#!/usr/bin/env bash
# MySQL 8.0 mysqldump 출력 → MariaDB 11.4 에서 읽히는 SQL 로 바꾼다.
#   사용: ./convert-for-mariadb.sh in.sql out.sql
# 바꾸는 것:
#   - MariaDB 가 해석하지 못하는 MySQL 8 전용 버전 주석 /*!80xxx ... */ 제거
#     (MariaDB 는 자기 버전 번호(110400)가 더 크다고 보고 이 주석을 실행하려 들어 오류가 난다)
#   - utf8mb4_0900_* 콜레이션 → MariaDB 11.4 의 UCA 14.0 콜레이션 (ai_ci / as_cs), 0900_bin → utf8mb4_bin
#   - GTID_PURGED 설정 줄 제거
set -euo pipefail
[[ $# -eq 2 ]] || { echo "usage: $0 in.sql out.sql" >&2; exit 2; }
sed -E \
  -e 's#/\*!80[0-9]{3}[^*]*\*/##g' \
  -e 's/utf8mb4_0900_ai_ci/utf8mb4_uca1400_ai_ci/g' \
  -e 's/utf8mb4_0900_as_cs/utf8mb4_uca1400_as_cs/g' \
  -e 's/utf8mb4_0900_as_ci/utf8mb4_uca1400_as_ci/g' \
  -e 's/utf8mb4_0900_bin/utf8mb4_bin/g' \
  -e '/^SET @@GLOBAL\.GTID_PURGED/d' \
  "$1" > "$2"
echo "변환: $1 -> $2"
echo "남은 위험 요소 (모두 0 이어야 한다):"
for k in '0900_' '/\*!80[0-9]{3}' 'ENCRYPTION' 'GTID_PURGED'; do printf "  %-14s %s\n" "$k" "$(grep -cE -- "$k" "$2" || true)"; done
