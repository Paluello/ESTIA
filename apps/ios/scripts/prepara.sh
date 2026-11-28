#!/usr/bin/env bash
# Prepara quello che il progetto Xcode non tiene in git:
#
# - il nucleo Rust (apps/nucleo) per iPhone e simulatore, in un XCFramework,
#   con i suoi legami Swift;
# - le frasi di packages/lingue, copiate così come sono: l'app le legge dalla
#   stessa tabella del web (ADR 0051 §5);
# - il progetto Xcode, generato da project.yml con XcodeGen.
#
#   scripts/prepara.sh [--debug]
set -euo pipefail
cd "$(dirname "$0")/.."
ios="$(pwd)"
nucleo="$ios/../nucleo"
profilo=release
[ "${1:-}" = "--debug" ] && profilo=debug
cartella_profilo=$([ "$profilo" = debug ] && echo debug || echo release)
opzione_profilo=$([ "$profilo" = debug ] && echo "" || echo "--release")

rustup target add aarch64-apple-ios aarch64-apple-ios-sim >/dev/null
# Lo stesso minimo di project.yml. Senza, rustc collega per iOS 10 e manca
# `___chkstk_darwin`, che c'è solo dalle versioni nuove.
export IPHONEOS_DEPLOYMENT_TARGET=18.0
( cd "$nucleo"
  cargo build --locked --lib $opzione_profilo --target aarch64-apple-ios
  cargo build --locked --lib $opzione_profilo --target aarch64-apple-ios-sim
  ./scripts/legami.sh "$nucleo/target/legami" )

rm -rf Generato && mkdir -p Generato/include
cp "$nucleo/target/legami/swift/EstiaNucleo.swift" Generato/
cp "$nucleo/target/legami/swift/EstiaNucleoFFI.h" Generato/include/
cp "$nucleo/target/legami/swift/EstiaNucleoFFI.modulemap" Generato/include/module.modulemap
xcodebuild -create-xcframework \
  -library "$nucleo/target/aarch64-apple-ios/$cartella_profilo/libestia_nucleo.a" -headers Generato/include \
  -library "$nucleo/target/aarch64-apple-ios-sim/$cartella_profilo/libestia_nucleo.a" -headers Generato/include \
  -output Generato/EstiaNucleo.xcframework

for lingua in it en; do
  cp "$ios/../../packages/lingue/src/frasi/$lingua.json" "Estia/Risorse/Frasi/frasi-$lingua.json"
done

command -v xcodegen >/dev/null || brew install xcodegen
xcodegen generate --quiet
echo "prepara: pronto. Apri Estia.xcodeproj, oppure scripts/simulatore.sh"
