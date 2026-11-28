// Le conversazioni cifrate (ADR 0038, 0043, 0052), sopra le `Sessioni` del
// nucleo: l'app chiede e mostra, il nucleo fa MLS e l'archivio. Nessuna
// chiave passa di qui.
//
// Qui l'elenco e la conversazione aperta, con la risposta e il ritiro. Il
// gruppo (crearlo, chi c'è, aggiungere, togliere, uscire) sta in Gruppi.swift.

import SwiftUI
import UIKit

struct Messaggi: View {
    @EnvironmentObject private var casa: Casa
    @State private var conversazioni: [Conversazione] = []
    @State private var io: Io?
    @State private var stato: Stato = .carico
    @State private var foglio: Foglio?
    @State private var percorso: [String] = []

    enum Stato: Equatable { case carico, pronto, errore }

    /// Che cosa si comincia: una conversazione a due, o un gruppo.
    enum Foglio: String, Identifiable {
        case diretta, gruppo
        var id: String { rawValue }
    }

    var body: some View {
        NavigationStack(path: $percorso) {
            Group {
                if let io, !io.approvato {
                    // Finché aspetta il sì non c'è niente da elencare: si dice
                    // perché, si mostra il codice, e dove andare a dirlo.
                    ScrollView {
                        AttesaDelSi(codice: io.codice, ricontrolla: { await carica() })
                            .padding(20)
                            .background(Tema.superficie, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                            .padding(16)
                    }
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
                        Menu {
                            Button { foglio = .diretta } label: {
                                Label(Frasi.t("app_messaggi.nuova"), systemImage: "person")
                            }
                            Button { foglio = .gruppo } label: {
                                Label(Frasi.t("gruppi.nuovo.voce"), systemImage: "person.3")
                            }
                        } label: {
                            Image(systemName: "square.and.pencil")
                        }
                        .accessibilityLabel(Frasi.t("app_messaggi.nuova_o_gruppo"))
                    }
                }
            }
            .navigationDestination(for: String.self) { id in
                if let c = conversazioni.first(where: { $0.id == id }) {
                    SchermataConversazione(
                        conversazione: c,
                        io: io,
                        cambiata: { await carica() },
                        uscita: { esce(da: c.id) }
                    )
                }
            }
            .sheet(item: $foglio) { quale in
                switch quale {
                case .diretta:
                    NuovaConversazione { creata in apri(creata) }
                case .gruppo:
                    NuovoGruppo(io: io) { creato in apri(creato) }
                }
            }
            .refreshable { await carica() }
            .task {
                await carica()
                // Chi aspetta il sì ricontrolla da sé ogni dieci secondi: il sì
                // arriva da un altro dispositivo, e qui non lo annuncia nessuno.
                while !Task.isCancelled, io?.approvato == false {
                    try? await Task.sleep(for: .seconds(10))
                    await carica()
                }
            }
        }
    }

