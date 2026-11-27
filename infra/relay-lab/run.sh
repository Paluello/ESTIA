#!/usr/bin/env bash
# Laboratorio dei relay — ADR 0045 §«Prima di costruire», verifiche 1, 2 e 3.
#
# Gira su una macchina con Docker e, per le prove con la scoperta di n0, con
# rete aperta verso Internet: è pensato per il runner di GitHub Actions
# (`.github/workflows/relay-lab.yml`), ma parte uguale su un portatile.
#
#   infra/relay-lab/run.sh            # tutte le prove
#   LAB_OFFLINE=1 infra/relay-lab/run.sh   # salta quelle che chiedono n0
#
# Topologia: due reti Docker separate, `lab-a` e `lab-b`. Docker non instrada
# fra due reti utente, quindi una Casa su `lab-a` e una su `lab-b` non possono
# parlarsi in diretto: è la condizione di due linee dietro CGNAT, e qualunque
# collegamento riuscito è passato da un relay. I relay stanno su tutte e due.
#
# Ogni prova scrive una riga JSON in `results/out/<prova>.json`; alla fine
# `summary.mjs` le confronta con l'atteso e fallisce se una non torna.
#
# Pulizia: lo script rimuove contenitori e reti che crea, anche se fallisce.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/results/out"
RELAY_IMAGE="${RELAY_IMAGE:-n0computer/iroh-relay:v1.5.0@sha256:50a2f5697d8f69537037503c81b989be17eeb694dbb2d3fdfd5418c9a71c8ec6}"
PROBE_IMAGE="estia-relay-lab-probe:local"
NODO_IMAGE="estia-nodo-pubblico:local"
SHARE="$(mktemp -d)"
chmod 777 "$SHARE"

rm -rf "$OUT"
mkdir -p "$OUT"

cleanup() {
  docker rm -f relay-a relay-b relay-lim relay-nodo casa-b-serve >/dev/null 2>&1 || true
  docker ps -aq --filter label=estia-relay-lab | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network rm lab-a lab-b >/dev/null 2>&1 || true
  # I file li ha scritti la sonda come root: se l'host non può toglierli, li toglie un contenitore.
  rm -rf "$SHARE" 2>/dev/null ||
    docker run --rm -v "$SHARE:/share" --entrypoint sh "$PROBE_IMAGE" -c 'rm -rf /share/*' >/dev/null 2>&1 || true
  rmdir "$SHARE" 2>/dev/null || true
}
trap cleanup EXIT
cleanup

echo "::group::Immagini"
docker image inspect "$RELAY_IMAGE" >/dev/null 2>&1 || docker pull "$RELAY_IMAGE"
# shellcheck disable=SC2086 # PROBE_BUILD_FLAGS va diviso apposta.
[[ "${PROBE_SKIP_BUILD:-0}" == "1" ]] || docker build --quiet ${PROBE_BUILD_FLAGS:-} -t "$PROBE_IMAGE" "$HERE/probe"
# L'immagine del Nodo pubblico, la stessa che si pubblica: la prova 2b passa da lei.
docker build --quiet -t "$NODO_IMAGE" "$HERE/../nodo-pubblico" >/dev/null
echo "::endgroup::"

docker network create lab-a >/dev/null
docker network create lab-b >/dev/null

relay() {
  local name="$1" config="$2"
  docker run -d --name "$name" --label estia-relay-lab --network lab-a \
    -v "$HERE/config/$config:/relay.toml:ro" \
    "$RELAY_IMAGE" --dev --config-path /relay.toml >/dev/null
  docker network connect lab-b "$name"
}

relay relay-a relay-dev.toml
relay relay-b relay-dev.toml
relay relay-lim relay-limited.toml

# Il Nodo pubblico in modalità di prova, con il limite di banda dalle sue variabili.
docker run -d --name relay-nodo --label estia-relay-lab --network lab-a \
  -e NODO_PROVA=1 -e NODO_BANDA_KIB=64 -e NODO_RAFFICA_KIB=128 "$NODO_IMAGE" >/dev/null
