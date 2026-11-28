// I gruppi (M8), sopra le `Sessioni` del nucleo: crearne uno, vedere chi c'è,
// aggiungere, togliere, far entrare chi non è ancora dentro, uscire. Le
// regole sono quelle del web (`screens/gruppi`): aggiungono e tolgono il
// creatore e chi amministra, e chiunque esce da solo.

import SwiftUI

/// Il nome di una persona com'è da mostrare.
func nomeDellaPersona(_ persona: Persona) -> String {
    persona.nome.isEmpty ? persona.username : persona.nome
}

/// Il foglio per creare un gruppo: un nome, e almeno altre due persone.
struct NuovoGruppo: View {
    @EnvironmentObject private var casa: Casa
    @Environment(\.dismiss) private var chiudi
    let io: Io?
    let creato: (Conversazione) -> Void

    @State private var nome = ""
    @State private var chi = ""
    /// Le persone scelte, come sono state scritte: `nome` o `nome@casa`.
    @State private var scelti: [String] = []
    @State private var inCorso = false
    @State private var errore: String?
    @FocusState private var cercando: Bool

    private var pronto: Bool {
        !nome.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && scelti.count >= 2
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(Frasi.t("gruppi.nuovo.nome"), text: $nome)
                        .font(Tema.corpo())
                        .submitLabel(.next)
                        .onSubmit { cercando = true }
                } footer: {
                    Text(Frasi.t("gruppi.nuovo.spiegazione"))
                }

                Section {
                    HStack(spacing: 8) {
                        TextField(Frasi.t("messaggi.cerca.segnaposto"), text: $chi)
                            .font(Tema.corpo())
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .textContentType(.username)
                            .focused($cercando)
                            .submitLabel(.done)
                            .onSubmit { aggiungi() }
                        Button(Frasi.t("gruppi.aggiungi.conferma")) { aggiungi() }
                            .font(Tema.corpo(.body, peso: .semibold))
                            .disabled(personaDaInvitare(chi) == nil)
                    }
                    ForEach(scelti, id: \.self) { scelto in
                        HStack(spacing: 12) {
                            Iniziale(nome: scelto, chiave: scelto)
                            Text(scelto)
                                .font(Tema.corpo())
                                .foregroundStyle(Tema.testo)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Spacer(minLength: 0)
                            Button {
                                withAnimation { scelti.removeAll { $0 == scelto } }
                            } label: {
                                Image(systemName: "minus.circle.fill")
                                    .font(.system(size: 20))
                                    .foregroundStyle(Tema.pericolo)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(Frasi.t("gruppi.nuovo.togli", ["nome": scelto]))
                        }
                    }
                    .onDelete { posti in scelti.remove(atOffsets: posti) }
                } header: {
                    Text(Frasi.t("gruppi.nuovo.cerca"))
                } footer: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(Frasi.t("app_messaggi.gruppo.chi.aiuto"))
                        if let errore {
                            Text(errore).foregroundStyle(Tema.pericolo)
                        } else if scelti.count >= 2 {
                            Text(Frasi.t("gruppi.nuovo.pronto", ["n": "\(scelti.count + 1)"]))
                                .foregroundStyle(Tema.testoAccento)
                        } else {
                            Text(Frasi.t("gruppi.nuovo.manca_persone"))
                        }
                    }
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(Frasi.t("gruppi.nuovo.titolo"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(Frasi.t("comune.annulla")) { chiudi() }
                        .disabled(inCorso)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if inCorso {
                        ProgressView()
                            .accessibilityLabel(Frasi.t("gruppi.nuovo.creo"))
                    } else {
                        Button(Frasi.t("gruppi.nuovo.crea")) { Task { await crea() } }
                            .disabled(!pronto)
                    }
                }
            }
        }
        .interactiveDismissDisabled(inCorso)
    }

    private func aggiungi() {
        guard let persona = personaDaInvitare(chi) else { return }
        let scritto = persona.casa.map { "\(persona.username)@\($0)" } ?? persona.username
        chi = ""
        cercando = true
        errore = nil
        // Sé stessi non si aggiungono: nel gruppo ci si è già.
        if persona.username == io?.username, persona.casa == nil || persona.casa == io?.casa { return }
        if scelti.contains(scritto) { return }
        withAnimation { scelti.append(scritto) }
    }

    private func crea() async {
        let pulito = nome.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !pulito.isEmpty else {
            errore = Frasi.t("gruppi.nuovo.manca_nome")
            return
        }
        guard scelti.count >= 2 else {
            errore = Frasi.t("gruppi.nuovo.manca_persone")
            return
        }
        inCorso = true
        errore = nil
        defer { inCorso = false }
        do {
            let sessioni = try await casa.sessioniPronte()
            let gruppo = try await sessioni.creaGruppo(nome: pulito, membri: scelti.compactMap(personaDaInvitare))
            creato(gruppo)
        } catch {
            switch codiceDellaCasa(error) {
            case "user_not_found": errore = Frasi.t("messaggi.nessuno_trovato")
            case "gruppo_pieno": errore = Frasi.t("gruppi.nuovo.troppe")
            default: errore = Frasi.t("gruppi.nuovo.errore")
            }
        }
    }
}

