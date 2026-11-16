#!/usr/bin/env bash
# 构建 Debian/Ubuntu .deb 包（安装后包含 systemd 服务与 udev 权限规则）。
#
# 用法:
#   ./packaging/build-deb.sh                       # 本机架构，zigbuild，glibc 2.17 基线
#   ARCH=arm64 ./packaging/build-deb.sh            # 交叉构建 arm64
#   ZIG=0 ./packaging/build-deb.sh                 # 原生构建（仅同架构，依赖本机 glibc）
#   SKIP_BUILD=1 BIN=target/.../can-tools ./packaging/build-deb.sh
#
# 产物: dist/can-tools_<version>_<arch>.deb
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' "${ROOT}/Cargo.toml" | head -n 1)"

host_arch() {
  case "$(uname -m)" in
    x86_64) echo amd64 ;;
    aarch64 | arm64) echo arm64 ;;
    *) echo unknown ;;
  esac
}

HOST_DEB="$(host_arch)"
ARCH="${ARCH:-${HOST_DEB}}"
case "${ARCH}" in
  amd64) TRIPLE="x86_64-unknown-linux-gnu" ;;
  arm64) TRIPLE="aarch64-unknown-linux-gnu" ;;
  *)
    echo "不支持的 ARCH=${ARCH}（可选 amd64 / arm64）" >&2
    exit 1
    ;;
esac

ZIG="${ZIG:-1}"
GLIBC="${GLIBC:-2.17}"

if [[ ! -f "${ROOT}/web/app.js" || ! -f "${ROOT}/web/app.css" ]]; then
  echo "缺少前端产物，请先执行: cd web && npm ci && npm run build" >&2
  exit 1
fi

BIN="${BIN:-}"
if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  if [[ "${ZIG}" == "1" ]]; then
    command -v cargo-zigbuild >/dev/null 2>&1 || {
      echo "缺少 cargo-zigbuild，请先 cargo install cargo-zigbuild" >&2
      exit 1
    }
    command -v zig >/dev/null 2>&1 || {
      echo "缺少 zig，请先安装（https://ziglang.org/download/）" >&2
      exit 1
    }
    (cd "${ROOT}" && LIBUDEV_NO_PKG_CONFIG=1 \
      cargo zigbuild --release --locked --target "${TRIPLE}.${GLIBC}")
    BIN="${ROOT}/target/${TRIPLE}/release/can-tools"
  else
    if [[ "${ARCH}" != "${HOST_DEB}" ]]; then
      echo "ZIG=0 只能构建本机架构（${HOST_DEB}）；交叉构建请用 ZIG=1" >&2
      exit 1
    fi
    (cd "${ROOT}" && cargo build --release --locked)
    BIN="${ROOT}/target/release/can-tools"
  fi
fi
if [[ ! -x "${BIN}" ]]; then
  echo "缺少可执行文件: ${BIN}" >&2
  exit 1
fi

# 依赖声明按二进制实际引用的最高 glibc 版本生成（跨架构也能用 strings 读取）。
GLIBC_REQ="$(strings "${BIN}" | grep -o 'GLIBC_[0-9.]*' | sed 's/^GLIBC_//' | sort -V | tail -n 1 || true)"
GLIBC_REQ="${GLIBC_REQ:-${GLIBC}}"

DIST="${ROOT}/dist"
STAGE="${DIST}/deb/${ARCH}"
OUT="${DIST}/can-tools_${VERSION}_${ARCH}.deb"
rm -rf "${STAGE}"
mkdir -p \
  "${STAGE}/DEBIAN" \
  "${STAGE}/usr/bin" \
  "${STAGE}/lib/systemd/system" \
  "${STAGE}/lib/udev/rules.d" \
  "${STAGE}/usr/share/doc/can-tools"

install -m 0755 "${BIN}" "${STAGE}/usr/bin/can-tools"
install -m 0644 "${ROOT}/packaging/systemd/can-tools.service" \
  "${STAGE}/lib/systemd/system/can-tools.service"
install -D -m 0755 "${ROOT}/packaging/can-up.sh" \
  "${STAGE}/usr/lib/can-tools/can-up.sh"
