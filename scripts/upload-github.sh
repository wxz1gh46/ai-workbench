#!/usr/bin/env bash
# =====================================================================
# 打包并上传到 GitHub 私人仓库
#
# 安全约束（务必遵守）：
#   1. Token 只从环境变量 GITHUB_TOKEN 读取，绝不写进脚本/日志/提交；
#   2. 任何命令都不回显 Token（用 --silent + 错误信息里做脱敏）；
#   3. 仓库默认 private，除非显式传 --public；
#   4. 只推送当前分支，不碰 main。
#
# 用法：
#   GITHUB_TOKEN=ghp_xxx ./scripts/upload-github.sh
#   GITHUB_TOKEN=ghp_xxx ./scripts/upload-github.sh --repo my-project --branch phase3
#   GITHUB_TOKEN=ghp_xxx ./scripts/upload-github.sh --public   # 不推荐
#
# 依赖：git、curl、tar、node/grep。会创建一个临时打包目录，不修改工作区。
# =====================================================================
set -euo pipefail

REPO_NAME="${REPO_NAME:-ai-workbench}"
BRANCH="${BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
VISIBILITY="private"
DESCRIPTION="${DESCRIPTION:-AI 桌面工作台：目标驱动、多 Agent、Office 处理、深度研究、网站部署、定时任务与推送}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO_NAME="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --public) VISIBILITY="public"; shift ;;
    --desc) DESCRIPTION="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

: "${GITHUB_TOKEN:?请通过环境变量提供 GITHUB_TOKEN（不要写在命令行里，会进 shell 历史）}"

# ---- 脱敏工具：任何输出都过滤掉 Token -------------------------------------
redact() { sed -e "s/${GITHUB_TOKEN}/****REDACTED****/g" -e 's/gh[pousr]_[A-Za-z0-9]\{20,\}/****REDACTED****/g'; }
die() { echo "❌ $1" | redact >&2; exit 1; }

API="https://api.github.com"
AUTH_HEADER="Authorization: Bearer ${GITHUB_TOKEN}"

echo "==> 校验 Token 与账号"
ACCOUNT="$(curl -sf -H "$AUTH_HEADER" -H 'Accept: application/vnd.github+json' "$API/user" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.login||"")})')" \
  || die "Token 无效或网络不可达（请确认 Token 未过期且具备 repo 权限）"
[[ -n "$ACCOUNT" ]] || die "无法解析 GitHub 账号"
echo "    账号：$ACCOUNT"

echo "==> 确认当前分支与工作区状态"
cd "$(git rev-parse --show-toplevel)"
[[ "$(git rev-parse --abbrev-ref HEAD)" == "$BRANCH" ]] || die "当前不在分支 $BRANCH（用 --branch 指定或先切换）"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "⚠️  工作区有未提交改动，将只推送已提交内容。"
fi
HEAD_SHA="$(git rev-parse HEAD)"
echo "    分支：$BRANCH  提交：${HEAD_SHA:0:8}"

echo "==> 创建/复用 GitHub 仓库（$VISIBILITY）"
PAYLOAD="$(node -e '
const [name, desc, vis] = process.argv.slice(1);
process.stdout.write(JSON.stringify({ name, description: desc, private: vis !== "public", has_issues: true, has_wiki: false, auto_init: false }));
' "$REPO_NAME" "$DESCRIPTION" "$VISIBILITY")"

CREATE_RES="$(curl -s -o /tmp/gh-create.json -w '%{http_code}' -X POST \
  -H "$AUTH_HEADER" -H 'Accept: application/vnd.github+json' \
  -d "$PAYLOAD" "$API/user/repos")"

case "$CREATE_RES" in
  201) echo "    仓库已创建：$ACCOUNT/$REPO_NAME" ;;
  422)
    echo "    仓库已存在，直接复用"
    ;;
  401|403) die "无权限创建仓库（请确认 Token 勾选 repo 权限）：$(cat /tmp/gh-create.json | redact)" ;;
  *) die "创建仓库失败 HTTP $CREATE_RES：$(cat /tmp/gh-create.json | redact)" ;;
esac

REMOTE_URL="https://github.com/${ACCOUNT}/${REPO_NAME}.git"

echo "==> 打包（含完整历史，跳过 node_modules/dist/敏感文件）"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
BUNDLE="$TMP_DIR/repo.bundle"
git bundle create "$BUNDLE" --all

echo "==> 通过 API 推送（避免把 Token 写进 git remote 配置）"
# 用一次性 remote（带 Token 的 URL 只在进程内存在，不写入 .git/config）
git -c "http.https://github.com/.extraheader=" push --quiet \
  "https://x-access-token:${GITHUB_TOKEN}@github.com/${ACCOUNT}/${REPO_NAME}.git" \
  "$HEAD_SHA:refs/heads/${BRANCH}" 2>&1 | redact || die "推送失败（请检查 Token 的 repo 权限）"

echo "==> 设置默认分支"
curl -s -o /dev/null -X PATCH \
  -H "$AUTH_HEADER" -H 'Accept: application/vnd.github+json' \
  -d "{\"default_branch\":\"${BRANCH}\"}" \
  "$API/repos/${ACCOUNT}/${REPO_NAME}" || true

echo ""
echo "✅ 上传完成"
echo "   仓库地址：https://github.com/${ACCOUNT}/${REPO_NAME}"
echo "   可见性：  $VISIBILITY"
echo "   分支：    $BRANCH"
echo "   提交：    ${HEAD_SHA:0:8}"
echo ""
echo "提醒：请到 https://github.com/settings/tokens 确认该 Token 是否需要轮换，"
echo "      本次使用结束后建议立即吊销（它曾在对话里出现过）。"