docker network connect lab-b relay-nodo
sleep 2

RA="http://relay-a:3340"
RB="http://relay-b:3340"
RL="http://relay-lim:3340"
RN="http://relay-nodo:3340"

# serve <rete> <file-indirizzo> [VAR=valore ...]  — la Casa che riceve, in sottofondo.
serve() {
  local network="$1" file="$2"
  shift 2
  local args=()
  for kv in "$@"; do args+=(-e "$kv"); done
  rm -f "$SHARE/$file"
  docker rm -f casa-b-serve >/dev/null 2>&1 || true
  docker run -d --name casa-b-serve --label estia-relay-lab --network "$network" \
    -v "$SHARE:/share" -e ROLE=serve -e NAME=casa-b -e "OUT=/share/$file" "${args[@]}" \
    "$PROBE_IMAGE" >/dev/null
}

# dial <prova> <rete> <file-indirizzo> [VAR=valore ...]  — la Casa che chiama.
dial() {
  local test="$1" network="$2" file="$3"
  shift 3
  local args=()
  for kv in "$@"; do args+=(-e "$kv"); done
  echo "::group::$test"
  set +e
  docker run --rm --label estia-relay-lab --network "$network" \
    -v "$SHARE:/share" -e ROLE=dial -e NAME=casa-a -e "PEER=/share/$file" "${args[@]}" \
    "$PROBE_IMAGE" | tee "$OUT/$test.json"
  set -e
  docker logs casa-b-serve 2>&1 | head -n 5 > "$OUT/$test.serve.json" || true
  docker rm -f casa-b-serve >/dev/null 2>&1 || true
  echo "::endgroup::"
}

# ── Verifica 1: due Case con relay principali diversi ──────────────────────

# 1a. Si scambiano chiave e relay (come un invito): A conosce solo relay-a, B solo relay-b.
serve lab-b v1a.json PRESET=minimal "RELAYS=$RB"
dial v1a-indirizzo-completo lab-a v1a.json PRESET=minimal "RELAYS=$RA" ADDR=full

# 1b. Il controllo: senza relay dell'altro e senza scoperta non deve passare,
#     altrimenti le reti non sono davvero separate e la prova non vale.
serve lab-b v1b.json PRESET=minimal "RELAYS=$RB"
dial v1b-controllo-senza-relay lab-a v1b.json PRESET=minimal "RELAYS=$RA" ADDR=id-no-relay \
  EXPECT=fail CONNECT_TIMEOUT_MS=10000

if [[ "${LAB_OFFLINE:-0}" != "1" ]]; then
  # 1c. Solo la chiave, con la scoperta DNS di n0: come si raggiungono oggi due Case.
  serve lab-b v1c.json PRESET=n0 "RELAYS=$RB"
  sleep 5 # il tempo di pubblicare il record
  dial v1c-solo-chiave-scoperta-n0 lab-a v1c.json PRESET=n0 "RELAYS=$RA" ADDR=id

  # 1d. A usa un relay della comunità, B solo i relay di n0.
  serve lab-b v1d.json PRESET=n0
  sleep 5
  dial v1d-comunita-verso-n0 lab-a v1d.json PRESET=n0 "RELAYS=$RA" ADDR=id

  # 1e. Il contrario: A solo n0, B su un relay della comunità.
  serve lab-b v1e.json PRESET=n0 "RELAYS=$RB"
  sleep 5
  dial v1e-n0-verso-comunita lab-a v1e.json PRESET=n0 ADDR=id
fi

# ── Verifica 2: i limiti dell'iroh-relay ───────────────────────────────────

# 2a. Riferimento: 1 MiB andata e ritorno su un relay senza limiti.
serve lab-b v2a.json PRESET=minimal "RELAYS=$RA"
dial v2a-banda-senza-limiti lab-a v2a.json PRESET=minimal "RELAYS=$RA" ADDR=full BYTES=1048576 \
  CONNECT_TIMEOUT_MS=60000

