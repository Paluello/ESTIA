// Le conversazioni cifrate (ADR 0038, 0043, 0052), sopra le `Sessioni` del
// nucleo: l'app chiede e mostra, il nucleo fa MLS e l'archivio. Nessuna
// chiave passa di qui.

import SwiftUI

struct Messaggi: View {
    @EnvironmentObject private var casa: Casa
    @State private var conversazioni: [Conversazione] = []
    @State private var io: Io?
    @State private var stato: Stato = .carico
    @State private var nuova = false
    @State private var percorso: [String] = []

    enum Stato: Equatable { case carico, pronto, errore }

    var body: some View {
        NavigationStack(path: $percorso) {
            Group {
                if let io, !io.approvato {
                    Avviso(titolo: Frasi.t("messaggi.titolo"), testo: Frasi.t("app_messaggi.non_approvato"))
                } else if conversazioni.isEmpty {
                    switch stato {
                    case .carico:
                        ProgressView(Frasi.t("messaggi.caricamento"))
                            .font(Tema.corpo())
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    case .errore:
                        Avviso(titolo: Frasi.t("feed.errore_lettura"), testo: Frasi.t("comune.non_ha_funzionato"))
                    case .pronto:
                        Avviso(titolo: Frasi.t("messaggi.vuoto.titolo"), testo: "")
                    }
                } else {
                    List(conversazioni, id: \.id) { c in
                        NavigationLink(value: c.id) {
                            RigaConversazione(conversazione: c, io: io)
                        }
                        .listRowBackground(Tema.superficie)
                        .listRowSeparatorTint(Tema.bordo)
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                }
            }
            .background(Tema.sfondo)
            .navigationTitle(Frasi.t("messaggi.titolo"))
            .toolbarTitleDisplayMode(.large)
            .toolbar {
                if io?.approvato == true {
                    ToolbarItem(placement: .primaryAction) {
                        Button { nuova = true } label: {
                            Image(systemName: "square.and.pencil")
                        }
                        .accessibilityLabel(Frasi.t("app_messaggi.nuova"))
                    }
                }
            }
            .navigationDestination(for: String.self) { id in
                if let c = conversazioni.first(where: { $0.id == id }) {
                    SchermataConversazione(conversazione: c, io: io)
                }
            }
            .sheet(isPresented: $nuova) {
                NuovaConversazione { creata in
                    nuova = false
                    if !conversazioni.contains(where: { $0.id == creata.id }) {
                        conversazioni.insert(creata, at: 0)
                    }
                    percorso = [creata.id]
                }
            }
            .refreshable { await carica() }
            .task { await carica() }
        }
    }

    private func carica() async {
        do {
            let sessioni = try await casa.sessioniPronte()
            io = sessioni.io()
            guard sessioni.io().approvato else {
                stato = .pronto
                return
            }
            conversazioni = try await sessioni.conversazioni()
            stato = .pronto
        } catch {
            stato = .errore
        }
    }
}

/// Il nome da mostrare: quello del gruppo, oppure l'altra persona.
func nomeConversazione(_ conversazione: Conversazione, io: Io?) -> String {
    if let nome = conversazione.nome, !nome.isEmpty { return nome }
    let altri = conversazione.membri.filter { $0.id != io?.id }
    if altri.isEmpty { return Frasi.t("messaggi.te_stesso") }
    return altri.map(\.nome).joined(separator: ", ")
}

private struct RigaConversazione: View {
    let conversazione: Conversazione
    let io: Io?

