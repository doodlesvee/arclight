#!/bin/sh
# Starts the app if it isn't running, waits until it answers, then opens it in
# its own window — no tabs, no address bar.
#
#   scripts/launch.sh          (or `make app`)
#
# Used by the macOS launcher app (`make mac-app`), but works from a terminal on
# macOS and Linux too. Closing the window does not stop the server; `make down`
# does.
#
# Settings, all optional:
#   APP_PORT=3001           the port the app is published on (default 3000)
#   LAUNCH_NO_WINDOW=1      start and wait, but do not open a window
set -u

# A launched .app does not get the PATH a terminal does, so Docker and Homebrew
# tools would not be found without this.
PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin"
export PATH

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PORT=${APP_PORT:-3000}
URL="http://localhost:$PORT"
OS=$(uname -s)
LOG="${TMPDIR:-/tmp}/private-server-launch.log"
COMPOSE_FILE="docker/docker-compose.yml"

notify() {
  if [ "$OS" = Darwin ]; then
    osascript -e "display notification \"$1\" with title \"Private Server\"" >/dev/null 2>&1 || true
  elif command -v notify-send >/dev/null 2>&1; then
    notify-send "Private Server" "$1" >/dev/null 2>&1 || true
  fi
}

# A launched .app has no terminal to print to, so a failure has to be a dialog.
fail() {
  echo "Private Server: $1" >&2
  if [ "$OS" = Darwin ]; then
    osascript -e "display dialog \"$1\" with title \"Private Server\" buttons {\"OK\"} default button \"OK\" with icon caution" >/dev/null 2>&1 || true
  else
    notify "$1"
  fi
  exit 1
}

command -v docker >/dev/null 2>&1 || fail "Docker is not installed. Install Docker Desktop, then open this again."

# --- 1. Docker itself ------------------------------------------------------
if ! docker info >/dev/null 2>&1; then
  if [ "$OS" = Darwin ] && open -Ra Docker >/dev/null 2>&1; then
    notify "Starting Docker..."
    open -ga Docker
    waited=0
    until docker info >/dev/null 2>&1; do
      [ "$waited" -ge 120 ] && fail "Docker did not start within 2 minutes. Open Docker Desktop, then try again."
      sleep 2
      waited=$((waited + 2))
    done
  else
    fail "Docker is not running. Start it, then open this again."
  fi
fi

# --- 2. The app's containers -----------------------------------------------
cd "$ROOT" || fail "Cannot find the project folder: $ROOT"
: > "$LOG"

# No containers yet means the first run, which builds the image.
if ! docker compose -f "$COMPOSE_FILE" ps -q 2>/dev/null | grep -q .; then
  notify "Setting up for the first time. This can take a few minutes."
fi

sh docker/with-lan-host.sh docker compose -f "$COMPOSE_FILE" up -d >> "$LOG" 2>&1 \
  || fail "Could not start the app. Details are in $LOG"

# --- 3. Wait until it answers ----------------------------------------------
waited=0
notified=0
until curl -fs -o /dev/null "$URL/api/health" 2>/dev/null; do
  if [ "$waited" -ge 120 ]; then
    fail "The app did not start within 2 minutes. Details: run 'make logs' in the project folder."
  fi
  if [ "$waited" -ge 8 ] && [ "$notified" -eq 0 ]; then
    notify "Still starting..."
    notified=1
  fi
  sleep 1
  waited=$((waited + 1))
done

[ "${LAUNCH_NO_WINDOW:-}" = 1 ] && { echo "Ready at $URL"; exit 0; }

# --- 4. Open it in its own window ------------------------------------------
# Chrome's app mode: the page in a window with no tabs or address bar. -n on
# macOS because `open` otherwise hands the arguments to an already-running
# Chrome by ignoring them.
if [ "$OS" = Darwin ]; then
  for app in "Google Chrome" "Chromium" "Microsoft Edge" "Brave Browser" "Google Chrome Beta"; do
    if open -Ra "$app" >/dev/null 2>&1; then
      exec open -na "$app" --args --app="$URL"
    fi
  done
else
  for bin in google-chrome google-chrome-stable chromium chromium-browser microsoft-edge brave-browser; do
    if command -v "$bin" >/dev/null 2>&1; then
      nohup "$bin" --app="$URL" >/dev/null 2>&1 &
      exit 0
    fi
  done
fi

notify "No Chrome-based browser found, so it opened in your default browser instead."
if [ "$OS" = Darwin ]; then
  exec open "$URL"
fi
exec xdg-open "$URL"
