#!/usr/bin/env bash
# Costruisce l'app per il simulatore e, senza --solo-build, la apre nel primo
# iPhone disponibile. Niente firma: per un telefono vero serve l'account Apple.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d Estia.xcodeproj ] || ./scripts/prepara.sh --debug
xcodebuild -project Estia.xcodeproj -scheme Estia -configuration Debug \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath build CODE_SIGNING_ALLOWED=NO build | tail -20
app="build/Build/Products/Debug-iphonesimulator/Estia.app"
test -d "$app"
[ "${1:-}" = "--solo-build" ] && exit 0
simulatore="$(xcrun simctl list devices available | grep -m1 -oE 'iPhone[^(]*\(([0-9A-F-]{36})\)' | grep -oE '[0-9A-F-]{36}')"
xcrun simctl boot "$simulatore" 2>/dev/null || true
open -a Simulator
xcrun simctl install "$simulatore" "$app"
xcrun simctl launch "$simulatore" org.estia.app
