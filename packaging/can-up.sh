#!/bin/sh
# 按 /etc/default/can-tools-can 配置 SocketCAN 接口（开机自动 UP）。
#
# 配置格式: CAN_INTERFACES="can0:500000 can1:250000"（接口:速率，空格分隔）。
# 已 UP 的接口会跳过；接口在启动后最多等待 10 秒出现。
set -u

CONF="${CAN_TOOLS_CAN_CONF:-/etc/default/can-tools-can}"
# shellcheck disable=SC1090
[ -r "$CONF" ] && . "$CONF"
: "${CAN_INTERFACES:=can0:500000}"

IP="$(command -v ip || true)"
if [ -z "$IP" ]; then
  echo "can-up: ip command not found"
  exit 0
fi

for pair in $CAN_INTERFACES; do
  iface=${pair%%:*}
  rate=${pair#*:}
  if [ "$rate" = "$pair" ]; then
    rate=500000
  fi
  case "$iface" in
    can*) ;;
    *)
      echo "can-up: skip non-can interface $iface"
      continue
      ;;
  esac
  case "$rate" in
    '' | *[!0-9]*)
      echo "can-up: invalid bitrate '$rate' for $iface, using 500000"
      rate=500000
      ;;
  esac

  i=0
  while [ "$i" -lt 20 ] && [ ! -e "/sys/class/net/$iface" ]; do
    i=$((i + 1))
    sleep 0.5
  done
  if [ ! -e "/sys/class/net/$iface" ]; then
    echo "can-up: $iface not found"
    continue
  fi

  if "$IP" -br link show "$iface" 2>/dev/null | grep -Eq '(^| )UP( |$)'; then
    echo "can-up: $iface already up"
    continue
  fi
  if ! "$IP" link set "$iface" type can bitrate "$rate" restart-ms 100; then
    echo "can-up: setting $iface bitrate failed"
  fi
  if "$IP" link set "$iface" up; then
    echo "can-up: $iface up ($rate bit/s)"
  else
    echo "can-up: bringing $iface up failed"
  fi
done
exit 0