    private func carica() async {
        do {
            let sessioni = try await casa.sessioniPronte()
            // Chi aspettava lo scopre dall'elenco dei dispositivi, che
            // aggiorna `approvato`.
            if !sessioni.io().approvato {
                _ = try? await sessioni.dispositivi()
            }
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

    private func apri(_ creata: Conversazione) {
        foglio = nil
        if !conversazioni.contains(where: { $0.id == creata.id }) {
            conversazioni.insert(creata, at: 0)
        }
        percorso = [creata.id]
    }

    /// Si è usciti da un gruppo: si torna all'elenco, dove non c'è più.
    private func esce(da id: String) {
        percorso = []
        conversazioni.removeAll { $0.id == id }
        Task { await carica() }
    }
}

/// Il nome da mostrare: quello del gruppo, oppure l'altra persona.
func nomeConversazione(_ conversazione: Conversazione, io: Io?) -> String {
    if let nome = conversazione.nome, !nome.isEmpty { return nome }
    let altri = conversazione.membri.filter { $0.id != io?.id }
    if altri.isEmpty { return Frasi.t("messaggi.te_stesso") }
    return altri.map(\.nome).joined(separator: ", ")
}

/// `nome` o `nome@chiave-della-casa`, com'è scritto, nella forma che la Casa
/// vuole. `nil` se non c'è un nome.
func personaDaInvitare(_ testo: String) -> PersonaDaInvitare? {
    let pulito = testo
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .trimmingCharacters(in: CharacterSet(charactersIn: "@"))
    let parti = pulito.split(separator: "@", maxSplits: 1).map(String.init)
    guard let username = parti.first, !username.isEmpty else { return nil }
    return PersonaDaInvitare(username: username, casa: parti.count > 1 ? parti[1] : nil)
}

/// Il codice con cui la Casa ha detto di no (`no_device_available`, …), se è
/// stata lei: il nucleo lo passa come `casa <stato>: <codice>`.
func codiceDellaCasa(_ errore: Error) -> String? {
    guard let errore = errore as? ErroreNucleo, case let .Casa(message) = errore,
          let due = message.range(of: ": ")
    else { return nil }
    return String(message[due.upperBound...])
}

/// Vetro di sistema su iOS 26, materiale sottile prima.
struct Vetro<Forma: Shape>: ViewModifier {
    let forma: Forma

    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content.glassEffect(.regular, in: forma)
        } else {
            content.background(.thinMaterial, in: forma)
        }
    }
}

private struct RigaConversazione: View {
    let conversazione: Conversazione
    let io: Io?

    var body: some View {
        let nome = nomeConversazione(conversazione, io: io)
        HStack(spacing: 12) {
            Iniziale(nome: nome, chiave: conversazione.id)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    if conversazione.gruppo {
                        Image(systemName: "person.3.fill")
                            .font(.system(size: 11))
                            .foregroundStyle(Tema.testoTenue)
                            .accessibilityHidden(true)
                    }
                    Text(nome)
                        .font(Tema.corpo(.body, peso: conversazione.nonLetti > 0 ? .semibold : .regular))
                        .foregroundStyle(Tema.testo)
                        .lineLimit(1)
                }
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

/// Il messaggio a cui una nuvoletta risponde, come lo si mostra sopra il testo.
struct Citazione: Equatable {
    let id: String
    /// `nil` quando il messaggio citato non è fra quelli caricati.
    let autore: String?
    let testo: String
}

/// Una conversazione aperta: la cronologia, e sotto il campo per scrivere.
struct SchermataConversazione: View {
    @EnvironmentObject private var casa: Casa
    let conversazione: Conversazione
    let io: Io?
    /// Chi c'è è cambiato: l'elenco si ricarica.
    let cambiata: () async -> Void
    /// Questa persona è uscita dal gruppo.
    let uscita: () -> Void

    @State private var messaggi: [Messaggio] = []
    @State private var ultimaPagina: Set<String> = []
    @State private var apertura: Apertura?
    @State private var senzaCronologia = false
    @State private var estranei: [String] = []
    /// Questo dispositivo aspetta ancora il sì: non crea e non rientra.
    @State private var aspettaIlSi = false
    @State private var testo = ""
    @State private var invio = false
    @State private var errore: String?
    @State private var risponde: Messaggio?
    @State private var daRitirare: Messaggio?
    @State private var info = false
    @FocusState private var scrivendo: Bool

    private var altro: String {
        conversazione.membri.first { $0.id != io?.id }?.nome ?? Frasi.t("messaggi.questa_persona")
    }

    /// Perché non si può scrivere, se non si può.
    private var blocco: (titolo: String, testo: String)? {
        let nome = ["nome": altro]
        if aspettaIlSi {
            return (
                Frasi.t("chat.dispositivo_in_attesa.titolo"),
                Frasi.t("chat.dispositivo_in_attesa.testo") + "\n\n" + Frasi.t("chat.dispositivo_in_attesa.cosa_fare")
            )
        }
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

    private var spento: Bool { blocco != nil || apertura != .pronta }

    /// Che cosa dice il campo di scrittura mentre è spento.
    private var segnaposto: String {
        aspettaIlSi ? Frasi.t("chat.dispositivo_in_attesa.segnaposto") : Frasi.t("messaggi.scrivi_segnaposto")
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
                        Nuvoletta(
                            messaggio: m,
                            gruppo: conversazione.gruppo,
                            mittente: m.mio ? Frasi.t("messaggi.tu") : nomeDi(m.mittente),
                            nomeDi: nomeDi,
                            citazione: citazione(di: m),
                            puoRispondere: !spento,
                            puoRitirare: m.mio && apertura == .pronta,
                            rispondi: {
                                withAnimation(.snappy) { risponde = m }
                                scrivendo = true
                            },
                            ritira: { daRitirare = m },
                            vaiA: { id in
                                withAnimation { lettore.scrollTo(id, anchor: .center) }
                            }
                        )
                        .id(m.id)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: messaggi.last?.id) { _, ultimo in
                guard let ultimo else { return }
                withAnimation { lettore.scrollTo(ultimo, anchor: .bottom) }
            }
        }
        .background(Tema.sfondo)
        .navigationTitle(nomeConversazione(conversazione, io: io))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if conversazione.gruppo && apertura != .tolto {
                ToolbarItem(placement: .primaryAction) {
                    Button { info = true } label: {
                        Image(systemName: "person.2")
                    }
                    .accessibilityLabel(Frasi.t("gruppi.membri.voce"))
                }
            }
        }
        .sheet(isPresented: $info) {
            InfoGruppo(
                conversazione: conversazione,
                io: io,
                cambiata: cambiata,
                uscita: {
                    info = false
                    uscita()
                }
            )
        }
        .confirmationDialog(
            Frasi.t("app_messaggi.ritira.titolo"),
            isPresented: Binding(get: { daRitirare != nil }, set: { if !$0 { daRitirare = nil } }),
            titleVisibility: .visible,
            presenting: daRitirare
        ) { m in
            Button(Frasi.t("app_messaggi.ritira"), role: .destructive) {
                Task { await ritira(m) }
            }
            Button(Frasi.t("comune.annulla"), role: .cancel) {}
        } message: { _ in
            Text(Frasi.t("app_messaggi.ritira.testo"))
        }
        .safeAreaInset(edge: .bottom) { campo }
        .task { await giri() }
    }

