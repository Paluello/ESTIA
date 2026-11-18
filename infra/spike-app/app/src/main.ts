import { invoke } from "@tauri-apps/api/core";

import { inTauri } from "./cassetto.ts";
import { sonda, type Risultato } from "./sonda.ts";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function mostra(r: Risultato): void {
  const lista = $("voci");
  lista.replaceChildren(
    ...r.voci.map((v) => {
      const li = document.createElement("li");
      li.className = v.esito;
      const nome = document.createElement("span");
      nome.className = "nome";
      nome.textContent = v.ms === undefined ? v.nome : `${v.nome} (${v.ms} ms)`;
      const det = document.createElement("span");
      det.className = "dettaglio";
      det.textContent = v.dettaglio;
      li.append(nome, det);
      return li;
    }),
  );
  $("avanzamento").textContent =
    r.fallite === 0
      ? `Tutto riuscito: ${r.riuscite} prove.`
      : `${r.fallite} prove fallite su ${r.riuscite + r.fallite}.`;
  $("json").textContent = JSON.stringify(r, null, 2);
}

async function avvia(): Promise<void> {
  const r = await sonda((t) => ($("avanzamento").textContent = t));
  mostra(r);
  (globalThis as { __sonda?: Risultato }).__sonda = r;
  if (inTauri()) await invoke("sonda_fine", { risultato: JSON.stringify(r, null, 2) });
}

$("copia").addEventListener("click", () => {
  void navigator.clipboard.writeText($("json").textContent ?? "").then(
    () => ($("copia").textContent = "Copiato"),
    () => ($("copia").textContent = "Non riesco a copiare: seleziona il testo qui sotto"),
  );
});

$("bussa").addEventListener("submit", (e) => {
  e.preventDefault();
  const pulsante = $<HTMLButtonElement>("bussa").querySelector("button")!;
  const esito = $("esito-bussa");
  if (!inTauri()) {
    esito.textContent = "Fuori dall'app non c'è iroh.";
    return;
  }
  pulsante.disabled = true;
  esito.textContent = "Mi collego alla Casa… (fino a 30 secondi)";
  invoke("bussa", { casa: $<HTMLInputElement>("casa").value, domande: 20 })
    .then((r) => (esito.textContent = JSON.stringify(r, null, 2)))
    .catch((err: unknown) => (esito.textContent = `Non riesco: ${String(err)}`))
    .finally(() => (pulsante.disabled = false));
});

if (inTauri()) {
  invoke<string>("rete_chiave").then(
    (k) => ($("mia-chiave").textContent = k),
    (err: unknown) => ($("mia-chiave").textContent = `errore: ${String(err)}`),
  );
}

void avvia();
