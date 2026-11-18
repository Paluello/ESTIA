/**
 * Come si chiamano le sezioni delle impostazioni, in un posto solo.
 *
 * Sta qui e non in `registro.ts` per una ragione meccanica: `registro.ts`
 * importa le dieci schermate, ogni schermata importa `Sezione`, e se `Sezione`
 * andasse a leggere il registro si chiuderebbe un cerchio — registro →
 * EstiaNet → Sezione → registro. ESM lo regge, il bundler lo segnala, e
 * l'ordine di valutazione diventa una cosa da sperare. Questo file non importa
 * soltanto la tabella delle frasi, quindi non può chiudere nessun cerchio.
 *
 * Il titolo di una sezione era scritto **due volte**: qui e nella schermata,
 * dentro `<Sezione titolo="…">`. Cinque schermate lo scrivevano perfino tre
 * volte, perché duplicavano l'intera cornice per dire «Carico…». Il giorno che
 * cambia, ne cambia una sola.
 */

import { t } from "../../lingua.js";

export type Chiave =
  | "aspetto"
  | "presenza"
  | "chat"
  | "dispositivi"
  | "informazioni"
  | "inviti"
  | "estianet"
  | "backup"
  | "stato"
  | "registro";

/**
 * Il nome di ogni sezione: lo legge la nav, la ricerca e la pagina stessa. Si
 * legge nella lingua di chi guarda nel momento in cui lo si chiede.
 */
export const TITOLI: Readonly<Record<Chiave, string>> = {
  get aspetto(): string {
    return t("sezioni.aspetto");
  },
  get backup(): string {
    return t("sezioni.backup");
  },
  get chat(): string {
    return t("sezioni.chat");
  },
  get dispositivi(): string {
    return t("sezioni.dispositivi");
  },
  get estianet(): string {
    return t("sezioni.estianet");
  },
  get informazioni(): string {
    return t("sezioni.informazioni");
  },
  get inviti(): string {
    return t("sezioni.inviti");
  },
  get presenza(): string {
    return t("sezioni.presenza");
  },
  get registro(): string {
    return t("sezioni.registro");
  },
  get stato(): string {
    return t("sezioni.stato");
  },
};
