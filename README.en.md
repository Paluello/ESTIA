# ESTIA

A real social network in which **your content physically lives in a place that is yours** — your home, or your community's shared space — encrypted, with no algorithm and no advertising.

The basic unit is an instance, called a **home**, hosted on a NAS or a small computer in a real place: a flat, a building, a street, a community centre. On top of it live three social surfaces with a single identity: the **local feed** of the people who share the home, the **profile** that reaches other ESTIA homes — and the Fediverse, for those who choose to adopt a domain — and **group chats**, which cross homes.

Homes find each other **by public key**, with no domain and no open ports, and talk **directly**, machine to machine; where two routers do not allow it, packets go through a relay that forwards them encrypted between the two ends, unable to read them and keeping none. And **content is not replicated**: someone reading you from another home visits it, and when you delete a post it is really deleted ([ADR 0018](docs/adr/0018-federazione-fra-istanze-estia.md)).

Five words held together: **owned, shared, communal, protected and connected with anyone**. Each alone describes something that already exists; the new thing is demanding them all at once. The full vision is in [`docs/PRODUCT_VISION.md`](docs/PRODUCT_VISION.md) (Italian).

> ESTIA is developed in Italian, and most design documents and decision records are in Italian. The interface ships in English and Italian ([ADR 0046](docs/adr/0046-le-lingue-di-estia.md)), and the guides people need to install and use a home are translated here. Adding a language means filling in one table: see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Where the project stands

ESTIA is **pre-1.0**, and this table says honestly what exists. The authoritative state of every milestone is [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md).

|                                   |                                                                                                                                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Done, proven on real hardware** | Posts, comments, likes and photos; operational robustness and repeatable installation; encrypted backups and restore; content crossing homes, tested between three homes                                                              |
| **Built, field test open**        | **Private messages**, end-to-end encrypted with MLS (RFC 9420) in the web client, crossing homes with each author's home keeping custody of what they wrote. The field gate — two homes, two people — is open                         |
| **Being built**                   | The **apps** for iPhone, Android and desktop, which are how a home is reached from outside ([ADR 0044](docs/adr/0044-il-dispositivo-e-l-app.md)); several devices per person; groups across three or more homes; federated moderation |
| **Not yet**                       | Store releases, push notifications, an external security audit                                                                                                                                                                        |

**First contact happens on the local network.** A home is installed and used with no domain, no certificates, no port forwarding: people join from the home network, and from then on recognise the home by its key ([ADR 0003](docs/adr/0003-primo-contatto-in-rete-locale.md)).

## Installing a home

On a machine that stays on — a NAS, a mini-PC, an old laptop with Linux, a Raspberry Pi:

```sh
curl -fsSL https://raw.githubusercontent.com/Paluello/ESTIA/main/install.sh | sh
```

It asks one question, the language the home will speak. On Linux, if Docker is missing, it offers to install it from your system's packages; on a NAS, Docker is installed first from the app centre. Then it prepares the place where the data will live, starts the home, puts the `estia` command on the machine and prints the address to open from your phone. The same command updates later, without touching what is inside.

Everything else — NAS panels, backups, disk encryption, what to do when it does not work — is in the **[installation guide](docs/en/INSTALL.md)**.

## Documents

| Document                                                     | Answers                                                | Language |
| ------------------------------------------------------------ | ------------------------------------------------------ | -------- |
| [`docs/en/INSTALL.md`](docs/en/INSTALL.md)                   | How to install on a NAS, mini-PC or laptop, and fix it | English  |
| [`SECURITY.md`](SECURITY.md)                                 | How to report a vulnerability                          | Italian  |
| [`docs/SECURITY_BASELINE.md`](docs/SECURITY_BASELINE.md)     | What is protected, from whom, and what stays uncovered | Italian  |
| [`docs/PRODUCT_VISION.md`](docs/PRODUCT_VISION.md)           | Why ESTIA exists, for whom, how it should feel         | Italian  |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)               | How it is built                                        | Italian  |
| [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) | In what order it is built, and when it is done         | Italian  |
| [`docs/adr/`](docs/adr/)                                     | Why each decision was taken                            | Italian  |

## The infrastructure promise, stated precisely

ESTIA does not promise "no central infrastructure at all": DNS, certificate authorities, push notifications and relays can be outside services.

> No central application server run by the developers, and no community content kept outside the home, unless the administrator explicitly chooses so.

## Licence

ESTIA is free software under the **GNU Affero General Public License v3** ([`LICENSE`](LICENSE), [ADR 0015](docs/adr/0015-licenza-agpl.md)).

Anyone can host, modify and fork the project. Whoever **modifies it and offers it to others over a network** must offer those users the source of their version. There is no obligation for those who host a home without modifying it. And the licence covers the software, not the content: what members write and publish remains theirs.

## Development

Node.js `24.18.0` (pinned in [`.node-version`](.node-version)) and pnpm `11.7.0`. From a clean clone:

```sh
corepack enable
corepack pnpm install --frozen-lockfile
cp .env.example .env
corepack pnpm verify
```

The rules for whoever writes code here, human or agent, are in [`AGENTS.md`](AGENTS.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md).
