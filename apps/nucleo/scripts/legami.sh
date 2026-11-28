#!/usr/bin/env bash
# Genera i legami Swift e Kotlin del nucleo dalla libreria compilata.
#
#   scripts/legami.sh [cartella di uscita]   (predefinita: target/legami)
#
# Poi controlla il confine di ADR 0051 §3: nessuna funzione esportata parla di
# segreti. Se un giorno ne servisse una, è una decisione, non una svista.
set -euo pipefail
cd "$(dirname "$0")/.."
uscita="${1:-target/legami}"

cargo build --lib
case "$(uname)" in
  Darwin) libreria=target/debug/libestia_nucleo.dylib ;;
  *) libreria=target/debug/libestia_nucleo.so ;;
esac

for lingua in swift kotlin; do
  cargo run -q --bin uniffi-bindgen -- generate --library "$libreria" \
    --language "$lingua" --out-dir "$uscita/$lingua" --no-format
done

esportate="$(grep -E '^\s*(open |public )+func ' "$uscita/swift/EstiaNucleo.swift" || true)"
test -n "$esportate"
if grep -iE 'serratura|segret|secret|export|privat' <<<"$esportate"; then
  echo "legami: il confine del nucleo espone qualcosa che somiglia a un segreto" >&2
  exit 1
fi
echo "legami: Swift e Kotlin in $uscita"
