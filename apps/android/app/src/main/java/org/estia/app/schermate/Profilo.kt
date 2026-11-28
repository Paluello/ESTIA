package org.estia.app.schermate

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.dp
import org.estia.app.Casa
import org.estia.app.Frasi
import org.estia.nucleo.MioDispositivo
import org.estia.nucleo.StatoDispositivo

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun Profilo(casa: Casa, modifier: Modifier = Modifier) {
    val utente by casa.utente.collectAsState()
    var chiediConferma by remember { mutableStateOf(false) }
    var dispositivi by rememberSaveable { mutableStateOf(false) }
    // Gli altri dispositivi che aspettano un sì, e se questo lo aspetta ancora.
    var richieste by remember { mutableStateOf(0) }
    var inAttesa by remember { mutableStateOf(false) }

    fun conta(elenco: List<MioDispositivo>) {
        richieste = elenco.count { !it.questo && it.stato == StatoDispositivo.IN_ATTESA }
        inAttesa = elenco.any { it.questo && it.stato == StatoDispositivo.IN_ATTESA }
    }

    LaunchedEffect(dispositivi) {
        if (!dispositivi) runCatching { casa.sessioniPronte().dispositivi() }.onSuccess { conta(it) }
    }

    if (dispositivi) {
        BackHandler { dispositivi = false }
        ElencoDispositivi(
            casa,
            onIndietro = { dispositivi = false },
            onCambiato = { conta(it) },
            modifier = modifier,
        )
        return
    }

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
            Surface(
                color = MaterialTheme.colorScheme.surfaceContainer,
                shape = RoundedCornerShape(16.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                ListItem(
                    colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                    leadingContent = {
                        Icon(Icons.Filled.Phone, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                    },
                    headlineContent = { Text(Frasi.t("app_dispositivi.titolo")) },
                    supportingContent = when {
                        inAttesa -> {
                            { Text(Frasi.t("chiavi.in_attesa.titolo"), color = MaterialTheme.colorScheme.primary) }
                        }
                        richieste > 0 -> {
                            {
                                Text(
                                    if (richieste == 1) {
                                        Frasi.t("chat_chiavi.richieste.one")
                                    } else {
                                        Frasi.t("chat_chiavi.richieste.other", mapOf("n" to "$richieste"))
                                    },
                                    color = MaterialTheme.colorScheme.primary,
                                )
                            }
                        }
                        else -> null
                    },
                    trailingContent = {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            if (richieste > 0) {
                                // Il numero lo dice già la riga sotto il titolo.
                                Badge(
                                    containerColor = MaterialTheme.colorScheme.primary,
                                    contentColor = MaterialTheme.colorScheme.onPrimary,
                                    modifier = Modifier.clearAndSetSemantics {},
                                ) { Text("$richieste") }
                            }
                            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null)
                        }
                    },
                    modifier = Modifier.clickable { dispositivi = true },
                )
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
