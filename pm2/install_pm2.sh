#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOOT_SH="$SCRIPT_DIR/pm2-boot.sh"
BOOT_LINE="@reboot sleep 20 && /bin/bash $BOOT_SH >> $SCRIPT_DIR/pm2-boot.log 2>&1"

# 부팅 등록은 crontab @reboot 하나로 통일한다 (pm2 startup systemd 는 쓰지 않는다 —
# 둘이 겹치면 부팅 때 resurrect 가 두 번 돈다). 이미 있으면 다시 넣지 않는다.
register_boot() {
    if crontab -l 2>/dev/null | grep -v '^[[:space:]]*#' | grep '@reboot' | grep -qF "$BOOT_SH"; then
        echo "부팅 등록: 이미 crontab 에 있습니다"
    else
        (crontab -l 2>/dev/null || true; echo "$BOOT_LINE") | crontab -
        echo "부팅 등록: crontab @reboot 를 넣었습니다 ($BOOT_SH)"
    fi
}

unregister_boot() {
    crontab -l 2>/dev/null | grep -vF "$BOOT_SH" | crontab - 2>/dev/null || true
}

usage() {
    echo "Usage: $0 {install|update|uninstall}"
    exit 1
}

check_node() {
    if ! command -v node &>/dev/null; then
        echo "Error: Node.js is not installed."
        echo "Install Node.js first: https://nodejs.org/"
        exit 1
    fi
    echo "Node.js: $(node -v)"
}

install_pm2() {
    echo "=== Installing PM2 ==="
    check_node

    if command -v pm2 &>/dev/null; then
        echo "PM2 is already installed: $(pm2 -v)"
        echo "Use '$0 update' to update instead."
        exit 1
    fi

    sudo npm install -g pm2

    # 재부팅 시 자동 시작 (crontab @reboot → pm2-boot.sh → pm2 resurrect)
    register_boot

    echo ""
    echo "=== PM2 installed successfully ==="
    echo "PM2: $(pm2 -v)"
    echo ""
    echo "Next steps:"
    echo "  cd $(dirname "$0")"
    echo "  pm2 start ecosystem.config.js"
    echo "  pm2 save     # 부팅 때 되살아날 목록을 저장 (이게 없으면 부팅 등록이 빈 목록을 되살린다)"
}

update_pm2() {
    echo "=== Updating PM2 ==="
    check_node

    if ! command -v pm2 &>/dev/null; then
        echo "PM2 is not installed. Use '$0 install' first."
        exit 1
    fi

    echo "Current: $(pm2 -v)"
    sudo npm install -g pm2@latest
    echo "Updated: $(pm2 -v)"

    pm2 update

    echo "=== PM2 updated successfully ==="
}

uninstall_pm2() {
    echo "=== Uninstalling PM2 ==="

    if ! command -v pm2 &>/dev/null; then
        echo "PM2 is not installed."
        exit 0
    fi

    pm2 kill 2>/dev/null || true
    unregister_boot
    sudo npm uninstall -g pm2

    echo "=== PM2 uninstalled ==="
}

if [[ $# -ne 1 ]]; then
    usage
fi

case "$1" in
    install)   install_pm2 ;;
    update)    update_pm2 ;;
    uninstall) uninstall_pm2 ;;
    *)         usage ;;
esac
