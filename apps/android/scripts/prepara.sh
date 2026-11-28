#!/usr/bin/env bash
# Prepara quello che il progetto Gradle non tiene in git:
#
# - il nucleo Rust (apps/nucleo) per Android arm64, in jniLibs, con i suoi
#   legami Kotlin;
# - le frasi di packages/lingue, copiate così come sono: l'app le legge dalla
#   stessa tabella del web (ADR 0051 §5).
#
#   scripts/prepara.sh [--debug]
#
# Serve l'NDK: ANDROID_NDK_HOME, oppure l'ultimo in $ANDROID_HOME/ndk.
set -euo pipefail
cd "$(dirname "$0")/.."
android="$(pwd)"
nucleo="$android/../nucleo"
profilo=release
[ "${1:-}" = "--debug" ] && profilo=debug
opzione_profilo=$([ "$profilo" = debug ] && echo "" || echo "--release")

ndk="${ANDROID_NDK_HOME:-${ANDROID_NDK_LATEST_HOME:-}}"
if [ -z "$ndk" ] && [ -n "${ANDROID_HOME:-}" ] && [ -d "$ANDROID_HOME/ndk" ]; then
  ndk="$(ls -d "$ANDROID_HOME"/ndk/* | sort -V | tail -1)"
fi
[ -d "$ndk" ] || { echo "prepara: NDK non trovato (ANDROID_NDK_HOME)" >&2; exit 1; }
ospite="$(ls "$ndk/toolchains/llvm/prebuilt" | head -1)"
strumenti="$ndk/toolchains/llvm/prebuilt/$ospite/bin"

# Lo stesso minimo di app/build.gradle.kts.
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$strumenti/aarch64-linux-android28-clang"
export CC_aarch64_linux_android="$CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER"
export AR_aarch64_linux_android="$strumenti/llvm-ar"
# Pagine da 16 KB: Android 15 le usa, e Google Play le chiede.
export CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS="-C link-arg=-Wl,-z,max-page-size=16384"

rustup target add aarch64-linux-android >/dev/null
( cd "$nucleo"
  cargo build --locked --lib $opzione_profilo --target aarch64-linux-android
  ./scripts/legami.sh "$nucleo/target/legami" )

rm -rf app/src/generato app/src/main/jniLibs
mkdir -p app/src/generato/kotlin app/src/main/jniLibs/arm64-v8a app/src/main/assets/frasi
cp -R "$nucleo/target/legami/kotlin/." app/src/generato/kotlin/
cp "$nucleo/target/aarch64-linux-android/$profilo/libestia_nucleo.so" app/src/main/jniLibs/arm64-v8a/
"$strumenti/llvm-strip" --strip-unneeded app/src/main/jniLibs/arm64-v8a/libestia_nucleo.so

for lingua in it en; do
  cp "$android/../../packages/lingue/src/frasi/$lingua.json" "app/src/main/assets/frasi/frasi-$lingua.json"
done
echo "prepara: pronto. gradle assembleDebug, oppure apri la cartella in Android Studio"
