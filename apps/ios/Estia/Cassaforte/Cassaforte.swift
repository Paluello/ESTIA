// La cassaforte del telefono (ADR 0044 §2, S6), il `Deposito` del nucleo.
//
// Una chiave sola, 32 byte, nel Keychain, che non lascia mai questo telefono
// (`ThisDeviceOnly`: niente iCloud, niente backup). I file del nucleo stanno in
// Application Support, sigillati con ChaCha20-Poly1305 e il loro nome come dato
// autenticato, ed esclusi dal backup: su un telefono nuovo non si aprirebbero.
//
// Il Keychain sopravvive alla disinstallazione, UserDefaults no. Senza il segno
// d'installazione si riparte da zero: reinstallare fa un dispositivo nuovo, che
// entra solo con l'approvazione di uno già posseduto (ADR 0044, verifica 4).

import CryptoKit
import Foundation
import Security

final class Cassaforte: Deposito, @unchecked Sendable {
    private static let servizio = "org.estia.app"
    private static let conto = "cassaforte"
    private static let segno = "org.estia.app.installazione"

    private let cartella: URL
    private let chiave: SymmetricKey
    private let serratura = NSLock()

    init() throws {
        let fm = FileManager.default
        cartella = try fm.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true
        ).appendingPathComponent("cassaforte", isDirectory: true)

        if !UserDefaults.standard.bool(forKey: Self.segno) {
            Self.cancellaChiave()
            try? fm.removeItem(at: cartella)
        }
        try fm.createDirectory(at: cartella, withIntermediateDirectories: true)
        var valori = URLResourceValues()
        valori.isExcludedFromBackup = true
        var url = cartella
        try url.setResourceValues(valori)

        chiave = try Self.chiaveDelKeychain()
        UserDefaults.standard.set(true, forKey: Self.segno)
    }

    // MARK: Deposito

    func leggi(nome: String) throws -> Data? {
        serratura.lock()
        defer { serratura.unlock() }
        let url = file(nome)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        do {
            let scatola = try ChaChaPoly.SealedBox(combined: Data(contentsOf: url))
            return try ChaChaPoly.open(scatola, using: chiave, authenticating: Data(nome.utf8))
        } catch {
            throw ErroreNucleo.Deposito(message: "\(nome): \(error.localizedDescription)")
        }
    }

    func scrivi(nome: String, dati: Data) throws {
        serratura.lock()
        defer { serratura.unlock() }
        do {
            let scatola = try ChaChaPoly.seal(dati, using: chiave, authenticating: Data(nome.utf8))
            try scatola.combined.write(to: file(nome), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            throw ErroreNucleo.Deposito(message: "\(nome): \(error.localizedDescription)")
        }
    }

    // MARK: -

    /// Il nome del nucleo contiene «/»: sul disco diventa esadecimale.
    private func file(_ nome: String) -> URL {
        let esadecimale = Data(nome.utf8).map { String(format: "%02x", $0) }.joined()
        return cartella.appendingPathComponent(esadecimale)
    }

    private static var domanda: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: servizio,
            kSecAttrAccount as String: conto,
        ]
    }

    private static func cancellaChiave() {
        SecItemDelete(domanda as CFDictionary)
    }

    private static func chiaveDelKeychain() throws -> SymmetricKey {
        var cerca = domanda
        cerca[kSecReturnData as String] = true
        var trovato: CFTypeRef?
        let stato = SecItemCopyMatching(cerca as CFDictionary, &trovato)
        if stato == errSecSuccess, let dati = trovato as? Data, dati.count == 32 {
            return SymmetricKey(data: dati)
        }

        let nuova = SymmetricKey(size: .bits256)
        var aggiungi = domanda
        aggiungi[kSecValueData as String] = nuova.withUnsafeBytes { Data($0) }
        aggiungi[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemDelete(domanda as CFDictionary)
        let esito = SecItemAdd(aggiungi as CFDictionary, nil)
        guard esito == errSecSuccess else {
            throw ErroreNucleo.Deposito(message: "Keychain: \(esito)")
        }
        return nuova
    }
}
