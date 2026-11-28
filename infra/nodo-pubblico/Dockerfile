# Il Nodo pubblico della comunità (ADR 0045 §1): un relay iroh e niente altro.
#
# Sopra l'immagine ufficiale, fissata per digest (indice multi-architettura,
# linux/amd64 e linux/arm64). Aggiunge solo `avvio.sh`, che scrive la
# configurazione da poche variabili d'ambiente e rifiuta di partire se manca
# quella obbligatoria. iroh-relay è `MIT OR Apache-2.0`, compatibile con l'AGPL
# (verificato sul Cargo.toml di iroh-relay 1.5.0).
FROM n0computer/iroh-relay:v1.5.0@sha256:50a2f5697d8f69537037503c81b989be17eeb694dbb2d3fdfd5418c9a71c8ec6

LABEL org.opencontainers.image.title="ESTIA · Nodo pubblico" \
      org.opencontainers.image.description="Relay iroh della comunità per le Case ESTIA (ADR 0045)" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

COPY avvio.sh /avvio.sh
RUN chmod 0755 /avvio.sh

# Certificati di Let's Encrypt e configurazione generata.
VOLUME ["/dati"]

# 80/tcp: sfida di Let's Encrypt e pagina di cortesia. 443/tcp: il relay.
# 7842/udp: QUIC, perché le Case scoprano il proprio indirizzo pubblico.
EXPOSE 80/tcp 443/tcp 7842/udp

ENTRYPOINT ["/avvio.sh"]
