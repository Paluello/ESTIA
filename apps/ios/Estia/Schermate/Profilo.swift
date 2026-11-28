import SwiftUI

struct Profilo: View {
    @EnvironmentObject private var casa: Casa
    @State private var chiediConferma = false
    /// Gli altri dispositivi che aspettano un sì.
    @State private var richieste = 0
    /// Questo dispositivo aspetta ancora il sì.
    @State private var inAttesa = false

    var body: some View {
        NavigationStack {
            List {
                if let utente = casa.utente {
                    HStack(spacing: 14) {
                        Iniziale(nome: utente.displayName, chiave: utente.id)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(utente.displayName)
                                .font(Tema.titolo(22, relativo: .title2))
                                .foregroundStyle(Tema.testo)
                            Text("@\(utente.username)")
                                .font(Tema.corpo(.subheadline))
                                .foregroundStyle(Tema.testoTenue)
                        }
                    }
                    .padding(.vertical, 6)
                    .listRowBackground(Tema.superficie)
                }
                Section {
                    NavigationLink {
                        ElencoDispositivi(cambiato: { conta($0) })
                    } label: {
                        HStack(spacing: 12) {
                            Label {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(Frasi.t("app_dispositivi.titolo"))
                                        .font(Tema.corpo())
                                        .foregroundStyle(Tema.testo)
                                    if inAttesa {
                                        Text(Frasi.t("chiavi.in_attesa.titolo"))
                                            .font(Tema.corpo(.footnote))
                                            .foregroundStyle(Tema.testoAccento)
                                    } else if richieste > 0 {
                                        Text(richieste == 1
                                            ? Frasi.t("chat_chiavi.richieste.one")
                                            : Frasi.t("chat_chiavi.richieste.other", ["n": "\(richieste)"]))
                                            .font(Tema.corpo(.footnote))
                                            .foregroundStyle(Tema.testoAccento)
                                    }
                                }
                            } icon: {
                                Image(systemName: "laptopcomputer.and.iphone")
                                    .foregroundStyle(Tema.testoAccento)
                            }
                            Spacer(minLength: 0)
                            if richieste > 0 {
                                Text("\(richieste)")
                                    .font(Tema.corpo(.caption, peso: .semibold))
                                    .foregroundStyle(Tema.sopraAccento)
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 3)
                                    .background(Tema.accento, in: Capsule())
                                    .accessibilityHidden(true)
                            }
                        }
                    }
                    .listRowBackground(Tema.superficie)
                }
                Section {
                    Button(Frasi.t("dispositivi.esci_da_questo"), role: .destructive) {
                        chiediConferma = true
                    }
                    .font(Tema.corpo())
                    .listRowBackground(Tema.superficie)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Tema.sfondo)
            .navigationTitle(Frasi.t("nav.profilo"))
            .refreshable { await leggiDispositivi() }
            .task { await leggiDispositivi() }
            .confirmationDialog(Frasi.t("dispositivi.esci_da_questo"), isPresented: $chiediConferma, titleVisibility: .visible) {
                Button(Frasi.t("menu.esci"), role: .destructive) {
                    Task { await casa.esci() }
                }
                Button(Frasi.t("comune.annulla"), role: .cancel) {}
            }
        }
    }

    private func leggiDispositivi() async {
        guard let elenco = try? await casa.sessioniPronte().dispositivi() else { return }
        conta(elenco)
    }

    private func conta(_ elenco: [MioDispositivo]) {
        richieste = elenco.filter { !$0.questo && $0.stato == .inAttesa }.count
        inAttesa = elenco.contains { $0.questo && $0.stato == .inAttesa }
    }
}
