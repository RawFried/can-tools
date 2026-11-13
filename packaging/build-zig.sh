#!/usr/bin/env bash
# 交叉编译（cargo-zigbuild）：用 zig 自带的 glibc 头文件产出可在旧发行版运行的二进制。
#
# 用法:
#   ./packaging/build-zig.sh                                   # x86_64, glibc 2.17 基线
#   TARGET=aarch64-unknown-linux-gnu.2.17 ./packaging/build-zig.sh
#   TARGET=x86_64-unknown-linux-musl ./packaging/build-zig.sh   # 需先 rustup target add
#
# 依赖: zig、cargo-zigbuild、对应 rustup target，以及已生成的前端产物。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${TARGET:-x86_64-unknown-linux-gnu.2.17}"

if [[ ! -f "${ROOT}/web/app.js" || ! -f "${ROOT}/web/app.css" ]]; then
  echo "缺少前端产物，请先执行: cd web && npm ci && npm run build" >&2
  exit 1
fi

# 目标机不需要 udev 热插拔；关闭宿主 libudev 探测，避免 vendored libusb
# 引入宿主的 /usr/include 与 glibc 2.38+ 符号。
export LIBUDEV_NO_PKG_CONFIG=1

(cd "${ROOT}" && cargo zigbuild --release --locked --target "${TARGET}" "$@")

TRIPLE="${TARGET%%.*}"
BIN="${ROOT}/target/${TRIPLE}/release/can-tools"
echo "产物: ${BIN}"
if command -v file >/dev/null 2>&1; then
  file "${BIN}"
fi
