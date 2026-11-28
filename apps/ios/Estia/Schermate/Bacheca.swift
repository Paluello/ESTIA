// La bacheca della Casa: i post di chi vive qui (`feed=locale`, ADR 0018).

import SwiftUI

struct Bacheca: View {
    @EnvironmentObject private var casa: Casa
    @State private var post: [Post] = []
    @State private var stato: Stato = .carico

    enum Stato: Equatable { case carico, pronto, errore }

    var body: some View {
        NavigationStack {
            Group {
                switch stato {
                case .carico where post.isEmpty:
                    ProgressView(Frasi.t("comune.carico"))
                        .font(Tema.corpo())
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                case .errore where post.isEmpty:
                    Avviso(titolo: Frasi.t("feed.errore_lettura"), testo: Frasi.t("comune.non_ha_funzionato"))
                case _ where post.isEmpty:
                    // Il testo del web rimanda al pulsante «crea», che qui non
                    // c'è ancora: si mostra solo il titolo.
                    Avviso(titolo: Frasi.t("feed.vuoto.istanza.titolo"), testo: "")
                default:
                    List(post) { p in
                        Riga(post: p)
                            .listRowBackground(Tema.superficie)
                            .listRowSeparatorTint(Tema.bordo)
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                }
            }
            .background(Tema.sfondo)
            .navigationTitle(Frasi.t("nav.home"))
            .toolbarTitleDisplayMode(.large)
            .refreshable { await carica() }
            .task { await carica() }
        }
    }

    private func carica() async {
        do {
            let pagina = try await casa.chiedi(PaginaBacheca.self, "GET", "/api/v1/posts?feed=locale")
            post = pagina.posts
            stato = .pronto
        } catch {
            stato = .errore
        }
    }
}

private struct Riga: View {
    let post: Post

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Iniziale(nome: post.author.displayName, chiave: post.author.id)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(post.author.displayName)
                        .font(Tema.corpo(.subheadline, peso: .semibold))
                        .foregroundStyle(Tema.testo)
                    Text("@\(post.author.username)")
                        .font(Tema.corpo(.subheadline))
                        .foregroundStyle(Tema.testoTenue)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if let data = Date.daISO(post.createdAt) {
                        Text(data, format: .relative(presentation: .numeric))
                            .font(Tema.corpo(.footnote))
                            .foregroundStyle(Tema.testoTenue)
                    }
                }
                Text(post.body)
                    .font(Tema.corpo())
                    .foregroundStyle(Tema.testo)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }
}

/// L'iniziale nel cerchio, con uno dei sei colori d'avatar scelto dalla chiave.
struct Iniziale: View {
    let nome: String
    let chiave: String

    private static let colori: [(Color, Color)] = [
        (Color(chiaro: 0xF6E3B4, scuro: 0x3B2E0E), Color(chiaro: 0x6B4700, scuro: 0xEBC56E)),
        (Color(chiaro: 0xD5E6DA, scuro: 0x173326), Color(chiaro: 0x1F4A39, scuro: 0x93CFAB)),
        (Color(chiaro: 0xD7E5EE, scuro: 0x162F3D), Color(chiaro: 0x204A62, scuro: 0x8FC0DE)),
        (Color(chiaro: 0xF3D9CF, scuro: 0x3C1D15), Color(chiaro: 0x7D2F1E, scuro: 0xEBA18D)),
        (Color(chiaro: 0xE4DDF0, scuro: 0x2A2240), Color(chiaro: 0x4A3A75, scuro: 0xC4B5EE)),
        (Color(chiaro: 0xE3E6C8, scuro: 0x2B2F12), Color(chiaro: 0x4A5216, scuro: 0xC9D08A)),
    ]

    var body: some View {
        let indice = chiave.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xFFFF } % Self.colori.count
        let (sfondo, testo) = Self.colori[indice]
        Text(String(nome.prefix(1)).uppercased())
            .font(Tema.titolo(17, relativo: .headline))
            .foregroundStyle(testo)
            .frame(width: 40, height: 40)
            .background(sfondo, in: Circle())
            .accessibilityHidden(true)
    }
}

struct Avviso: View {
    let titolo: String
    let testo: String

    var body: some View {
        VStack(spacing: 8) {
            Text(titolo)
                .font(Tema.titolo(22, relativo: .title2))
                .foregroundStyle(Tema.testo)
            if !testo.isEmpty {
                Text(testo)
                    .font(Tema.corpo())
                    .foregroundStyle(Tema.testoTenue)
            }
        }
        .multilineTextAlignment(.center)
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

extension Date {
    static func daISO(_ testo: String) -> Date? {
        let conMillisecondi = ISO8601DateFormatter()
        conMillisecondi.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return conMillisecondi.date(from: testo) ?? ISO8601DateFormatter().date(from: testo)
    }
}
