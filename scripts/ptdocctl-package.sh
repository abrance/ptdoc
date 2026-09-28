#!/usr/bin/env bash
# 交叉编译 ptdocctl 并打 tar.gz 包（每平台一个，含校验和）。
#
# 用法：
#   scripts/ptdocctl-package.sh [输出目录]     # 默认 dist/ptdocctl
#   VERSION=v1.0.0 scripts/ptdocctl-package.sh # 缺省时自动从 git tag 取
#
# 产物：ptdocctl-<version>-<os>-<arch>.tar.gz + SHA256SUMS
set -euo pipefail

cd "$(dirname "$0")/../ptdocctl"

VERSION="${VERSION:-$(git describe --tags --abbrev=0 2>/dev/null || echo dev)}"
OUT="${1:-../dist/ptdocctl}"
mkdir -p "$OUT"

TARGETS=(
  linux/amd64 linux/arm64
  darwin/amd64 darwin/arm64
  windows/amd64
)

for t in "${TARGETS[@]}"; do
  GOOS="${t%/*}"; GOARCH="${t#*/}"
  name="ptdocctl-${VERSION}-${GOOS}-${GOARCH}"
  [ "$GOOS" = windows ] && name+=".exe"
  bin="$OUT/$name"
  echo "build $name"
  CGO_ENABLED=0 GOOS="$GOOS" GOARCH="$GOARCH" go build -trimpath -ldflags "-s -w" -o "$bin" .
  tar -czf "$bin.tar.gz" -C "$OUT" "$(basename "$bin")"
  rm "$bin"
done

# 免 chmod：tar 包内保留可执行位，解压即用；Windows 为 .exe
(cd "$OUT" && sha256sum ptdocctl-*.tar.gz > SHA256SUMS)
echo "done → $OUT ($(ls "$OUT" | wc -l) 个文件)"
