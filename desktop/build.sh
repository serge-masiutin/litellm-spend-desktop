#!/usr/bin/env bash
# Сборка не устанавливает приложение и отказывается перезаписывать готовую .app.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
if [[ "$(bun --version)" != 1.3.12 ]]; then
  echo "Для воспроизводимой упаковки нужен Bun 1.3.12" >&2
  exit 1
fi
output="${1:-$root/desktop/build.noindex/LiteLLM Spend.app}"
if [[ -e "$output" ]]; then
  echo "Приложение уже существует: $output. Выбери новый путь сборки." >&2
  exit 1
fi
mkdir -p "$(dirname "$output")"
work="$(mktemp -d "$(dirname "$output")/.litellm-build.XXXXXX")"
trap 'rm -rf "$work"' EXIT
app="$work/LiteLLM Spend.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/plugin" "$app/Contents/Resources/cli"
compiler_flags=(-O -swift-version 5)
duplicate=/Library/Developer/CommandLineTools/usr/include/swift/module.modulemap
if [[ -f "$duplicate" && -f "${duplicate%module.modulemap}bridging.modulemap" ]]; then
  # Обход дубля SwiftBridging в CLT, не изменение системных заголовков.
  : > "$work/empty.modulemap"
  printf '{"version":0,"roots":[{"name":"%s","type":"file","external-contents":"%s"}]}' "$duplicate" "$work/empty.modulemap" > "$work/overlay.json"
  compiler_flags+=(-vfsoverlay "$work/overlay.json" -Xcc -ivfsoverlay -Xcc "$work/overlay.json")
fi
MACOSX_DEPLOYMENT_TARGET=13.0 swiftc "${compiler_flags[@]}" -o "$app/Contents/MacOS/OpenCodeSpend" desktop/Sources/*.swift
bun build bin/desktop-cli.ts --target=bun --outfile "$app/Contents/Resources/cli/litellm-spend.js"
cp "$(command -v bun)" "$app/Contents/MacOS/bun"
MACOSX_DEPLOYMENT_TARGET=13.0 swiftc "${compiler_flags[@]}" -o "$app/Contents/MacOS/litellm-spend" desktop/launcher.swift
swiftc "${compiler_flags[@]}" -o "$work/make-icon" desktop/icon.swift
"$work/make-icon" "$work/Spend.iconset"
iconutil --convert icns --output "$app/Contents/Resources/Spend.icns" "$work/Spend.iconset"
for name in core adapters index.ts tui.ts package.json config.defaults.json install.sh connect-telegram.command; do
  cp -R "$name" "$app/Contents/Resources/plugin/$name"
done
mkdir "$app/Contents/Resources/plugin/bin"
cp bin/litellm-spend.ts "$app/Contents/Resources/plugin/bin/"
cp docs/monitor.md "$app/Contents/Resources/plugin/README.md"
cp config.defaults.json "$app/Contents/Resources/config.defaults.json"
cp desktop/telegram.command "$app/Contents/Resources/telegram.command"
cp -R licenses "$app/Contents/Resources/licenses"
chmod +x "$app/Contents/Resources/telegram.command"
version="$(bun -e 'console.log(require("./package.json").version)')"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>OpenCodeSpend</string>
<key>CFBundleIdentifier</key><string>local.serge.opencode-spend</string>
<key>CFBundleName</key><string>LiteLLM Spend</string>
<key>CFBundleDisplayName</key><string>LiteLLM Spend</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleIconFile</key><string>Spend.icns</string>
<key>CFBundleShortVersionString</key><string>$version</string>
<key>CFBundleVersion</key><string>5</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
codesign --verify --strict "$app/Contents/MacOS/bun"
codesign --force --sign - "$app/Contents/MacOS/litellm-spend"
codesign --force --sign - "$app"
codesign --verify --deep --strict "$app"
mv "$app" "$output"
echo "Собрано: $output"
