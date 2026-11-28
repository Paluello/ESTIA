// Lo stato dell'app: se il telefono è già entrato in una Casa, e il
// collegamento con cui le parla. Tutto il resto lo chiedono le schermate.

import Foundation
import UIKit

struct Utente: Decodable, Equatable {
    let id: String
    let username: String
    let displayName: String
}

struct Autore: Decodable, Equatable {
    let id: String
    let username: String
    let displayName: String
}

struct Post: Decodable, Identifiable, Equatable {
    let id: String
    let author: Autore
    let body: String
    let createdAt: String
    let likeCount: Int
    let commentCount: Int
}

struct PaginaBacheca: Decodable {
    let posts: [Post]
    let nextCursor: String?
}

enum ErroreCasa: Error {
    /// La Casa ha risposto con uno stato che non è 2xx, e il suo codice d'errore.
    case risposta(stato: Int, codice: String?)
    case irraggiungibile
}

@MainActor
final class Casa: ObservableObject {
    enum Fase: Equatable {
        case avvio
        case ingresso
        case dentro
        /// La cassaforte non si apre: le chiavi non avrebbero dove stare.
        case guasto(String)
    }

    @Published private(set) var fase: Fase = .avvio
    @Published private(set) var utente: Utente?
    private var collegamento: Collegamento?

    /// Un collegamento `estia://ingresso` arrivato da fuori (il QR inquadrato
    /// dalla fotocamera di sistema), che la schermata d'ingresso usa subito.
    @Published var collegamentoArrivato: String?

    func avvia() async {
        guard collegamento == nil else { return }
        do {
            let cassaforte = try Cassaforte()
            let collegamento = try await Collegamento.apri(deposito: cassaforte)
            self.collegamento = collegamento
            fase = collegamento.casa() == nil ? .ingresso : .dentro
            if fase == .dentro { await aggiornaUtente() }
        } catch {
            fase = .guasto(String(describing: error))
        }
    }

    func entra(_ testo: String) async throws {
        guard let collegamento else { throw ErroreCasa.irraggiungibile }
        let ingresso = try await collegamento.entra(
            collegamento: testo.trimmingCharacters(in: .whitespacesAndNewlines),
            etichetta: UIDevice.current.name
        )
        utente = try? JSONDecoder().decode(Utente.self, from: Data(ingresso.utente.utf8))
        fase = .dentro
        await aggiornaUtente()
    }

    func esci() async {
        try? await collegamento?.dimenticaCasa()
        utente = nil
        fase = .ingresso
    }

    /// Una richiesta dell'API dei membri, sul filo verso la Casa.
    func chiedi<T: Decodable>(_ tipo: T.Type, _ metodo: String, _ percorso: String) async throws -> T {
        guard let collegamento else { throw ErroreCasa.irraggiungibile }
        let risposta: RispostaCasa
        do {
            risposta = try await collegamento.chiedi(
                metodo: metodo, percorso: percorso,
                intestazioni: ["accept": "application/json"], corpo: Data()
            )
        } catch {
            throw ErroreCasa.irraggiungibile
        }
        guard (200..<300).contains(Int(risposta.stato)) else {
            let codice = (try? JSONSerialization.jsonObject(with: risposta.corpo) as? [String: Any])?["code"] as? String
            throw ErroreCasa.risposta(stato: Int(risposta.stato), codice: codice)
        }
        return try JSONDecoder().decode(T.self, from: risposta.corpo)
    }

    private func aggiornaUtente() async {
        if let io = try? await chiedi(Utente.self, "GET", "/api/v1/auth/me") {
            utente = io
        }
    }
}
