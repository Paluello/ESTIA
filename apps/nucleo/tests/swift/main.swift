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

// L'archivio: la catena nasce con chi crea, e chi entra la riceve dal mazzo.
// L'interfaccia porta soltanto buste: nessuna chiave passa di qui.
let quando = "2026-11-28T10:00:00.000Z"
controlla(anna.haArchivio(conversazione: "c"), "anna, che ha creato, ha la catena")
controlla(!bruno.haArchivio(conversazione: "c"), "bruno non ha ancora aperto il mazzo")
controlla(try bruno.mazzoAvvolto(conversazione: "c") == nil, "chi non conosce il mazzo non lo riavvolge")
let mazzo = try anna.mazzoAvvolto(conversazione: "c")!
controlla(try bruno.apriMazzo(conversazione: "c", avvolto: mazzo), "bruno apre il mazzo di anna")

let voce = try anna.archivia(conversazione: "c", testo: "dall'archivio", id: "m-1", creatoIl: quando)
controlla(voce.chiaveN == 1, "la prima chiave della catena")
let riletta = bruno.rileggi(
    conversazione: "c", voce: voce,
    dichiarato: Dichiarato(id: "m-1", mittente: "anna@casa", creatoIl: quando))
controlla(riletta?.testo == "dall'archivio" && riletta?.legata == true, "bruno rilegge la voce di anna")
let falsa = bruno.rileggi(
    conversazione: "c", voce: voce,
    dichiarato: Dichiarato(id: "m-1", mittente: "bruno@casa", creatoIl: quando))
controlla(falsa == nil, "con un altro mittente la voce non si apre")

do {
    let estraneo = try Dispositivo.apri(membro: "carla@casa", deposito: DepositoInMemoria(), registro: registro)
    _ = try anna.aggiungi(conversazione: "c", pacchetto: try estraneo.nuoviPacchetti(quanti: 1)[0])
    controlla(false, "una chiave non registrata non deve entrare")
} catch ErroreNucleo.NonAutenticato {
}

print("legami Swift: ok")
