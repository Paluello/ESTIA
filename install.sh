#!/bin/sh
#
# Installa un'istanza ESTIA, e la aggiorna.
#
# Esiste per una ragione sola, ed e' un difetto vero: un container ESTIA creato
# a mano — dal modulo di un pannello, o con `docker run` senza argomenti — mette
# i dati su un volume che Docker chiama da se'. Quel volume sopravvive a
# `docker compose`, e NON sopravvive al pulsante «aggiorna» di un pannello, che
# butta il container e ne fa un altro dall'immagine. L'istanza torna su un
# volume nuovo e vuoto: da configurare, con una chiave diversa, ogni volta.
#
# Un'immagine non puo' rimediare da se': `VOLUME` dichiara un percorso e non un
# nome, e il nome lo sceglie chi crea il container. Quindi lo sceglie questo
# script, una volta, e non lo chiede a nessuno.
#
# Lo stesso comando installa e aggiorna: rifarlo tira giu' l'immagine nuova e
# ricrea il container sullo stesso volume.
#
# La CLI `estia` non e' il container. Va copiata sull'host, in un posto del
# PATH. Da utente normale `/usr/local/bin` non e' scrivibile (Linux Mint, Ubuntu):
# per quella copia sola si chiede sudo, leggendo la password da /dev/tty perche'
# `curl | sh` occupa stdin. Se sudo non c'e' o viene rifiutato, la CLI finisce
# in ~/.local/bin. Non si avvolge tutto lo script in sudo: Docker resta
# dell'utente, e non si dice «digita estia» se il file non e' stato messo.
#
# Parla la lingua della Casa (ADR 0046). La prima domanda, in inglese e in
# italiano insieme, la sceglie, e la risposta diventa ESTIA_LINGUA sul
# container. Rilanciato per aggiornare, la legge dal container e non la chiede.
# Senza un terminale non chiede niente e usa l'inglese, come l'istanza.

set -eu

IMAGE="${ESTIA_IMAGE:-ghcr.io/paluello/estia:latest}"
NAME="${ESTIA_CONTAINER:-estia}"
VOLUME="${ESTIA_VOLUME:-estia-data}"
PORT="${ESTIA_PORT:-3000}"
CLI_URL="${ESTIA_CLI_URL:-https://raw.githubusercontent.com/Paluello/ESTIA/main/bin/estia}"

CLI_DEST=""
CLI_NEL_PATH=0

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
	C0="\033[0m"
	C1="\033[1m"
	CDIM="\033[2m"
	CCYAN="\033[1;36m"
	CBLUE="\033[4;34m"
	CGREEN="\033[32m"
	CYELLOW="\033[33m"
	CRED="\033[31m"
else
	C0=""
	C1=""
	CDIM=""
	CCYAN=""
	CBLUE=""
	CGREEN=""
	CYELLOW=""
	CRED=""
fi

say() {
	printf '%s\n' "$*"
}

sayb() {
	printf '%b\n' "$*"
}

die() {
	printf '\n%b\n' "${CRED}${C1}$(frase errore)${C0} $*" >&2
	exit 1
}

# --- Lingua (ADR 0046) -------------------------------------------------------
#
# L'installatore parla la lingua della Casa: la prima domanda la sceglie, e la
# stessa risposta diventa ESTIA_LINGUA sul container. Le frasi stanno qui e non
# in packages/lingue perche' questo file si scarica da solo con `curl | sh`, e
# non ha un Node che legga un JSON. Le lingue sono quelle della tabella: un test
# controlla che LINGUE dica le stesse, e che ogni frase le abbia tutte.

LINGUE="en it"
LINGUA=en

# Il terminale da cui si legge la risposta. `curl | sh` occupa stdin, quindi
# la si legge da /dev/tty, come la password di sudo. I test passano un file.
TTY="${ESTIA_TTY:-/dev/tty}"

lingua_nota() {
	case " $LINGUE " in
	*" $1 "*) return 0 ;;
	esac
	return 1
}

