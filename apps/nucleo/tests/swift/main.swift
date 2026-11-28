// I legami Swift del nucleo, provati davvero: due dispositivi in Swift si
// parlano attraverso il nucleo. Gira su macOS in CI (`.github/workflows/nucleo.yml`).

import Foundation

final class DepositoInMemoria: Deposito, @unchecked Sendable {
    private var dati: [String: Data] = [:]
    func leggi(nome: String) throws -> Data? { dati[nome] }
    func scrivi(nome: String, dati nuovi: Data) throws { dati[nome] = nuovi }
}

final class RegistroInMemoria: Registro, @unchecked Sendable {
    var chiavi: [String: [Data]] = [:]
    func chiaviDiFirma(membro: String) throws -> [Data] { chiavi[membro] ?? [] }
}

func controlla(_ condizione: Bool, _ cosa: String) {
    if !condizione {
        print("FALLITO: \(cosa)")
        exit(1)
    }
}

let registro = RegistroInMemoria()
let anna = try Dispositivo.apri(membro: "anna@casa", deposito: DepositoInMemoria(), registro: registro)
let bruno = try Dispositivo.apri(membro: "bruno@casa", deposito: DepositoInMemoria(), registro: registro)
registro.chiavi["anna@casa"] = [anna.chiaveDiFirma()]
registro.chiavi["bruno@casa"] = [bruno.chiaveDiFirma()]

try anna.creaConversazione(conversazione: "c")
let esito = try anna.aggiungi(conversazione: "c", pacchetto: try bruno.nuoviPacchetti(quanti: 1)[0])
controlla(try bruno.entra(welcome: esito.welcome) == "c", "bruno entra")

let busta = try anna.cifra(conversazione: "c", testo: "ciao da Swift")
switch try bruno.applica(conversazione: "c", busta: busta) {
case let .messaggio(testo, da):
    controlla(testo == "ciao da Swift" && da == "anna@casa", "bruno legge anna")
default:
    controlla(false, "atteso un messaggio")
}

do {
    let estraneo = try Dispositivo.apri(membro: "carla@casa", deposito: DepositoInMemoria(), registro: registro)
    _ = try anna.aggiungi(conversazione: "c", pacchetto: try estraneo.nuoviPacchetti(quanti: 1)[0])
    controlla(false, "una chiave non registrata non deve entrare")
} catch ErroreNucleo.NonAutenticato {
}

print("legami Swift: ok")