/// Chi c'è in un gruppo, e che cosa ci si può fare: aggiungere, togliere,
/// far entrare chi non è ancora nel gruppo cifrato, uscire.
struct InfoGruppo: View {
    @EnvironmentObject private var casa: Casa
    @Environment(\.dismiss) private var chiudi
    let conversazione: Conversazione
    let io: Io?
    let cambiata: () async -> Void
    let uscita: () -> Void

    /// Com'è andato l'ultimo gesto, da dire in cima.
    struct Esito: Equatable {
        let testo: String
        let guasto: Bool
    }

    @State private var membri: [MembroDelGruppo] = []
    @State private var carico = true
    @State private var lavoro: String?
    @State private var esito: Esito?
    @State private var aggiungendo = false
    @State private var chi = ""
    @State private var daTogliere: MembroDelGruppo?
    @State private var esco = false

    private var mio: MembroDelGruppo? { membri.first { $0.persona.id == io?.id } }

    /// Aggiungono e tolgono il creatore e chi amministra (`gestisce` del web).
    private var gestisce: Bool {
        guard !conversazione.congelata, let ruolo = mio?.persona.ruolo else { return false }
        return ruolo == "creatore" || ruolo == "amministratore"
    }

    private var nome: String {
        if let nome = conversazione.nome, !nome.isEmpty { return nome }
        return Frasi.t("gruppi.senza_nome")
    }

    private var persone: String {
        let n = membri.isEmpty ? conversazione.membri.count : membri.count
        return n == 1
            ? Frasi.t("gruppi.persone.one", ["n": "1"])
            : Frasi.t("gruppi.persone.other", ["n": "\(n)"])
    }

    private var titoloMembri: String {
        membri.count == 1
            ? Frasi.t("gruppi.membri.titolo.one", ["n": "1"])
            : Frasi.t("gruppi.membri.titolo.other", ["n": "\(membri.count)"])
    }

