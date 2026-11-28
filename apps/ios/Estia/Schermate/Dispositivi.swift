// I propri dispositivi (ADR 0040), sopra le `Sessioni` del nucleo: chi ha il
// sì, chi lo aspetta, chi è stato revocato. Le regole sono quelle del web
// (`screens/impostazioni/Chat.tsx`): il codice da confrontare lo calcola il
// nucleo dalla chiave pubblica, mai la Casa; dire di sì o revocare si può
// soltanto da un dispositivo che ha già il sì; e la revoca si conferma.
//
// Dopo un sì o una revoca il nucleo rimette d'accordo le foglie in ogni
// conversazione: qui si mostra il lavoro in corso, e poi com'è andata.

import SwiftUI

/// Il nome di un dispositivo com'è da mostrare.
func nomeDelDispositivo(_ dispositivo: MioDispositivo) -> String {
    dispositivo.etichetta ?? Frasi.t("dispositivi.dispositivo")
}

/// «5 minuti fa», nella lingua dell'app.
func quandoRelativo(_ iso: String?) -> String? {
    guard let iso, let data = Date.daISO(iso) else { return nil }
    let formato = RelativeDateTimeFormatter()
    formato.locale = Locale(identifier: Frasi.lingua)
    formato.unitsStyle = .full
    return formato.localizedString(for: data, relativeTo: .now)
}

/// «28 nov 2026, 10:00», nella lingua dell'app.
func quandoMedio(_ iso: String) -> String {
    guard let data = Date.daISO(iso) else { return iso }
    let formato = DateFormatter()
    formato.locale = Locale(identifier: Frasi.lingua)
    formato.dateStyle = .medium
    formato.timeStyle = .short
    return formato.string(from: data)
}

/// Un'icona che somiglia al dispositivo, dal nome che si è dato entrando.
private func iconaDi(_ dispositivo: MioDispositivo) -> String {
    let nome = (dispositivo.etichetta ?? "").lowercased()
    if nome.contains("iphone") { return "iphone" }
    if nome.contains("ipad") { return "ipad" }
    let computer = ["mac", "windows", "linux", "chrome", "firefox", "safari", "edge", "browser"]
    if computer.contains(where: { nome.contains($0) }) { return "laptopcomputer" }
    return "candybarphone"
}

/// Le otto cifre da confrontare, grandi e lette a voce una per una.
struct CodiceDaConfrontare: View {
    let codice: String

    var body: some View {
        Text(codice)
            .font(.system(.title, design: .monospaced).weight(.semibold))
            .monospacedDigit()
            .kerning(2)
            .foregroundStyle(Tema.testo)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .background(Tema.superficie2, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .accessibilityLabel(codice.filter(\.isNumber).map(String.init).joined(separator: " "))
    }
}

/// Il pulsante del sì: vetro pieno su iOS 26, pieno di sistema prima.
private struct PulsanteDelSi: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content
                .buttonStyle(.glassProminent)
                .tint(Tema.accento)
                .foregroundStyle(Tema.sopraAccento)
        } else {
            content
                .buttonStyle(.borderedProminent)
                .tint(Tema.accento)
                .foregroundStyle(Tema.sopraAccento)
        }
    }
}

/// Questo dispositivo aspetta il sì: che cosa vuol dire, il suo codice, e
/// dove andare a dirlo. È anche ciò che mostrano i messaggi finché aspetta.
struct AttesaDelSi: View {
    let codice: String
    /// Se c'è, un pulsante per ricontrollare subito invece di aspettare il giro.
    var ricontrolla: (() async -> Void)?

    @State private var controllo = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label {
                Text(Frasi.t("chiavi.in_attesa.titolo"))
                    .font(Tema.titolo(20, relativo: .title3))
                    .foregroundStyle(Tema.testo)
            } icon: {
                Image(systemName: "hourglass")
                    .foregroundStyle(Tema.testoAccento)
            }
            Text(Frasi.t("chiavi.in_attesa.testo"))
                .font(Tema.corpo(.callout))
                .foregroundStyle(Tema.testoTenue)
                .fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 6) {
                Text(Frasi.t("chat_chiavi.il_mio_codice"))
                    .font(Tema.corpo(.footnote, peso: .semibold))
                    .foregroundStyle(Tema.testoTenue)
                CodiceDaConfrontare(codice: codice)
            }
            Text(Frasi.t("app_dispositivi.in_attesa.cosa_fare"))
                .font(Tema.corpo(.callout))
                .foregroundStyle(Tema.testo)
                .fixedSize(horizontal: false, vertical: true)
            if let ricontrolla {
                Button {
                    Task {
                        controllo = true
                        await ricontrolla()
                        controllo = false
                    }
                } label: {
                    HStack(spacing: 8) {
                        if controllo { ProgressView() }
                        Text(Frasi.t("app_dispositivi.ricontrolla"))
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
                .disabled(controllo)
            }
        }
    }
}

