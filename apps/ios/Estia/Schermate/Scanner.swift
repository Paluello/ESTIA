// Lo scanner del QR dentro l'app. Prima l'unica strada era la Fotocamera di
// sistema, che apre `estia://…`: funziona, ma chi apre l'app per la prima
// volta cerca un pulsante per inquadrare, non sa che deve uscire dall'app.
//
// VisionKit (DataScannerViewController) legge solo QR, e solo quelli che
// cominciano con `estia://`: un QR qualsiasi inquadrato per sbaglio non
// riempie il modulo con un testo che poi la Casa rifiuterebbe.

import AVFoundation
import SwiftUI
import VisionKit

/// Il foglio con la fotocamera. `trovato` riceve il testo del primo QR ESTIA.
struct FoglioScanner: View {
    let trovato: (String) -> Void
    @Environment(\.dismiss) private var chiudi
    @State private var permesso = AVCaptureDevice.authorizationStatus(for: .video)

    private var disponibile: Bool {
        DataScannerViewController.isSupported && DataScannerViewController.isAvailable
    }

    var body: some View {
        NavigationStack {
            Group {
                if permesso == .denied || permesso == .restricted {
                    avviso(
                        "ingresso_app.scanner.negato",
                        azione: ("ingresso_app.scanner.impostazioni", {
                            if let url = URL(string: UIApplication.openSettingsURLString) {
                                UIApplication.shared.open(url)
                            }
                        })
                    )
                } else if !DataScannerViewController.isSupported {
                    avviso("ingresso_app.scanner.non_supportato", azione: nil)
                } else if permesso == .notDetermined {
                    ProgressView()
                        .task {
                            _ = await AVCaptureDevice.requestAccess(for: .video)
                            permesso = AVCaptureDevice.authorizationStatus(for: .video)
                        }
                } else if disponibile {
                    ZStack(alignment: .bottom) {
                        Scanner { testo in
                            trovato(testo)
                            chiudi()
                        }
                        .ignoresSafeArea()
                        Text(Frasi.t("ingresso_app.scanner.aiuto"))
                            .font(Tema.corpo(.callout))
                            .multilineTextAlignment(.center)
                            .padding(14)
                            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                            .padding(24)
                    }
                } else {
                    avviso("ingresso_app.scanner.non_disponibile", azione: nil)
                }
            }
            .navigationTitle(Frasi.t("ingresso_app.scanner.titolo"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(Frasi.t("ingresso_app.scanner.annulla")) { chiudi() }
                }
            }
        }
    }

    private func avviso(_ chiave: String, azione: (String, () -> Void)?) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "camera.fill")
                .font(.system(size: 34))
                .foregroundStyle(Tema.testoTenue)
                .accessibilityHidden(true)
            Text(Frasi.t(chiave))
                .font(Tema.corpo())
                .foregroundStyle(Tema.testo)
                .multilineTextAlignment(.center)
            if let azione {
                Button(Frasi.t(azione.0), action: azione.1)
                    .buttonStyle(.borderedProminent)
                    .tint(Tema.accento)
                    .foregroundStyle(Tema.sopraAccento)
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Tema.sfondo)
    }
}

/// Il DataScannerViewController di VisionKit, ridotto a «dammi il primo QR ESTIA».
private struct Scanner: UIViewControllerRepresentable {
    let trovato: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let vc = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isHighlightingEnabled: true
        )
        vc.delegate = context.coordinator
        try? vc.startScanning()
        return vc
    }

    func updateUIViewController(_ vc: DataScannerViewController, context: Context) {}

    static func dismantleUIViewController(_ vc: DataScannerViewController, coordinator: Coordinator) {
        vc.stopScanning()
    }

    func makeCoordinator() -> Coordinator { Coordinator(trovato: trovato) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let trovato: (String) -> Void
        private var fatto = false

        init(trovato: @escaping (String) -> Void) { self.trovato = trovato }

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            didAdd addedItems: [RecognizedItem],
            allItems: [RecognizedItem]
        ) {
            guard !fatto else { return }
            for item in addedItems {
                guard case let .barcode(codice) = item, let testo = codice.payloadStringValue,
                    testo.hasPrefix("estia://")
                else { continue }
                fatto = true
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                dataScanner.stopScanning()
                trovato(testo)
                return
            }
        }
    }
}