# frase CHIAVE — la frase nella lingua dell'installatore. I valori li prende
# dalle variabili dello script, lette quando la frase si scrive.
frase() {
	case "$LINGUA:$1" in
	it:errore) printf '%s' "ERRORE" ;;
	*:errore) printf '%s' "ERROR" ;;

	it:cli.installo) printf '%s' "Installo il comando «estia»…" ;;
	*:cli.installo) printf '%s' "Installing the «estia» command…" ;;
	it:cli.installato) printf '%s' "Installato:" ;;
	*:cli.installato) printf '%s' "Installed:" ;;
	it:cli.prova) printf '%s' "Prova:" ;;
	*:cli.prova) printf '%s' "Try:" ;;
	it:cli.fuori_path) printf '%s' "In questo terminale non e' ancora nel PATH. Prova:" ;;
	*:cli.fuori_path) printf '%s' "It is not in this terminal's PATH yet. Try:" ;;
	it:cli.poi) printf '%s' "Poi:" ;;
	*:cli.poi) printf '%s' "Then:" ;;
	it:cli.non_copiato) printf '%s' "Non sono riuscito a copiare il comando estia in /usr/local/bin ne' in ~/.local/bin." ;;
	*:cli.non_copiato) printf '%s' "Could not copy the estia command to /usr/local/bin or to ~/.local/bin." ;;

	it:sudo.serve) printf '%s' "Per il comando «estia» serve scrivere in ${dest_dir}." ;;
	*:sudo.serve) printf '%s' "The «estia» command needs to be written to ${dest_dir}." ;;
	it:sudo.perche) printf '%s' "E' la password di amministratore (sudo), una volta. L'istanza e' gia' accesa:
senza questa password il comando finisce nella tua home." ;;
	*:sudo.perche) printf '%s' "It is the administrator password (sudo), asked once. The instance is already on:
