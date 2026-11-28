import SwiftUI

@main
struct EstiaApp: App {
    @StateObject private var casa = Casa()

    var body: some Scene {
        WindowGroup {
            Radice()
                .environmentObject(casa)
                .tint(Tema.testoAccento)
                .task { await casa.avvia() }
                // Il QR inquadrato con la fotocamera apre `estia://ingresso?...`.
                .onOpenURL { url in
                    if url.scheme == "estia", url.host == "ingresso" || url.host == "invito" {
                        casa.collegamentoArrivato = url.absoluteString
                    }
                }
        }
    }
}

struct Radice: View {
    @EnvironmentObject private var casa: Casa

    var body: some View {
        switch casa.fase {
        case .avvio:
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Tema.sfondo)
        case .ingresso:
            SchermataIngresso()
        case .inAttesa:
            SchermataInAttesa()
        case .dentro:
            Dentro()
        case let .guasto(motivo):
            Guasto(motivo: motivo)
        }
    }
}

struct Guasto: View {
    let motivo: String

    var body: some View {
        Text(Frasi.t("ingresso_app.cassaforte", ["motivo": motivo]))
            .font(Tema.corpo())
            .foregroundStyle(Tema.pericolo)
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Tema.sfondo)
    }
}
