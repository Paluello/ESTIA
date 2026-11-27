import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const INSTALL_SH = path.join(REPO, "install.sh");
const CLI = path.join(REPO, "bin/estia");

function sh(args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync("sh", args, {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...env },
  });
}

describe("install.sh — comando estia sull'host", () => {
  it("è uno script POSIX valido", () => {
    execFileSync("sh", ["-n", INSTALL_SH]);
    execFileSync("sh", ["-n", CLI]);
  });

  it("non si limita più a copiare solo se /usr/local/bin è scrivibile", () => {
    const testo = readFileSync(INSTALL_SH, "utf8");
    expect(testo).toContain("/dev/tty");
    expect(testo).toContain("sudo");
    expect(testo).toContain("$HOME/.local/bin");
    expect(testo).toContain("ESTIA_SOLO_CLI");
    expect(testo).not.toMatch(/if \[ -w \/usr\/local\/bin \]; then\n\tcurl /);
  });

  it("installa la CLI in una cartella indicata, senza sudo e senza Docker", () => {
    const root = mkdtempSync(path.join(tmpdir(), "estia-cli-"));
    const dest = path.join(root, "bin");
    const src = path.join(root, "estia-src");
    writeFileSync(src, "#!/bin/sh\necho ok\n");
    chmodSync(src, 0o755);

    const out = sh([INSTALL_SH], {
      ESTIA_SOLO_CLI: "1",
      ESTIA_CLI_SRC: src,
      ESTIA_CLI_BINDIR: dest,
    });

    expect(out).toContain(path.join(dest, "estia"));
    const installato = readFileSync(path.join(dest, "estia"), "utf8");
    expect(installato).toContain("echo ok");
  });

  it("usa il bin/estia accanto allo script quando si lancia da un clone", () => {
    const root = mkdtempSync(path.join(tmpdir(), "estia-clone-"));
    const dest = path.join(root, "out");
    mkdirSync(dest);
    const cloneInstall = path.join(root, "install.sh");
    const cloneCliDir = path.join(root, "bin");
    mkdirSync(cloneCliDir);
    writeFileSync(cloneInstall, readFileSync(INSTALL_SH));
    writeFileSync(path.join(cloneCliDir, "estia"), "#!/bin/sh\necho dal-clone\n");
    chmodSync(cloneInstall, 0o755);
    chmodSync(path.join(cloneCliDir, "estia"), 0o755);

    sh([cloneInstall], {
      ESTIA_SOLO_CLI: "1",
      ESTIA_CLI_BINDIR: dest,
    });

    expect(readFileSync(path.join(dest, "estia"), "utf8")).toContain("dal-clone");
  });
});

describe("bin/estia — aspetto dei comandi", () => {
  it("aiuto usa la stessa cornice di info e elenca i comandi", () => {
    const out = sh([CLI, "aiuto"]);
    expect(out).toContain("ESTIA");
    expect(out).toContain("estia info");
    expect(out).toContain("estia ripristino-backup");
    expect(out).toContain("╔");
  });

  it("un comando sconosciuto esce con un errore in italiano", () => {
    try {
      sh([CLI, "xyzzy"]);
      throw new Error("doveva fallire");
    } catch (errore) {
      const e = errore as { message: string; stderr?: string };
      expect(`${e.message}\n${e.stderr ?? ""}`).toMatch(/sconosciuto/);
    }
  });
});

/**
 * Verifica 6 di ADR 0046: l'installatore chiede la lingua della Casa quando ha
 * un terminale, non si blocca quando non ce l'ha, e non la richiede rilanciato
 * su un container che la porta già. Docker è finto: uno script che scrive i
 * propri argomenti e risponde come risponderebbe a quelle domande.
 */
