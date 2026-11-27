# Spike S7 — OpenMLS e `ts-mls`

Materiale dello spike [S7](../../docs/spike/S7-openmls-e-ts-mls.md): un membro OpenMLS in Rust e i client `ts-mls` del web nella stessa conversazione MLS.

**Non è il nucleo delle app.** È quanto basta a provare che le due implementazioni si capiscono.

| Cosa        | Che cosa c'è                                                                                         |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| `ponte/`    | Un membro OpenMLS 0.9.2 per processo, comandato a righe JSON su stdin, risposte su stdout            |
| `prova.mjs` | Il pilota: tre membri `ts-mls` e due OpenMLS attraversano otto epoch, e si confronta il key schedule |

## Come si rifà

Dalla radice del repository:

```sh
pnpm install          # prende ts-mls da apps/web, con la patch di patches/
cargo build --manifest-path infra/spike-mls/ponte/Cargo.toml
node infra/spike-mls/prova.mjs
```

L'ultima riga dice `S7: interoperabili.` se tutto passa, altrimenti il passo che si è rotto.
