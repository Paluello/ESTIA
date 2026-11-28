import SwiftUI

struct Profilo: View {
    @EnvironmentObject private var casa: Casa
    @State private var chiediConferma = false

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
            .confirmationDialog(Frasi.t("dispositivi.esci_da_questo"), isPresented: $chiediConferma, titleVisibility: .visible) {
                Button(Frasi.t("menu.esci"), role: .destructive) {
                    Task { await casa.esci() }
                }
                Button(Frasi.t("comune.annulla"), role: .cancel) {}
            }
        }
    }
}
