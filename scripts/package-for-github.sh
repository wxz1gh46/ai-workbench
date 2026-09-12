#!/usr/bin/env bash
# =====================================================================
# 打包成发布归档（tar.gz + zip），用于「打包上传」场景
#
# - 只包含源码与文档，排除 node_modules / dist / data / .env
# - 生成 SHA256 校验值
# - 不包含任何凭据（打包前做一次模式扫描，命中直接失败）
#
# 用法：./scripts/package-for-github.sh [输出目录]
# =====================================================================
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
OUT_DIR="$(mkdir -p "${1:-$ROOT/release}" && cd "${1:-$ROOT/release}" && pwd)"

STAMP="$(date +%Y%m%d-%H%M%S)"
NAME="ai-workbench-${STAMP}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> 导出已提交内容（git archive，天然不含未跟踪/ignored 文件）"
git archive --format=tar --prefix="${NAME}/" HEAD | tar -x -C "$WORK"

echo "==> 敏感文件扫描"
# 常见凭据形态 + 显式凭据文件
PATTERNS='(sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{12,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)'
HITS="$(grep -rEIln "$PATTERNS" "$WORK" 2>/dev/null || true)"
if [[ -n "$HITS" ]]; then
  echo "❌ 归档中发现疑似凭据，已中止：" >&2
  echo "$HITS" | sed "s|$WORK/||" >&2
  exit 1
fi
if find "$WORK" -name '.env' -not -name '.env.example' | grep -q .; then
  echo "❌ 归档中发现 .env 文件，已中止" >&2
  exit 1
fi
echo "    ✅ 未发现疑似凭据"

echo "==> 生成归档"
( cd "$WORK" && tar -czf "${OUT_DIR}/${NAME}.tar.gz" "${NAME}" )

# zip 可选：环境里没有 zip 命令时跳过（tar.gz 已足够）
if command -v zip >/dev/null 2>&1; then
  ( cd "$WORK" && zip -qr "${OUT_DIR}/${NAME}.zip" "${NAME}" )
  ZIP_MADE=1
else
  echo "    （未安装 zip 命令，跳过 .zip；可 brew/apt install zip 后重跑）"
  ZIP_MADE=0
fi

echo "==> 计算校验值"
if [[ "$ZIP_MADE" == "1" ]]; then
  ( cd "$OUT_DIR" && sha256sum "${NAME}.tar.gz" "${NAME}.zip" > "${NAME}.sha256" )
else
  ( cd "$OUT_DIR" && sha256sum "${NAME}.tar.gz" > "${NAME}.sha256" )
fi

echo ""
echo "✅ 打包完成"
ls -lh "${OUT_DIR}/${NAME}".tar.gz ${ZIP_MADE:+} 2>/dev/null | awk '{print "   " $9 "  " $5}'
[[ "$ZIP_MADE" == "1" ]] && ls -lh "${OUT_DIR}/${NAME}.zip" | awk '{print "   " $9 "  " $5}'
echo "   校验文件：${OUT_DIR}/${NAME}.sha256"
echo ""
echo "上传到 GitHub 私人仓库："
echo "  GITHUB_TOKEN=*** ./scripts/upload-github.sh --repo ai-workbench"