/// I dispositivi di questa persona, dal Profilo.
struct ElencoDispositivi: View {
    @EnvironmentObject private var casa: Casa
    /// L'elenco è cambiato: il Profilo aggiorna il suo contatore.
    var cambiato: ([MioDispositivo]) -> Void = { _ in }

    /// Com'è andato l'ultimo gesto, da dire in cima.
    struct Esito: Equatable {
        let testo: String
        let guasto: Bool
    }

    @State private var dispositivi: [MioDispositivo] = []
    @State private var io: Io?
    @State private var carico = true
    @State private var guastoElenco = false
    @State private var lavoro: String?
    @State private var esito: Esito?
    @State private var daRevocare: MioDispositivo?

    private var questo: MioDispositivo? { dispositivi.first { $0.questo } }
    private var richieste: [MioDispositivo] { dispositivi.filter { !$0.questo && $0.stato == .inAttesa } }
    private var approvati: [MioDispositivo] { dispositivi.filter { !$0.questo && $0.stato == .approvato } }
    private var revocati: [MioDispositivo] { dispositivi.filter { !$0.questo && $0.stato == .revocato } }
    /// Il sì e il no li dice soltanto un dispositivo che ha già il sì.
    private var decide: Bool { io?.approvato == true }

    private var titoloRichieste: String {
        richieste.count == 1
            ? Frasi.t("chat_chiavi.richieste.one")
            : Frasi.t("chat_chiavi.richieste.other", ["n": "\(richieste.count)"])
    }

    private var primaDelSi: String {
        Frasi.t("chat_chiavi.prima_del_si", ["guarda": Frasi.t("chat_chiavi.prima_del_si.guarda")])
    }

    private var titoloConferma: String {
        guard let d = daRevocare else { return "" }
        return d.stato == .inAttesa
            ? Frasi.t("app_dispositivi.rifiuta.titolo")
            : Frasi.t("app_dispositivi.revoca.titolo", ["nome": nomeDelDispositivo(d)])
    }