    var body: some View {
        let nome = nomeConversazione(conversazione, io: io)
        HStack(spacing: 12) {
            Iniziale(nome: nome, chiave: conversazione.id)
            VStack(alignment: .leading, spacing: 2) {
                Text(nome)
                    .font(Tema.corpo(.body, peso: conversazione.nonLetti > 0 ? .semibold : .regular))
                    .foregroundStyle(Tema.testo)
                    .lineLimit(1)
                if let quando = conversazione.ultimoMessaggioIl.flatMap(Date.daISO) {
                    Text(quando, format: .relative(presentation: .numeric))
                        .font(Tema.corpo(.footnote))
                        .foregroundStyle(Tema.testoTenue)
                }
            }
            Spacer(minLength: 0)
            if conversazione.nonLetti > 0 {
                Text("\(conversazione.nonLetti)")
                    .font(Tema.corpo(.caption, peso: .semibold))
                    .foregroundStyle(Tema.sopraAccento)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Tema.accento, in: Capsule())
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

/// Una conversazione aperta: la cronologia, e sotto il campo per scrivere.
struct SchermataConversazione: View {
    @EnvironmentObject private var casa: Casa
    let conversazione: Conversazione
    let io: Io?

    @State private var messaggi: [Messaggio] = []
    @State private var ultimaPagina: Set<String> = []
    @State private var apertura: Apertura?
    @State private var senzaCronologia = false
    @State private var estranei: [String] = []
    @State private var testo = ""
    @State private var invio = false
    @State private var errore: String?

    private var altro: String {
        conversazione.membri.first { $0.id != io?.id }?.nome ?? Frasi.t("messaggi.questa_persona")
    }

    /// Perché non si può scrivere, se non si può.
    private var blocco: (titolo: String, testo: String)? {
        let nome = ["nome": altro]
        switch apertura {
        case .none: return nil
        case .tolto: return (Frasi.t("chat.tolto.titolo"), Frasi.t("chat.tolto.testo"))
        case .inAttesa:
            return conversazione.gruppo
                ? (Frasi.t("chat.gruppo_in_attesa.titolo"), Frasi.t("chat.gruppo_in_attesa.testo", nome))
                : (Frasi.t("chat.in_attesa.titolo"), Frasi.t("chat.in_attesa.testo", nome))
        case .pronta:
            if senzaCronologia {
                return (Frasi.t("chat.cronologia.titolo"), Frasi.t("chat.cronologia.testo", nome))
            }
            if !estranei.isEmpty {
                let nomi = ["nomi": estranei.joined(separator: ", ")]
                return (Frasi.t("chat.estranei.titolo"), Frasi.t("chat.estranei.testo", nomi))
            }
            return nil
        }
    }

    var body: some View {
        ScrollViewReader { lettore in
            ScrollView {
                LazyVStack(spacing: 8) {
                    if let blocco {
                        Riquadro(titolo: blocco.titolo, testo: blocco.testo)
                    } else if apertura == .pronta, messaggi.isEmpty {
                        Text(Frasi.t("messaggi.nessun_messaggio"))
                            .font(Tema.corpo(.callout))
                            .foregroundStyle(Tema.testoTenue)
                            .padding(.top, 32)
                    }
                    ForEach(messaggi, id: \.id) { m in
                        Nuvoletta(messaggio: m, conversazione: conversazione, gruppo: conversazione.gruppo)
                            .id(m.id)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .defaultScrollAnchor(.bottom)
            .onChange(of: messaggi.last?.id) { _, ultimo in
                guard let ultimo else { return }
                withAnimation { lettore.scrollTo(ultimo, anchor: .bottom) }
            }
        }
        .background(Tema.sfondo)
        .navigationTitle(nomeConversazione(conversazione, io: io))
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) { campo }
        .task { await giri() }
    }

    @ViewBuilder private var campo: some View {
        let spento = blocco != nil || apertura != .pronta
        VStack(spacing: 6) {
            if let errore {
                Text(errore)
                    .font(Tema.corpo(.footnote))
                    .foregroundStyle(Tema.pericolo)
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField(Frasi.t("messaggi.scrivi_segnaposto"), text: $testo, axis: .vertical)
                    .font(Tema.corpo())
                    .lineLimit(1...5)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Tema.superficie, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(Tema.bordo))
                    .disabled(spento)
                Button {
                    Task { await invia() }
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 17, weight: .semibold))
                        .frame(width: 40, height: 40)
                }
                .modifier(PulsanteTondo())
                .disabled(spento || invio || testo.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel(Frasi.t("comune.invia"))
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }

    /// Un giro subito, poi ogni dieci secondi finché la schermata è aperta:
    /// il `.task` si ferma da solo quando si torna indietro.
    private func giri() async {
        do {
            let sessioni = try await casa.sessioniPronte()
            apertura = try await sessioni.apriConversazione(conversazione: conversazione.id)
            if apertura == .pronta {
                let pagina = try await sessioni.cronologia(conversazione: conversazione.id, prima: nil)
                messaggi = pagina.messaggi
            }
        } catch {
            errore = Frasi.t("messaggi.errore_avvio")
        }
        while !Task.isCancelled {
            await giro()
            try? await Task.sleep(for: .seconds(10))
        }
    }

    private func giro() async {
        guard let sessioni = try? await casa.sessioniPronte(),
              let a = try? await sessioni.aggiorna(conversazione: conversazione.id)
        else { return }
        apertura = a.apertura
        senzaCronologia = a.senzaCronologia
        estranei = a.estranei
        // Ciò che era nell'ultima pagina e non c'è più l'ha ritirato chi l'aveva scritto.
        let ritirati = ultimaPagina.subtracting(a.pagina)
        var perId = Dictionary(messaggi.filter { !ritirati.contains($0.id) }.map { ($0.id, $0) }, uniquingKeysWith: { _, ultimo in ultimo })
        for m in a.nuovi { perId[m.id] = m }
        messaggi = perId.values.sorted { ($0.creatoIl, $0.id) < ($1.creatoIl, $1.id) }
        ultimaPagina = Set(a.pagina)
    }

    private func invia() async {
        let daMandare = testo.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !daMandare.isEmpty, !invio else { return }
        invio = true
        errore = nil
        defer { invio = false }
        do {
            let sessioni = try await casa.sessioniPronte()
            let mandato = try await sessioni.invia(conversazione: conversazione.id, testo: daMandare, risponde: nil)
            testo = ""
            messaggi.removeAll { $0.id == mandato.id }
            messaggi.append(mandato)
        } catch {
            errore = Frasi.t("messaggi.errore_invio")
        }
    }
}

/// Il pulsante d'invio: vetro di sistema su iOS 26, altrimenti pieno.
private struct PulsanteTondo: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.circle)
                .tint(Tema.accento)
                .foregroundStyle(Tema.sopraAccento)
        } else {
            content
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.circle)
                .tint(Tema.accento)
                .foregroundStyle(Tema.sopraAccento)
        }
    }
}

private struct Riquadro: View {
    let titolo: String
    let testo: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(titolo)
                .font(Tema.corpo(.headline, peso: .semibold))
                .foregroundStyle(Tema.testo)
            Text(testo)
                .font(Tema.corpo(.callout))
                .foregroundStyle(Tema.testoTenue)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Tema.superficie2, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

private struct Nuvoletta: View {
    let messaggio: Messaggio
    let conversazione: Conversazione
    let gruppo: Bool