# 2b. Lo stesso MiB sull'immagine del Nodo pubblico con NODO_BANDA_KIB=64.
serve lab-b v2b.json PRESET=minimal "RELAYS=$RN"
dial v2b-banda-con-limiti lab-a v2b.json PRESET=minimal "RELAYS=$RN" ADDR=full BYTES=1048576 \
  CONNECT_TIMEOUT_MS=120000

# 2c. Tasso di connessioni: dieci Case che si accendono insieme sul relay limitato
#     (1 al secondo, raffica 2). Si misura quanto tarda ognuna ad avere il relay.
echo "::group::v2c-tasso-di-connessioni"
for i in $(seq 1 10); do
  docker run -d --label estia-relay-lab --label estia-relay-lab-burst --network lab-a \
    -e ROLE=idle -e "NAME=burst-$i" -e PRESET=minimal -e "RELAYS=$RL" -e HOLD_MS=1000 \
    -e ONLINE_TIMEOUT_MS=60000 "$PROBE_IMAGE" >/dev/null
done
for id in $(docker ps -aq --filter label=estia-relay-lab-burst); do docker wait "$id" >/dev/null; done
for id in $(docker ps -aq --filter label=estia-relay-lab-burst); do docker logs "$id" 2>/dev/null; done |
  tee "$OUT/v2c-tasso-di-connessioni.jsonl"
docker ps -aq --filter label=estia-relay-lab-burst | xargs -r docker rm -f >/dev/null
echo "::endgroup::"

# 2d. Lo stesso, sul relay senza limiti, per confronto.
echo "::group::v2d-tasso-senza-limiti"
for i in $(seq 1 10); do
  docker run -d --label estia-relay-lab --label estia-relay-lab-burst --network lab-a \
    -e ROLE=idle -e "NAME=burst-$i" -e PRESET=minimal -e "RELAYS=$RA" -e HOLD_MS=1000 \
    -e ONLINE_TIMEOUT_MS=60000 "$PROBE_IMAGE" >/dev/null
done
for id in $(docker ps -aq --filter label=estia-relay-lab-burst); do docker wait "$id" >/dev/null; done
for id in $(docker ps -aq --filter label=estia-relay-lab-burst); do docker logs "$id" 2>/dev/null; done |
  tee "$OUT/v2d-tasso-senza-limiti.jsonl"
docker ps -aq --filter label=estia-relay-lab-burst | xargs -r docker rm -f >/dev/null
echo "::endgroup::"

# ── Verifica 3: la mappatura delle porte ───────────────────────────────────
#
# Un endpoint con il portmapper attivo, appena acceso, chiede al router una
# porta: NAT-PMP e PCP sulla UDP 5351 del gateway, UPnP con un M-SEARCH SSDP
# sulla 239.255.255.250:1900. In una rete Docker il gateway è l'host, quindi
# `gateway.mjs` ascolta lì, e si confronta la porta chiesta con quella su cui
# l'endpoint è legato.

node "$HERE/gateway.mjs" > "$OUT/v3-gateway.jsonl" 2> "$OUT/v3-gateway.err" &
GATEWAY_PID=$!
sleep 1

portmap() {
  local test="$1"
  shift
  local args=()
  for kv in "$@"; do args+=(-e "$kv"); done
  echo "::group::$test"
  docker run --rm --label estia-relay-lab --network lab-a \
    -e ROLE=idle -e "NAME=$test" -e PRESET=minimal -e "RELAYS=$RA" -e HOLD_MS=15000 "${args[@]}" \
    "$PROBE_IMAGE" | tee "$OUT/$test.json"
  echo "::endgroup::"
}

portmap v3a-porta-casuale
portmap v3b-porta-fissa BIND_ADDR=0.0.0.0:41641

kill "$GATEWAY_PID" 2>/dev/null || true
wait "$GATEWAY_PID" 2>/dev/null || true

node "$HERE/summary.mjs" "$OUT"
