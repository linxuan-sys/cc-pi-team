#!/usr/bin/env bash
# pi-ctl.sh <workspace> <steer|abort> [message...]
# 通过 .pi-rpc.sock 给正在跑的 Pi 发控制命令。

WS="$1"
CMD="$2"
shift 2 2>/dev/null || true
SOCK="$WS/.pi-rpc.sock"
[ -S "$SOCK" ] || { echo NO_SOCKET; exit 1; }

case "$CMD" in
  steer)
    MSG="$*"
    [ -n "$MSG" ] || { echo BAD_MESSAGE; exit 1; }
    PAYLOAD=$(jq -cn --arg m "$MSG" '{command:"steer",message:$m}') || { echo BAD_PAYLOAD; exit 1; }
    ;;
  abort)
    PAYLOAD='{"command":"abort"}'
    ;;
  *)
    echo BAD_COMMAND
    exit 1
    ;;
esac

node -e '
const net = require("node:net");
const [sock, payload] = process.argv.slice(1);
const s = net.connect(sock, () => { s.end(payload + "\n"); });
s.on("error", () => process.exit(1));
' "$SOCK" "$PAYLOAD" || { echo SEND_FAILED; exit 1; }

case "$CMD" in
  steer) echo STEERED ;;
  abort) echo ABORTED ;;
esac