install -D -m 0644 "${ROOT}/packaging/systemd/can-tools-can.service" \
  "${STAGE}/lib/systemd/system/can-tools-can.service"
install -D -m 0644 "${ROOT}/packaging/default/can-tools-can" \
  "${STAGE}/etc/default/can-tools-can"
install -m 0644 "${ROOT}/packaging/udev/99-usbcan.rules" \
  "${STAGE}/lib/udev/rules.d/99-usbcan.rules"
install -m 0644 "${ROOT}/README.md" "${STAGE}/usr/share/doc/can-tools/README.md"
install -m 0644 "${ROOT}/LICENSE" "${STAGE}/usr/share/doc/can-tools/copyright"

printf '%s\n' /etc/default/can-tools-can > "${STAGE}/DEBIAN/conffiles"

SIZE_KB="$(du -sk "${STAGE}" | cut -f1)"
cat > "${STAGE}/DEBIAN/control" <<EOF
Package: can-tools
Version: ${VERSION}
Architecture: ${ARCH}
Maintainer: CAN Tools <wangtianci@iplusmobot.com>
Installed-Size: ${SIZE_KB}
Depends: libc6 (>= ${GLIBC_REQ})
Section: utils
Priority: optional
Homepage: https://github.com/example/can-tools
Description: USBCAN/SocketCAN web host with DBC signal charts
 CAN Tools hosts a local web UI for Chuangxin USBCAN-II/CANalyst-II
 adapters and Linux SocketCAN links: baud/mode setup, filters, live
 frames, CSV recording, DBC decoding and signal charts.
EOF

cat > "${STAGE}/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e

if ! getent group can >/dev/null 2>&1; then
  groupadd -r can || true
fi
if ! getent passwd can >/dev/null 2>&1; then
  useradd -r -g can -d /var/lib/can-tools -s /usr/sbin/nologin can || true
fi
install -d -o can -g can -m 0755 /var/lib/can-tools || true

if command -v udevadm >/dev/null 2>&1; then
  udevadm control --reload-rules || true
  udevadm trigger --subsystem-match=usb --action=add || true
fi

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload || true
  # 应用改为手动启动: 安装/升级不再自动启用或启动 can-tools.service
  systemctl disable can-tools.service >/dev/null 2>&1 || true
  # CAN 接口仍开机自动 UP (按 /etc/default/can-tools-can)
  systemctl enable can-tools-can.service || true
  systemctl restart can-tools-can.service || true
fi
exit 0
EOF

cat > "${STAGE}/DEBIAN/prerm" <<'EOF'
#!/bin/sh
set -e
if [ "$1" = "remove" ] || [ "$1" = "deconfigure" ]; then
  if command -v systemctl >/dev/null 2>&1; then
    systemctl stop can-tools.service || true
    systemctl disable can-tools.service || true
    systemctl stop can-tools-can.service || true
    systemctl disable can-tools-can.service || true
  fi
fi
exit 0
EOF

cat > "${STAGE}/DEBIAN/postrm" <<'EOF'
#!/bin/sh
set -e
if [ "$1" = "remove" ] || [ "$1" = "purge" ]; then
  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload || true
  fi
fi
exit 0
EOF
chmod 0755 "${STAGE}/DEBIAN/postinst" "${STAGE}/DEBIAN/prerm" "${STAGE}/DEBIAN/postrm"

# 旧版 dpkg（如 Ubuntu 16.04 的 1.18）不识别 zstd；显式用 xz 以保证兼容。
COMPRESS="${DEB_COMPRESS:-xz}"
if dpkg-deb --help 2>&1 | grep -q -- '--root-owner-group'; then
  dpkg-deb --root-owner-group -Z"${COMPRESS}" --build "${STAGE}" "${OUT}"
elif command -v fakeroot >/dev/null 2>&1; then
  fakeroot dpkg-deb -Z"${COMPRESS}" --build "${STAGE}" "${OUT}"
else
  dpkg-deb -Z"${COMPRESS}" --build "${STAGE}" "${OUT}"
fi

echo "产物: ${OUT}"
dpkg-deb --info "${OUT}" | sed -n '1,12p'
