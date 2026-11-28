// I propri dispositivi (ADR 0040), sopra le `Sessioni` del nucleo: chi ha il
// sì, chi lo aspetta, chi è stato revocato. Le regole sono quelle del web
// (`screens/impostazioni/Chat.tsx`): il codice da confrontare lo calcola il
// nucleo dalla chiave pubblica, mai la Casa; dire di sì o revocare si può
// soltanto da un dispositivo che ha già il sì; e la revoca si conferma.
//
// Dopo un sì o una revoca il nucleo rimette d'accordo le foglie in ogni
// conversazione: qui si mostra il lavoro in corso, e poi com'è andata.

package org.estia.app.schermate

import android.text.format.DateUtils
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.estia.app.Casa
import org.estia.app.Frasi
import org.estia.nucleo.Io
import org.estia.nucleo.MioDispositivo
import org.estia.nucleo.Sessioni
import org.estia.nucleo.StatoDispositivo

/** Il nome di un dispositivo com'è da mostrare. */
internal fun nomeDelDispositivo(d: MioDispositivo): String =
    d.etichetta?.takeIf { it.isNotBlank() } ?: Frasi.t("dispositivi.dispositivo")

/** «5 minuti fa». */
private fun daQuantoTempo(iso: String?): String? {
    if (iso == null) return null
    return runCatching {
        DateUtils.getRelativeTimeSpanString(
            Instant.parse(iso).toEpochMilli(),
            System.currentTimeMillis(),
            DateUtils.MINUTE_IN_MILLIS,
        ).toString()
    }.getOrNull()
}

/** «28 nov 2026, 10:00», nella lingua dell'app. */
private fun dataMedia(iso: String): String = runCatching {
    val formato = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT)
        .withLocale(Locale.forLanguageTag(Frasi.lingua))
    Instant.parse(iso).atZone(ZoneId.systemDefault()).format(formato)
}.getOrDefault(iso)

/** Com'è andato l'ultimo gesto sui dispositivi, da dire in cima. */
private data class EsitoDispositivi(val testo: String, val guasto: Boolean)

/** Le otto cifre da confrontare, grandi e lette a voce una per una. */
@Composable
internal fun CodiceDaConfrontare(codice: String, modifier: Modifier = Modifier) {
    val aVoce = codice.filter { it.isDigit() }.toList().joinToString(" ")
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHighest,
        shape = RoundedCornerShape(14.dp),
        modifier = modifier.fillMaxWidth(),
    ) {
        Text(
            codice,
            style = MaterialTheme.typography.headlineSmall,
            fontFamily = FontFamily.Monospace,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = 2.sp,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .padding(vertical = 12.dp)
                .clearAndSetSemantics { contentDescription = aVoce },
        )
    }
}

/**
 * Questo dispositivo aspetta il sì: che cosa vuol dire, il suo codice, e
 * dove andare a dirlo. È anche ciò che mostrano i messaggi finché aspetta.
 * Con `onRicontrolla` c'è un pulsante per ricontrollare subito.
 */
@Composable
internal fun AttesaDelSi(codice: String, onRicontrolla: (suspend () -> Unit)?, modifier: Modifier = Modifier) {
    var controllo by remember { mutableStateOf(false) }
    val ambito = rememberCoroutineScope()

    Column(modifier, verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.Info, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
            Text(Frasi.t("chiavi.in_attesa.titolo"), style = MaterialTheme.typography.titleLarge)
        }
        Text(
            Frasi.t("chiavi.in_attesa.testo"),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                Frasi.t("chat_chiavi.il_mio_codice"),
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            CodiceDaConfrontare(codice)
        }
        Text(Frasi.t("app_dispositivi.in_attesa.cosa_fare"), style = MaterialTheme.typography.bodyMedium)
        if (onRicontrolla != null) {
            OutlinedButton(
                onClick = {
                    controllo = true
                    ambito.launch {
                        try {
                            onRicontrolla()
                        } finally {
                            controllo = false
                        }
                    }
                },
                enabled = !controllo,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (controllo) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    Box(Modifier.size(8.dp))
                }
                Text(Frasi.t("app_dispositivi.ricontrolla"))
            }
        }
    }
}