without this password the command goes into your home folder." ;;

	it:docker.manca) printf '%s' "Docker non c'e'. Su un NAS si installa dal centro applicazioni — Container Manager su Synology, Container Station su QNAP, Docker su UGREEN — e su Linux con: curl -fsSL https://get.docker.com | sh" ;;
	*:docker.manca) printf '%s' "Docker is not here. On a NAS you install it from the app centre — Container Manager on Synology, Container Station on QNAP, Docker on UGREEN — and on Linux with: curl -fsSL https://get.docker.com | sh" ;;
	it:docker.muto) printf '%s' "Docker c'e' ma non risponde. Se sei su Linux e l'hai appena installato, il tuo utente non e' ancora nel gruppo docker: 'sudo usermod -aG docker \"\$USER\"', poi chiudi e riapri il terminale." ;;
	*:docker.muto) printf '%s' "Docker is here but does not answer. If you are on Linux and have just installed it, your user is not in the docker group yet: 'sudo usermod -aG docker \"\$USER\"', then close and reopen the terminal." ;;

	it:esistente.senza_volume) printf '%s' "C'e' gia' un container «${NAME}» che tiene i dati dentro di se', senza volume. Ricrearlo li cancellerebbe. Fermati: 'docker cp $NAME:/data ./estia-data-salvata' li porta fuori, e da li' si ripartono." ;;
	*:esistente.senza_volume) printf '%s' "There is already a container «${NAME}» that keeps its data inside itself, without a volume. Recreating it would erase them. Stop here: 'docker cp $NAME:/data ./estia-data-saved' copies them out, and you start again from there." ;;

	it:immagine.scarico) printf '%s' "Scarico l'immagine…" ;;
	*:immagine.scarico) printf '%s' "Downloading the image…" ;;
	it:immagine.offline) printf '%s' "(non ho raggiunto il registry: uso l'immagine gia' presente)" ;;
	*:immagine.offline) printf '%s' "(could not reach the registry: using the image already here)" ;;
	it:immagine.manca) printf '%s' "Non riesco a scaricare $IMAGE e qui non c'e'. Se la macchina non ha Internet, portacela da un altro computer: docker save $IMAGE | gzip | ssh utente@macchina 'docker load'" ;;
	*:immagine.manca) printf '%s' "Cannot download $IMAGE, and it is not here. If this machine has no Internet, bring it from another computer: docker save $IMAGE | gzip | ssh user@machine 'docker load'" ;;

	it:avvio.avvio) printf '%s' "Avvio l'istanza…" ;;
	*:avvio.avvio) printf '%s' "Starting the instance…" ;;
	it:avvio.fallito) printf '%s' "Non sono riuscito ad avviare il container. Se la porta $PORT e' gia' occupata da qualcos'altro, rilancia scegliendone un'altra: ESTIA_PORT=3001 sh install.sh" ;;
	*:avvio.fallito) printf '%s' "Could not start the container. If port $PORT is already taken by something else, run it again with another one: ESTIA_PORT=3001 sh install.sh" ;;
	it:avvio.attendo) printf '%s' "Attendo che sia pronta…" ;;
	*:avvio.attendo) printf '%s' "Waiting for it to be ready…" ;;
	it:avvio.scaduto) printf '%s' "L'istanza non ha risposto entro un minuto. I log dicono perche': docker logs $NAME" ;;
	*:avvio.scaduto) printf '%s' "The instance did not answer within a minute. The logs say why: docker logs $NAME" ;;

	it:esito.titolo) printf '%s' "🏡 ESTIA e' in piedi                                              " ;;
	*:esito.titolo) printf '%s' "🏡 ESTIA is up                                                    " ;;
	it:esito.accesso) printf '%s' "ACCESSO ALL'ISTANZA" ;;
	*:esito.accesso) printf '%s' "OPENING THE INSTANCE" ;;
	it:esito.in_esecuzione) printf '%s' "in esecuzione" ;;
	*:esito.in_esecuzione) printf '%s' "running" ;;
	it:esito.porta) printf '%s' "Porta:       " ;;
	*:esito.porta) printf '%s' "Port:        " ;;
	it:esito.dati) printf '%s' "Dati:        " ;;
	*:esito.dati) printf '%s' "Data:        " ;;
	it:esito.lingua) printf '%s' "Lingua:      " ;;
	*:esito.lingua) printf '%s' "Language:    " ;;
	it:esito.comando) printf '%s' "COMANDO «estia»" ;;
	*:esito.comando) printf '%s' "THE «estia» COMMAND" ;;
	it:esito.installato) printf '%s' "Installato:  " ;;
	*:esito.installato) printf '%s' "Installed:   " ;;
	it:esito.da_qui) printf '%s' "Da qui:      " ;;
	*:esito.da_qui) printf '%s' "From here:   " ;;
	it:esito.fuori_path) printf '%s' "In questo terminale «estia» non e' ancora nel PATH." ;;
	*:esito.fuori_path) printf '%s' "«estia» is not in this terminal's PATH yet." ;;
	it:esito.prova_ora) printf '%s' "Prova ora:   " ;;
	*:esito.prova_ora) printf '%s' "Try now:     " ;;
	it:esito.prossimi) printf '%s' "Poi, per i prossimi terminali:" ;;
	*:esito.prossimi) printf '%s' "Then, for the terminals you open later:" ;;
	it:esito.riapri) printf '%s' "chiudi e riapri il terminale, oppure:" ;;
	*:esito.riapri) printf '%s' "close and reopen the terminal, or:" ;;
	it:esito.cmd.info) printf '%s' "Questa panoramica" ;;
	*:esito.cmd.info) printf '%s' "This overview" ;;
	it:esito.cmd.stato) printf '%s' "Dettagli tecnici e diagnostica Docker" ;;
	*:esito.cmd.stato) printf '%s' "Technical details and Docker diagnostics" ;;
	it:esito.cmd.ripristino) printf '%s' "Ripristina un backup cifrato" ;;
	*:esito.cmd.ripristino) printf '%s' "Restores an encrypted backup" ;;
	it:esito.cmd.backup) printf '%s' "Esegue un backup immediato" ;;
	*:esito.cmd.backup) printf '%s' "Takes a backup right now" ;;
	it:esito.cmd.logs) printf '%s' "Visualizza i log in tempo reale" ;;
	*:esito.cmd.logs) printf '%s' "Shows the logs as they happen" ;;
	it:esito.cmd.aggiorna) printf '%s' "Aggiorna all'ultima versione" ;;
	*:esito.cmd.aggiorna) printf '%s' "Updates to the latest version" ;;
	it:esito.cmd.riavvia) printf '%s' "Riavvia il container" ;;
	*:esito.cmd.riavvia) printf '%s' "Restarts the container" ;;
	it:esito.cli_fallita) printf '%s' "Non e' stato possibile copiarlo in /usr/local/bin ne' in ~/.local/bin." ;;
	*:esito.cli_fallita) printf '%s' "Could not copy it to /usr/local/bin or to ~/.local/bin." ;;
	it:esito.cli_a_mano) printf '%s' "L'istanza gira lo stesso. Per avere il comando:" ;;
	*:esito.cli_a_mano) printf '%s' "The instance runs anyway. To get the command:" ;;
	it:esito.aggiornare) printf '%s' "AGGIORNARE, UN DOMANI" ;;
	*:esito.aggiornare) printf '%s' "UPDATING, LATER ON" ;;
	it:esito.volume) printf '%s' "I dati stanno sul volume «${VOLUME}» e restano dove sono." ;;
	*:esito.volume) printf '%s' "The data lives on the volume «${VOLUME}» and stays where it is." ;;
	it:esito.rilancia) printf '%s' "Rilancia questo stesso comando, oppure" ;;
	*:esito.rilancia) printf '%s' "Run this same command again, or" ;;
	it:esito.codice) printf '%s' "Il codice di configurazione e' in cima ai log, e vale finche' il processo resta acceso:" ;;
	*:esito.codice) printf '%s' "The setup code is at the top of the logs, and it works as long as the process keeps running:" ;;
	it:esito.documentazione) printf '%s' "Documentazione:" ;;
	*:esito.documentazione) printf '%s' "Documentation:" ;;
	esac
}

