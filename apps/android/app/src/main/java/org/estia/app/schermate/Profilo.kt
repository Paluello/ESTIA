package org.estia.app.schermate

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import org.estia.app.Casa
import org.estia.app.Frasi

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun Profilo(casa: Casa, modifier: Modifier = Modifier) {
    val utente by casa.utente.collectAsState()
    var chiediConferma by remember { mutableStateOf(false) }

    Scaffold(
        modifier = modifier,
        topBar = { TopAppBar(title = { Text(Frasi.t("nav.profilo")) }) },
    ) { margini ->
        Column(
            Modifier
                .padding(margini)
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(24.dp),
        ) {
            utente?.let { io ->
                Row(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
                    Iniziale(io.displayName, io.id)
                    Column {
                        Text(io.displayName, style = MaterialTheme.typography.headlineSmall)
                        Text(
                            "@${io.username}",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            OutlinedButton(
                onClick = { chiediConferma = true },
                colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(Frasi.t("dispositivi.esci_da_questo"))
            }
        }
    }

    if (chiediConferma) {
        AlertDialog(
            onDismissRequest = { chiediConferma = false },
            title = { Text(Frasi.t("dispositivi.esci_da_questo")) },
            confirmButton = {
                TextButton(
                    onClick = {
                        chiediConferma = false
                        casa.esci()
                    },
                    colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error),
                ) { Text(Frasi.t("menu.esci")) }
            },
            dismissButton = {
                TextButton(onClick = { chiediConferma = false }) { Text(Frasi.t("comune.annulla")) }
            },
        )
    }
}