/** I dispositivi di questa persona, dal Profilo. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ElencoDispositivi(
    casa: Casa,
    onIndietro: () -> Unit,
    onCambiato: (List<MioDispositivo>) -> Unit,
    modifier: Modifier = Modifier,
) {
    var dispositivi by remember { mutableStateOf<List<MioDispositivo>>(emptyList()) }
    var io by remember { mutableStateOf<Io?>(null) }
    var carico by remember { mutableStateOf(true) }
    var guastoElenco by remember { mutableStateOf(false) }
    var aggiorno by remember { mutableStateOf(false) }
    var lavoro by remember { mutableStateOf<String?>(null) }
    var esito by remember { mutableStateOf<EsitoDispositivi?>(null) }
    var daRevocare by remember { mutableStateOf<MioDispositivo?>(null) }
    val ambito = rememberCoroutineScope()

    val questo = dispositivi.firstOrNull { it.questo }
    val richieste = dispositivi.filter { !it.questo && it.stato == StatoDispositivo.IN_ATTESA }
    val approvati = dispositivi.filter { !it.questo && it.stato == StatoDispositivo.APPROVATO }
    val revocati = dispositivi.filter { !it.questo && it.stato == StatoDispositivo.REVOCATO }
    // Il sì e il no li dice soltanto un dispositivo che ha già il sì.
    val decide = io?.approvato == true
    val occupato = lavoro != null

    suspend fun carica() {
        if (lavoro != null) return
        carico = true
        try {
            val sessioni = casa.sessioniPronte()
            val elenco = sessioni.dispositivi()
            dispositivi = elenco
            // Dopo l'elenco: è lui che aggiorna `approvato` di questo dispositivo.
            io = sessioni.io()
            guastoElenco = false
            onCambiato(elenco)
        } catch (e: Exception) {
            guastoElenco = true
        } finally {
            carico = false
        }
    }

    // Finché la schermata è aperta si rilegge ogni quindici secondi: chi
    // aspetta vede arrivare il sì, chi decide vede arrivare una richiesta.
    LaunchedEffect(Unit) {
        while (isActive) {
            carica()
            delay(15_000)
        }
    }

    fun percheNo(e: Throwable, altrimenti: String): String =
        if (codiceDellaCasa(e) == "device_not_approved") Frasi.t("app_dispositivi.solo_approvati") else altrimenti

    /** Un gesto: il lavoro in corso mentre dura, poi l'elenco di nuovo, e `dopo` con il guasto se c'è stato. */
    fun gesto(inCorso: String, fai: suspend (Sessioni) -> Unit, dopo: (Throwable?) -> Unit) {
        lavoro = inCorso
        esito = null
        ambito.launch {
            val guasto = try {
                fai(casa.sessioniPronte())
                null
            } catch (e: Exception) {
                e
            }
            lavoro = null
            carica()
            dopo(guasto)
        }
    }

    fun approva(d: MioDispositivo) {
        gesto(Frasi.t("app_dispositivi.lavoro.approvo"), { it.approvaDispositivo(d.id) }) { guasto ->
            esito = if (guasto == null) {
                EsitoDispositivi(Frasi.t("chat_chiavi.autorizzato"), false)
            } else {
                EsitoDispositivi(percheNo(guasto, Frasi.t("chat_chiavi.risposta_fallita")), true)
            }
        }
    }

    fun revoca(d: MioDispositivo) {
        val aspettava = d.stato == StatoDispositivo.IN_ATTESA
        gesto(Frasi.t("app_dispositivi.lavoro.revoco"), { it.revocaDispositivo(d.id) }) { guasto ->
            esito = when {
                guasto == null && aspettava -> EsitoDispositivi(Frasi.t("chat_chiavi.rifiutato"), false)
                guasto == null -> EsitoDispositivi(Frasi.t("app_dispositivi.revocato"), false)
                aspettava -> EsitoDispositivi(percheNo(guasto, Frasi.t("chat_chiavi.risposta_fallita")), true)
                else -> EsitoDispositivi(percheNo(guasto, Frasi.t("app_dispositivi.revoca.errore")), true)
            }
        }
    }

    Scaffold(
        modifier = modifier,
        topBar = {
            Column {
                TopAppBar(
                    title = { Text(Frasi.t("app_dispositivi.titolo")) },
                    navigationIcon = {
                        IconButton(onClick = onIndietro) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = Frasi.t("comune.indietro"))
                        }
                    },
                )
                if (occupato) LinearProgressIndicator(Modifier.fillMaxWidth())
            }
        },
    ) { margini ->
        PullToRefreshBox(
            isRefreshing = aggiorno,
            onRefresh = {
                ambito.launch {
                    aggiorno = true
                    carica()
                    aggiorno = false
                }
            },
            modifier = Modifier.padding(margini).fillMaxSize(),
        ) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(vertical = 8.dp)) {
                val avviso = lavoro?.let { EsitoDispositivi(it, false) } ?: esito
                if (avviso != null) {
                    item(key = "esito") {
                        Surface(
                            color = if (avviso.guasto) {
                                MaterialTheme.colorScheme.errorContainer
                            } else {
                                MaterialTheme.colorScheme.secondaryContainer
                            },
                            shape = RoundedCornerShape(14.dp),
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                        ) {
                            Row(
                                Modifier.padding(14.dp),
                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                when {
                                    occupato -> CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                                    avviso.guasto -> Icon(Icons.Filled.Warning, contentDescription = null)
                                    else -> Icon(Icons.Filled.CheckCircle, contentDescription = null)
                                }
                                Text(avviso.testo, style = MaterialTheme.typography.bodyMedium)
                            }
                        }
                    }
                }

                val chi = io
                if (chi != null && !chi.approvato) {
                    item(key = "attesa") {
                        Surface(
                            color = MaterialTheme.colorScheme.surfaceContainer,
                            shape = RoundedCornerShape(20.dp),
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                        ) {
                            AttesaDelSi(chi.codice, onRicontrolla = { carica() }, modifier = Modifier.padding(20.dp))
                        }
                    }
                }

                if (richieste.isNotEmpty()) {
                    item(key = "richieste") {
                        Titoletto(
                            if (richieste.size == 1) {
                                Frasi.t("chat_chiavi.richieste.one")
                            } else {
                                Frasi.t("chat_chiavi.richieste.other", mapOf("n" to "${richieste.size}"))
                            },
                        )
                    }
                    items(richieste, key = { "richiesta-${it.id}" }) { d ->
                        RichiestaDispositivo(
                            dispositivo = d,
                            decide = decide,
                            occupato = occupato,
                            onSi = { approva(d) },
                            onNo = { daRevocare = d },
                        )
                    }
                    item(key = "richieste-piede") {
                        Piede(
                            if (decide) {
                                Frasi.t(
                                    "chat_chiavi.prima_del_si",
                                    mapOf("guarda" to Frasi.t("chat_chiavi.prima_del_si.guarda")),
                                )
                            } else {
                                Frasi.t("app_dispositivi.solo_approvati")
                            },
                        )
                    }
                }

                item(key = "questo") {
                    when {
                        questo != null -> RigaDispositivo(questo, onRevoca = null)
                        carico -> Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator()
                        }
                        guastoElenco -> Text(
                            Frasi.t("dispositivi.errore_elenco"),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.error,
                            modifier = Modifier.padding(16.dp),
                        )
                    }
                }
                item(key = "spiegazione") { Piede(Frasi.t("app_dispositivi.spiegazione")) }

                if (approvati.isNotEmpty()) {
                    item(key = "approvati") { Titoletto(Frasi.t("app_dispositivi.approvati")) }
                    items(approvati, key = { "approvato-${it.id}" }) { d ->
                        RigaDispositivo(d, onRevoca = if (decide && !occupato) ({ daRevocare = d }) else null)
                    }
                    if (decide) {
                        item(key = "approvati-piede") { Piede(Frasi.t("dispositivi.disconnettere")) }
                    }
                }

                if (revocati.isNotEmpty()) {
                    item(key = "revocati") { Titoletto(Frasi.t("app_dispositivi.revocati")) }
                    items(revocati, key = { "revocato-${it.id}" }) { d -> RigaDispositivo(d, onRevoca = null) }
                }
            }
        }
    }

    daRevocare?.let { d ->
        val aspetta = d.stato == StatoDispositivo.IN_ATTESA
        AlertDialog(
            onDismissRequest = { daRevocare = null },
            icon = { Icon(Icons.Filled.Warning, contentDescription = null) },
            title = {
                Text(
                    if (aspetta) {
                        Frasi.t("app_dispositivi.rifiuta.titolo")
                    } else {
                        Frasi.t("app_dispositivi.revoca.titolo", mapOf("nome" to nomeDelDispositivo(d)))
                    },
                )
            },
            text = {
                Text(if (aspetta) Frasi.t("app_dispositivi.rifiuta.testo") else Frasi.t("app_dispositivi.revoca.testo"))
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        daRevocare = null
                        revoca(d)
                    },
                    colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error),
                ) {
                    Text(if (aspetta) Frasi.t("chat_chiavi.no_rifiuta") else Frasi.t("app_dispositivi.revoca.conferma"))
                }
            },
            dismissButton = {
                TextButton(onClick = { daRevocare = null }) { Text(Frasi.t("comune.annulla")) }
            },
        )
    }
}