    private var piedeMembri: String {
        guard membri.contains(where: { $0.dispositivi == 0 }) else {
            return Frasi.t("gruppi.ruolo.spiegazione")
        }
        return gestisce ? Frasi.t("gruppi.assenti.gestisci") : Frasi.t("gruppi.assenti.aspetta")
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(spacing: 10) {
                        Iniziale(nome: nome, chiave: conversazione.id)
                            .scaleEffect(1.6)
                            .frame(width: 64, height: 64)
                        Text(nome)
                            .font(Tema.titolo(22, relativo: .title2))
                            .foregroundStyle(Tema.testo)
                            .multilineTextAlignment(.center)
                        Text(persone)
                            .font(Tema.corpo(.subheadline))
                            .foregroundStyle(Tema.testoTenue)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
                    .listRowBackground(Color.clear)
                }

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

                Section {
                    if carico && membri.isEmpty {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                    }
                    ForEach(membri, id: \.membro) { m in
                        let altro = m.persona.id != io?.id
                        RigaMembro(membro: m, io: io)
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                if gestisce && altro {
                                    Button(role: .destructive) { daTogliere = m } label: {
                                        Label(Frasi.t("gruppi.togli.voce"), systemImage: "person.badge.minus")
                                    }
                                }
                            }
                            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                                if gestisce && m.dispositivi == 0 {
                                    Button { Task { await faiEntrare(m) } } label: {
                                        Label(Frasi.t("gruppi.entra.voce"), systemImage: "person.badge.key")
                                    }
                                    .tint(Tema.accento)
                                }
                            }
                            .contextMenu {
                                if gestisce && m.dispositivi == 0 {
                                    Button { Task { await faiEntrare(m) } } label: {
                                        Label(Frasi.t("gruppi.entra.voce"), systemImage: "person.badge.key")
                                    }
                                }
                                if gestisce && altro {
                                    Button(role: .destructive) { daTogliere = m } label: {
                                        Label(Frasi.t("gruppi.togli.voce"), systemImage: "person.badge.minus")
                                    }
                                }
                            }
                    }
                    if gestisce {
                        Button {
                            chi = ""
                            aggiungendo = true
                        } label: {
                            Label(Frasi.t("gruppi.aggiungi.voce"), systemImage: "person.badge.plus")
                                .font(Tema.corpo())
                                .foregroundStyle(Tema.testoAccento)
                        }
                    }
                } header: {
                    Text(titoloMembri)
                } footer: {
                    Text(piedeMembri)
                }
                .listRowBackground(Tema.superficie)

                Section {
                    if conversazione.congelata {
                        Text(Frasi.t("gruppi.trasloco.congelato"))
                            .font(Tema.corpo(.callout))
                            .foregroundStyle(Tema.testoTenue)
                    } else {
                        Button(role: .destructive) { esco = true } label: {
                            Label(Frasi.t("gruppi.esci.voce"), systemImage: "rectangle.portrait.and.arrow.right")
                                .font(Tema.corpo())
                                .foregroundStyle(Tema.pericolo)
                        }
                    }
                } footer: {
                    if !conversazione.congelata {
                        Text(Frasi.t("gruppi.esci.nota"))
                    }
                }
                .listRowBackground(Tema.superficie)
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
            .navigationTitle(Frasi.t("gruppi.membri.voce"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(Frasi.t("comune.chiudi")) { chiudi() }
                }
            }
            .refreshable { await carica() }
            .alert(Frasi.t("gruppi.aggiungi.cerca"), isPresented: $aggiungendo) {
                TextField(Frasi.t("messaggi.cerca.segnaposto"), text: $chi)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button(Frasi.t("comune.annulla"), role: .cancel) {}
                Button(Frasi.t("gruppi.aggiungi.conferma")) { Task { await aggiungi() } }
            } message: {
                Text(Frasi.t("gruppi.aggiungi.spiegazione"))
            }
            .confirmationDialog(
                Frasi.t("gruppi.togli.titolo", ["nome": daTogliere.map { nomeDellaPersona($0.persona) } ?? ""]),
                isPresented: Binding(get: { daTogliere != nil }, set: { if !$0 { daTogliere = nil } }),
                titleVisibility: .visible,
                presenting: daTogliere
            ) { m in
                Button(Frasi.t("gruppi.togli.conferma"), role: .destructive) {
                    Task { await togli(m) }
                }
                Button(Frasi.t("comune.annulla"), role: .cancel) {}
            } message: { m in
                Text(Frasi.t("gruppi.togli.testo", ["nome": nomeDellaPersona(m.persona)]))
            }
            .confirmationDialog(Frasi.t("gruppi.esci.titolo"), isPresented: $esco, titleVisibility: .visible) {
                Button(Frasi.t("gruppi.esci.conferma"), role: .destructive) {
                    Task { await esci() }
                }
                Button(Frasi.t("comune.annulla"), role: .cancel) {}
            } message: {
                Text(Frasi.t("gruppi.esci.testo"))
            }
            .task { await carica() }
        }
        .interactiveDismissDisabled(lavoro != nil)
    }

    private func carica() async {
        carico = true
        defer { carico = false }
        do {
            membri = try await casa.sessioniPronte().membri(conversazione: conversazione.id)
        } catch {
            esito = Esito(testo: Frasi.t("comune.non_ha_funzionato"), guasto: true)
        }
    }

    /// Un gesto sul gruppo: il lavoro in corso mentre dura, poi chi c'è di
    /// nuovo, e l'elenco delle conversazioni avvisato.
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
        await cambiata()
        return guasto
    }

    /// Perché una persona non è entrata nel gruppo cifrato.
    private func percheNonEntra(_ errore: Error, nome: String) -> String {
        if let e = errore as? ErroreNucleo {
            switch e {
            case .ChiaveDiUnAltro: return Frasi.t("gruppi.entra.chiave_di_un_altro", ["nome": nome])
            case .GruppoPieno: return Frasi.t("errori.gruppo_pieno")
            default: break
            }
        }
        switch codiceDellaCasa(errore) {
        case "no_device_available": return Frasi.t("gruppi.entra.senza_dispositivo", ["nome": nome])
        case "gruppo_pieno": return Frasi.t("errori.gruppo_pieno")
        default: return Frasi.t("gruppi.entra.errore", ["nome": nome])
        }
    }

    /// Perché la Casa non ha cambiato chi c'è.
    private func percheNo(_ errore: Error, altrimenti: String) -> String {
        switch codiceDellaCasa(errore) {
        case "user_not_found": return Frasi.t("errori.user_not_found")
        case "solo_amministratori": return Frasi.t("errori.solo_amministratori")
        case "gruppo_pieno": return Frasi.t("errori.gruppo_pieno")
        case "casa_che_ordina_non_raggiungibile": return Frasi.t("errori.casa_che_ordina_non_raggiungibile")
        default: return altrimenti
        }
    }

    private func aggiungi() async {
        guard let persona = personaDaInvitare(chi) else { return }
        let nome = persona.username
        let guasto = await gesto(Frasi.t("gruppi.aggiungi.lavoro", ["nome": nome])) { sessioni in
            try await sessioni.aggiungiMembro(conversazione: conversazione.id, chi: persona)
        }
        guard let guasto else {
            esito = Esito(testo: Frasi.t("gruppi.aggiungi.fatto", ["nome": nome]), guasto: false)
            return
        }
        // Due passi: se è fra i membri, è il secondo che non è riuscito, e la
        // si fa entrare dopo dalla sua riga.
        let dentro = membri.contains { $0.persona.username == persona.username }
        esito = Esito(
            testo: dentro
                ? percheNonEntra(guasto, nome: nome)
                : percheNo(guasto, altrimenti: Frasi.t("gruppi.aggiungi.errore")),
            guasto: true
        )
    }

    private func faiEntrare(_ m: MembroDelGruppo) async {
        let nome = nomeDellaPersona(m.persona)
        let guasto = await gesto(Frasi.t("gruppi.entra.lavoro", ["nome": nome])) { sessioni in
            try await sessioni.faiEntrare(conversazione: conversazione.id, membroId: m.persona.id)
        }
        esito = guasto.map { Esito(testo: percheNonEntra($0, nome: nome), guasto: true) }
            ?? Esito(testo: Frasi.t("gruppi.entra.fatto", ["nome": nome]), guasto: false)
    }

    private func togli(_ m: MembroDelGruppo) async {
        let nome = nomeDellaPersona(m.persona)
        let guasto = await gesto(Frasi.t("gruppi.togli.lavoro", ["nome": nome])) { sessioni in
            try await sessioni.togliMembro(conversazione: conversazione.id, membroId: m.persona.id)
        }
        guard let guasto else {
            esito = Esito(testo: Frasi.t("gruppi.togli.fatto", ["nome": nome]), guasto: false)
            return
        }
        // Non è più fra i membri, ma la sua foglia è rimasta: finché c'è, legge.
        let ancora = membri.contains { $0.persona.id == m.persona.id }
        esito = Esito(
            testo: ancora
                ? percheNo(guasto, altrimenti: Frasi.t("gruppi.togli.errore"))
                : Frasi.t("gruppi.togli.a_meta", ["nome": nome]),
            guasto: true
        )
    }

    private func esci() async {
        lavoro = Frasi.t("gruppi.esci.lavoro")
        esito = nil
        do {
            try await casa.sessioniPronte().esci(conversazione: conversazione.id)
            lavoro = nil
            uscita()
        } catch {
            lavoro = nil
            esito = Esito(testo: percheNo(error, altrimenti: Frasi.t("gruppi.esci.errore")), guasto: true)
        }
    }
}

