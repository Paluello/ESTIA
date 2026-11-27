# Installing an ESTIA instance

This guide takes an instance from nothing to "it works, and I have a backup".

You need a machine that stays on: a NAS, a mini-PC, an old laptop running Linux, a home server. Here we call it **the machine**; where a NAS does things differently, it says so.

It was written after real installations, and its most tedious steps exist because those times they went wrong. The product budget is **under 30 minutes** ([`PRODUCT_VISION.md`](../PRODUCT_VISION.md) §4): if it takes you much longer, that is a bug in the guide, not in you.

> This is the English translation of [`INSTALLAZIONE.md`](../INSTALLAZIONE.md). The Italian guide is the reference: if the two ever disagree, it wins, and the disagreement is a bug worth reporting.

## How to read this guide

Three things before you start, because they are the three that tripped up the last installation.

**Grey blocks are not all the same.** Blocks marked `sh` are **commands**: paste them into the terminal and press Enter. Blocks marked `yaml` are the **contents of a file**: they do not work in the terminal, and pasting them there answers `command not found`. Where a file is needed, the guide also gives you the command that writes it for you.

**There are three ways, and one is enough.**

| Way                 | For whom                                                          | What you follow                                                                                                            |
| ------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **One command**     | Anyone with a terminal. It is the shortest and asks no questions  | [The command](#install-with-one-command), then from step 7                                                                 |
| **Step by step**    | Those who want to see every piece, or change something on the way | Steps 1 to 13, in order                                                                                                    |
| **Graphical panel** | NAS only, if you would rather not open a terminal                 | Steps 1 and 3, then [from the graphical panel](#from-the-nas-graphical-panel-instead-of-steps-4-5-and-6), then from step 7 |

Do not mix them: the same instance is installed one way **or** the other. If in doubt, use the first.

**Every command is run on the machine that will host the instance**, not on your laptop — over SSH, or from a terminal opened right there.

## Install with one command

On any Linux — mini-PC, old laptop, Raspberry Pi — this installs the instance and switches it on. **If Docker is missing, it offers to install it for you**, from the system's own packages (`apt-get install docker.io` on Debian, Ubuntu, Mint and Raspberry Pi OS; Docker's official script on Fedora and RHEL), after asking your permission. On a NAS, Docker is installed from the app centre instead, and that is step 1:

```sh
curl -fsSL https://raw.githubusercontent.com/Paluello/ESTIA/main/install.sh | sh
```

The first question is the language this home will speak. On a desktop Linux (Mint, Ubuntu, …) it may ask **once** for the administrator password: to install Docker if it is missing, and to copy the `estia` command into `/usr/local/bin`, which a normal user cannot write to. Do not wrap everything in `sudo` (`curl … | sudo sh`): Docker must stay your user's. If you do not give the password, the instance starts anyway and the command ends up in `~/.local/bin`.

If it had to install Docker, your user joins the `docker` group at your next login: this time the script uses `sudo`, and you do not need to close anything. Then it downloads the image, prepares the place where the data will live, starts the instance, installs `estia` and prints the address to open it at. From there, go to **step 7**.

**If the instance is already running and only the command is missing** (`estia: command not found` on Linux Mint, after an installation done as a normal user):

```sh
curl -fsSL https://raw.githubusercontent.com/Paluello/ESTIA/main/install.sh | env ESTIA_SOLO_CLI=1 sh
```

**The same command updates**, later on: running it again pulls the new version and puts the instance back up with the same things inside. If it finds something on the machine it did not put there, it stops and tells you instead of running over it. The details — and how to update if you installed another way — are in [step 12](#12-updating).

> If you prefer to read a script before running it — a healthy habit with anything downloaded from the Internet — it is a text file: open the same address in a browser, or `curl -fsSL … -o install.sh` and then `less install.sh`.

The rest of this guide is for doing the same things by hand, one piece at a time.

## What you need

- A **machine that stays on**: a NAS (Synology, QNAP, UGREEN, Asustor, TerraMaster), a Linux mini-PC, or an old laptop with Linux.
- **Docker**. On Linux the one-command install sets it up if it is missing; on a NAS, and for the step-by-step way, it is step 1. Do not assume it is there: almost no machine has it already.
- **Access to a terminal**: SSH is the most convenient. On a NAS it has to be enabled from the panel, usually under "Terminal" or "SSH".
- A **second device on the same network** — phone or laptop — to finish the setup.

You do not need: a domain, a certificate, port forwarding, a public IP address. ESTIA lives on the local network ([ADR 0003](../adr/0003-primo-contatto-in-rete-locale.md)).

## 1. Install Docker

First, check whether it is already there.

```sh
docker --version
```

If it answers with a version number, skip to step 2. If it answers `command not found`, Docker needs installing — and how depends on the machine.

### On a NAS

Docker is installed **from the NAS panel**, from its app centre, not from the terminal. The name changes from brand to brand:

| NAS         | App to install                            |
| ----------- | ----------------------------------------- |
| Synology    | **Container Manager** (formerly "Docker") |
| QNAP        | **Container Station**                     |
| UGREEN      | **Docker**                                |
| Asustor     | **Docker Engine**                         |
| TerraMaster | **Docker Manager**                        |

Install it and open it once, so it finishes setting itself up. Then, if you want to follow the terminal way, **enable SSH** in the NAS system settings — on Synology it is Control Panel → Terminal & SNMP, on UGREEN and QNAP under network or system settings — and connect:

```sh
ssh user@nas-name.local
```

### On Linux: mini-PC, old laptop, server

The one-command install does this for you. By hand, Docker's official script recognises the distribution and installs everything needed, `docker compose` included. Two commands, one at a time:

```sh
curl -fsSL https://get.docker.com -o get-docker.sh
```

```sh
sudo sh get-docker.sh
```

Then **add your user to the `docker` group**, otherwise every command below needs `sudo` and sooner or later you forget one:

```sh
sudo usermod -aG docker "$USER"
```

**This change takes effect from the next session.** Close the terminal — or the SSH connection — and open it again. If you do not, the next command answers `permission denied` on the Docker socket, which looks like a Docker problem but is only the group not being active yet.

### On macOS or Windows

Install **Docker Desktop**, from Docker's website. It is perfectly fine for trying ESTIA out, but keep one thing in mind: an instance is a community's board, and it lives on a machine that stays on. A laptop that is closed in the evening is not that machine.

### Check that it works

```sh
docker --version && docker compose version && docker run --rm hello-world
```

All three must answer: two version numbers and a message starting with "Hello from Docker!". The third is the most useful, because it really downloads an image and runs it: if it works, everything after it will.

If `docker compose version` fails but `docker-compose --version` answers, you have the old version of Compose: it works all the same, and throughout the guide write `docker-compose` (with a hyphen) where it says `docker compose`.

## 2. Look at the machine you have

```sh
uname -m && df -h
```

`x86_64` means **amd64**, `aarch64` means **arm64**. **If you download the image from the registry you do not need to know**: the published tag contains both architectures and Docker picks the right one. It only matters if you build or move the image by hand (note in step 4).

`df -h` lists the disks with their free space. You need it in the next step.

## 3. Decide where the data lives

**The short answer is: do nothing.** The file in step 5 uses a **named Docker volume**, which Docker creates on first start, with the right permissions, where it already keeps its things. For most machines that is fine.

It is still worth thirty seconds, because that directory will hold the database, the members' photos and **the instance's private key**, which cannot be replaced: if you lose it, members no longer recognise their instance.

See where Docker keeps its things, and how much space there is:

```sh
docker info --format '{{.DockerRootDir}}' && df -h "$(docker info --format '{{.DockerRootDir}}')"
```

**If that path is on the big disk** — on many NAS boxes it is something like `/volume1/@docker` — you are done: go to step 4.

**If it is on the system partition** and space is short there, the data goes in a folder on the big disk. Create it now, with the right permissions:

```sh
sudo mkdir -p /volume1/estia-data && sudo chown -R 10001:10001 /volume1/estia-data && sudo chmod 700 /volume1/estia-data
```

Replace `/volume1` with a path that exists on your machine. The `10001`, on the other hand, stays as it is: it is the non-root user the container runs as.

## 4. Get the image

**You do not have to do anything: step 6 downloads it.** The image is public at `ghcr.io/paluello/estia`, without credentials or an account, and the same tag contains both `linux/amd64` and `linux/arm64`.

```sh
docker pull ghcr.io/paluello/estia:latest
```

**Which tag to use.** `latest` follows `main`: every published change becomes an update available to you. That is fine for trying out, but on an instance holding real people's photos it is calmer to **pin a fixed tag**, so you decide when to update. There is one per commit, written in place of `latest` in the step 5 file: `ghcr.io/paluello/estia:sha-8a1147c`.

> **If the machine has no Internet access**, download the image elsewhere and stream it into `docker load`. Here you choose the architecture, so step 2 matters:
>
> ```sh
> docker pull --platform linux/amd64 ghcr.io/paluello/estia:latest
> ```
>
> ```sh
> docker save ghcr.io/paluello/estia:latest | gzip | ssh user@nas 'docker load'
> ```

## 5. Write the `docker-compose.yml` file

**This step creates a file; it does not run commands.** First the folder that will hold it. On a NAS, the big disk is best, for example `/volume1/docker/estia`; on a mini-PC your home is fine:

```sh
mkdir -p ~/estia && cd ~/estia
```

Then the file. **Paste this command whole**, from the first line to the last `YAML`, and press Enter once:

```sh
cat > docker-compose.yml <<'YAML'
name: estia
services:
  core-api:
    container_name: estia
    image: ghcr.io/paluello/estia:latest
    environment:
      ESTIA_DATA_DIR: /data
      ESTIA_HOST: 0.0.0.0
      ESTIA_LOG_LEVEL: info
      ESTIA_LINGUA: en
    ports:
      - "0.0.0.0:3000:3000"
    volumes:
      - estia-data:/data
      - estia-backup:/data/backup
    user: "10001:10001"
    init: true
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    restart: unless-stopped
volumes:
  estia-data:
  estia-backup:
YAML
```

`ESTIA_LINGUA` is the home's language: `en` or `it`. Each member can still choose their own.

Check that it came out right:

```sh
docker compose config
```

**The line not to get wrong is `0.0.0.0:3000:3000`.** With `127.0.0.1` the instance only answers the machine itself, and the phone in the living room cannot see it.

If in step 3 you chose your own folder instead of the volume, change `- estia-data:/data` to `- /volume1/estia-data:/data`.

## 6. Switch it on

From the same folder as step 5:

```sh
docker compose up -d
```

If it answers `no configuration file provided`, you are in another folder: `cd ~/estia` and try again. If port 3000 is already taken, change **only the number on the left**: `"0.0.0.0:3080:3000"`.

## From the NAS graphical panel, instead of steps 4, 5 and 6

Skip this section if you have just started the instance from the terminal.

**If your NAS can import a Compose file, use that.** On Synology it is Container Manager → **Project** → Create, and in the file field you paste the contents of step 5 (the lines from `name: estia` to `estia-backup:`). It is exactly the same installation as this guide, with an interface on top.

**If your panel cannot import Compose, do not build the container by hand in the form**: that is where the volume line gets forgotten, and that is how two instances were lost. Open an SSH terminal and give one command, which carries everything needed:

```sh
docker run -d --name estia --restart unless-stopped -p 3000:3000 -v estia-data:/data ghcr.io/paluello/estia:latest
```

If you really do create the container from the panel's form, you need three things and nothing else: the image `ghcr.io/paluello/estia:latest`; port `3000` → `3000` published on `0.0.0.0`; and **a folder of yours mapped to `/data`**. **Without that last line the instance will not let you set it up** ([ADR 0019](../adr/0019-i-dati-hanno-un-posto-prima-della-configurazione.md)): an anonymous volume does not survive the panel's "update" button, and the instance would come back empty, with a new key, every time.

## 7. Get the setup code

It is printed once at start-up, and **on purpose it does not go into the structured logs**: it is a credential.

```sh
docker compose logs core-api | head -20
```

From the graphical panel it is the container's **Log** tab, at the top. The code changes every time the process restarts. If you lose it, restart and read the new one.

## 8. Set up from the browser

**Try the machine's name first**, which almost every NAS publishes by itself ([ADR 0017](../adr/0017-niente-mdns-nostro.md)):

```
http://machine-name.local:3000
```

The name is the one shown in the NAS panel; on Linux it is what `hostname` answers. It is the best way because **it does not change**, while the numeric address can change when the router reassigns addresses.

If the name does not resolve, you need the address:

```sh
ip -4 addr show scope global | grep inet
```

and in that case **reserve it in the router**, in the DHCP section, so it stays the same forever.

Open the instance from another device on the same network and complete the setup: the community's name, a description, and your administrator account.

**Write down the recovery code.** It appears once only. Whoever loses it and the password loses the instance, and that is not a bug: it is a stated consequence of not having a central server that could reset it for you ([ADR 0009](../adr/0009-recupero-accesso-amministratore.md)). Treat it like your house keys.

## 9. Let someone in

From the administration section press **Create invite**: a **complete link** appears, ready to paste into a message. Whoever receives it opens it, picks a name and asks to join; you approve. **An invite lets someone ask, never walk in alone.**

The link contains the address from which **you** are looking at the instance at that moment. If you open the administration from `localhost` — the machine itself — the link only works there. Create the invite from the network address of step 8.

## 10. Backups, the part people skip and should not

An instance without backups is a disk that will sooner or later break with everyone's photos on it.

**It is done from the browser** ([ADR 0016](../adr/0016-backup-dal-pannello.md)). In **Administration → Backup**:

1. **Generate a key pair.** The private key appears **once only** — put it in a password manager or print it, **away from this machine**. Only the public key stays on the instance: **the instance produces archives it cannot read back**. Whoever takes the machine finds unreadable files.
2. **Save.** From then on backups run by themselves.
3. **Take a backup now**, to see straight away that it works.
4. **Download** the latest archive and put it somewhere else.

The last one is not an extra. By default archives go **next to the data, on the same disk**: they protect you from a mistake and a bad update, not from a broken disk or a stolen machine. They are encrypted precisely so you can put them anywhere.

Encrypting an archive happens **in memory** ([ADR 0013](../adr/0013-backup-cifrati-in-formato-age.md)) and takes about **six times the size of the data**. If you set a memory limit on the container, keep that in mind: the instance tells you in **Instance status** when the limit is not enough.

To send archives to another disk, declare `ESTIA_BACKUP_DIR`, `ESTIA_BACKUP_PUBLIC_KEY`, `ESTIA_BACKUP_INTERVAL_HOURS` and `ESTIA_BACKUP_KEEP` in the Compose file and mount the folder; the Italian guide's step 10 has the exact lines. Once set from the environment, the panel can no longer change them, and says so.

## 11. Disk encryption, and the choice that is yours

That machine now holds photos of real people. **On disk they are in plain text**, unless you encrypted the volume. ESTIA does not do disk encryption: the machine's system does ([ADR 0007](../adr/0007-cifratura-a-riposo-e-furto-fisico.md)) — LUKS on Linux, native volume encryption on Synology, QNAP and UGREEN, encrypted datasets on TrueNAS.

| Level                  | Protects against                           | Does not protect against                 | Cost                                |
| ---------------------- | ------------------------------------------ | ---------------------------------------- | ----------------------------------- |
| **Passphrase at boot** | Stolen machine, removed or discarded disks | Someone using the machine while it is on | The instance does not restart alone |
| **Automatic unlock**   | Removed or discarded disks                 | **A stolen machine**                     | None                                |
| **No encryption**      | Nothing                                    | Everything                               | None                                |

**The advice is a passphrase at boot**, knowingly: after a power cut the board stays down until someone unlocks the machine. Decide it before, not during. Then **declare it to ESTIA** with `ESTIA_AT_REST_ENCRYPTION: passphrase` (or `automatic`, or `none`) under `environment:`. The instance checks what it can see and tells you in red if you declared encryption it cannot find.

## 12. Updating

**Update the same way you installed.**

- **With the `estia` command** (installed by `install.sh`): `estia aggiorna`.
- **With `install.sh`**: run the same command again.
- **With Compose**: from the step 5 folder, first a backup, then the update:

  ```sh
  docker compose exec core-api node dist/backup/cli.js backup /backup
  ```

  ```sh
  docker compose pull && docker compose up -d
  ```

- **From the panel or with `docker run`**: pull, remove and recreate **with the same volume**:

  ```sh
  docker pull ghcr.io/paluello/estia:latest && docker rm -f estia && docker run -d --name estia --restart unless-stopped -p 3000:3000 -v estia-data:/data ghcr.io/paluello/estia:latest
  ```

In the panel, **Settings → Instance status → Check for updates** compares this image with the published one and shows the right commands for this installation.

Database migrations **only go forward**. When the new version finds migrations to apply, it writes a backup by itself first (`estia-aggiornamento-*.tar.age`, [ADR 0014](../adr/0014-backup-prima-delle-migrazioni.md)) — but only if backups are configured. So: **configure backups, check the first archive exists, and only then update.**

**If your instance was installed before 27 November 2026**, it points at the old address `ghcr.io/chrono-web/estia`, which no longer receives new versions. Run `install.sh` again from the address above, or change the `image:` line to `ghcr.io/paluello/estia:latest`. The data volume stays the same.

## 13. Restoring

A backup never restored is not a backup. **Try it before you need it.**

With the `estia` command it is one interactive command, which asks for the archive path and the key:

```sh
estia ripristino-backup
```

Or with Docker directly (the key is asked on screen, so it does not end up in your shell history):

```sh
docker run --rm -it --user 0:0 -v /folder/of/the/file:/backup:ro -v /volume1/docker/estia-restore:/restore --entrypoint node ghcr.io/paluello/estia:latest dist/backup/cli.js ripristina /backup/ARCHIVE.tar.age /restore
```

And worth knowing: **an archive opens without ESTIA**, with standard tools ([ADR 0013](../adr/0013-backup-cifrati-in-formato-age.md)):

```sh
age -d -i private-key.txt archive.tar.age | tar -xv
```

## When something goes wrong

| Symptom                                                          | What is happening                                                                                                     |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `estia: command not found`                                       | The command is not on the PATH. Run again with `ESTIA_SOLO_CLI=1`, or give the sudo password when asked               |
| `command not found` on lines like `name:`, `services:`, `image:` | You pasted **a file's contents** into the terminal. That block goes into `docker-compose.yml`: step 5                 |
| `docker: command not found`                                      | Docker is not installed. Step 1 — on a NAS it is installed from the app centre                                        |
| `no configuration file provided: not found`                      | You are not in the folder holding `docker-compose.yml`. `cd` there and try again                                      |
| `docker` says "permission denied" on the socket                  | Your user is not in the `docker` group yet: `sudo usermod -aG docker "$USER"`, then **log out and back in**           |
| The container starts and dies, `exec format error`               | Wrong architecture image: only happens if you moved it by hand. See step 4                                            |
| It opens from the machine but not from the phone                 | The port is published on `127.0.0.1`. It must be `0.0.0.0`                                                            |
| `backup_not_configured` in the logs                              | Not an error: the instance is telling you **it is not taking backups**. Set them in Settings → Backup                 |
| `schema_migration_without_backup` in the logs                    | The instance is **about to** migrate without a backup. If you see it in time, stop it and configure backups (step 10) |

## What this installation does not protect

Said here because no interface should suggest protection that is not there.

**Data on the machine is in plain text unless you encrypted the volume** in step 11. Whoever takes the machine reads everything. **Backups**, on the other hand, are always encrypted.

**Whoever administers the instance sees everything the instance stores**, except private messages, which are end-to-end encrypted ([ADR 0006](../adr/0006-messaggi-privati-end-to-end-o-niente.md)). It is the consequence of self-hosting, not a flaw to hide.

**The local feed is readable by the server that serves it**, by design: it is the board of those who share the instance, not a private chat.