@Composable
private fun Titoletto(testo: String) {
    Text(
        testo,
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier
            .padding(start = 16.dp, end = 16.dp, top = 20.dp, bottom = 4.dp)
            .semantics { heading() },
    )
}

@Composable
private fun Piede(testo: String) {
    Text(
        testo,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
    )
}

/** L'icona dello stato, con il colore che lo dice: il testo accanto lo ripete. */
@Composable
private fun IconaStato(stato: StatoDispositivo) {
    val (icona, colore) = when (stato) {
        StatoDispositivo.APPROVATO -> Icons.Filled.CheckCircle to MaterialTheme.colorScheme.primary
        StatoDispositivo.IN_ATTESA -> Icons.Filled.Info to MaterialTheme.colorScheme.tertiary
        StatoDispositivo.REVOCATO -> Icons.Filled.Close to MaterialTheme.colorScheme.onSurfaceVariant
    }
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHighest,
        shape = RoundedCornerShape(10.dp),
        modifier = Modifier.size(40.dp),
    ) {
        Box(contentAlignment = Alignment.Center) { Icon(icona, contentDescription = null, tint = colore) }
    }
}

/** Un dispositivo che chiede di entrare: il codice da confrontare, e il sì o il no. */
@Composable
private fun RichiestaDispositivo(
    dispositivo: MioDispositivo,
    decide: Boolean,
    occupato: Boolean,
    onSi: () -> Unit,
    onNo: () -> Unit,
) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainer,
        shape = RoundedCornerShape(20.dp),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                IconaStato(dispositivo.stato)
                Text(
                    nomeDelDispositivo(dispositivo),
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            CodiceDaConfrontare(dispositivo.codice)
            Text(
                Frasi.t("chat_chiavi.chiede_dal", mapOf("quando" to dataMedia(dispositivo.creatoIl))),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (decide) {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Button(onClick = onSi, enabled = !occupato, modifier = Modifier.weight(1f)) {
                        Text(Frasi.t("chat_chiavi.si_sono_io"))
                    }
                    OutlinedButton(
                        onClick = onNo,
                        enabled = !occupato,
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
                        modifier = Modifier.weight(1f),
                    ) {
                        Text(Frasi.t("chat_chiavi.no_rifiuta"))
                    }
                }
            }
        }
    }
}

