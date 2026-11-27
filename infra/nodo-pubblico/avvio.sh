#!/bin/sh
# Scrive la configurazione dell'iroh-relay dalle variabili d'ambiente e lo avvia.
#
# Obbligatorie (fuori dalla modalità di prova):
#   NODO_DOMINIO   il nome DNS che punta a questa macchina, es. relay.circolo.it
#   NODO_EMAIL     il contatto per Let's Encrypt
#
# Facoltative:
#   NODO_BANDA_KIB      banda in ingresso per ogni Casa collegata, KiB/s (predefinito 1024)
#   NODO_RAFFICA_KIB    quanto una Casa può superarla per poco, KiB (predefinito 4096)
#   NODO_LE_STAGING=1   certificati di prova di Let's Encrypt, per non bruciare i tentativi
#   NODO_PROVA=1        HTTP in chiaro sulla 3340, senza certificato: solo per laboratori
#
# Che cosa NON si può limitare qui, e perché: iroh-relay 1.5.0 legge
# `accept_conn_limit` ma non lo applica (src/server.rs, «not currently
# implemented»; misurato in infra/relay-lab), e non ha un tetto di connessioni
# simultanee né di banda totale. Chi li vuole li mette fuori dal contenitore:
# docs/NODO_PUBBLICO.md §«I limiti».
#
# Non c'è controllo d'accesso: il relay è aperto a chiunque (ADR 0045 §4).

set -eu

fail() {
  echo "nodo-pubblico: $1" >&2
  exit 64
}

is_number() {
  case "$1" in
    '' | *[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

BANDA_KIB="${NODO_BANDA_KIB:-1024}"
RAFFICA_KIB="${NODO_RAFFICA_KIB:-4096}"
is_number "$BANDA_KIB" || fail "NODO_BANDA_KIB deve essere un numero intero di KiB/s, non «$BANDA_KIB»."
is_number "$RAFFICA_KIB" || fail "NODO_RAFFICA_KIB deve essere un numero intero di KiB, non «$RAFFICA_KIB»."
[ "$BANDA_KIB" -ge 16 ] || fail "NODO_BANDA_KIB sotto 16 KiB/s rende il relay inutilizzabile."
[ "$BANDA_KIB" -le 4194303 ] || fail "NODO_BANDA_KIB oltre 4194303 non entra nel limite di iroh-relay."
[ "$RAFFICA_KIB" -ge "$BANDA_KIB" ] || fail "NODO_RAFFICA_KIB deve essere almeno NODO_BANDA_KIB."
[ "$RAFFICA_KIB" -le 4194303 ] || fail "NODO_RAFFICA_KIB oltre 4194303 non entra nel limite di iroh-relay."

mkdir -p /dati/certificati
CONFIG=/dati/relay.toml
ARGS="--config-path $CONFIG"

if [ "${NODO_PROVA:-0}" = "1" ]; then
  echo "nodo-pubblico: MODALITÀ DI PROVA, HTTP in chiaro sulla 3340. Non usarla su Internet." >&2
  cat > "$CONFIG" <<TOML
http_bind_addr = "0.0.0.0:3340"
enable_metrics = false
TOML
  ARGS="--dev $ARGS"
else
  [ -n "${NODO_DOMINIO:-}" ] || fail "manca NODO_DOMINIO: il nome DNS che punta a questa macchina (docs/NODO_PUBBLICO.md)."
  [ -n "${NODO_EMAIL:-}" ] || fail "manca NODO_EMAIL: il contatto per il certificato di Let's Encrypt."
  case "$NODO_DOMINIO" in
    *[!a-zA-Z0-9.-]* | .* | *. ) fail "NODO_DOMINIO «$NODO_DOMINIO» non è un nome DNS." ;;
  esac
  case "$NODO_EMAIL" in
    *@*.*) ;;
    *) fail "NODO_EMAIL «$NODO_EMAIL» non sembra un indirizzo email." ;;
  esac
  if [ "${NODO_LE_STAGING:-0}" = "1" ]; then PROD=false; else PROD=true; fi

  cat > "$CONFIG" <<TOML
# IPv4: un contenitore Docker senza IPv6 abilitato non sa legarsi a [::].
http_bind_addr = "0.0.0.0:80"
enable_quic_addr_discovery = true
# Le metriche restano dentro il contenitore: non si pubblicano su Internet.
enable_metrics = true
metrics_bind_addr = "127.0.0.1:9090"

[tls]
cert_mode = "LetsEncrypt"
hostname = "$NODO_DOMINIO"
contact = "$NODO_EMAIL"
cert_dir = "/dati/certificati"
prod_tls = $PROD
TOML
fi

cat >> "$CONFIG" <<TOML

[limits.client.rx]
bytes_per_second = $((BANDA_KIB * 1024))
max_burst_bytes = $((RAFFICA_KIB * 1024))
TOML

echo "nodo-pubblico: configurazione scritta in $CONFIG" >&2
# shellcheck disable=SC2086 # ARGS va diviso apposta.
exec /iroh-relay $ARGS