    var body: some View {
        List {
            if let esito {
                Section {
                    Label {
                        Text(esito.testo)
                            .font(Tema.corpo(.callout))
                            .foregroundStyle(esito.guasto ? Tema.pericolo : Tema.testo)
                    } icon: {
                        Image(systemName: esito.guasto ? "exclamationmark.circle.fill" : "checkmark.circle.fill")
                            .foregroundStyle(esito.guasto ? Tema.pericolo : Tema.testoAccento)
                    }
                }
                .listRowBackground(esito.guasto ? Tema.sfondoPericolo : Tema.superficie2)
            }

            if let io, !io.approvato {
                Section {
                    AttesaDelSi(codice: io.codice, ricontrolla: { await carica() })
                        .padding(.vertical, 6)
                }
                .listRowBackground(Tema.superficie)
            }

            if !richieste.isEmpty {
                Section {
                    ForEach(richieste, id: \.id) { d in
                        RichiestaDispositivo(
                            dispositivo: d,
                            decide: decide,
                            si: { Task { await approva(d) } },
                            no: { daRevocare = d }
                        )
                    }
                } header: {
                    Text(titoloRichieste)
                } footer: {
                    Text(decide ? primaDelSi : Frasi.t("app_dispositivi.solo_approvati"))
                }
                .listRowBackground(Tema.superficie)
            }

            Section {
                if let questo {
                    RigaDispositivo(dispositivo: questo)
                } else if carico {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                } else if guastoElenco {
                    Text(Frasi.t("dispositivi.errore_elenco"))
                        .font(Tema.corpo(.callout))
                        .foregroundStyle(Tema.pericolo)
                }
            } footer: {
                Text(Frasi.t("app_dispositivi.spiegazione"))
            }
            .listRowBackground(Tema.superficie)

            if !approvati.isEmpty {
                Section {
                    ForEach(approvati, id: \.id) { d in
                        RigaDispositivo(dispositivo: d)
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                if decide {
                                    Button(role: .destructive) { daRevocare = d } label: {
                                        Label(Frasi.t("app_dispositivi.revoca"), systemImage: "xmark.shield")
                                    }
                                }
                            }
                            .contextMenu {
                                if decide {
                                    Button(role: .destructive) { daRevocare = d } label: {
                                        Label(Frasi.t("app_dispositivi.revoca"), systemImage: "xmark.shield")
                                    }
                                }
                            }
                    }
                } header: {
                    Text(Frasi.t("app_dispositivi.approvati"))
                } footer: {
                    if decide {
                        Text(Frasi.t("dispositivi.disconnettere"))
                    }
                }
                .listRowBackground(Tema.superficie)
            }

            if !revocati.isEmpty {
                Section {
                    ForEach(revocati, id: \.id) { d in
                        RigaDispositivo(dispositivo: d)
                    }
                } header: {
                    Text(Frasi.t("app_dispositivi.revocati"))
                }
                .listRowBackground(Tema.superficie)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Tema.sfondo)
        .disabled(lavoro != nil)
        .overlay {
            if let lavoro {
                ProgressView(lavoro)
                    .font(Tema.corpo(.callout))
                    .padding(20)
                    .modifier(Vetro(forma: RoundedRectangle(cornerRadius: 18, style: .continuous)))
                    .transition(.opacity)
            }
        }
        .animation(.snappy, value: lavoro)
        .animation(.snappy, value: esito)
        .animation(.snappy, value: dispositivi)
        .navigationTitle(Frasi.t("app_dispositivi.titolo"))
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await carica() }
        .confirmationDialog(
            titoloConferma,
            isPresented: Binding(get: { daRevocare != nil }, set: { if !$0 { daRevocare = nil } }),
            titleVisibility: .visible,
            presenting: daRevocare
        ) { d in
            Button(
                d.stato == .inAttesa ? Frasi.t("chat_chiavi.no_rifiuta") : Frasi.t("app_dispositivi.revoca.conferma"),
                role: .destructive
            ) {
                Task { await revoca(d) }
            }
            Button(Frasi.t("comune.annulla"), role: .cancel) {}
        } message: { d in
            Text(d.stato == .inAttesa ? Frasi.t("app_dispositivi.rifiuta.testo") : Frasi.t("app_dispositivi.revoca.testo"))
        }
        // Finché la schermata è aperta si rilegge ogni quindici secondi: chi
        // aspetta vede arrivare il sì, chi decide vede arrivare una richiesta.
        .task {
            while !Task.isCancelled {
                await carica()
                try? await Task.sleep(for: .seconds(15))
            }
        }
    }

    private func carica() async {
        guard lavoro == nil else { return }
        carico = true
        defer { carico = false }
        do {
            let sessioni = try await casa.sessioniPronte()
            let elenco = try await sessioni.dispositivi()
            dispositivi = elenco
            // Dopo l'elenco: è lui che aggiorna `approvato` di questo dispositivo.
            io = sessioni.io()
            guastoElenco = false
            cambiato(elenco)
        } catch {
            guastoElenco = true
        }
    }

    /// Un gesto: il lavoro in corso mentre dura, poi l'elenco di nuovo.
    private func gesto(_ inCorso: String, _ fai: (Sessioni) async throws -> Void) async -> Error? {
        lavoro = inCorso
        esito = nil
        var guasto: Error?
        do {
            try await fai(try await casa.sessioniPronte())
        } catch {
            guasto = error
        }
        lavoro = nil
        await carica()
        return guasto
    }

    private func approva(_ d: MioDispositivo) async {
        let guasto = await gesto(Frasi.t("app_dispositivi.lavoro.approvo")) { sessioni in
            try await sessioni.approvaDispositivo(id: d.id)
        }
        esito = guasto.map { Esito(testo: percheNo($0, altrimenti: Frasi.t("chat_chiavi.risposta_fallita")), guasto: true) }
            ?? Esito(testo: Frasi.t("chat_chiavi.autorizzato"), guasto: false)
    }

    private func revoca(_ d: MioDispositivo) async {
        let aspettava = d.stato == .inAttesa
        let guasto = await gesto(Frasi.t("app_dispositivi.lavoro.revoco")) { sessioni in
            try await sessioni.revocaDispositivo(id: d.id)
        }
        if let guasto {
            let altrimenti = aspettava ? Frasi.t("chat_chiavi.risposta_fallita") : Frasi.t("app_dispositivi.revoca.errore")
            esito = Esito(testo: percheNo(guasto, altrimenti: altrimenti), guasto: true)
        } else {
            esito = Esito(
                testo: aspettava ? Frasi.t("chat_chiavi.rifiutato") : Frasi.t("app_dispositivi.revocato"),
                guasto: false
            )
        }
    }

    private func percheNo(_ errore: Error, altrimenti: String) -> String {
        codiceDellaCasa(errore) == "device_not_approved" ? Frasi.t("app_dispositivi.solo_approvati") : altrimenti
    }
}

