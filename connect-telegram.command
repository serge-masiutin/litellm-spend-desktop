#!/bin/sh
# Локальный мастер: токен не передаётся в аргументах и не отображается при вводе.
set -eu
cd "$(dirname "$0")"
if ! command -v bun >/dev/null 2>&1; then
  if [ -x "$HOME/.bun/bin/bun" ]; then
    BUN="$HOME/.bun/bin/bun"
  else
    echo "Не найден Bun. Установите Bun и повторите подключение."
    exit 1
  fi
else
  BUN="$(command -v bun)"
fi
exec "$BUN" bin/litellm-spend.ts telegram setup
