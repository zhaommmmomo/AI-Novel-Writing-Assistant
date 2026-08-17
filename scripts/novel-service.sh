#!/usr/bin/env bash

set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
readonly SCRIPT_PATH="${SCRIPT_DIR}/$(basename -- "${BASH_SOURCE[0]}")"
readonly SERVICE_LABEL="com.ai-novel.dev"
readonly SERVICE_DOMAIN="gui/$(id -u)"
readonly SERVICE_TARGET="${SERVICE_DOMAIN}/${SERVICE_LABEL}"
readonly PLIST_PATH="${HOME}/Library/LaunchAgents/${SERVICE_LABEL}.plist"
readonly LOG_FILE="${PROJECT_ROOT}/.logs/novel-service.log"
readonly SERVER_URL="http://127.0.0.1:3000"
readonly CLIENT_URL="http://127.0.0.1:5173"
readonly STARTUP_TIMEOUT_SECONDS=90

usage() {
  cat <<'EOF'
用法: ./scripts/novel-service.sh {start|restart|stop|status}

  start    使用 launchd 后台启动 novel 前端、后端和 shared watch
  restart  重建 LaunchAgent 配置并重新启动
  stop     停止 novel 服务，保留 LaunchAgent 配置文件
  status   查看 LaunchAgent 和前后端健康状态
EOF
}

die() {
  printf 'novel-service: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "缺少命令: $1"
}

service_loaded() {
  launchctl print "${SERVICE_TARGET}" >/dev/null 2>&1
}

prepare_log() {
  umask 077
  mkdir -p -- "$(dirname -- "${LOG_FILE}")"
  touch "${LOG_FILE}"
  chmod 600 "${LOG_FILE}"
}