    private func nomeDi(_ membro: String?) -> String {
        guard let membro else { return Frasi.t("messaggi.interlocutore") }
        let persona = conversazione.membri.first { "\($0.username)@\($0.casa)" == membro }
        if let nome = persona?.nome, !nome.isEmpty { return nome }
        return persona?.username ?? membro
    }

    private func anteprima(_ m: Messaggio) -> String {
        switch m.stato {
        case .letto: return m.testo ?? ""
        case .nonSiApre: return Frasi.t("messaggi.non_si_apre.titolo")
        case .nonDisponibile: return Frasi.t("messaggi.non_disponibile.titolo")
        }
    }

    private func citazione(di m: Messaggio) -> Citazione? {
        guard let id = m.risponde else { return nil }
        guard let citato = messaggi.first(where: { $0.id == id }) else {
            return Citazione(id: id, autore: nil, testo: Frasi.t("app_messaggi.citato_assente"))
        }
        return Citazione(
            id: id,
            autore: citato.mio ? Frasi.t("messaggi.tu") : nomeDi(citato.mittente),
            testo: anteprima(citato)
        )
    }

    @ViewBuilder private var campo: some View {
        VStack(spacing: 6) {
            if let errore {
                Text(errore)
                    .font(Tema.corpo(.footnote))
                    .foregroundStyle(Tema.pericolo)
            }
            if let citato = risponde {
                HStack(spacing: 10) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Tema.accento)
                        .frame(width: 3)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(Frasi.t("messaggi.risposta_a", [
                            "nome": citato.mio ? Frasi.t("messaggi.tu") : nomeDi(citato.mittente),
                        ]))
                        .font(Tema.corpo(.caption, peso: .semibold))
                        .foregroundStyle(Tema.testoAccento)
                        Text(anteprima(citato))
                            .font(Tema.corpo(.footnote))
                            .foregroundStyle(Tema.testoTenue)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Button {
                        withAnimation(.snappy) { risponde = nil }
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 20))
                            .foregroundStyle(Tema.testoTenue)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Frasi.t("messaggi.annulla_risposta"))
                }
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Tema.superficie2, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField(segnaposto, text: $testo, axis: .vertical)
                    .font(Tema.corpo())
                    .lineLimit(1...5)
                    .focused($scrivendo)
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
        .modifier(FondoDelCampo())
    }

    /// Un giro subito, poi ogni dieci secondi finché la schermata è aperta:
    /// il `.task` si ferma da solo quando si torna indietro.
    private func giri() async {
        do {
            let sessioni = try await casa.sessioniPronte()
            apertura = try await sessioni.apriConversazione(conversazione: conversazione.id)
            aspettaIlSi = false
            if apertura == .pronta {
                let pagina = try await sessioni.cronologia(conversazione: conversazione.id, prima: nil)
                messaggi = pagina.messaggi
            }
        } catch ErroreNucleo.DispositivoInAttesa {
            // Non è un guasto: la mossa è su un altro dispositivo, e si dice.
            aspettaIlSi = true
        } catch {
            errore = Frasi.t("messaggi.errore_avvio")
        }
        while !Task.isCancelled {
            await giro()
            try? await Task.sleep(for: .seconds(10))
        }
    }

    private func giro() async {
        guard let sessioni = try? await casa.sessioniPronte() else { return }
        let a: Aggiornamento
        do {
            a = try await sessioni.aggiorna(conversazione: conversazione.id)
        } catch ErroreNucleo.DispositivoInAttesa {
            aspettaIlSi = true
            return
        } catch {
            return
        }
        aspettaIlSi = false
        apertura = a.apertura
        senzaCronologia = a.senzaCronologia
        estranei = a.estranei
        // Ciò che era nell'ultima pagina e non c'è più l'ha ritirato chi l'aveva scritto.
        let ritirati = ultimaPagina.subtracting(a.pagina)
        var perId = Dictionary(messaggi.filter { !ritirati.contains($0.id) }.map { ($0.id, $0) }, uniquingKeysWith: { _, ultimo in ultimo })
        for m in a.nuovi { perId[m.id] = m }
        messaggi = perId.values.sorted { ($0.creatoIl, $0.id) < ($1.creatoIl, $1.id) }
        ultimaPagina = Set(a.pagina)
        if let citato = risponde, ritirati.contains(citato.id) { risponde = nil }
    }

    private func invia() async {
        let daMandare = testo.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !daMandare.isEmpty, !invio else { return }
        invio = true
        errore = nil
        defer { invio = false }
        do {
            let sessioni = try await casa.sessioniPronte()
            let mandato = try await sessioni.invia(
                conversazione: conversazione.id,
                testo: daMandare,
                risponde: risponde?.id
            )
            testo = ""
            withAnimation(.snappy) { risponde = nil }
            messaggi.removeAll { $0.id == mandato.id }
            messaggi.append(mandato)
        } catch {
            errore = Frasi.t("messaggi.errore_invio")
        }
    }

    /// Il ritiro: la voce esce dall'archivio della propria casa, e da qui.
    private func ritira(_ m: Messaggio) async {
        errore = nil
        do {
            let sessioni = try await casa.sessioniPronte()
            try await sessioni.ritira(conversazione: conversazione.id, messaggio: m.id)
            withAnimation(.snappy) {
                messaggi.removeAll { $0.id == m.id }
                if risponde?.id == m.id { risponde = nil }
            }
            ultimaPagina.remove(m.id)
        } catch {
            errore = Frasi.t("app_messaggi.ritira.errore")
        }
    }
}