private struct RigaMembro: View {
    let membro: MembroDelGruppo
    let io: Io?

    private var ruolo: String? {
        switch membro.persona.ruolo {
        case "creatore": return Frasi.t("gruppi.ruolo.creatore")
        case "amministratore": return Frasi.t("gruppi.ruolo.amministratore")
        default: return nil
        }
    }

    var body: some View {
        let nome = nomeDellaPersona(membro.persona)
        HStack(spacing: 12) {
            Iniziale(nome: nome, chiave: membro.persona.id)
            VStack(alignment: .leading, spacing: 2) {
                Text(membro.persona.id == io?.id ? Frasi.t("gruppi.membri.tu", ["nome": nome]) : nome)
                    .font(Tema.corpo())
                    .foregroundStyle(Tema.testo)
                    .lineLimit(1)
                if membro.dispositivi == 0 {
                    Text(Frasi.t("gruppi.membri.non_entrato"))
                        .font(Tema.corpo(.footnote))
                        .foregroundStyle(Tema.pericolo)
                } else {
                    Text("@\(membro.persona.username)")
                        .font(Tema.corpo(.footnote))
                        .foregroundStyle(Tema.testoTenue)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            if let ruolo {
                Text(ruolo)
                    .font(Tema.corpo(.caption, peso: .semibold))
                    .foregroundStyle(Tema.testoAccento)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Tema.superficie2, in: Capsule())
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}