# Il nome di una lingua nella lingua stessa, come lo scrive la tabella.
nome_lingua() {
	case "$1" in
	en) printf '%s' "English" ;;
	it) printf '%s' "Italiano" ;;
	*) printf '%s' "$1" ;;
	esac
}

# Si puo' leggere dal terminale? `[ -r /dev/tty ]` dice di si' anche senza un
# terminale che controlla il processo, e poi l'apertura fallisce: si prova ad
# aprirlo davvero.
terminale() {
	(exec <"$TTY") 2>/dev/null
}

# chiedi_lingua — la prima domanda, in tutte le lingue insieme perche' ancora
# non si sa quale legge chi installa. Una risposta vuota o sconosciuta tiene
# l'inglese: meglio un'istanza in una lingua sbagliata, che ognuno cambia per
# se', che un'installazione ferma.
chiedi_lingua() {
	sayb "${C1}Which language should this home speak? · In che lingua parla questa Casa?${C0}"
	i=0
	for codice in $LINGUE; do
		i=$((i + 1))
		sayb "  ${C1}${i}${C0}  $(nome_lingua "$codice") (${codice})"
	done
	printf '%s' "[1] > "
	risposta=""
	IFS= read -r risposta <"$TTY" || risposta=""
	say ""

	i=0
	for codice in $LINGUE; do
		i=$((i + 1))
		if [ "$risposta" = "$i" ] || [ "$risposta" = "$codice" ]; then
			LINGUA="$codice"
			return 0
		fi
	done
	LINGUA=en
}

# La lingua scritta su un container che esiste gia', se ce l'ha.
lingua_del_container() {
	docker container inspect "$NAME" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null |
		sed -n 's/^ESTIA_LINGUA=//p' | head -n 1
}

# scegli_lingua — ESTIA_LINGUA se chi lancia l'ha data; poi quella del
# container che c'e' gia', perche' un aggiornamento non e' il momento di rifare
# le scelte; poi la domanda, se c'e' un terminale; altrimenti l'inglese.
scegli_lingua() {
	if [ -n "${ESTIA_LINGUA:-}" ] && lingua_nota "$ESTIA_LINGUA"; then
		LINGUA="$ESTIA_LINGUA"
		return 0
	fi

	if command -v docker >/dev/null 2>&1 && docker container inspect "$NAME" >/dev/null 2>&1; then
		esistente=$(lingua_del_container || true)
		if [ -n "$esistente" ] && lingua_nota "$esistente"; then
			LINGUA="$esistente"
			return 0
		fi
	fi

	if [ "${1:-}" = "chiedi" ] && terminale; then
		chiedi_lingua
		return 0
	fi

	LINGUA=en
}

# --- CLI locale (`estia` sul PATH) -------------------------------------------