write_plist() {
  local pnpm_path
  local runtime_path
  local temporary="${PLIST_PATH}.tmp.$$"

  pnpm_path="$(command -v pnpm)"
  [[ "${pnpm_path}" = /* ]] || die "pnpm 必须解析为绝对路径"
  runtime_path="$(dirname -- "${pnpm_path}"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

  umask 077
  mkdir -p -- "$(dirname -- "${PLIST_PATH}")"
  rm -f -- "${temporary}"
  plutil -create xml1 "${temporary}"
  plutil -insert Label -string "${SERVICE_LABEL}" "${temporary}"
  plutil -insert ProgramArguments -array "${temporary}"
  plutil -insert ProgramArguments.0 -string /bin/bash "${temporary}"
  plutil -insert ProgramArguments.1 -string "${SCRIPT_PATH}" "${temporary}"
  plutil -insert ProgramArguments.2 -string __run "${temporary}"
  plutil -insert WorkingDirectory -string "${PROJECT_ROOT}" "${temporary}"
  plutil -insert EnvironmentVariables -dictionary "${temporary}"
  plutil -insert EnvironmentVariables.PATH -string "${runtime_path}" "${temporary}"
  plutil -insert RunAtLoad -bool true "${temporary}"
  plutil -insert KeepAlive -bool true "${temporary}"
  plutil -insert ProcessType -string Background "${temporary}"
  plutil -insert ThrottleInterval -integer 5 "${temporary}"
  plutil -insert StandardOutPath -string "${LOG_FILE}" "${temporary}"
  plutil -insert StandardErrorPath -string "${LOG_FILE}" "${temporary}"
  chmod 600 "${temporary}"
  mv -f -- "${temporary}" "${PLIST_PATH}"
}

server_ready() {
  curl --silent --show-error --fail --max-time 2 \
    --output /dev/null "${SERVER_URL}/api/health" 2>/dev/null
}

client_ready() {
  curl --silent --show-error --fail --max-time 2 \
    --output /dev/null "${CLIENT_URL}/" 2>/dev/null
}

service_pid() {
  launchctl print "${SERVICE_TARGET}" 2>/dev/null \
    | awk '$1 == "pid" && $2 == "=" { print $3; exit }'
}

print_locations() {
  printf '前端: %s\n' "${CLIENT_URL}"
  printf '后端: %s\n' "${SERVER_URL}"
  printf '日志: %s\n' "${LOG_FILE}"
}

wait_until_ready() {
  local waited=0

  while (( waited < STARTUP_TIMEOUT_SECONDS )); do
    service_loaded || die "LaunchAgent 已退出，请查看日志: ${LOG_FILE}"
    if server_ready && client_ready; then
      return
    fi
    sleep 1
    waited=$((waited + 1))
  done

  printf 'novel 服务已加载，但前后端在 %s 秒内未全部就绪。\n' \
    "${STARTUP_TIMEOUT_SECONDS}" >&2
  printf '请运行 status 或查看日志: %s\n' "${LOG_FILE}" >&2
  exit 1
}

bootstrap_service() {
  launchctl bootstrap "${SERVICE_DOMAIN}" "${PLIST_PATH}" \
    || die "LaunchAgent 加载失败"
  launchctl kickstart "${SERVICE_TARGET}" \
    || die "LaunchAgent 启动失败"
}

start_service() {
  if service_loaded; then
    if server_ready && client_ready; then
      printf 'novel 已在后台运行，PID: %s\n' "$(service_pid)"
      print_locations
      return
    fi
    launchctl kickstart -k "${SERVICE_TARGET}" \
      || die "LaunchAgent 重新触发失败"
  else
    prepare_log
    write_plist
    bootstrap_service
  fi

  wait_until_ready
  printf 'novel 已在后台启动，PID: %s\n' "$(service_pid)"
  print_locations
}

stop_service() {
  if ! service_loaded; then
    printf 'novel 当前已停止。\n'
    return
  fi

  launchctl bootout "${SERVICE_TARGET}" || die "LaunchAgent 停止失败"
  if service_loaded; then
    die "LaunchAgent 仍处于加载状态"
  fi
  printf 'novel 已停止。\n'
}

restart_service() {
  if service_loaded; then
    launchctl bootout "${SERVICE_TARGET}" || die "旧 LaunchAgent 停止失败"
  fi
  prepare_log
  write_plist
  bootstrap_service
  wait_until_ready
  printf 'novel 已重新启动，PID: %s\n' "$(service_pid)"
  print_locations
}

show_status() {
  local pid

  if ! service_loaded; then
    printf '状态: 已停止\n'
    printf 'LaunchAgent: %s\n' "${PLIST_PATH}"
    printf '日志: %s\n' "${LOG_FILE}"
    return
  fi

  pid="$(service_pid)"
  printf '状态: LaunchAgent 已加载\n'
  if [[ "${pid}" =~ ^[1-9][0-9]*$ ]]; then
    printf 'PID: %s\n' "${pid}"
  else
    printf 'PID: 正在等待 launchd 拉起\n'
  fi
  if server_ready; then
    printf '后端: 正常 (%s)\n' "${SERVER_URL}"
  else
    printf '后端: 未就绪 (%s)\n' "${SERVER_URL}"
  fi
  if client_ready; then
    printf '前端: 正常 (%s)\n' "${CLIENT_URL}"
  else
    printf '前端: 未就绪 (%s)\n' "${CLIENT_URL}"
  fi
  printf 'LaunchAgent: %s\n' "${PLIST_PATH}"
  printf '日志: %s\n' "${LOG_FILE}"
}

run_service() {
  cd -- "${PROJECT_ROOT}"
  exec pnpm dev
}

main() {
  if [[ $# -ne 1 ]]; then
    usage >&2
    exit 64
  fi

  case "$1" in
    start)
      require_command launchctl
      require_command plutil
      require_command pnpm
      require_command curl
      require_command awk
      start_service
      ;;
    restart)
      require_command launchctl
      require_command plutil
      require_command pnpm
      require_command curl
      require_command awk
      restart_service
      ;;
    stop)
      require_command launchctl
      stop_service
      ;;
    status)
      require_command launchctl
      require_command curl
      require_command awk
      show_status
      ;;
    __run)
      require_command pnpm
      run_service
      ;;
    -h|--help|help)
      usage
      ;;
    *)
      usage >&2
      exit 64
      ;;
  esac
}

main "$@"
