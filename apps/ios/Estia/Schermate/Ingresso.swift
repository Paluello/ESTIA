// La prima schermata: collegare il telefono alla propria Casa con il codice
// monouso del QR (ADR 0044, docs/ACCESSO_DEL_DISPOSITIVO.md). Il QR si
// inquadra con la fotocamera di sistema, che apre `estia://ingresso`; in
// alternativa il collegamento si incolla qui.

import SwiftUI

struct SchermataIngresso: View {
    @EnvironmentObject private var casa: Casa
    @State private var collegamento = ""
    @State private var inCorso = false
    @State private var errore: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Image(systemName: "house.fill")
                    .font(.system(size: 34))
                    .foregroundStyle(Tema.sopraAccento)
                    .frame(width: 64, height: 64)
                    .background(Tema.accento, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .accessibilityHidden(true)

                Text(Frasi.t("ingresso_app.titolo"))
                    .font(Tema.titolo())
                    .foregroundStyle(Tema.testo)

                Text(Frasi.t("ingresso_app.spiegazione"))
                    .font(Tema.corpo())
                    .foregroundStyle(Tema.testoTenue)

                VStack(alignment: .leading, spacing: 8) {
                    Text(Frasi.t("ingresso_app.collegamento"))
                        .font(Tema.corpo(.subheadline, peso: .semibold))
                        .foregroundStyle(Tema.testo)
                    TextField("estia://ingresso?…", text: $collegamento, axis: .vertical)
                        .font(Tema.corpo(.callout))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .lineLimit(1...4)
                        .padding(12)
                        .background(Tema.superficie, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Tema.bordo))
                }

                if let errore {
                    Text(errore)
                        .font(Tema.corpo(.callout))
                        .foregroundStyle(Tema.pericolo)
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Tema.sfondoPericolo, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }

                pulsante
            }
            .padding(24)
            .frame(maxWidth: 560)
            .frame(maxWidth: .infinity)
        }
        .background(Tema.sfondo)
        .onChange(of: casa.collegamentoArrivato, initial: true) { _, arrivato in
            guard let arrivato else { return }
            collegamento = arrivato
            casa.collegamentoArrivato = nil
            Task { await collega() }
        }
    }

    @ViewBuilder private var pulsante: some View {
        let etichetta = Text(inCorso ? Frasi.t("ingresso_app.collego") : Frasi.t("ingresso_app.collega"))
            .font(Tema.corpo(.headline, peso: .semibold))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
        let azione = { Task { await collega() } }
        let spento = inCorso || collegamento.trimmingCharacters(in: .whitespaces).isEmpty
        if #available(iOS 26, *) {
            Button(action: { _ = azione() }) { etichetta }
                .buttonStyle(.glassProminent)
                .tint(Tema.accento)
                .foregroundStyle(Tema.sopraAccento)
                .disabled(spento)
        } else {
            Button(action: { _ = azione() }) { etichetta }
                .buttonStyle(.borderedProminent)
                .tint(Tema.accento)
                .foregroundStyle(Tema.sopraAccento)
                .disabled(spento)
        }
    }

    private func collega() async {
        guard !inCorso else { return }
        inCorso = true
        errore = nil
        defer { inCorso = false }
        do {
            try await casa.entra(collegamento)
        } catch ErroreNucleo.CodiceNonAccettato, ErroreNucleo.Formato {
            // La Casa non dice perché ha rifiutato, e nemmeno l'app lo inventa.
            errore = Frasi.t("ingresso_app.non_accettato")
        } catch {
            errore = Frasi.t("ingresso_app.non_raggiungibile")
        }
    }
}