cli_sorgente() {
	if [ -n "${ESTIA_CLI_SRC:-}" ] && [ -f "$ESTIA_CLI_SRC" ]; then
		printf '%s\n' "$ESTIA_CLI_SRC"
		return 0
	fi

	# `curl | sh` ha $0 uguale a `sh`: non prendere un bin/estia a caso
	# dalla cartella corrente. Uno script su disco (./install.sh) si.
	case "$0" in
	/* | ./* | ../* | *.sh)
		dir=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd) || dir=""
		if [ -n "$dir" ] && [ -f "$dir/bin/estia" ]; then
			printf '%s\n' "$dir/bin/estia"
			return 0
		fi
		;;
	esac

	return 1
}

prepara_cli_tmp() {
	tmp="$1"
	src=""
	if src=$(cli_sorgente); then
		cp "$src" "$tmp"
		return 0
	fi
	if command -v curl >/dev/null 2>&1 && curl -fsSL "$CLI_URL" -o "$tmp"; then
		return 0
	fi
	return 1
}

# Copia $1 in /usr/local/bin/estia. Da utente normale quella cartella non e'
# scrivibile: si chiede sudo, con la password dal terminale e non dalla pipe.
installa_cli_in_usr_local() {
	src="$1"
	dest_dir=/usr/local/bin
	dest="$dest_dir/estia"

	if [ -d "$dest_dir" ] && [ -w "$dest_dir" ]; then
		cp "$src" "$dest" && chmod 755 "$dest"
		return 0
	fi

	if [ "$(id -u)" -eq 0 ]; then
		mkdir -p "$dest_dir" && cp "$src" "$dest" && chmod 755 "$dest"
		return 0
	fi

	if ! command -v sudo >/dev/null 2>&1; then
		return 1
	fi

	if sudo -n true >/dev/null 2>&1; then
		sudo mkdir -p "$dest_dir" && sudo cp "$src" "$dest" && sudo chmod 755 "$dest"
		return 0
	fi

	if [ ! -r /dev/tty ]; then
		return 1
	fi

	sayb ""
	sayb "${CYELLOW}$(frase sudo.serve)${C0}"
	sayb "$(frase sudo.perche)"
	sayb ""

	if sudo mkdir -p "$dest_dir" </dev/tty &&
		sudo cp "$src" "$dest" </dev/tty &&
		sudo chmod 755 "$dest" </dev/tty; then
		return 0
	fi
	return 1
}

installa_cli_in_home() {
	src="$1"
	dest_dir="$HOME/.local/bin"
	dest="$dest_dir/estia"
	mkdir -p "$dest_dir" || return 1
	cp "$src" "$dest" && chmod 755 "$dest"
}

cli_segna_path() {
	dir=$(dirname "$CLI_DEST")
	case ":$PATH:" in
	*":$dir:"*)
		CLI_NEL_PATH=1
		;;
	*)
		CLI_NEL_PATH=0
		;;
	esac
}

# Imposta CLI_DEST se il file e' al suo posto. CLI_NEL_PATH=1 se la cartella
# era gia' nel PATH di chi ha lanciato lo script (quindi «estia» funziona
# nello stesso terminale, senza export).
install_cli() {
	CLI_DEST=""
	CLI_NEL_PATH=0
	tmp=$(mktemp)
	if ! prepara_cli_tmp "$tmp"; then
		rm -f "$tmp"
		return 1
	fi
	chmod 755 "$tmp"

	if [ -n "${ESTIA_CLI_BINDIR:-}" ]; then
		mkdir -p "$ESTIA_CLI_BINDIR"
		cp "$tmp" "$ESTIA_CLI_BINDIR/estia"
		chmod 755 "$ESTIA_CLI_BINDIR/estia"
		CLI_DEST="$ESTIA_CLI_BINDIR/estia"
		rm -f "$tmp"
		cli_segna_path
		return 0
	fi

	if installa_cli_in_usr_local "$tmp"; then
		CLI_DEST=/usr/local/bin/estia
	elif installa_cli_in_home "$tmp"; then
		CLI_DEST="$HOME/.local/bin/estia"
	fi

	rm -f "$tmp"

	if [ -z "$CLI_DEST" ] || [ ! -x "$CLI_DEST" ]; then
		CLI_DEST=""
		return 1
	fi

	cli_segna_path
	return 0
}

# I test importano le funzioni qui sopra senza toccare Docker.
if [ "${ESTIA_INSTALL_LIB:-}" = "1" ]; then
	return 0 2>/dev/null || exit 0
fi

# Istanza gia' in piedi, manca solo il comando (il caso Linux Mint).
if [ "${ESTIA_SOLO_CLI:-}" = "1" ]; then
	scegli_lingua
	sayb "${CCYAN}→${C0} $(frase cli.installo)"
	if install_cli; then
		sayb ""
		ok_line="$(frase cli.installato) ${CLI_DEST}"
		if [ "$CLI_NEL_PATH" = "1" ]; then
			sayb "${CGREEN}●${C0} $ok_line"
			sayb "  $(frase cli.prova) ${C1}estia info${C0}"
		else
			sayb "${CGREEN}●${C0} $ok_line"
			sayb "  $(frase cli.fuori_path) ${C1}$CLI_DEST info${C0}"
			sayb "  $(frase cli.poi) export PATH=\"\$HOME/.local/bin:\$PATH\""
		fi
		exit 0
	fi
	die "$(frase cli.non_copiato)"
fi

# --- Istanza -----------------------------------------------------------------

# Prima di ogni altra cosa, cosi' da qui in poi l'installatore parla quella.
scegli_lingua chiedi

if ! command -v docker >/dev/null 2>&1; then
	die "$(frase docker.manca)"
fi

if ! docker info >/dev/null 2>&1; then
	die "$(frase docker.muto)"
fi

# Il controllo che questo script esiste per non far saltare a nessuno.
#
# Se qui c'e' gia' un container con questo nome e i suoi dati NON stanno sul
# volume che gestiamo noi, ricrearlo li lascerebbe orfani: durano, ma l'istanza
# nuova non li vedrebbe e ripartirebbe vuota. E' esattamente il modo in cui si
# perde una configurazione, quindi ci si ferma e si dice dove sono.
if docker container inspect "$NAME" >/dev/null 2>&1; then
	MOUNTED="$(docker container inspect "$NAME" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}')"
	EXISTING_PORT="$(docker inspect -f '{{range $p, $conf := .NetworkSettings.Ports}}{{if $conf}}{{(index $conf 0).HostPort}}{{end}}{{end}}' "$NAME" 2>/dev/null || true)"

	if [ -n "$EXISTING_PORT" ] && [ "${PORT}" = "3000" ]; then
		PORT="$EXISTING_PORT"
	fi

	case "$MOUNTED" in
	"")
		die "$(frase esistente.senza_volume)"
		;;
	*)
		VOLUME="$MOUNTED"
		;;
	esac
fi

sayb "${CCYAN}→${C0} $(frase immagine.scarico)"

# Un pull fallito non e' per forza un problema: l'immagine puo' essere gia' qui,
# portata da `docker load` su una macchina senza Internet. Fallisce solo se dopo
# il tentativo non c'e' comunque niente da avviare.
if ! docker pull "$IMAGE" >/dev/null 2>&1; then
	if docker image inspect "$IMAGE" >/dev/null 2>&1; then
		sayb "  ${CDIM}$(frase immagine.offline)${C0}"
	else
		die "$(frase immagine.manca)"
	fi
fi

# Creato esplicitamente e prima del container: cosi' esiste con un nome anche
# se il run qui sotto fallisce, e il nome e' l'unica cosa che rende dei dati
# ritrovabili sei mesi dopo.
docker volume create "$VOLUME" >/dev/null

docker rm -f "$NAME" >/dev/null 2>&1 || true

sayb "${CCYAN}→${C0} $(frase avvio.avvio)"

# La stessa postura del Compose in infra/: utente non root, filesystem in sola
# lettura tranne il volume, nessuna capability, nessun privilegio nuovo.
# ESTIA_LINGUA e' la lingua della Casa: l'istanza la valida all'avvio.
docker run -d \
	--name "$NAME" \
	--restart unless-stopped \
	--publish "${PORT}:3000" \
	--volume "${VOLUME}:/data" \
	--env ESTIA_DATA_DIR=/data \
	--env ESTIA_HOST=0.0.0.0 \
	--env ESTIA_LINGUA="$LINGUA" \
	--user 10001:10001 \
	--init \
	--read-only \
	--tmpfs /tmp \
	--cap-drop ALL \
	--security-opt no-new-privileges:true \
	--pids-limit 256 \
	"$IMAGE" >/dev/null || die "$(frase avvio.fallito)"

WAITED=0

sayb "${CCYAN}→${C0} $(frase avvio.attendo)"

while [ "$WAITED" -lt 60 ]; do
	if docker exec "$NAME" node -e "fetch('http://127.0.0.1:3000/health/ready').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
		break
	fi

	WAITED=$((WAITED + 1))
	sleep 1
done

if [ "$WAITED" -ge 60 ]; then
	die "$(frase avvio.scaduto)"
fi

# Solo la prima etichetta: `hostname` su parecchie macchine risponde con il
# nome completo appiccicato dal router, e «casa.rete-del-provider.it.local» non
# risolve da nessuna parte.
HOSTNAME_LOCAL="$(hostname 2>/dev/null | cut -d. -f1)"
HOSTNAME_LOCAL="${HOSTNAME_LOCAL:-localhost}"

sayb "${CCYAN}→${C0} $(frase cli.installo)"

if install_cli; then
	:
else
	CLI_DEST=""
fi

# --- Esito, nello stesso aspetto di `estia info` -----------------------------

sayb "
${CCYAN}╔════════════════════════════════════════════════════════════════════╗
║  $(frase esito.titolo)║
╚════════════════════════════════════════════════════════════════════╝${C0}

📍 ${C1}$(frase esito.accesso)${C0}
   ${CCYAN}├──${C0} Web:          ${CBLUE}http://${HOSTNAME_LOCAL}.local:${PORT}${C0}
   ${CCYAN}├──${C0} Container:    ${NAME} (${CGREEN}● $(frase esito.in_esecuzione)${C0})
   ${CCYAN}├──${C0} $(frase esito.porta) ${PORT}
   ${CCYAN}├──${C0} $(frase esito.lingua) $(nome_lingua "$LINGUA")
   ${CCYAN}└──${C0} $(frase esito.dati) ${VOLUME} → /data
"

if [ -n "$CLI_DEST" ]; then
	sayb "🛠  ${C1}$(frase esito.comando)${C0}
   ${CCYAN}├──${C0} $(frase esito.installato) ${CLI_DEST}"
	if [ "$CLI_NEL_PATH" = "1" ]; then
		sayb "   ${CCYAN}└──${C0} $(frase esito.da_qui) ${C1}estia info${C0}
"
	else
		sayb "   ${CCYAN}└──${C0} ${CYELLOW}$(frase esito.fuori_path)${C0}
       $(frase esito.prova_ora) ${C1}$CLI_DEST info${C0}
       $(frase esito.prossimi)

          echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.profile
          # $(frase esito.riapri)
          export PATH=\"\$HOME/.local/bin:\$PATH\"
"
	fi
	sayb "   ${CCYAN}├──${C0} ${C1}estia info${C0}                  $(frase esito.cmd.info)
   ${CCYAN}├──${C0} ${C1}estia stato${C0}                 $(frase esito.cmd.stato)
   ${CCYAN}├──${C0} ${C1}estia ripristino-backup${C0}     $(frase esito.cmd.ripristino)
   ${CCYAN}├──${C0} ${C1}estia backup${C0}                $(frase esito.cmd.backup)
   ${CCYAN}├──${C0} ${C1}estia logs -f${C0}               $(frase esito.cmd.logs)
   ${CCYAN}├──${C0} ${C1}estia aggiorna${C0}              $(frase esito.cmd.aggiorna)
   ${CCYAN}└──${C0} ${C1}estia riavvia${C0}               $(frase esito.cmd.riavvia)
"
else
	sayb "🛠  ${C1}$(frase esito.comando)${C0}
   ${CYELLOW}$(frase esito.cli_fallita)${C0}
   $(frase esito.cli_a_mano)

      sudo curl -fsSL ${CLI_URL} -o /usr/local/bin/estia
      sudo chmod 755 /usr/local/bin/estia
"
fi

sayb "💾 ${C1}$(frase esito.aggiornare)${C0}
   ${CCYAN}├──${C0} $(frase esito.volume)
   ${CCYAN}└──${C0} $(frase esito.rilancia) ${C1}estia aggiorna${C0}.

📖 ${CDIM}$(frase esito.codice)${C0}

      docker logs ${NAME} | head -20

${CDIM}$(frase esito.documentazione) https://github.com/Paluello/ESTIA${C0}
"
