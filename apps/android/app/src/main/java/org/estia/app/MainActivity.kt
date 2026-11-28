package org.estia.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import org.estia.app.aspetto.EstiaTema
import org.estia.app.schermate.Dentro
import org.estia.app.schermate.SchermataInAttesa
import org.estia.app.schermate.SchermataIngresso

class MainActivity : ComponentActivity() {
    private val casa: Casa by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Frasi.carica(this)
        enableEdgeToEdge()
        ricevi(intent)
        setContent {
            EstiaTema { Radice(casa) }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        ricevi(intent)
    }

    /** Il QR inquadrato con la fotocamera apre `estia://ingresso?...`. */
    private fun ricevi(intent: Intent?) {
        val dati = intent?.data ?: return
        if (dati.scheme == "estia" && (dati.host == "ingresso" || dati.host == "invito")) {
            casa.collegamentoArrivato.value = dati.toString()
        }
    }
}

@Composable
private fun Radice(casa: Casa) {
    val fase by casa.fase.collectAsState()
    when (val attuale = fase) {
        Fase.Avvio -> Box(
            Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background),
            contentAlignment = Alignment.Center,
        ) { CircularProgressIndicator() }
        Fase.Ingresso -> SchermataIngresso(casa)
        Fase.InAttesa -> SchermataInAttesa(casa)
        Fase.Dentro -> Dentro(casa)
        is Fase.Guasto -> Box(
            Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).padding(24.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                Frasi.t("ingresso_app.cassaforte", mapOf("motivo" to attuale.motivo)),
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.error,
            )
        }
    }
}
