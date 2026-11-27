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

/**
 * Chi non conosce Docker: su un Linux con apt l'installatore lo installa da sé,
 * con il consenso, dai pacchetti della distribuzione; su un NAS si ferma e
 * rimanda al centro applicazioni. Tutto è finto: apt-get, sudo, systemctl e
 * usermod scrivono i propri argomenti, e apt-get «installa» un docker finto.
 * Il PATH contiene solo questi e gli strumenti di base, così il Docker vero
 * di chi lancia i test non si vede.
 */
describe("install.sh — Docker per chi non lo conosce", () => {
  const STRUMENTI = [
    "sh",
    "sed",
    "tr",
    "head",
    "id",
    "uname",
    "mktemp",
    "cp",
    "chmod",
    "mkdir",
    "rm",
    "hostname",
    "cut",
    "sleep",
    "env",
    "cat",
    "grep",
    "dirname",
    "basename",
    "printf",
  ];

  const DOCKER_FINTO = `#!/bin/sh
printf 'docker %s\\n' "$*" >>"$FINTO_LOG"
case "$1" in
container) exit 1 ;;
esac
exit 0
`;

  function prepara(opzioni: { osRelease?: string; apt?: boolean }): {
    root: string;
    bin: string;
    log: string;
    env: NodeJS.ProcessEnv;
  } {
    const root = mkdtempSync(path.join(tmpdir(), "estia-docker-"));
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    for (const nome of STRUMENTI) {
      try {
        const dove = execFileSync("sh", ["-c", `command -v ${nome}`], { encoding: "utf8" }).trim();
        if (dove.startsWith("/")) {
          execFileSync("ln", ["-s", dove, path.join(bin, nome)]);
        }
      } catch {
        // Non c'è su questa macchina: lo script non ne ha bisogno per forza.
      }
    }
    const log = path.join(root, "log");
    writeFileSync(log, "");
    writeFileSync(path.join(root, "docker-finto"), DOCKER_FINTO);

    const scrivi = (nome: string, corpo: string) => {
      writeFileSync(path.join(bin, nome), `#!/bin/sh\n${corpo}\n`);
      chmodSync(path.join(bin, nome), 0o755);
    };
    scrivi("sudo", 'printf "sudo %s\\n" "$*" >>"$FINTO_LOG"\nexec "$@"');
    scrivi("systemctl", 'printf "systemctl %s\\n" "$*" >>"$FINTO_LOG"');
    scrivi("usermod", 'printf "usermod %s\\n" "$*" >>"$FINTO_LOG"');
    if (opzioni.apt !== false) {
      scrivi(
        "apt-get",
        [
          'printf "apt-get %s\\n" "$*" >>"$FINTO_LOG"',
          'case "$*" in *install*docker.io*) cp "$FINTO_ROOT/docker-finto" "$FINTO_BIN/docker"; chmod 755 "$FINTO_BIN/docker" ;; esac',
        ].join("\n"),
      );
    }

    const osRelease = path.join(root, "os-release");
    writeFileSync(osRelease, opzioni.osRelease ?? 'ID=linuxmint\nID_LIKE="ubuntu debian"\n');

    return {
      root,
      bin,
      log,
      env: {
        PATH: bin,
        HOME: root,
        ESTIA_OS_RELEASE: osRelease,
        ESTIA_CLI_SRC: CLI,
        ESTIA_CLI_BINDIR: path.join(root, "cli"),
        ESTIA_LINGUA: "en",
        FINTO_LOG: log,
        FINTO_ROOT: root,
        FINTO_BIN: bin,
      },
    };
  }

  function lancia(env: NodeJS.ProcessEnv): { codice: number; uscita: string } {
    try {
      const uscita = execFileSync(path.join(env.FINTO_BIN ?? "", "sh"), [INSTALL_SH], {
        encoding: "utf8",
        env: { NO_COLOR: "1", ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { codice: 0, uscita };
    } catch (errore) {
      const e = errore as { status: number; stdout?: string; stderr?: string };
      return { codice: e.status, uscita: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  }

  it("su un Linux con apt chiede, installa docker.io e poi installa ESTIA", () => {
    const { root, log, env } = prepara({});
    const tty = path.join(root, "tty");
    writeFileSync(tty, "\n");

    const { codice, uscita } = lancia({ ...env, ESTIA_TTY: tty });
    const registro = readFileSync(log, "utf8");

    expect(uscita).toContain("Install Docker? [Y/n]");
    expect(uscita).toContain("apt-get install docker.io");
    expect(registro).toMatch(/apt-get install -y -q docker\.io/);
    expect(registro).toContain("systemctl enable --now docker");
    expect(registro).toMatch(/docker run -d/);
    expect(uscita).toContain("ESTIA is up");
    expect(codice).toBe(0);
  });

  it("una risposta «no» non tocca niente", () => {
    const { root, log, env } = prepara({});
    const tty = path.join(root, "tty");
    writeFileSync(tty, "n\n");

    const { codice, uscita } = lancia({ ...env, ESTIA_TTY: tty });

    expect(codice).not.toBe(0);
    expect(uscita).toContain("I am not touching anything");
    expect(readFileSync(log, "utf8")).not.toContain("apt-get");
  });

  it("senza terminale non installa niente da sé, salvo ESTIA_INSTALLA_DOCKER=1", () => {
    const senza = prepara({});
    const rifiuto = lancia({ ...senza.env, ESTIA_TTY: path.join(senza.root, "nessuno") });
    expect(rifiuto.codice).not.toBe(0);
    expect(rifiuto.uscita).toContain("Docker is not here");
    expect(readFileSync(senza.log, "utf8")).not.toContain("apt-get");

    const con = prepara({});
    const esito = lancia({
      ...con.env,
      ESTIA_TTY: path.join(con.root, "nessuno"),
      ESTIA_INSTALLA_DOCKER: "1",
    });
    expect(readFileSync(con.log, "utf8")).toMatch(/apt-get install -y -q docker\.io/);
    expect(esito.codice).toBe(0);
  });

  it("su un NAS non installa Docker da terminale e rimanda al centro applicazioni", () => {
    const { root, log, env } = prepara({});
    const tty = path.join(root, "tty");
    writeFileSync(tty, "\n");

    const { codice, uscita } = lancia({ ...env, ESTIA_TTY: tty, ESTIA_FINTO_NAS: "1" });

    expect(codice).not.toBe(0);
    expect(uscita).toContain("this machine is a NAS");
    expect(readFileSync(log, "utf8")).not.toContain("apt-get");
  });

  it("su un sistema che non sa riconoscere si ferma e dice come fare", () => {
    const { root, log, env } = prepara({ osRelease: "ID=arch\n", apt: false });
    const tty = path.join(root, "tty");
    writeFileSync(tty, "\n");

    const { codice, uscita } = lancia({ ...env, ESTIA_TTY: tty });

    expect(codice).not.toBe(0);
    expect(uscita).toContain("Docker is not here");
    expect(readFileSync(log, "utf8")).toBe("");
  });

  // Da root il ramo sudo non esiste; in CI i test girano da utente normale.
  it.skipIf(process.getuid?.() === 0)(
    "appena installato, il gruppo docker non vale ancora: usa sudo invece di fermarsi",
    () => {
      const { root, bin, log, env } = prepara({});
      // Docker c'è, ma risponde solo a chi passa da sudo.
      writeFileSync(
        path.join(bin, "docker"),
        `#!/bin/sh\nprintf 'docker %s %s\\n' "\${FINTO_SUDO:-utente}" "$*" >>"$FINTO_LOG"\ncase "$1" in info) [ -n "$FINTO_SUDO" ] || exit 1 ;; container) exit 1 ;; esac\nexit 0\n`,
      );
      chmodSync(path.join(bin, "docker"), 0o755);
      writeFileSync(
        path.join(bin, "sudo"),
        '#!/bin/sh\nprintf "sudo %s\\n" "$*" >>"$FINTO_LOG"\nFINTO_SUDO=sudo exec "$@"\n',
      );
      const tty = path.join(root, "tty");
      writeFileSync(tty, "\n");

      const { codice, uscita } = lancia({ ...env, ESTIA_TTY: tty });
      const registro = readFileSync(log, "utf8");

      expect(uscita).toContain("this time I am using sudo");
      expect(registro).toMatch(/docker sudo run -d/);
      expect(codice).toBe(0);
    },
  );
});

/**
 * Revisione interna 2026-11-27: ricreare il container (con `estia aggiorna` o
 * rilanciando l'installatore) teneva solo i dati, la prima porta e la lingua.
 * Una porta legata a 127.0.0.1 tornava aperta su tutte le interfacce, le
 * variabili dei backup sparivano e la cartella dei backup su un altro disco si
 * staccava. Il docker finto descrive un container così configurato.
 */
describe("ricreare il container conserva la sua configurazione", () => {
  const DOCKER_CONFIGURATO = `#!/bin/sh
printf '%s\\n' "$*" >>"$FINTO_LOG"
case "$1" in
container | inspect)
  case "$*" in
  *compose.project*) ;;
  *Config.Env*) printf '%s\\n' PATH=/usr/bin ESTIA_DATA_DIR=/data ESTIA_HOST=0.0.0.0 ESTIA_LINGUA=it ESTIA_BACKUP_DIR=/data/backup 'ESTIA_BACKUP_PUBLIC_KEY=age1 xyz' ESTIA_AT_REST_ENCRYPTION=1 ;;
  *PortBindings*) printf '%s\\n' '127.0.0.1|8080|3000/tcp' ;;
  *'ne .Destination'*) printf '%s\\n' '/mnt/disco2/estia-backup|/data/backup|true' '/etc/estia-extra|/extra|false' ;;
  *Mounts*) printf '%s\\n' estia-data ;;
  *NetworkSettings*) printf '%s\\n' 8080 ;;
  *NanoCpus*) printf '%s\\n' 1500000000 ;;
  *Memory*) printf '%s\\n' 536870912 ;;
  esac
  ;;
esac
exit 0
`;

  function prepara(): { bin: string; log: string; root: string } {
    const root = mkdtempSync(path.join(tmpdir(), "estia-conserva-"));
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "docker"), DOCKER_CONFIGURATO);
    chmodSync(path.join(bin, "docker"), 0o755);
    const log = path.join(root, "docker.log");
    writeFileSync(log, "");
    return { bin, log, root };
  }

  function rigaRun(log: string): string {
    return (
      readFileSync(log, "utf8")
        .split("\n")
        .find((riga) => riga.startsWith("run ")) ?? ""
    );
  }

  function controllaConservato(run: string): void {
    expect(run).toContain("--publish 127.0.0.1:8080:3000/tcp");
    expect(run).not.toMatch(/--publish (8080|3000):3000/);
    expect(run).toContain("--env ESTIA_BACKUP_DIR=/data/backup");
    expect(run).toContain("--env ESTIA_BACKUP_PUBLIC_KEY=age1 xyz");
    expect(run).toContain("--env ESTIA_AT_REST_ENCRYPTION=1");
    expect(run).toContain("--env ESTIA_LINGUA=it");
    expect(run.match(/ESTIA_LINGUA=/g)).toHaveLength(1);
    expect(run.match(/ESTIA_DATA_DIR=/g)).toHaveLength(1);
    expect(run).toContain("--volume estia-data:/data");
    expect(run).toContain("--volume /mnt/disco2/estia-backup:/data/backup");
    expect(run).toContain("--volume /etc/estia-extra:/extra:ro");
    expect(run).toContain("--memory 536870912");
    expect(run).toContain("--cpus 1.5");
    // La postura di sicurezza resta quella del Compose di riferimento.
    expect(run).toContain("--cap-drop ALL");
    expect(run).toContain("--read-only");
    expect(run).toContain("--user 10001:10001");
  }

  it("estia aggiorna", () => {
    const { bin, log } = prepara();
    sh([CLI, "aggiorna"], { PATH: `${bin}:${process.env.PATH ?? ""}`, FINTO_LOG: log });
    controllaConservato(rigaRun(log));
  });

  it("install.sh rilanciato sulla stessa macchina", () => {
    const { bin, log, root } = prepara();
    sh([INSTALL_SH], {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      ESTIA_TTY: path.join(root, "nessun-tty"),
      ESTIA_CLI_SRC: CLI,
      ESTIA_CLI_BINDIR: path.join(root, "cli"),
      ESTIA_LINGUA: "",
      FINTO_LOG: log,
    });
    controllaConservato(rigaRun(log));
  });

  it("una porta chiesta con ESTIA_PORT vince su quella di prima", () => {
    const { bin, log, root } = prepara();
    sh([INSTALL_SH], {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      ESTIA_TTY: path.join(root, "nessun-tty"),
      ESTIA_CLI_SRC: CLI,
      ESTIA_CLI_BINDIR: path.join(root, "cli"),
      ESTIA_LINGUA: "",
      ESTIA_PORT: "4000",
      FINTO_LOG: log,
    });
    const run = rigaRun(log);
    expect(run).toContain("--publish 4000:3000");
    expect(run).not.toContain("8080");
  });
});
