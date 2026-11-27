/**
 * Il filo fra la voce di menu e il pannello.
 *
 * La voce «Numero di sicurezza» sta nel menu della conversazione, il pannello
 * sta in [`SicurezzaConversazione`](./SicurezzaConversazione.tsx): sono due
 * punti dello schermo, e l'alternativa a questo filo era uno stato in più
 * dentro `Messaggi.tsx` passato a tutti e due. Qui la schermata dice «apri» e
 * non sa altro.
 */
const ascoltatori = new Set<() => void>();

/** Apre il pannello del numero di sicurezza della conversazione aperta. */
export function apriNumeroDiSicurezza(): void {
  for (const ascoltatore of ascoltatori) {
    ascoltatore();
  }
}

export function quandoSiApre(ascoltatore: () => void): () => void {
  ascoltatori.add(ascoltatore);
  return () => {
    ascoltatori.delete(ascoltatore);
  };
}
