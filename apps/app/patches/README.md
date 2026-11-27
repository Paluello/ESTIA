# Le copie corrette di crate di terzi

## `netdev/` — netdev 0.46.3 (MIT), per iOS

**Il problema.** iroh 1.4.1 non compila per iOS. La catena è
`iroh → netwatch 0.19.3 → netdev 0.46.3`, e `netdev` usa `libc::in6_ifreq`
in `src/os/darwin/ipv6_addr_flags.rs`. Da `libc` 0.2.190 quella struttura è
dichiarata **solo per macOS** (`#[cfg(target_os = "macos")]`), e `mio` richiede
`libc >= 0.2.190`, quindi non si può tornare indietro. L'errore:

```
error[E0425]: cannot find type `in6_ifreq` in crate `libc`
  --> netdev-0.46.3/src/os/darwin/ipv6_addr_flags.rs:19:28
```

Riprodotto con `cargo check -p netdev@0.46.3 --target aarch64-apple-ios` il
2026-11-27. netdev 0.48.0, l'ultima, ha lo stesso codice.

**La correzione.** Una riga di sostanza: su iOS la struttura si dichiara nel
file stesso, con la forma di `<netinet6/in6_var.h>` di XNU e la dimensione che
l'ioctl `SIOCGIFAFLAG_IN6` codifica (`0x120`, 288 byte, controllata a tempo di
compilazione). Su macOS resta quella di `libc`. Il resto del crate è identico
all'originale pubblicato su crates.io.

`src-tauri/Cargo.toml` la usa con `[patch.crates-io]`. **Quando togliere la
copia**: quando `libc` dichiara `in6_ifreq` anche per iOS, o quando netdev
smette di usarla. Si toglie la sezione `[patch.crates-io]`, si cancella la
cartella e si rifà `cargo update -p netdev`.

## `netwatch/` — netwatch 0.19.3 (MIT o Apache-2.0), per iOS

**Il problema.** Lo stesso di netdev, un gradino sopra: `netwatch` legge la
tabella di routing con le costanti di `<net/route.h>` (`RTM_ADD`, `RTM_GET2`,
`RTAX_DST`, `RTF_IFSCOPE`…), e `libc` ≥ 0.2.190 le dichiara per macOS e non
per iOS. Ventidue errori `cannot find value … in crate libc`, visti nella CI e
riprodotti con `cargo check -p netwatch --target aarch64-apple-ios`.

**La correzione.** `src/libc_ios.rs` riesporta `libc` e aggiunge quelle
costanti, copiate da libc 0.2.191 (sono di XNU, uguali su macOS e iOS). I tre
file che le usano (`interfaces/bsd.rs`, `interfaces/bsd/macos.rs`,
`netmon/bsd.rs`) su iOS prendono `libc` da lì. Su ogni altra piattaforma il
crate è identico all'originale.

**Quando togliere la copia**: insieme a quella di netdev, quando `libc` torna a
dichiarare le costanti di routing per iOS.
