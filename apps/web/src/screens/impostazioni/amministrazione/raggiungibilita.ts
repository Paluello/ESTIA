import type { FederatedInstanceView } from "@estia/contracts";

import { t, tn } from "../../../lingua.js";
import { giornoEMese } from "../../../tempo.js";

/**
 * Come si dice, a una persona, se un'altra casa c'è.
 *
 * Sta in un modulo suo perché è la parte che si può sbagliare in silenzio: le
 * frasi qui dentro passano typecheck e lint qualunque cosa dicano, e sbagliano
 * soltanto addosso a chi le legge. Con un test si può almeno fissare la
 * distinzione che conta.
 *
 * **«Non lo so ancora» e «non risponde» non sono la stessa cosa**, e mostrarle
 * con le stesse parole è il modo più facile di far preoccupare qualcuno per
 * niente. Il battito di [ADR 0041] guarda **solo** le istanze collegate, quindi
 * per una richiesta in attesa o per una bloccata non esiste nessun «adesso» —
 * e inventarlo sarebbe una diagnosi che nessuno ha fatto.
 */

export type Segnale =
  /** Il battito l'ha raggiunta all'ultimo giro. */
  | "raggiungibile"
  /** Il battito ha provato e non ha ottenuto risposta. */
  | "non-risponde"
  /** Collegata, ma il primo giro non è ancora passato. */
  | "in-ascolto"
  /** Non collegata: il battito non la guarda, e non c'è nessun adesso da dire. */
  | "non-osservata";

const MINUTO = 60_000;
const ORA = 60 * MINUTO;
const GIORNO = 24 * ORA;
const SETTIMANA = 7 * GIORNO;

export function segnaleDi(istanza: FederatedInstanceView): Segnale {
  if (istanza.state !== "collegata") {
    return "non-osservata";
  }

  if (istanza.battito === undefined) {
    return "in-ascolto";
  }

  return istanza.battito.raggiungibile ? "raggiungibile" : "non-risponde";
}

/** Quanto tempo fa, in parole intere: qui la data è il dato, non il contorno. */
export function daQuando(valore: string, adesso: Date = new Date()): string {
  const istante = new Date(valore);
  const trascorso = adesso.getTime() - istante.getTime();

  if (Number.isNaN(trascorso)) {
    return "";
  }

  if (trascorso < MINUTO) {
    return t("battito.meno_di_un_minuto");
  }

  if (trascorso < ORA) {
    const minuti = Math.floor(trascorso / MINUTO);

    return tn("battito.minuti_fa", minuti);
  }

  if (trascorso < GIORNO) {
    const ore = Math.floor(trascorso / ORA);

    return tn("battito.ore_fa", ore);
  }

  if (trascorso < SETTIMANA) {
    const giorni = Math.floor(trascorso / GIORNO);

    return tn("battito.giorni_fa", giorni);
  }

  return t("battito.il_giorno", { giorno: giornoEMese(istante) });
}

/** Fra quanto, per l'arretramento: è l'unico posto dove i minuti si vedono. */
export function fraQuanto(valore: string, adesso: Date = new Date()): string {
  const istante = new Date(valore);
  const mancante = istante.getTime() - adesso.getTime();

  if (Number.isNaN(mancante) || mancante <= MINUTO) {
    // Sotto il minuto non si promette un numero: il giro del battito ha una
    // grana sua, e «fra 4 secondi» sarebbe una precisione che non esiste.
    return t("battito.a_momenti");
  }

  if (mancante < ORA) {
    const minuti = Math.round(mancante / MINUTO);

    return tn("battito.fra_minuti", minuti);
  }

  const ore = Math.round(mancante / ORA);

  return tn("battito.fra_ore", ore);
}

/** Due parole per il pallino e per chi legge con lo screen reader. */
export function etichettaDi(segnale: Segnale): string {
  switch (segnale) {
    case "raggiungibile":
      return t("battito.raggiungibile");
    case "non-risponde":
      return t("battito.non_risponde");
    case "in-ascolto":
      return t("battito.in_ascolto");
    case "non-osservata":
      return "";
  }
}

/**
 * La riga sotto il nome: il dettaglio, **non** lo stato.
 *
 * Lo stato lo dice già il segnale accanto, e ripeterlo qui produceva «Non
 * risponde. Non risponde. Vista…» — un difetto che nessun test di logica trova
 * e che si vede al primo sguardo alla schermata vera. Qui si dice da quando
 * manca, per che strada era passata l'ultima volta, e **quando si riprova**
 * (euristica 9: la prossima mossa, che qui è «nessuna, ci pensa l'istanza»).
 */
export function fraseDi(istanza: FederatedInstanceView, adesso: Date = new Date()): string {
  const segnale = segnaleDi(istanza);

  const via =
    istanza.lastReachedVia === "relay"
      ? t("battito.via_relay")
      : istanza.lastReachedVia === "diretto"
        ? t("battito.via_diretto")
        : "";

  switch (segnale) {
    case "raggiungibile":
      return istanza.lastSeenAt === null
        ? ""
        : t("battito.ha_risposto", { quando: daQuando(istanza.lastSeenAt, adesso), via });

    case "non-risponde": {
      const riprova =
        istanza.battito === undefined
          ? ""
          : t("battito.riprovo", { quando: fraQuanto(istanza.battito.prossimoTentativo, adesso) });

      return istanza.lastSeenAt === null
        ? t("battito.mai_risposto", { riprova })
        : t("battito.vista_riprova", {
            quando: daQuando(istanza.lastSeenAt, adesso),
            via,
            riprova,
          });
    }

    case "in-ascolto":
      return istanza.lastSeenAt === null
        ? t("battito.primo_controllo")
        : t("battito.vista_primo_controllo", { quando: daQuando(istanza.lastSeenAt, adesso), via });

    case "non-osservata":
      return istanza.lastSeenAt === null
        ? t("battito.mai_raggiunta")
        : t("battito.vista", { quando: daQuando(istanza.lastSeenAt, adesso), via });
  }
}
