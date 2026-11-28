// La prima schermata: collegare il telefono alla propria Casa con il codice
// monouso del QR (ADR 0044, docs/ACCESSO_DEL_DISPOSITIVO.md). Il QR si
// inquadra con la fotocamera di sistema, che apre `estia://ingresso`; in
// alternativa il collegamento si incolla qui.

package org.estia.app.schermate

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.estia.app.Casa
import org.estia.app.Frasi
import org.estia.nucleo.ErroreNucleo

@Composable
fun SchermataIngresso(casa: Casa) {
    var collegamento by rememberSaveable { mutableStateOf("") }
    var inCorso by remember { mutableStateOf(false) }
    var errore by remember { mutableStateOf<String?>(null) }
    val ambito = rememberCoroutineScope()
    val arrivato by casa.collegamentoArrivato.collectAsState()

    fun collega() {
        if (inCorso) return
        inCorso = true
        errore = null
        ambito.launch {
            try {
                casa.entra(collegamento)
            } catch (e: ErroreNucleo.CodiceNonAccettato) {
                // La Casa non dice perché ha rifiutato, e nemmeno l'app lo inventa.
                errore = Frasi.t("ingresso_app.non_accettato")
            } catch (e: ErroreNucleo.Formato) {
                errore = Frasi.t("ingresso_app.non_accettato")
            } catch (e: Exception) {
                errore = Frasi.t("ingresso_app.non_raggiungibile")
            } finally {
                inCorso = false
            }
        }
    }

    LaunchedEffect(arrivato) {
        val testo = arrivato ?: return@LaunchedEffect
        collegamento = testo
        casa.collegamentoArrivato.value = null
        collega()
    }

    Box(
        Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .safeDrawingPadding()
            .imePadding(),
        contentAlignment = Alignment.TopCenter,
    ) {
        Column(
            Modifier
                .widthIn(max = 560.dp)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            Surface(
                color = MaterialTheme.colorScheme.primary,
                contentColor = MaterialTheme.colorScheme.onPrimary,
                shape = RoundedCornerShape(18.dp),
                modifier = Modifier.size(64.dp),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(Icons.Filled.Home, contentDescription = null, modifier = Modifier.size(34.dp))
                }
            }

            Text(
                Frasi.t("ingresso_app.titolo"),
                style = MaterialTheme.typography.headlineMedium,
                color = MaterialTheme.colorScheme.onBackground,
            )
            Text(
                Frasi.t("ingresso_app.spiegazione"),
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            OutlinedTextField(
                value = collegamento,
                onValueChange = { collegamento = it },
                label = { Text(Frasi.t("ingresso_app.collegamento")) },
                placeholder = { Text("estia://ingresso?…") },
                maxLines = 4,
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                    keyboardType = KeyboardType.Uri,
                    imeAction = ImeAction.Go,
                ),
                modifier = Modifier.fillMaxWidth(),
            )

            errore?.let {
                Surface(
                    color = MaterialTheme.colorScheme.errorContainer,
                    contentColor = MaterialTheme.colorScheme.onErrorContainer,
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(it, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(12.dp))
                }
            }

            Button(
                onClick = { collega() },
                enabled = !inCorso && collegamento.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    if (inCorso) Frasi.t("ingresso_app.collego") else Frasi.t("ingresso_app.collega"),
                    style = MaterialTheme.typography.labelLarge,
                    modifier = Modifier.padding(vertical = 6.dp),
                )
            }
        }
    }
}
