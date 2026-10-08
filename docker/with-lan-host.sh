#!/bin/sh
# Runs a command with LAN_HOST set to this machine's address on the wifi.
#
# A container can only see its own address on the Docker bridge, so the
# Settings screen cannot find the address a phone should open by itself. The
# host can, so this wrapper looks it up on every start — which also
# means a new address after changing networks is picked up by just starting
# again. An explicit LAN_HOST (in the shell or docker/.env) always wins.
#
# macOS names the wifi interface en0 on most machines and en1 on some; on
# Linux, `hostname -I` lists the addresses and the first is the LAN one.
if [ -z "${LAN_HOST:-}" ] && [ -f docker/.env ]; then
  LAN_HOST=$(sed -n 's/^LAN_HOST=//p' docker/.env | tail -n 1)
fi
if [ -z "${LAN_HOST:-}" ]; then
  LAN_HOST=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')
fi
export LAN_HOST
[ -n "$LAN_HOST" ] && echo "Local network address: $LAN_HOST"
exec "$@"