/// Un dispositivo che chiede di entrare: il codice da confrontare, e il sì o
/// il no.
private struct RichiestaDispositivo: View {
    let dispositivo: MioDispositivo
    let decide: Bool
    let si: () -> Void
    let no: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Image(systemName: iconaDi(dispositivo))
                    .font(.system(size: 20))
                    .foregroundStyle(Tema.testoAccento)
                    .frame(width: 36, height: 36)
                    .background(Tema.superficie2, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                    .accessibilityHidden(true)
                Text(nomeDelDispositivo(dispositivo))
                    .font(Tema.corpo(.body, peso: .semibold))
                    .foregroundStyle(Tema.testo)
                    .lineLimit(1)
            }
            CodiceDaConfrontare(codice: dispositivo.codice)
            Text(Frasi.t("chat_chiavi.chiede_dal", ["quando": quandoMedio(dispositivo.creatoIl)]))
                .font(Tema.corpo(.footnote))
                .foregroundStyle(Tema.testoTenue)
                .fixedSize(horizontal: false, vertical: true)
            if decide {
                HStack(spacing: 10) {
                    Button(action: si) {
                        Text(Frasi.t("chat_chiavi.si_sono_io"))
                            .font(Tema.corpo(.body, peso: .semibold))
                            .frame(maxWidth: .infinity)
                    }
                    .modifier(PulsanteDelSi())
                    Button(role: .destructive, action: no) {
                        Text(Frasi.t("chat_chiavi.no_rifiuta"))
                            .font(Tema.corpo(.body, peso: .semibold))
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                }
                .controlSize(.large)
            }
        }
        .padding(.vertical, 6)
    }
}

/// Una riga dell'elenco: il nome, a che punto è, quando l'ultima volta, il codice.
private struct RigaDispositivo: View {
    let dispositivo: MioDispositivo

    private var revocato: Bool { dispositivo.stato == .revocato }

    private var stato: (testo: String, accento: Bool) {
        switch dispositivo.stato {
        case .approvato:
            if let visto = quandoRelativo(dispositivo.vistoIl) {
                return (Frasi.t("app_dispositivi.visto", ["quando": visto]), false)
            }
            return (Frasi.t("app_dispositivi.senza_sessione"), true)
        case .inAttesa:
            return (Frasi.t("app_dispositivi.stato.in_attesa"), true)
        case .revocato:
            let quando = quandoRelativo(dispositivo.revocatoIl)
            return (quando.map { Frasi.t("app_dispositivi.revocato_il", ["quando": $0]) }
                ?? Frasi.t("app_dispositivi.stato.revocato"), false)
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: iconaDi(dispositivo))
                .font(.system(size: 18))
                .foregroundStyle(revocato ? Tema.testoTenue : Tema.testoAccento)
                .frame(width: 34, height: 34)
                .background(Tema.superficie2, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(nomeDelDispositivo(dispositivo))
                        .font(Tema.corpo(.body, peso: .semibold))
                        .foregroundStyle(revocato ? Tema.testoTenue : Tema.testo)
                        .strikethrough(revocato)
                        .lineLimit(1)
                    if dispositivo.questo {
                        Text(Frasi.t("dispositivi.questo"))
                            .font(Tema.corpo(.caption, peso: .semibold))
                            .foregroundStyle(Tema.sopraAccento)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 2)
                            .background(Tema.accento, in: Capsule())
                    }
                }
                Text(stato.testo)
                    .font(Tema.corpo(.footnote))
                    .foregroundStyle(stato.accento ? Tema.testoAccento : Tema.testoTenue)
                    .fixedSize(horizontal: false, vertical: true)
                if let entrato = quandoRelativo(dispositivo.creatoIl) {
                    Text(Frasi.t("app_dispositivi.entrato", ["quando": entrato]))
                        .font(Tema.corpo(.footnote))
                        .foregroundStyle(Tema.testoTenue)
                }
                Text(Frasi.t("app_dispositivi.codice", ["codice": dispositivo.codice]))
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundStyle(Tema.testoTenue)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}
