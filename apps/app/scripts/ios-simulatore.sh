#!/usr/bin/env bash
# L'app ESTIA nel simulatore iOS, senza firma e senza account Apple.
#
#   apps/app/scripts/ios-simulatore.sh               # costruisce, installa e apre
#   apps/app/scripts/ios-simulatore.sh --solo-build  # solo la build (la CI)
#   SIMULATORE="iPhone 17" apps/app/scripts/ios-simulatore.sh
#
# Perché uno script e non `tauri ios dev`:
#
# - la CLI di Tauri si rifiuta di partire quando Xcode non ha il simulatore
#   della sua stessa versione (Xcode 27.2 con solo iOS 26.5 installato). Qui si
#   costruisce con `xcodebuild` verso un simulatore che c'è davvero;
# - su un disco exFAT (un SSD esterno) macOS scrive un file `._` accanto a ogni
#   file, e Tauri li legge come capability e icone rotte. Se il repository sta
#   sotto /Volumes, lo script lo copia sul disco interno, senza i `._`, e
#   costruisce lì.
#
# Il portachiavi senza firma non c'è («A required entitlement isn't present»):
# l'app parte, la cassaforte no. La misura vera del portachiavi è su un iPhone
# firmato (infra/spike-app/README.md, prova 2).
set -euo pipefail

solo_build=false
[ "${1:-}" = "--solo-build" ] && solo_build=true

qui="$(cd "$(dirname "$0")/.." && pwd)"
radice="$(cd "$qui/../.." && pwd)"

if [[ "$radice" == /Volumes/* ]]; then
  copia="${ESTIA_BUILD_DIR:-$HOME/Library/Caches/estia-app-build}/ESTIA"
  echo "Il repository sta su un disco esterno: costruisco in $copia"
  mkdir -p "$copia"
  COPYFILE_DISABLE=1 rsync -a --delete \
    --exclude '._*' --exclude '.DS_Store' --exclude 'node_modules' \
    --exclude 'target' --exclude 'apps/app/src-tauri/gen' --exclude '.git' \
    "$radice/" "$copia/"
  radice="$copia"
  qui="$copia/apps/app"
  (cd "$radice" && corepack pnpm install --frozen-lockfile)
fi

cd "$qui"
rustup target add aarch64-apple-ios-sim >/dev/null

if [ ! -d src-tauri/gen/apple ]; then
  corepack pnpm tauri ios init --ci
fi

npm run web:build

# Un iPhone fra i simulatori installati: quello chiesto, o il primo che c'è.
nome="${SIMULATORE:-iPhone}"
riga="$(xcrun simctl list devices available | grep -m1 -F "$nome" || true)"
if [ -z "$riga" ]; then
  echo "Nessun simulatore «$nome». Quelli installati:" >&2
  xcrun simctl list devices available >&2
  exit 1
fi
udid="$(echo "$riga" | grep -oE '[0-9A-F]{8}-([0-9A-F]{4}-){3}[0-9A-F]{12}')"
echo "Simulatore: $(echo "$riga" | sed -E 's/ \(.*//; s/^ +//') ($udid)"

progetto="$(ls -d src-tauri/gen/apple/*.xcodeproj | head -1)"
schema="$(basename "$progetto" .xcodeproj)_iOS"

xcodebuild \
  -project "$progetto" \
  -scheme "$schema" \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination "id=$udid" \
  -derivedDataPath src-tauri/gen/apple/build \
  ARCHS=arm64 ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO \
  build

app="$(find src-tauri/gen/apple/build/Build/Products -maxdepth 2 -name '*.app' -path '*iphonesimulator*' | head -1)"
echo "Costruita: $app"
$solo_build && exit 0

xcrun simctl boot "$udid" 2>/dev/null || true
open -a Simulator
xcrun simctl install "$udid" "$app"
xcrun simctl launch "$udid" org.estia.app
