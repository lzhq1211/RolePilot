#!/bin/zsh

# RolePilot 双击停止入口：只结束本项目使用的 Web/API 端口。
set -u

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR" || exit 1

if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi

WEB_PORT="${ROLEPILOT_WEB_PORT:-4173}"
API_PORT="${PORT:-4174}"

stop_port() {
  local port="$1"
  local label="$2"
  local pid
  local found=0

  while read -r pid; do
    [[ -z "$pid" ]] && continue
    found=1
    print "正在停止 ${label}（端口 ${port}，PID ${pid}）..."
    kill "$pid" 2>/dev/null || true
  done < <(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null)

  if (( found == 0 )); then
    print "${label} 未运行（端口 ${port}）。"
    return 0
  fi

  for _ in {1..20}; do
    if ! lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      print "${label} 已停止。"
      return 0
    fi
    sleep 0.2
  done

  while read -r pid; do
    [[ -z "$pid" ]] && continue
    print "${label} 未响应，强制停止（PID ${pid}）。"
    kill -KILL "$pid" 2>/dev/null || true
  done < <(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null)
  print "${label} 已停止。"
}

print "RolePilot 服务停止器"
stop_port "$WEB_PORT" "前端"
stop_port "$API_PORT" "API"
print "处理完成，可以再次双击 RolePilot.command。"
read -k 1 "?按任意键关闭..."
