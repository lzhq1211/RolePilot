#!/bin/zsh

# RolePilot 双击入口：启动本地 API 与 Vite 前端，然后打开首页。
set -u

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

cd "$ROOT_DIR" || exit 1

if [[ ! -f .env && -f .env.example ]]; then
  cp .env.example .env
fi

if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi

WEB_PORT="${ROLEPILOT_WEB_PORT:-4173}"
API_PORT="${PORT:-4174}"
WEB_URL="http://127.0.0.1:${WEB_PORT}"

if ! command -v pnpm >/dev/null 2>&1; then
  print -u2 "未找到 pnpm。请先安装 pnpm 10.12.1，再双击此文件。"
  read -k 1 "?按任意键关闭..."
  exit 1
fi

if ! command -v open >/dev/null 2>&1; then
  print -u2 "未找到 macOS open 命令，无法自动打开浏览器。"
  read -k 1 "?按任意键关闭..."
  exit 1
fi

# 验收配置使用 ROLEPILOT_TEST_* 命名；仅在本机启动器内映射到服务端变量。
export SUPABASE_URL="${SUPABASE_URL:-${ROLEPILOT_TEST_SUPABASE_URL:-}}"
export SUPABASE_SERVICE_ROLE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-${ROLEPILOT_TEST_SERVICE_ROLE_KEY:-}}"
export ROLEPILOT_DEPLOYMENT_INSTANCE_ID="${ROLEPILOT_DEPLOYMENT_INSTANCE_ID:-local-double-click}"
export ROLEPILOT_STORAGE_MODE="${ROLEPILOT_STORAGE_MODE:-local}"
export ROLEPILOT_DATA_DIR="${ROLEPILOT_DATA_DIR:-$ROOT_DIR/.rolepilot-data}"
# 双击入口默认执行真实 provider；离线 stub 必须由用户显式配置回放文件。
export ROLEPILOT_WORKER_MODE="${ROLEPILOT_WORKER_MODE:-live}"
export HOST="${HOST:-127.0.0.1}"
export ROLEPILOT_API_TARGET="http://127.0.0.1:${API_PORT}"

if [[ "$ROLEPILOT_STORAGE_MODE" == "supabase" && ( -z "$SUPABASE_URL" || -z "$SUPABASE_SERVICE_ROLE_KEY" ) ]]; then
  print -u2 "Supabase 模式缺少配置；单机使用请设置 ROLEPILOT_STORAGE_MODE=local。"
  read -k 1 "?按任意键关闭..."
  exit 1
fi

# 已有前端时只打开页面，避免 strictPort 因重复启动而失败。
if curl -fsS "$WEB_URL" >/dev/null 2>&1; then
  open "$WEB_URL"
  exit 0
fi

if lsof -tiTCP:"$API_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  print -u2 "API 端口 ${API_PORT} 已被占用。请先双击 RolePilot-stop.command，再重新启动。"
  read -k 1 "?按任意键关闭..."
  exit 1
fi

if lsof -tiTCP:"$WEB_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  print -u2 "前端端口 ${WEB_PORT} 已被占用。请先双击 RolePilot-stop.command，再重新启动。"
  read -k 1 "?按任意键关闭..."
  exit 1
fi

mkdir -p .rolepilot-work/launcher
API_LOG="$ROOT_DIR/.rolepilot-work/launcher/api.log"

print "正在执行统一构建准备（pnpm run prepare）..."
if ! pnpm run prepare >"$API_LOG" 2>&1; then
  print -u2 "构建准备失败，请查看日志：${API_LOG}"
  read -k 1 "?按任意键关闭..."
  exit 1
fi

print "正在启动 RolePilot API（端口 ${API_PORT}）..."
PORT="$API_PORT" pnpm --filter rolepilot-web-service start >>"$API_LOG" 2>&1 &
API_PID=$!

cleanup() {
  if [[ -n "${WEB_PID:-}" ]] && kill -0 "$WEB_PID" 2>/dev/null; then
    kill "$WEB_PID" 2>/dev/null || true
  fi
  if kill -0 "$API_PID" 2>/dev/null; then
    kill "$API_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

print "正在启动 RolePilot 前端（端口 ${WEB_PORT}）..."
PORT="$WEB_PORT" pnpm --filter rolepilot-web dev -- --host 127.0.0.1 --port "$WEB_PORT" &
WEB_PID=$!

for _ in {1..60}; do
  if curl -fsS "$WEB_URL" >/dev/null 2>&1; then
    open "$WEB_URL"
    print ""
    print "RolePilot 已打开：${WEB_URL}"
    print "关闭此终端窗口会停止本次本地服务。"
    wait "$WEB_PID"
    exit $?
  fi
  if ! kill -0 "$API_PID" 2>/dev/null; then
    print -u2 "API 启动失败，请检查日志：${API_LOG}"
    read -k 1 "?按任意键关闭..."
    exit 1
  fi
  if ! kill -0 "$WEB_PID" 2>/dev/null; then
    print -u2 "前端启动失败，请检查端口 ${WEB_PORT} 或依赖。"
    print -u2 "API 日志：${API_LOG}"
    read -k 1 "?按任意键关闭..."
    exit 1
  fi
  sleep 0.5
done

print -u2 "前端启动超时，请检查 API 日志：${API_LOG}"
read -k 1 "?按任意键关闭..."
exit 1