/// Il fondo del campo per scrivere: su iOS 26 un pannello di vetro che
/// galleggia sopra la cronologia, prima la barra di sistema.
private struct FondoDelCampo: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
                .padding(.horizontal, 8)
                .padding(.bottom, 4)
        } else {
            content
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(.bar)
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
    let gruppo: Bool
    /// Chi l'ha scritto, già detto come va mostrato.
    let mittente: String
    let nomeDi: (String?) -> String
    let citazione: Citazione?
    let puoRispondere: Bool
    let puoRitirare: Bool
    let rispondi: () -> Void
    let ritira: () -> Void
    let vaiA: (String) -> Void

    var body: some View {
        if let evento = messaggio.evento {
            let di = nomeDi(evento.chi)
            Text(
                evento.tipo == .uscita
                    ? Frasi.t("gruppi.evento.uscita", ["nome": di])
                    : evento.tipo == .ingresso
                    ? Frasi.t("gruppi.evento.ingresso", ["chi": mittente, "nome": di])
                    : Frasi.t("gruppi.evento.rimozione", ["chi": mittente, "nome": di])
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
                        Text(mittente)
                            .font(Tema.corpo(.caption, peso: .semibold))
                            .foregroundStyle(Tema.testoAccento)
                    }
                    if let citazione {
                        Button { vaiA(citazione.id) } label: { citato(citazione) }
                            .buttonStyle(.plain)
                            .disabled(citazione.autore == nil)
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
                .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: 18, style: .continuous))
                .contextMenu { azioni }
                if !messaggio.mio { Spacer(minLength: 48) }
            }
            .accessibilityElement(children: .combine)
            .accessibilityActions { azioni }
        }
    }

    /// Le azioni su una nuvoletta: dal menu del tocco lungo, e da VoiceOver.
    @ViewBuilder private var azioni: some View {
        if puoRispondere {
            Button(action: rispondi) {
                Label(Frasi.t("commento.rispondi"), systemImage: "arrowshape.turn.up.left")
            }
        }
        if messaggio.stato == .letto, let testo = messaggio.testo, !testo.isEmpty {
            Button {
                UIPasteboard.general.string = testo
            } label: {
                Label(Frasi.t("comune.copia"), systemImage: "doc.on.doc")
            }
        }
        if puoRitirare {
            Button(role: .destructive, action: ritira) {
                Label(Frasi.t("app_messaggi.ritira"), systemImage: "trash")
            }
        }
    }

    private func citato(_ citazione: Citazione) -> some View {
        HStack(spacing: 8) {
            RoundedRectangle(cornerRadius: 2)
                .fill(messaggio.mio ? Tema.sopraAccento.opacity(0.6) : Tema.accento)
                .frame(width: 3)
            VStack(alignment: .leading, spacing: 1) {
                if let autore = citazione.autore {
                    Text(autore)
                        .font(Tema.corpo(.caption, peso: .semibold))
                }
                Text(citazione.testo)
                    .font(Tema.corpo(.footnote))
                    .italic(citazione.autore == nil)
                    .lineLimit(2)
            }
            .foregroundStyle(messaggio.mio ? Tema.sopraAccento.opacity(0.85) : Tema.testoTenue)
            Spacer(minLength: 0)
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(
            (messaggio.mio ? Tema.sopraAccento.opacity(0.1) : Tema.superficie2),
            in: RoundedRectangle(cornerRadius: 10, style: .continuous)
        )
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
                        .disabled(inCorso || personaDaInvitare(chi) == nil)
                }
            }
        }
        .presentationDetents([.medium])
    }

    private func comincia() async {
        guard let persona = personaDaInvitare(chi) else { return }
        inCorso = true
        errore = nil
        defer { inCorso = false }
        do {
            let sessioni = try await casa.sessioniPronte()
            let conversazione = try await sessioni.creaDiretta(con: persona)
            creata(conversazione)
        } catch {
            errore = Frasi.t("messaggi.errore_avvio")
        }
    }
}
