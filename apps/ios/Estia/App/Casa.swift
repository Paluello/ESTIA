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
        /// Ha chiesto di entrare con un invito, e l'amministratore non ha
        /// ancora deciso: appena dice di sì, questa chiave è dentro.
        case inAttesa
        case dentro
        /// La cassaforte non si apre: le chiavi non avrebbero dove stare.
        case guasto(String)
    }

    @Published private(set) var fase: Fase = .avvio
    @Published private(set) var utente: Utente?
    private var collegamento: Collegamento?
    private var cassaforte: Cassaforte?
    /// Le conversazioni MLS, aperte la prima volta che servono.
    private var sessioni: Sessioni?

    /// Un collegamento `estia://ingresso` arrivato da fuori (il QR inquadrato
    /// dalla fotocamera di sistema), che la schermata d'ingresso usa subito.
    @Published var collegamentoArrivato: String?

    func avvia() async {
        guard collegamento == nil else { return }
        do {
            let cassaforte = try Cassaforte()
            let collegamento = try await Collegamento.apri(deposito: cassaforte)
            self.cassaforte = cassaforte
            self.collegamento = collegamento
            if collegamento.casa() != nil {
                fase = .dentro
                await aggiornaUtente()
            } else if collegamento.inAttesa() != nil {
                fase = .inAttesa
                aspetta()
            } else {
                fase = .ingresso
            }
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

    /// La domanda con il QR d'invito (`estia://invito`), per chi non è ancora
    /// membro. Se la Casa la registra si aspetta l'amministratore.
    func chiediDiEntrare(
        _ testo: String, username: String, password: String, nome: String, messaggio: String
    ) async throws {
        guard let collegamento else { throw ErroreCasa.irraggiungibile }
        _ = try await collegamento.chiediDiEntrare(
            collegamento: testo.trimmingCharacters(in: .whitespacesAndNewlines),
            domanda: DomandaDiEntrare(
                username: username, password: password,
                nome: nome.isEmpty ? nil : nome, messaggio: messaggio.isEmpty ? nil : messaggio
            ),
            etichetta: UIDevice.current.name
        )
        fase = .inAttesa
        aspetta()
    }

    /// Se l'amministratore ha già detto di sì. Non dice mai se ha detto di no:
    /// la Casa non lo dice.
    func controllaRichiesta() async {
        guard let collegamento, fase == .inAttesa else { return }
        guard let ingresso = try? await collegamento.controllaRichiesta() else { return }
        utente = try? JSONDecoder().decode(Utente.self, from: Data(ingresso.utente.utf8))
        fase = .dentro
        await aggiornaUtente()
    }

    func smettiDiAspettare() {
        try? collegamento?.dimenticaRichiesta()
        attesa?.cancel()
        fase = .ingresso
    }

    private var attesa: Task<Void, Never>?

    /// Riprova ogni venti secondi finché la fase resta «in attesa».
    private func aspetta() {
        attesa?.cancel()
        attesa = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(20))
                guard let self, self.fase == .inAttesa else { return }
                await self.controllaRichiesta()
            }
        }
    }

    func esci() async {
        try? await collegamento?.dimenticaCasa()
        sessioni = nil
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

    /// Prepara il dispositivo per le conversazioni (identità MLS, chiave di
    /// firma, KeyPackage) la prima volta, poi restituisce sempre le stesse.
    func sessioniPronte() async throws -> Sessioni {
        if let sessioni { return sessioni }
        guard let collegamento, let cassaforte else { throw ErroreCasa.irraggiungibile }
        let aperte = try await Sessioni.apri(collegamento: collegamento, deposito: cassaforte)
        sessioni = aperte
        return aperte
    }

    private func aggiornaUtente() async {
        if let io = try? await chiedi(Utente.self, "GET", "/api/v1/auth/me") {
            utente = io
        }
    }
}
