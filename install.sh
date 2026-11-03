#!/bin/sh
# Обновляет только пакет; конфиг, неизвестные файлы и резервная копия старой установки сохраняются.
set -eu
umask 077
TARGET="${1:-$HOME/.config/opencode/plugins/litellm-spend}"
SRC="$(cd "$(dirname "$0")" && pwd)"
case "$TARGET" in /*) ;; *) TARGET="$PWD/$TARGET" ;; esac
[ "$TARGET" != / ] || { echo "Нельзя устанавливать в корень файловой системы" >&2; exit 1; }
[ ! -L "$TARGET" ] || { echo "Целевая папка не должна быть символической ссылкой" >&2; exit 1; }
if [ -d "$TARGET" ] && [ "$SRC" = "$(cd "$TARGET" && pwd)" ]; then
  echo "Пакет уже находится в целевой папке; настройте config.json и запустите connect-telegram.command."
  exit 0
fi
parent="$(dirname "$TARGET")"
mkdir -p "$parent"
stage="$(mktemp -d "$parent/.litellm-spend-install.XXXXXX")"
backup=""
cleanup() {
  if [ ! -e "$TARGET" ] && [ -n "$backup" ] && [ -d "$backup/previous" ]; then mv "$backup/previous" "$TARGET"; fi
  rm -rf "$stage"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
if [ -d "$TARGET" ]; then cp -R "$TARGET/." "$stage/"; fi
for item in core adapters; do
  mkdir -p "$stage/$item"
  cp -R "$SRC/$item/." "$stage/$item/"
done
mkdir -p "$stage/bin"
cp "$SRC/bin/litellm-spend.ts" "$stage/bin/litellm-spend.ts"
for item in index.ts tui.ts package.json README.md config.defaults.json connect-telegram.command install.sh; do cp "$SRC/$item" "$stage/$item"; done
chmod +x "$stage/connect-telegram.command" "$stage/install.sh"
[ -f "$stage/config.json" ] || cp "$SRC/config.defaults.json" "$stage/config.json"
if [ -e "$TARGET" ]; then
  backup="$(mktemp -d "$parent/.litellm-spend-backup.XXXXXX")"
  mv "$TARGET" "$backup/previous"
fi
mv "$stage" "$TARGET"
[ -z "$backup" ] || echo "Предыдущая установка: $backup/previous"
echo "Установлено в $TARGET. Укажите litellm.baseUrl в config.json и ключ в LITELLM_API_KEY."
