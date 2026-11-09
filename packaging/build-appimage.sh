#!/usr/bin/env bash
# 构建可分发的 AppImage。
#
# 用法:
#   ./packaging/build-appimage.sh              # 编译 release 并打包
#   SKIP_BUILD=1 ./packaging/build-appimage.sh # 复用 target/release/can-tools
#   APPIMAGETOOL=/path/to/appimagetool ...     # 使用本地 appimagetool
#   APPIMAGE_RUNTIME=/path/to/runtime-x86_64 . # 使用本地 type2 runtime
#
# 产物: dist/can-tools-<version>-<arch>.AppImage
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' "${ROOT}/Cargo.toml" | head -n 1)"
ARCH="${ARCH:-$(uname -m)}"
case "${ARCH}" in
  x86_64 | aarch64) ;;
  *)
    echo "不支持的架构: ${ARCH}" >&2
    exit 1
    ;;
esac

DIST="${ROOT}/dist"
APPDIR="${DIST}/AppDir"
TOOLS="${ROOT}/.tools"
OUTPUT="${DIST}/can-tools-${VERSION}-${ARCH}.AppImage"
BIN="${ROOT}/target/release/can-tools"

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  (cd "${ROOT}" && cargo build --release --locked)
fi
if [[ ! -x "${BIN}" ]]; then
  echo "缺少 ${BIN}; 请先执行 cargo build --release" >&2
  exit 1
fi
if [[ ! -f "${ROOT}/web/icon.svg" ]]; then
  echo "缺少 web/icon.svg (AppImage 图标)" >&2
  exit 1
fi

rm -rf "${APPDIR}"
install -Dm755 "${BIN}" "${APPDIR}/usr/bin/can-tools"
install -Dm755 "${ROOT}/packaging/AppRun" "${APPDIR}/AppRun"
install -Dm644 "${ROOT}/packaging/can-tools.desktop" \
  "${APPDIR}/usr/share/applications/can-tools.desktop"
cp "${ROOT}/packaging/can-tools.desktop" "${APPDIR}/can-tools.desktop"
install -Dm644 "${ROOT}/web/icon.svg" \
  "${APPDIR}/usr/share/icons/hicolor/scalable/apps/can-tools.svg"
cp "${ROOT}/web/icon.svg" "${APPDIR}/can-tools.svg"

# .DirIcon 优先使用 PNG; 缺少 ImageMagick 时退回 SVG。
if command -v convert >/dev/null 2>&1; then
  convert -background none "${ROOT}/web/icon.svg" -resize 256x256 "${APPDIR}/can-tools.png"
  install -Dm644 "${APPDIR}/can-tools.png" \
    "${APPDIR}/usr/share/icons/hicolor/256x256/apps/can-tools.png"
  ln -sf can-tools.png "${APPDIR}/.DirIcon"
else
  ln -sf can-tools.svg "${APPDIR}/.DirIcon"
fi

APPIMAGETOOL="${APPIMAGETOOL:-}"
if [[ -z "${APPIMAGETOOL}" ]]; then
  if command -v appimagetool >/dev/null 2>&1; then
    APPIMAGETOOL="$(command -v appimagetool)"
  else
    mkdir -p "${TOOLS}"
    APPIMAGETOOL="${TOOLS}/appimagetool-${ARCH}.AppImage"
    if [[ ! -x "${APPIMAGETOOL}" ]]; then
      echo "下载 appimagetool: ${APPIMAGETOOL}"
      curl -fL --retry 5 --retry-all-errors --connect-timeout 20 \
        -o "${APPIMAGETOOL}" \
        "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-${ARCH}.AppImage"
      chmod +x "${APPIMAGETOOL}"
    fi
  fi
fi

rm -f "${OUTPUT}"
# AppImage 打包需要 type2 runtime; 缓存到 .tools/ 避免重复下载。
RUNTIME="${APPIMAGE_RUNTIME:-}"
if [[ -z "${RUNTIME}" ]]; then
  mkdir -p "${TOOLS}"
  RUNTIME="${TOOLS}/runtime-${ARCH}"
  if [[ ! -s "${RUNTIME}" ]]; then
    echo "下载 AppImage runtime: ${RUNTIME}"
    curl -fL --retry 5 --retry-all-errors --connect-timeout 20 \
      -o "${RUNTIME}" \
      "https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-${ARCH}"
    chmod +x "${RUNTIME}"
  fi
fi
# 无 FUSE 的开发机也能运行 appimagetool。
ARCH="${ARCH}" APPIMAGE_EXTRACT_AND_RUN=1 \
  "${APPIMAGETOOL}" --runtime-file "${RUNTIME}" "${APPDIR}" "${OUTPUT}"
chmod +x "${OUTPUT}"
echo "AppImage: ${OUTPUT}"
du -h "${OUTPUT}"
