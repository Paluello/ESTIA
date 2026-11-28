// La prima schermata: collegare il telefono alla propria Casa con il codice
// monouso del QR (ADR 0044, docs/ACCESSO_DEL_DISPOSITIVO.md). Il QR si
// inquadra dall'app (`FoglioScanner`) o con la fotocamera di sistema, che apre
// `estia://ingresso`; in alternativa il collegamento si incolla qui.

import SwiftUI

struct SchermataIngresso: View {
    @EnvironmentObject private var casa: Casa
    @State private var collegamento = ""
    @State private var inCorso = false
    @State private var errore: String?
    @State private var username = ""
    @State private var password = ""
    @State private var nome = ""
    @State private var messaggio = ""
    @State private var scanner = false

    /// Un QR d'invito: chi non è ancora membro chiede di entrare.
    private var conInvito: Bool {
        collegamento.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("estia://invito?")
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Image(systemName: "house.fill")
                    .font(.system(size: 34))
                    .foregroundStyle(Tema.sopraAccento)
                    .frame(width: 64, height: 64)
                    .background(Tema.accento, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .accessibilityHidden(true)

                Text(Frasi.t(conInvito ? "ingresso_app.invito.titolo" : "ingresso_app.titolo"))
                    .font(Tema.titolo())
                    .foregroundStyle(Tema.testo)

                Text(Frasi.t(conInvito ? "ingresso_app.invito.spiegazione" : "ingresso_app.spiegazione"))
                    .font(Tema.corpo())
                    .foregroundStyle(Tema.testoTenue)

                pulsanteScanner

                VStack(alignment: .leading, spacing: 8) {
                    Text(Frasi.t("ingresso_app.collegamento_incolla"))
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

                if conInvito {
                    campo("ingresso_app.invito.username", testo: $username)
                    VStack(alignment: .leading, spacing: 8) {
                        Text(Frasi.t("ingresso_app.invito.password"))
                            .font(Tema.corpo(.subheadline, peso: .semibold))
                            .foregroundStyle(Tema.testo)
                        SecureField("", text: $password)
                            .textContentType(.newPassword)
                            .padding(12)
                            .background(Tema.superficie, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Tema.bordo))
                    }
                    campo("ingresso_app.invito.nome", testo: $nome)
                    campo("ingresso_app.invito.messaggio", testo: $messaggio)
                }

                if let errore {
                    Text(errore)
                        .font(Tema.corpo(.callout))
                        .foregroundStyle(Tema.pericolo)
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Tema.sfondoPericolo, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }

                if !vuoto { pulsante }
            }
            .padding(24)
            .frame(maxWidth: 560)
            .frame(maxWidth: .infinity)
        }
        .background(Tema.sfondo)
        .onChange(of: casa.collegamentoArrivato, initial: true) { _, arrivato in
            guard let arrivato else { return }
            casa.collegamentoArrivato = nil
            arriva(arrivato)
        }
        .sheet(isPresented: $scanner) {
            FoglioScanner { arriva($0) }
        }
    }

    private var vuoto: Bool { collegamento.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// Un collegamento letto dal QR, dall'app o dalla Fotocamera di sistema.
    private func arriva(_ testo: String) {
        collegamento = testo
        errore = nil
        // Un QR d'invito aspetta il modulo; quello d'ingresso entra subito.
        if !conInvito { Task { await collega() } }
    }

    /// Il gesto che chi arriva si aspetta: inquadrare. Pieno finché non c'è un
    /// collegamento, poi diventa secondario, per inquadrarne un altro.
    @ViewBuilder private var pulsanteScanner: some View {
        let etichetta = Label(
            Frasi.t(vuoto ? "ingresso_app.scanner.apri" : "ingresso_app.scanner.ancora"),
            systemImage: "qrcode.viewfinder"
        )
            .font(Tema.corpo(.headline, peso: .semibold))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
        if vuoto {
            Button { scanner = true } label: { etichetta }
                .buttonStyle(.borderedProminent)
                .tint(Tema.accento)
                .foregroundStyle(Tema.sopraAccento)
                .disabled(inCorso)
        } else {
            Button { scanner = true } label: { etichetta }
                .buttonStyle(.bordered)
                .tint(Tema.accento)
                .disabled(inCorso)
        }
    }

    private func campo(_ chiave: String, testo: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(Frasi.t(chiave))
                .font(Tema.corpo(.subheadline, peso: .semibold))
                .foregroundStyle(Tema.testo)
            TextField("", text: testo)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(12)
                .background(Tema.superficie, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Tema.bordo))
        }
    }

    @ViewBuilder private var pulsante: some View {
        let etichetta = Text(
            conInvito
                ? Frasi.t(inCorso ? "ingresso_app.invito.invio" : "ingresso_app.invito.chiedi")
                : Frasi.t(inCorso ? "ingresso_app.collego" : "ingresso_app.collega")
        )
            .font(Tema.corpo(.headline, peso: .semibold))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
        let azione = { Task { await collega() } }
        let spento = inCorso || collegamento.trimmingCharacters(in: .whitespaces).isEmpty
            || (conInvito && (username.isEmpty || password.count < 12))
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
        if conInvito {
            do {
                try await casa.chiediDiEntrare(
                    collegamento, username: username, password: password, nome: nome, messaggio: messaggio
                )
            } catch ErroreNucleo.InvitoNonAccettato, ErroreNucleo.Formato {
                errore = Frasi.t("ingresso_app.invito.non_accettato")
            } catch let ErroreNucleo.Casa(message) {
                // Il nucleo passa `casa <stato>: <codice>`, e il codice ha la sua frase.
                switch message.components(separatedBy: ": ").last {
                case "username_taken": errore = Frasi.t("errori.username_taken")
                case "invite_requests_full": errore = Frasi.t("errori.invite_requests_full")
                default: errore = Frasi.t("ingresso_app.invito.non_accettato")
                }
            } catch {
                errore = Frasi.t("ingresso_app.non_raggiungibile")
            }
            return
        }
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

/// Dopo la domanda con invito: l'amministratore deve ancora decidere. L'app
/// riprova da sola; da qui si può controllare subito o smettere di aspettare.
struct SchermataInAttesa: View {
    @EnvironmentObject private var casa: Casa
    @State private var controllo = false

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Image(systemName: "hourglass")
                .font(.system(size: 34))
                .foregroundStyle(Tema.sopraAccento)
                .frame(width: 64, height: 64)
                .background(Tema.accento, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .accessibilityHidden(true)
            Text(Frasi.t("ingresso_app.attesa.titolo"))
                .font(Tema.titolo())
                .foregroundStyle(Tema.testo)
            Text(Frasi.t("ingresso_app.attesa.testo"))
                .font(Tema.corpo())
                .foregroundStyle(Tema.testoTenue)
            Button {
                Task {
                    controllo = true
                    await casa.controllaRichiesta()
                    controllo = false
                }
            } label: {
                Text(Frasi.t("ingresso_app.attesa.controlla"))
                    .font(Tema.corpo(.headline, peso: .semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .tint(Tema.accento)
            .foregroundStyle(Tema.sopraAccento)
            .disabled(controllo)
            Button(Frasi.t("ingresso_app.attesa.annulla")) { casa.smettiDiAspettare() }
                .font(Tema.corpo(.callout))
                .foregroundStyle(Tema.testoTenue)
                .frame(maxWidth: .infinity)
        }
        .padding(24)
        .frame(maxWidth: 560)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Tema.sfondo)
    }
}