    private func nome(_ membro: String?) -> String {
        guard let membro else { return Frasi.t("messaggi.interlocutore") }
        return conversazione.membri.first { "\($0.username)@\($0.casa)" == membro }?.nome ?? membro
    }

    var body: some View {
        if let evento = messaggio.evento {
            let chi = messaggio.mio ? Frasi.t("messaggi.tu") : nome(messaggio.mittente)
            let di = nome(evento.chi)
            Text(
                evento.tipo == .uscita
                    ? Frasi.t("gruppi.evento.uscita", ["nome": di])
                    : Frasi.t(evento.tipo == .ingresso ? "gruppi.evento.ingresso" : "gruppi.evento.rimozione",
                              ["chi": chi, "nome": di])
            )
            .font(Tema.corpo(.footnote))
            .foregroundStyle(Tema.testoTenue)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
        } else {
            HStack {
                if messaggio.mio { Spacer(minLength: 48) }
                VStack(alignment: .leading, spacing: 4) {
                    if gruppo, !messaggio.mio {
                        Text(nome(messaggio.mittente))
                            .font(Tema.corpo(.caption, peso: .semibold))
                            .foregroundStyle(Tema.testoAccento)
                    }
                    contenuto
                    HStack(spacing: 4) {
                        if !messaggio.attestato {
                            Image(systemName: "exclamationmark.triangle")
                                .accessibilityLabel(Frasi.t("messaggi.non_attestato"))
                        }
                        if let quando = Date.daISO(messaggio.creatoIl) {
                            Text(quando, format: .dateTime.hour().minute())
                        }
                    }
                    .font(Tema.corpo(.caption2))
                    .foregroundStyle(messaggio.mio ? Tema.sopraAccento.opacity(0.7) : Tema.testoTenue)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(
                    messaggio.mio ? Tema.accento : Tema.superficie,
                    in: RoundedRectangle(cornerRadius: 18, style: .continuous)
                )
                if !messaggio.mio { Spacer(minLength: 48) }
            }
            .accessibilityElement(children: .combine)
        }
    }

    @ViewBuilder private var contenuto: some View {
        switch messaggio.stato {
        case .letto:
            Text(messaggio.testo ?? "")
                .font(Tema.corpo())
                .foregroundStyle(messaggio.mio ? Tema.sopraAccento : Tema.testo)
                .textSelection(.enabled)
        case .nonSiApre:
            Text(Frasi.t("messaggi.non_si_apre.titolo"))
                .font(Tema.corpo().italic())
                .foregroundStyle(Tema.testoTenue)
        case .nonDisponibile:
            Text(Frasi.t("messaggi.non_disponibile.titolo"))
                .font(Tema.corpo().italic())
                .foregroundStyle(Tema.testoTenue)
        }
    }
}

/// Il foglio per cominciare una conversazione con qualcuno.
private struct NuovaConversazione: View {
    @EnvironmentObject private var casa: Casa
    @Environment(\.dismiss) private var chiudi
    let creata: (Conversazione) -> Void

    @State private var chi = ""
    @State private var inCorso = false
    @State private var errore: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(Frasi.t("messaggi.cerca.segnaposto"), text: $chi)
                        .font(Tema.corpo())
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textContentType(.username)
                } header: {
                    Text(Frasi.t("app_messaggi.chi"))
                } footer: {
                    Text(errore ?? Frasi.t("app_messaggi.chi.aiuto"))
                        .foregroundStyle(errore == nil ? Tema.testoTenue : Tema.pericolo)
                }
            }
            .navigationTitle(Frasi.t("app_messaggi.nuova"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(Frasi.t("comune.annulla")) { chiudi() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(Frasi.t("app_messaggi.comincia")) { Task { await comincia() } }
                        .disabled(inCorso || chi.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
        .presentationDetents([.medium])
    }

    private func comincia() async {
        let pulito = chi.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "@"))
        let parti = pulito.split(separator: "@", maxSplits: 1).map(String.init)
        guard let username = parti.first, !username.isEmpty else { return }
        inCorso = true
        errore = nil
        defer { inCorso = false }
        do {
            let sessioni = try await casa.sessioniPronte()
            let conversazione = try await sessioni.creaDiretta(
                con: PersonaDaInvitare(username: username, casa: parti.count > 1 ? parti[1] : nil)
            )
            creata(conversazione)
        } catch {
            errore = Frasi.t("messaggi.errore_avvio")
        }
    }
}
