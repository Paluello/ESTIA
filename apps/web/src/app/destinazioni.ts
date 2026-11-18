import type { IconName } from "../ui/index.js";
import { t } from "../lingua.js";

export interface Destinazione {
  to: string;
  etichetta: string;
  icona: IconName;
  /** Solo la radice: senza, «Home» resterebbe attiva su ogni percorso. */
  esatta: boolean;
  /**
   * Dove compare. La barra in basso ha cinque posti fissi (stile Threads);
   * la sidebar desktop ne mostra di più (cerca, altro).
   */
  dove: "primaria" | "desktop";
}

/**
 * Le destinazioni di navigazione, in un posto solo.
 *
 * Mobile: cinque voci in basso — home, messaggi, crea, notifiche, profilo —
 * più cerca e impostazioni in alto (cerca a destra, menù a sinistra).
 * Desktop: le stesse voci, espanse nella sidebar, con cerca e impostazioni
 * insieme a loro.
 *
 * Messaggi e notifiche esistono come destinazione anche se la funzione non c'è
 * ancora: una voce che dice onestamente «non ancora» batte nasconderla.
 */
export function destinazioni(username: string): readonly Destinazione[] {
  return [
    { dove: "primaria", esatta: true, etichetta: t("nav.home"), icona: "home", to: "/" },
    { dove: "desktop", esatta: false, etichetta: t("nav.cerca"), icona: "search", to: "/cerca" },
    {
      dove: "primaria",
      esatta: true,
      etichetta: t("nav.messaggi"),
      icona: "send",
      to: "/messaggi",
    },
    { dove: "primaria", esatta: true, etichetta: t("nav.crea"), icona: "plus", to: "/scrivi" },
    {
      dove: "primaria",
      esatta: true,
      etichetta: t("nav.notifiche"),
      icona: "bell",
      to: "/notifiche",
    },
    {
      dove: "primaria",
      esatta: false,
      etichetta: t("nav.profilo"),
      icona: "user",
      to: `/@${username}`,
    },
    {
      dove: "desktop",
      esatta: false,
      etichetta: t("nav.impostazioni"),
      icona: "settings",
      to: "/impostazioni",
    },
  ];
}

export function destinazioniPrimarie(username: string): readonly Destinazione[] {
  return destinazioni(username).filter((d) => d.dove === "primaria");
}
