// Dentro la Casa. Le schede sono quelle di sistema: su iOS 26 la barra è
// Liquid Glass da sé, e si riduce scorrendo (ADR 0051 §1).

import SwiftUI

struct Dentro: View {
    var body: some View {
        TabView {
            Tab(Frasi.t("nav.home"), systemImage: "house") {
                Bacheca()
            }
            Tab(Frasi.t("nav.messaggi"), systemImage: "bubble.left.and.bubble.right") {
                Messaggi()
            }
            Tab(Frasi.t("nav.profilo"), systemImage: "person.crop.circle") {
                Profilo()
            }
        }
        .modifier(BarraCheSiRiduce())
    }
}

private struct BarraCheSiRiduce: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content.tabBarMinimizeBehavior(.onScrollDown)
        } else {
            content
        }
    }
}