/** Una riga dell'elenco: il nome, a che punto è, quando l'ultima volta, il codice. */
@Composable
private fun RigaDispositivo(dispositivo: MioDispositivo, onRevoca: (() -> Unit)?) {
    val revocato = dispositivo.stato == StatoDispositivo.REVOCATO
    val (stato, accento) = when (dispositivo.stato) {
        StatoDispositivo.APPROVATO -> {
            val visto = daQuantoTempo(dispositivo.vistoIl)
            if (visto != null) {
                Frasi.t("app_dispositivi.visto", mapOf("quando" to visto)) to false
            } else {
                Frasi.t("app_dispositivi.senza_sessione") to true
            }
        }
        StatoDispositivo.IN_ATTESA -> Frasi.t("app_dispositivi.stato.in_attesa") to true
        StatoDispositivo.REVOCATO -> {
            val quando = daQuantoTempo(dispositivo.revocatoIl)
            if (quando != null) {
                Frasi.t("app_dispositivi.revocato_il", mapOf("quando" to quando)) to false
            } else {
                Frasi.t("app_dispositivi.stato.revocato") to false
            }
        }
    }
    val entrato = daQuantoTempo(dispositivo.creatoIl)

    ListItem(
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
        leadingContent = { IconaStato(dispositivo.stato) },
        headlineContent = {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    nomeDelDispositivo(dispositivo),
                    fontWeight = FontWeight.SemiBold,
                    color = if (revocato) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                    textDecoration = if (revocato) TextDecoration.LineThrough else null,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (dispositivo.questo) {
                    Surface(
                        color = MaterialTheme.colorScheme.primary,
                        contentColor = MaterialTheme.colorScheme.onPrimary,
                        shape = RoundedCornerShape(50),
                    ) {
                        Text(
                            Frasi.t("dispositivi.questo"),
                            style = MaterialTheme.typography.labelSmall,
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                        )
                    }
                }
            }
        },
        supportingContent = {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    stato,
                    color = if (accento) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (entrato != null) {
                    Text(Frasi.t("app_dispositivi.entrato", mapOf("quando" to entrato)))
                }
                Text(
                    Frasi.t("app_dispositivi.codice", mapOf("codice" to dispositivo.codice)),
                    fontFamily = FontFamily.Monospace,
                )
            }
        },
        trailingContent = if (onRevoca != null) {
            {
                TextButton(
                    onClick = onRevoca,
                    colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error),
                ) { Text(Frasi.t("app_dispositivi.revoca")) }
            }
        } else {
            null
        },
    )
}
