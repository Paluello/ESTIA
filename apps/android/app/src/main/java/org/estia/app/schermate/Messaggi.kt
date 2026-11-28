// Le conversazioni cifrate (ADR 0038, 0043, 0052), sopra le `Sessioni` del
// nucleo: l'app chiede e mostra, il nucleo fa MLS e l'archivio. Nessuna
// chiave passa di qui.

package org.estia.app.schermate

import android.text.format.DateUtils
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.estia.app.Casa
import org.estia.app.Frasi
import org.estia.nucleo.Apertura
import org.estia.nucleo.Conversazione
import org.estia.nucleo.Io
import org.estia.nucleo.Messaggio
import org.estia.nucleo.PersonaDaInvitare
import org.estia.nucleo.StatoMessaggio
import org.estia.nucleo.TipoEvento

private enum class StatoElenco { Carico, Pronto, Errore }

/** Il nome da mostrare: quello del gruppo, oppure le altre persone. */
private fun nomeConversazione(c: Conversazione, io: Io?): String {
    c.nome?.takeIf { it.isNotBlank() }?.let { return it }
    val altri = c.membri.filter { it.id != io?.id }
    return if (altri.isEmpty()) Frasi.t("messaggi.te_stesso") else altri.joinToString(", ") { it.nome }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun Messaggi(casa: Casa, modifier: Modifier = Modifier) {
    var conversazioni by remember { mutableStateOf<List<Conversazione>>(emptyList()) }
    var io by remember { mutableStateOf<Io?>(null) }
    var stato by remember { mutableStateOf(StatoElenco.Carico) }
    var aggiorno by remember { mutableStateOf(false) }
    var aperta by rememberSaveable { mutableStateOf<String?>(null) }
    var nuova by remember { mutableStateOf(false) }
    val ambito = rememberCoroutineScope()
    val barra = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()

    suspend fun carica() {
        stato = try {
            val sessioni = casa.sessioniPronte()
            val chi = sessioni.io()
            io = chi
            if (chi.approvato) conversazioni = sessioni.conversazioni()
            StatoElenco.Pronto
        } catch (e: Exception) {
            StatoElenco.Errore
        }
    }

    LaunchedEffect(Unit) { carica() }

    val scelta = conversazioni.firstOrNull { it.id == aperta }
    if (scelta != null) {
        BackHandler { aperta = null }
        SchermataConversazione(casa, scelta, io, onIndietro = { aperta = null }, modifier = modifier)
        return
    }

    Scaffold(
        modifier = modifier.nestedScroll(barra.nestedScrollConnection),
        topBar = { LargeTopAppBar(title = { Text(Frasi.t("messaggi.titolo")) }, scrollBehavior = barra) },
        floatingActionButton = {
            if (io?.approvato == true) {
                FloatingActionButton(onClick = { nuova = true }) {
                    Icon(Icons.Filled.Edit, contentDescription = Frasi.t("app_messaggi.nuova"))
                }
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
            val chi = io
            when {
                chi != null && !chi.approvato ->
                    Avviso(Frasi.t("messaggi.titolo"), Frasi.t("app_messaggi.non_approvato"))
                conversazioni.isEmpty() && stato == StatoElenco.Carico ->
                    Box(Modifier.fillMaxSize(), Alignment.Center) { CircularProgressIndicator() }
                conversazioni.isEmpty() && stato == StatoElenco.Errore ->
                    Avviso(Frasi.t("feed.errore_lettura"), Frasi.t("comune.non_ha_funzionato"))
                conversazioni.isEmpty() -> Avviso(Frasi.t("messaggi.vuoto.titolo"), "")
                else -> LazyColumn(Modifier.fillMaxSize()) {
                    items(conversazioni, key = { it.id }) { c ->
                        RigaConversazione(c, io) { aperta = c.id }
                        HorizontalDivider(color = MaterialTheme.colorScheme.outline)
                    }
                }
            }
        }
    }

    if (nuova) {
        NuovaConversazione(casa, onChiudi = { nuova = false }) { creata ->
            nuova = false
            if (conversazioni.none { it.id == creata.id }) conversazioni = listOf(creata) + conversazioni
            aperta = creata.id
        }
    }
}

@Composable
private fun RigaConversazione(c: Conversazione, io: Io?, onClick: () -> Unit) {
    val nome = nomeConversazione(c, io)
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp)
            .semantics(mergeDescendants = true) {},
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Iniziale(nome, c.id)
        Column(Modifier.weight(1f)) {
            Text(
                nome,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = if (c.nonLetti > 0u) FontWeight.SemiBold else FontWeight.Normal,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            c.ultimoMessaggioIl?.let { quando(it) }?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (c.nonLetti > 0u) {
            Badge(containerColor = MaterialTheme.colorScheme.primary, contentColor = MaterialTheme.colorScheme.onPrimary) {
                Text(c.nonLetti.toString())
            }
        }
    }
}

private fun quando(iso: String): String? = runCatching {
    DateUtils.getRelativeTimeSpanString(
        Instant.parse(iso).toEpochMilli(),
        System.currentTimeMillis(),
        DateUtils.MINUTE_IN_MILLIS,
        DateUtils.FORMAT_ABBREV_RELATIVE,
    ).toString()
}.getOrNull()

private val ora = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT)

private fun oraDi(iso: String): String? =
    runCatching { Instant.parse(iso).atZone(ZoneId.systemDefault()).format(ora) }.getOrNull()

/** Una conversazione aperta: la cronologia, e sotto il campo per scrivere. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SchermataConversazione(
    casa: Casa,
    conversazione: Conversazione,
    io: Io?,
    onIndietro: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var messaggi by remember { mutableStateOf<List<Messaggio>>(emptyList()) }
    var ultimaPagina by remember { mutableStateOf<Set<String>>(emptySet()) }
    var apertura by remember { mutableStateOf<Apertura?>(null) }
    var senzaCronologia by remember { mutableStateOf(false) }
    var estranei by remember { mutableStateOf<List<String>>(emptyList()) }
    var testo by rememberSaveable { mutableStateOf("") }
    var invio by remember { mutableStateOf(false) }
    var errore by remember { mutableStateOf<String?>(null) }
    val ambito = rememberCoroutineScope()
    val elenco = rememberLazyListState()

    val altro = conversazione.membri.firstOrNull { it.id != io?.id }?.nome ?: Frasi.t("messaggi.questa_persona")
    val nome = mapOf("nome" to altro)
    val blocco: Pair<String, String>? = when (apertura) {
        null -> null
        Apertura.TOLTO -> Frasi.t("chat.tolto.titolo") to Frasi.t("chat.tolto.testo")
        Apertura.IN_ATTESA ->
            if (conversazione.gruppo) {
                Frasi.t("chat.gruppo_in_attesa.titolo") to Frasi.t("chat.gruppo_in_attesa.testo", nome)
            } else {
                Frasi.t("chat.in_attesa.titolo") to Frasi.t("chat.in_attesa.testo", nome)
            }
        Apertura.PRONTA -> when {
            senzaCronologia -> Frasi.t("chat.cronologia.titolo") to Frasi.t("chat.cronologia.testo", nome)
            estranei.isNotEmpty() -> Frasi.t("chat.estranei.titolo") to
                Frasi.t("chat.estranei.testo", mapOf("nomi" to estranei.joinToString(", ")))
            else -> null
        }
    }
    val spento = blocco != null || apertura != Apertura.PRONTA

    // Un giro subito, poi ogni dieci secondi finché la schermata è aperta.
    LaunchedEffect(conversazione.id) {
        try {
            val sessioni = casa.sessioniPronte()
            apertura = sessioni.apriConversazione(conversazione.id)
            if (apertura == Apertura.PRONTA) {
                messaggi = sessioni.cronologia(conversazione.id, null).messaggi
            }
        } catch (e: Exception) {
            errore = Frasi.t("messaggi.errore_avvio")
        }
        while (isActive) {
            runCatching { casa.sessioniPronte().aggiorna(conversazione.id) }.onSuccess { a ->
                apertura = a.apertura
                senzaCronologia = a.senzaCronologia
                estranei = a.estranei
                // Ciò che era nell'ultima pagina e non c'è più l'ha ritirato chi l'aveva scritto.
                val ritirati = ultimaPagina - a.pagina.toSet()
                val perId = LinkedHashMap<String, Messaggio>()
                messaggi.filter { it.id !in ritirati }.forEach { perId[it.id] = it }
                a.nuovi.forEach { perId[it.id] = it }
                messaggi = perId.values.sortedWith(compareBy({ it.creatoIl }, { it.id }))
                ultimaPagina = a.pagina.toSet()
            }
            delay(10_000)
        }
    }

    LaunchedEffect(messaggi.size) {
        if (messaggi.isNotEmpty()) elenco.animateScrollToItem(messaggi.size - 1)
    }

    fun invia() {
        val daMandare = testo.trim()
        if (daMandare.isEmpty() || invio) return
        invio = true
        errore = null
        ambito.launch {
            try {
                val mandato = casa.sessioniPronte().invia(conversazione.id, daMandare, null)
                testo = ""
                messaggi = messaggi.filter { it.id != mandato.id } + mandato
            } catch (e: Exception) {
                errore = Frasi.t("messaggi.errore_invio")
            } finally {
                invio = false
            }
        }
    }

    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                title = { Text(nomeConversazione(conversazione, io), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = {
                    IconButton(onClick = onIndietro) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = Frasi.t("messaggi.torna_elenco"))
                    }
                },
            )
        },
        bottomBar = {
            Surface(tonalElevation = 3.dp, modifier = Modifier.imePadding()) {
                Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                    errore?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                    }
                    Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextField(
                            value = testo,
                            onValueChange = { testo = it },
                            placeholder = { Text(Frasi.t("messaggi.scrivi_segnaposto")) },
                            enabled = !spento,
                            maxLines = 5,
                            shape = RoundedCornerShape(24.dp),
                            colors = TextFieldDefaults.colors(
                                focusedIndicatorColor = Color.Transparent,
                                unfocusedIndicatorColor = Color.Transparent,
                                disabledIndicatorColor = Color.Transparent,
                            ),
                            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                            modifier = Modifier.weight(1f),
                        )
                        FilledIconButton(
                            onClick = { invia() },
                            enabled = !spento && !invio && testo.isNotBlank(),
                        ) {
                            Icon(Icons.AutoMirrored.Filled.Send, contentDescription = Frasi.t("comune.invia"))
                        }
                    }
                }
            }
        },
    ) { margini ->
        LazyColumn(
            state = elenco,
            modifier = Modifier.padding(margini).fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(8.dp),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
        ) {
            blocco?.let { (titolo, spiegazione) ->
                item(key = "blocco") { Riquadro(titolo, spiegazione) }
            }
            if (blocco == null && apertura == Apertura.PRONTA && messaggi.isEmpty()) {
                item(key = "vuoto") {
                    Text(
                        Frasi.t("messaggi.nessun_messaggio"),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().padding(top = 32.dp),
                    )
                }
            }
            items(messaggi, key = { it.id }) { m -> Nuvoletta(m, conversazione) }
        }
    }
}

@Composable
private fun Riquadro(titolo: String, testo: String) {
    Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(14.dp)) {
        Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(titolo, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            Text(testo, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun Nuvoletta(m: Messaggio, conversazione: Conversazione) {
    fun nome(membro: String?): String =
        membro?.let { chi -> conversazione.membri.firstOrNull { "${it.username}@${it.casa}" == chi }?.nome ?: chi }
            ?: Frasi.t("messaggi.interlocutore")

    val evento = m.evento
    if (evento != null) {
        val di = nome(evento.chi)
        val chi = if (m.mio) Frasi.t("messaggi.tu") else nome(m.mittente)
        val frase = when (evento.tipo) {
            TipoEvento.USCITA -> Frasi.t("gruppi.evento.uscita", mapOf("nome" to di))
            TipoEvento.INGRESSO -> Frasi.t("gruppi.evento.ingresso", mapOf("chi" to chi, "nome" to di))
            TipoEvento.RIMOZIONE -> Frasi.t("gruppi.evento.rimozione", mapOf("chi" to chi, "nome" to di))
        }
        Text(
            frase,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
        )
        return
    }

    val mio = m.mio
    val sfondo = if (mio) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceContainerHigh
    val inchiostro = if (mio) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface
    Row(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}) {
        if (mio) Spacer(Modifier.weight(1f))
        Surface(
            color = sfondo,
            contentColor = inchiostro,
            shape = RoundedCornerShape(18.dp),
            modifier = Modifier.widthIn(max = 300.dp),
        ) {
            Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                if (conversazione.gruppo && !mio) {
                    Text(
                        nome(m.mittente),
                        style = MaterialTheme.typography.labelMedium,
                        fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.tertiary,
                    )
                }
                when (m.stato) {
                    StatoMessaggio.LETTO -> Text(m.testo ?: "", style = MaterialTheme.typography.bodyLarge)
                    StatoMessaggio.NON_SI_APRE -> Text(
                        Frasi.t("messaggi.non_si_apre.titolo"),
                        style = MaterialTheme.typography.bodyLarge,
                        fontStyle = FontStyle.Italic,
                    )
                    StatoMessaggio.NON_DISPONIBILE -> Text(
                        Frasi.t("messaggi.non_disponibile.titolo"),
                        style = MaterialTheme.typography.bodyLarge,
                        fontStyle = FontStyle.Italic,
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (!m.attestato) {
                        Icon(
                            Icons.Filled.Warning,
                            contentDescription = Frasi.t("messaggi.non_attestato"),
                            modifier = Modifier.padding(0.dp).background(Color.Transparent, CircleShape),
                        )
                    }
                    oraDi(m.creatoIl)?.let {
                        Text(it, style = MaterialTheme.typography.labelSmall, color = inchiostro.copy(alpha = 0.7f))
                    }
                }
            }
        }
        if (!mio) Spacer(Modifier.weight(1f))
    }
}

/** La finestra per cominciare una conversazione con qualcuno. */
@Composable
private fun NuovaConversazione(casa: Casa, onChiudi: () -> Unit, onCreata: (Conversazione) -> Unit) {
    var chi by rememberSaveable { mutableStateOf("") }
    var inCorso by remember { mutableStateOf(false) }
    var errore by remember { mutableStateOf<String?>(null) }
    val ambito = rememberCoroutineScope()

    fun comincia() {
        val parti = chi.trim().trim('@').split("@", limit = 2)
        val username = parti.firstOrNull()?.takeIf { it.isNotBlank() } ?: return
        inCorso = true
        errore = null
        ambito.launch {
            try {
                val creata = casa.sessioniPronte().creaDiretta(PersonaDaInvitare(username, parti.getOrNull(1)))
                onCreata(creata)
            } catch (e: Exception) {
                errore = Frasi.t("messaggi.errore_avvio")
            } finally {
                inCorso = false
            }
        }
    }

    AlertDialog(
        onDismissRequest = onChiudi,
        title = { Text(Frasi.t("app_messaggi.nuova")) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = chi,
                    onValueChange = { chi = it },
                    label = { Text(Frasi.t("app_messaggi.chi")) },
                    placeholder = { Text(Frasi.t("messaggi.cerca.segnaposto")) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    errore ?: Frasi.t("app_messaggi.chi.aiuto"),
                    style = MaterialTheme.typography.bodySmall,
                    color = if (errore == null) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error,
                )
            }
        },
        confirmButton = {
            TextButton(onClick = { comincia() }, enabled = !inCorso && chi.isNotBlank()) {
                Text(Frasi.t("app_messaggi.comincia"))
            }
        },
        dismissButton = { TextButton(onClick = onChiudi) { Text(Frasi.t("comune.annulla")) } },
    )
}
