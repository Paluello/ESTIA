// Colori e caratteri dello studio dell'interfaccia («la casa con la luce
// accesa»), dai token di /mnt/project-files/app-interfaccia/tokens-proposti.css:
// stessi nomi di ruolo del web, valori chiari e scuri. Ocra è l'accento.
//
// I componenti di sistema (barre, schede, fogli) restano di sistema: su iOS 26
// sono Liquid Glass da soli. Qui si danno solo i colori e i caratteri.

import SwiftUI
import UIKit

enum Tema {
    static let sfondo = Color(chiaro: 0xFBFAF6, scuro: 0x111715)
    static let superficie = Color(chiaro: 0xFFFFFF, scuro: 0x171F1C)
    static let superficie2 = Color(chiaro: 0xF3F0E8, scuro: 0x202A26)
    static let bordo = Color(chiaro: 0xE4E0D4, scuro: 0x2A3531)
    static let testo = Color(chiaro: 0x1B2420, scuro: 0xEEF0EA)
    static let testoTenue = Color(chiaro: 0x59605B, scuro: 0xA5AFA9)
    static let accento = Color(chiaro: 0xEDB03A, scuro: 0xF0B84A)
    static let testoAccento = Color(chiaro: 0x7A5200, scuro: 0xF0B84A)
    static let sopraAccento = Color(chiaro: 0x221803, scuro: 0x1F1603)
    static let pericolo = Color(chiaro: 0xA6322A, scuro: 0xEE8A7F)
    static let sfondoPericolo = Color(chiaro: 0xFBEAE7, scuro: 0x2A1512)

    /// Besley solo per i titoli, a 17 punti o più e peso 600.
    static func titolo(_ dimensione: CGFloat = 28, relativo: Font.TextStyle = .largeTitle) -> Font {
        .custom("Besley", size: dimensione, relativeTo: relativo).weight(.semibold)
    }

    /// Atkinson Hyperlegible Next per tutto ciò che si legge.
    static func corpo(_ stile: Font.TextStyle = .body, peso: Font.Weight = .regular) -> Font {
        .custom("Atkinson Hyperlegible Next", size: dimensione(stile), relativeTo: stile).weight(peso)
    }

    private static func dimensione(_ stile: Font.TextStyle) -> CGFloat {
        switch stile {
        case .largeTitle: 34
        case .title: 28
        case .title2: 22
        case .title3: 20
        case .headline, .body: 17
        case .callout: 16
        case .subheadline: 15
        case .footnote: 13
        case .caption: 12
        case .caption2: 11
        @unknown default: 17
        }
    }
}

extension Color {
    init(chiaro: UInt32, scuro: UInt32) {
        self.init(uiColor: UIColor { tratti in
            UIColor(esadecimale: tratti.userInterfaceStyle == .dark ? scuro : chiaro)
        })
    }
}

extension UIColor {
    convenience init(esadecimale: UInt32) {
        self.init(
            red: CGFloat((esadecimale >> 16) & 0xFF) / 255,
            green: CGFloat((esadecimale >> 8) & 0xFF) / 255,
            blue: CGFloat(esadecimale & 0xFF) / 255,
            alpha: 1
        )
    }
}