describe("install.sh — la lingua della Casa (ADR 0046)", () => {
  const DOCKER_FINTO = `#!/bin/sh
printf '%s\\n' "$*" >>"$FINTO_LOG"
case "$1" in
container)
  [ -n "$FINTO_ESISTE" ] || exit 1
  case "$*" in
  *Config.Env*) printf '%s\\n' "PATH=/usr/bin" $FINTO_ENV ;;
  *Mounts*) printf '%s\\n' estia-data ;;
  esac
  ;;
inspect) printf '%s\\n' 3000 ;;
pull | info | volume | rm | run | exec) ;;
esac
exit 0
`;

  function installa(opzioni: { risposta?: string; esiste?: boolean; env?: string }): {
    uscita: string;
    run: string;
  } {
    const root = mkdtempSync(path.join(tmpdir(), "estia-lingua-"));
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "docker"), DOCKER_FINTO);
    chmodSync(path.join(bin, "docker"), 0o755);
    const log = path.join(root, "docker.log");
    writeFileSync(log, "");

    // Il «terminale»: un file con la risposta, o un percorso che non si apre.
    const tty = path.join(root, "tty");
    if (opzioni.risposta !== undefined) {
      writeFileSync(tty, `${opzioni.risposta}\n`);
    }

    const uscita = sh([INSTALL_SH], {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      ESTIA_TTY: tty,
      ESTIA_CLI_SRC: CLI,
      ESTIA_CLI_BINDIR: path.join(root, "cli"),
      ESTIA_LINGUA: "",
      FINTO_LOG: log,
      FINTO_ESISTE: opzioni.esiste === true ? "1" : "",
      FINTO_ENV: opzioni.env ?? "",
    });
    const run = readFileSync(log, "utf8")
      .split("\n")
      .find((riga) => riga.startsWith("run "));

    return { uscita, run: run ?? "" };
  }

  it("con un terminale chiede la lingua, in tutte le lingue, e la scrive nel container", () => {
    const { uscita, run } = installa({ risposta: "2" });

    expect(uscita).toContain(
      "Which language should this home speak? · In che lingua parla questa Casa?",
    );
    expect(uscita).toContain("English (en)");
    expect(uscita).toContain("Italiano (it)");
    expect(run).toContain("--env ESTIA_LINGUA=it");
    // Dopo la risposta, l'installatore parla quella.
    expect(uscita).toContain("Avvio l'istanza");
    expect(uscita).toContain("ESTIA e' in piedi");
  });

  it("accetta anche il codice, e una risposta vuota tiene l'inglese", () => {
    expect(installa({ risposta: "it" }).run).toContain("--env ESTIA_LINGUA=it");

    const vuota = installa({ risposta: "" });
    expect(vuota.run).toContain("--env ESTIA_LINGUA=en");
    expect(vuota.uscita).toContain("Starting the instance");
  });

  it("senza terminale non si blocca e usa l'inglese", () => {
    const { uscita, run } = installa({});

    expect(uscita).not.toContain("Which language");
    expect(run).toContain("--env ESTIA_LINGUA=en");
    expect(uscita).toContain("ESTIA is up");
  });

  it("rilanciato su un container che ha già la lingua, non la richiede e la conserva", () => {
    const { uscita, run } = installa({ risposta: "1", esiste: true, env: "ESTIA_LINGUA=it" });

    expect(uscita).not.toContain("Which language");
    expect(run).toContain("--env ESTIA_LINGUA=it");
    expect(uscita).toContain("Scarico l'immagine");
  });

  it("elenca le stesse lingue della tabella, e ogni frase le ha tutte", async () => {
    const { lingue } = await import("@estia/lingue");
    const testo = readFileSync(INSTALL_SH, "utf8");
    const dichiarate = /^LINGUE="([^"]*)"$/m.exec(testo)?.[1]?.split(" ") ?? [];

    expect([...dichiarate].sort()).toEqual(
      lingue()
        .map((voce) => voce.codice)
        .sort(),
    );

    const chiavi = new Map<string, Set<string>>();
    for (const [, lingua, chiave] of testo.matchAll(/^\t([a-z*]+):([a-z_.]+)\) printf/gm)) {
      chiavi.set(chiave ?? "", (chiavi.get(chiave ?? "") ?? new Set()).add(lingua ?? ""));
    }
    expect(chiavi.size).toBeGreaterThan(30);
    for (const [chiave, lingueDellaFrase] of chiavi) {
      // `*` è l'inglese, che fa anche da riserva.
      const attese = dichiarate.map((codice) => (codice === "en" ? "*" : codice));
      expect([chiave, [...lingueDellaFrase].sort()]).toEqual([chiave, attese.sort()]);
    }
  });
});
