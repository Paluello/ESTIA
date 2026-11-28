// Le frasi dell'app vengono dalla stessa tabella del web, `packages/lingue`
// (ADR 0046, ADR 0051 §5): `scripts/prepara.sh` copia i JSON nel bundle, e qui
// si leggono con le stesse regole di `packages/lingue/src/index.ts`. Una
// chiave senza frase nella lingua scelta cade sull'inglese, mai sulla chiave.

import Foundation

enum Frasi {
    static let disponibili = ["it", "en"]
    static let riferimento = "en"

    /// La prima lingua del telefono che ESTIA conosce, altrimenti l'inglese.
    static let lingua: String = {
        for preferita in Locale.preferredLanguages {
            let codice = String(preferita.prefix(2))
            if disponibili.contains(codice) { return codice }
        }
        return riferimento
    }()

    private static let tabelle: [String: [String: String]] = {
        var tabelle: [String: [String: String]] = [:]
        for codice in disponibili {
            guard let url = Bundle.main.url(forResource: "frasi-\(codice)", withExtension: "json"),
                  let dati = try? Data(contentsOf: url),
                  let tabella = try? JSONDecoder().decode([String: String].self, from: dati)
            else { continue }
            tabelle[codice] = tabella
        }
        return tabelle
    }()

    static func t(_ chiave: String, _ valori: [String: String] = [:]) -> String {
        let frase = tabelle[lingua]?[chiave] ?? tabelle[riferimento]?[chiave] ?? chiave
        guard !valori.isEmpty else { return frase }
        var risultato = frase
        for (nome, valore) in valori {
            risultato = risultato.replacingOccurrences(of: "{\(nome)}", with: valore)
        }
        return risultato
    }
}
