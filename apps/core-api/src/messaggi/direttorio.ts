/**
 * I due versi del confine fra i messaggi e la rete ([ADR 0042](../../../../docs/adr/0042-come-mls-attraversa.md)),
 * e la regola di chi può scrivere a chi ([ADR 0030](../../../../docs/adr/0030-chi-puo-scrivere-a-chi.md)).
 *
 * `direttorioMessaggi` è ciò che questa casa **risponde** quando un'altra le
 * chiede qualcosa di una conversazione; `reteFraCase` è ciò che questa casa
 * **chiede** alle altre. Stanno qui, e non dentro `buildApp`, per una ragione
 * trovata il 2026-11-27: fino a quel giorno `buildApp` collegava soltanto il
 * prelievo dei KeyPackage e il registro delle chiavi. Coda, stato, segnaposto
 * e archivio erano costruiti, provati operazione per operazione — e **mai
 * collegati**: un'istanza vera rispondeva `richiesta_sconosciuta` a ognuna, e
 * una chat fra due case non funzionava. Le prove non lo vedevano perché
 * sostituivano il filo con chiamate dirette al servizio.
 *
 * Con il collegamento in una funzione sola, una prova può chiedere che ci sia
 * tutto: `direttorioMessaggi` ritorna `Required<MessaggiDirectory>`, quindi
 * un'operazione nuova che qui manca **non compila**; e
 * [`due-case-sul-filo.test.ts`](due-case-sul-filo.test.ts) fa parlare due
 * istanze intere attraverso il protocollo.
 */
import type { DispositiviService } from "../dispositivi/service.js";
import type { RemoteState } from "../federation/repository.js";
import type { FederationService, MessaggiDirectory } from "../federation/service.js";
import type { FollowRepository } from "../profile/follows.js";
import type { ProfileRepository } from "../profile/repository.js";

import type { ChiPuoScrivere, MessaggiService, ReteFraCase } from "./service.js";

/** Quello che questa casa risponde alle altre sulle conversazioni. */
export function direttorioMessaggi(
  messaggi: MessaggiService,
  dispositivi: DispositiviService,
): Required<MessaggiDirectory> {
  return {
    chiaviDiFirmaDi: (username) => dispositivi.chiaviDiFirmaDi(username).chiavi,
    depositaHandshake: (record) => messaggi.depositaHandshakeRemoto(record),
    depositaStato: (conversazioneId, remoteKey, tipo, stato) =>
      messaggi.depositaStatoRemoto(conversazioneId, remoteKey, tipo, stato),
    getKeyPackages(username) {
      const preso = dispositivi.claimKeyPackagePerNome(username);
      return preso === null ? [] : [{ blob: preso.keyPackage, id: preso.deviceId }];
    },
    handshakeDa: (conversazioneId, remoteKey, options) =>
      messaggi.handshakeRemoti(conversazioneId, remoteKey, options),
    partecipa: (remoteKey) => messaggi.casaPartecipa(remoteKey),
    riceviSegnapostiSpinti: (spinta) => messaggi.riceviSegnapostiSpinti(spinta),
    segnapostiPerCasa: (conversazioneId, remoteKey, dopo) =>
      messaggi.segnapostiPerCasa(conversazioneId, remoteKey, dopo),
    stato: (conversazioneId, remoteKey, tipo) =>
      messaggi.statoRemoto(conversazioneId, remoteKey, tipo),
    vociPerCasa: (conversazioneId, remoteKey, ids) =>
      messaggi.vociPerCasa(conversazioneId, remoteKey, ids),
  };
}

/** Quello che questa casa chiede alle altre. `casa` è la sua chiave (ADR 0042 §0). */
export function reteFraCase(federation: FederationService, casa: string): ReteFraCase {
  return {
    casa,
    coda: (altra, conversazioneId, dopo) => federation.fetchHandshake(altra, conversazioneId, dopo),
    deposita: (altra, conversazioneId, busta) =>
      federation.depositaHandshakePresso(altra, conversazioneId, busta),
    depositaStato: (altra, conversazioneId, tipo, stato) =>
      federation.depositaStatoPresso(altra, conversazioneId, tipo, stato),
    leggiStato: (altra, conversazioneId, tipo) =>
      federation.leggiStatoPresso(altra, conversazioneId, tipo),
    segnapostiDa: (altra, conversazioneId, dopo) =>
      federation.segnapostiDaPresso(altra, conversazioneId, dopo),
    spingiSegnaposti: (altra, spinta) => federation.spingiSegnapostiA(altra, spinta),
    visitaArchivio: (altra, conversazioneId, ids) =>
      federation.visitaArchivioPresso(altra, conversazioneId, ids),
  };
}

/**
 * Chi, da un'altra casa, può aprire una conversazione con qualcuno di qui.
 *
 * Due strade, e nessun'altra:
 *
 * 1. **le due persone si conoscono**: fra loro c'è un follow accettato, in un
 *    verso o nell'altro. È la relazione di ADR 0030 §1, e l'ha decisa una
 *    persona di qui;
 * 2. **le due case sono collegate** — l'ha deciso chi amministra — **e la
 *    persona di qui è presente in rete**: è la stessa persona che quella casa
 *    può già trovare con la ricerca (ADR 0020), e da cui `Messaggi` fa partire
 *    una chat. Chi ha scelto di non esserci in rete non si raggiunge così.
 *
 * Una casa sconosciuta non passa da nessuna delle due, qualunque nome dichiari.
 * `da` è un campo del messaggio e non una prova: per questo la strada 1 vale
 * solo come permesso di **quella casa** verso **quella persona**, che è ciò che
 * la persona di qui ha accettato — un nome inventato non trova nessun follow.
 */
export function chiPuoScrivere(dipendenze: {
  /** Lo stato del rapporto con una casa, o `undefined` se non la si è mai vista. */
  statoDi: (casa: string) => RemoteState | undefined;
  follows: Pick<FollowRepository, "findFollower" | "findFollowing">;
  profiles: Pick<ProfileRepository, "find">;
}): ChiPuoScrivere {
  return {
    puoAprire(casa, da, destinatario) {
      const stato = dipendenze.statoDi(casa);
      if (stato === "bloccata") {
        return false;
      }

      const coppia = { instance: casa, userId: destinatario.id, username: da };
      if (
        dipendenze.follows.findFollower(coppia)?.state === "accettato" ||
        dipendenze.follows.findFollowing(coppia)?.state === "accettato"
      ) {
        return true;
      }

      if (stato !== "collegata") {
        return false;
      }

      const profilo = dipendenze.profiles.find(destinatario.id);
      return profilo !== undefined && profilo.presence !== "non_presente";
    },
  };
}
