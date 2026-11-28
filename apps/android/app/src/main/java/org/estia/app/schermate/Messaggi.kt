// Le conversazioni cifrate (ADR 0038, 0043, 0052), sopra le `Sessioni` del
// nucleo: l'app chiede e mostra, il nucleo fa MLS e l'archivio. Nessuna
// chiave passa di qui.
//
// Qui l'elenco e la conversazione aperta, con la risposta e il ritiro. Il
// gruppo (crearlo, chi c'è, aggiungere, togliere, uscire) sta in Gruppi.kt.

package org.estia.app.schermate

import android.text.format.DateUtils
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
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
import org.estia.nucleo.ErroreNucleo
import org.estia.nucleo.Io
import org.estia.nucleo.Messaggio
import org.estia.nucleo.PersonaDaInvitare
import org.estia.nucleo.StatoMessaggio
import org.estia.nucleo.TipoEvento

private enum class StatoElenco { Carico, Pronto, Errore }

/** Che cosa si comincia: una conversazione a due, o un gruppo. */
private enum class Foglio { Diretta, Gruppo }

/** Il nome da mostrare: quello del gruppo, oppure le altre persone. */
private fun nomeConversazione(c: Conversazione, io: Io?): String {
    c.nome?.takeIf { it.isNotBlank() }?.let { return it }
    val altri = c.membri.filter { it.id != io?.id }
    return if (altri.isEmpty()) Frasi.t("messaggi.te_stesso") else altri.joinToString(", ") { it.nome }
}

/** Chi è `username@casa` in questa conversazione, detto come va mostrato. */
private fun nomeNellaConversazione(c: Conversazione, membro: String?): String {
    if (membro == null) return Frasi.t("messaggi.interlocutore")
    val persona = c.membri.firstOrNull { "${it.username}@${it.casa}" == membro }
    return persona?.nome?.takeIf { it.isNotBlank() } ?: persona?.username ?: membro
}

/**
 * `nome` o `nome@chiave-della-casa`, com'è scritto, nella forma che la Casa
 * vuole. `null` se non c'è un nome.
 */
internal fun personaDaInvitare(testo: String): PersonaDaInvitare? {
    val parti = testo.trim().trim('@').split("@", limit = 2)
    val username = parti.firstOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    return PersonaDaInvitare(username, parti.getOrNull(1)?.trim()?.takeIf { it.isNotEmpty() })
}

/**
 * Il codice con cui la Casa ha detto di no (`no_device_available`, …), se è
 * stata lei: il nucleo lo passa come `casa <stato>: <codice>`.
 */
internal fun codiceDellaCasa(e: Throwable): String? {
    val messaggio = (e as? ErroreNucleo.Casa)?.message ?: return null
    return messaggio.substringAfter(": ", "").takeIf { it.isNotEmpty() }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun Messaggi(casa: Casa, modifier: Modifier = Modifier) {
    var conversazioni by remember { mutableStateOf<List<Conversazione>>(emptyList()) }
    var io by remember { mutableStateOf<Io?>(null) }
    var stato by remember { mutableStateOf(StatoElenco.Carico) }
    var aggiorno by remember { mutableStateOf(false) }
    var aperta by rememberSaveable { mutableStateOf<String?>(null) }
    var foglio by remember { mutableStateOf<Foglio?>(null) }
    var menu by remember { mutableStateOf(false) }
    val ambito = rememberCoroutineScope()
    val barra = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()

    suspend fun carica() {
        stato = try {
            val sessioni = casa.sessioniPronte()
            // Chi aspettava il sì lo scopre dall'elenco dei dispositivi, che
            // aggiorna `approvato`.
            if (!sessioni.io().approvato) runCatching { sessioni.dispositivi() }
            val chi = sessioni.io()
            io = chi
            if (chi.approvato) conversazioni = sessioni.conversazioni()
            StatoElenco.Pronto
        } catch (e: Exception) {
            StatoElenco.Errore
        }
    }

    fun apri(creata: Conversazione) {
        foglio = null
        if (conversazioni.none { it.id == creata.id }) conversazioni = listOf(creata) + conversazioni
        aperta = creata.id
    }

    LaunchedEffect(Unit) {
        carica()
        // Chi aspetta il sì ricontrolla da sé ogni dieci secondi: il sì arriva
        // da un altro dispositivo, e qui non lo annuncia nessuno.
        while (isActive && io?.approvato == false) {
            delay(10_000)
            carica()
        }
    }

    val scelta = conversazioni.firstOrNull { it.id == aperta }
    if (scelta != null) {
        BackHandler { aperta = null }
        SchermataConversazione(
            casa,
            scelta,
            io,
            onIndietro = { aperta = null },
            onCambiata = { ambito.launch { carica() } },
            onUscita = {
                // Si è usciti dal gruppo: si torna all'elenco, dove non c'è più.
                aperta = null
                conversazioni = conversazioni.filter { it.id != scelta.id }
                ambito.launch { carica() }
            },
            modifier = modifier,
        )
        return
    }

    Scaffold(
        modifier = modifier.nestedScroll(barra.nestedScrollConnection),
        topBar = { LargeTopAppBar(title = { Text(Frasi.t("messaggi.titolo")) }, scrollBehavior = barra) },
        floatingActionButton = {
            if (io?.approvato == true) {
                Box {
                    FloatingActionButton(onClick = { menu = true }) {
                        Icon(Icons.Filled.Edit, contentDescription = Frasi.t("app_messaggi.nuova_o_gruppo"))
                    }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(
                            text = { Text(Frasi.t("app_messaggi.nuova")) },
                            onClick = {
                                menu = false
                                foglio = Foglio.Diretta
                            },
                        )
                        DropdownMenuItem(
                            text = { Text(Frasi.t("gruppi.nuovo.voce")) },
                            onClick = {
                                menu = false
                                foglio = Foglio.Gruppo
                            },
                        )
                    }
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
                // Finché aspetta il sì non c'è niente da elencare: si dice
                // perché, si mostra il codice, e dove andare a dirlo.
                chi != null && !chi.approvato -> LazyColumn(Modifier.fillMaxSize()) {
                    item(key = "attesa") {
                        Surface(
                            color = MaterialTheme.colorScheme.surfaceContainer,
                            shape = RoundedCornerShape(20.dp),
                            modifier = Modifier.fillMaxWidth().padding(16.dp),
                        ) {
                            AttesaDelSi(chi.codice, onRicontrolla = { carica() }, modifier = Modifier.padding(20.dp))
                        }
                    }
                }
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

    when (foglio) {
        Foglio.Diretta -> NuovaConversazione(casa, onChiudi = { foglio = null }) { creata -> apri(creata) }
        Foglio.Gruppo -> NuovoGruppo(casa, io, onChiudi = { foglio = null }) { creato -> apri(creato) }
        null -> {}
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

/** Il messaggio a cui una nuvoletta risponde, come lo si mostra sopra il testo. */
private data class Citazione(
    val id: String,
    /** `null` quando il messaggio citato non è fra quelli caricati. */
    val autore: String?,
    val testo: String,
)

/** Ciò che una riga dice di sé in un'anteprima: il testo, o perché non c'è. */
private fun anteprima(m: Messaggio): String = when (m.stato) {
    StatoMessaggio.LETTO -> m.testo ?: ""
    StatoMessaggio.NON_SI_APRE -> Frasi.t("messaggi.non_si_apre.titolo")
    StatoMessaggio.NON_DISPONIBILE -> Frasi.t("messaggi.non_disponibile.titolo")
}

/** Una conversazione aperta: la cronologia, e sotto il campo per scrivere. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SchermataConversazione(
    casa: Casa,
    conversazione: Conversazione,
    io: Io?,
    onIndietro: () -> Unit,
    onCambiata: () -> Unit,
    onUscita: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var messaggi by remember { mutableStateOf<List<Messaggio>>(emptyList()) }
    var ultimaPagina by remember { mutableStateOf<Set<String>>(emptySet()) }
    var apertura by remember { mutableStateOf<Apertura?>(null) }
    var senzaCronologia by remember { mutableStateOf(false) }
    var estranei by remember { mutableStateOf<List<String>>(emptyList()) }
    // Questo dispositivo aspetta ancora il sì: non crea e non rientra.
    var aspettaIlSi by remember { mutableStateOf(false) }
    var testo by rememberSaveable { mutableStateOf("") }
    var invio by remember { mutableStateOf(false) }
    var errore by remember { mutableStateOf<String?>(null) }
    var risponde by remember { mutableStateOf<Messaggio?>(null) }
    var daRitirare by remember { mutableStateOf<Messaggio?>(null) }
    var info by rememberSaveable { mutableStateOf(false) }
    val ambito = rememberCoroutineScope()
    val elenco = rememberLazyListState()
    val fuoco = remember { FocusRequester() }

    if (info) {
        BackHandler { info = false }
        InfoGruppo(
            casa,
            conversazione,
            io,
            onIndietro = { info = false },
            onCambiata = onCambiata,
            onUscita = {
                info = false
                onUscita()
            },
            modifier = modifier,
        )
        return
    }

    val altro = conversazione.membri.firstOrNull { it.id != io?.id }?.nome ?: Frasi.t("messaggi.questa_persona")
    val nome = mapOf("nome" to altro)
    val blocco: Pair<String, String>? = if (aspettaIlSi) {
        Frasi.t("chat.dispositivo_in_attesa.titolo") to
            (Frasi.t("chat.dispositivo_in_attesa.testo") + "\n\n" + Frasi.t("chat.dispositivo_in_attesa.cosa_fare"))
    } else when (apertura) {
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

    fun autoreDi(m: Messaggio): String =
        if (m.mio) Frasi.t("messaggi.tu") else nomeNellaConversazione(conversazione, m.mittente)

    fun citazioneDi(m: Messaggio): Citazione? {
        val id = m.risponde ?: return null
        val citato = messaggi.firstOrNull { it.id == id }
            ?: return Citazione(id, null, Frasi.t("app_messaggi.citato_assente"))
        return Citazione(id, autoreDi(citato), anteprima(citato))
    }

    // Un giro subito, poi ogni dieci secondi finché la schermata è aperta.
    LaunchedEffect(conversazione.id) {
        try {
            val sessioni = casa.sessioniPronte()
            apertura = sessioni.apriConversazione(conversazione.id)
            aspettaIlSi = false
            if (apertura == Apertura.PRONTA) {
                messaggi = sessioni.cronologia(conversazione.id, null).messaggi
            }
        } catch (e: ErroreNucleo.DispositivoInAttesa) {
            // Non è un guasto: la mossa è su un altro dispositivo, e si dice.
            aspettaIlSi = true
        } catch (e: Exception) {
            errore = Frasi.t("messaggi.errore_avvio")
        }
        while (isActive) {
            runCatching { casa.sessioniPronte().aggiorna(conversazione.id) }.onFailure { e ->
                if (e is ErroreNucleo.DispositivoInAttesa) aspettaIlSi = true
            }.onSuccess { a ->
                aspettaIlSi = false
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
                if (risponde?.id in ritirati) risponde = null
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
                val mandato = casa.sessioniPronte().invia(conversazione.id, daMandare, risponde?.id)
                testo = ""
                risponde = null
                messaggi = messaggi.filter { it.id != mandato.id } + mandato
            } catch (e: Exception) {
                errore = Frasi.t("messaggi.errore_invio")
            } finally {
                invio = false
            }
        }
    }

    // Il ritiro: la voce esce dall'archivio della propria casa, e da qui.
    fun ritira(m: Messaggio) {
        errore = null
        ambito.launch {
            try {
                casa.sessioniPronte().ritira(conversazione.id, m.id)
                messaggi = messaggi.filter { it.id != m.id }
                ultimaPagina = ultimaPagina - m.id
                if (risponde?.id == m.id) risponde = null
            } catch (e: Exception) {
                errore = Frasi.t("app_messaggi.ritira.errore")
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
                actions = {
                    if (conversazione.gruppo && apertura != Apertura.TOLTO) {
                        IconButton(onClick = { info = true }) {
                            Icon(Icons.Filled.Info, contentDescription = Frasi.t("gruppi.membri.voce"))
                        }
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
                    risponde?.let { citato ->
                        BarraDellaRisposta(
                            titolo = Frasi.t("messaggi.risposta_a", mapOf("nome" to autoreDi(citato))),
                            testo = anteprima(citato),
                            onAnnulla = { risponde = null },
                        )
                    }
                    Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextField(
                            value = testo,
                            onValueChange = { testo = it },
                            placeholder = {
                                Text(
                                    if (aspettaIlSi) {
                                        Frasi.t("chat.dispositivo_in_attesa.segnaposto")
                                    } else {
                                        Frasi.t("messaggi.scrivi_segnaposto")
                                    },
                                )
                            },
                            enabled = !spento,
                            maxLines = 5,
                            shape = RoundedCornerShape(24.dp),
                            colors = TextFieldDefaults.colors(
                                focusedIndicatorColor = Color.Transparent,
                                unfocusedIndicatorColor = Color.Transparent,
                                disabledIndicatorColor = Color.Transparent,
                            ),
                            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                            modifier = Modifier.weight(1f).focusRequester(fuoco),
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
            contentPadding = PaddingValues(16.dp),
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
            items(messaggi, key = { it.id }) { m ->
                Nuvoletta(
                    m = m,
                    conversazione = conversazione,
                    citazione = citazioneDi(m),
                    puoRispondere = !spento,
                    puoRitirare = m.mio && apertura == Apertura.PRONTA,
                    onRispondi = {
                        risponde = m
                        runCatching { fuoco.requestFocus() }
                    },
                    onRitira = { daRitirare = m },
                    onCitazione = { id ->
                        val posto = messaggi.indexOfFirst { it.id == id }
                        if (posto >= 0) {
                            val prima = if (blocco != null) 1 else 0
                            ambito.launch { elenco.animateScrollToItem(posto + prima) }
                        }
                    },
                )
            }
        }
    }

    daRitirare?.let { m ->
        AlertDialog(
            onDismissRequest = { daRitirare = null },
            title = { Text(Frasi.t("app_messaggi.ritira.titolo")) },
            text = { Text(Frasi.t("app_messaggi.ritira.testo")) },
            confirmButton = {
                TextButton(
                    onClick = {
                        daRitirare = null
                        ritira(m)
                    },
                ) {
                    Text(Frasi.t("app_messaggi.ritira"), color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = { daRitirare = null }) { Text(Frasi.t("comune.annulla")) } },
        )
    }
}

/** Sopra il campo: a che cosa si sta rispondendo, e come smettere. */
@Composable
private fun BarraDellaRisposta(titolo: String, testo: String, onAnnulla: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(bottom = 6.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceContainerHighest)
            .padding(start = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .width(3.dp)
                .height(32.dp)
                .background(MaterialTheme.colorScheme.primary, RoundedCornerShape(2.dp)),
        )
        Column(Modifier.weight(1f).padding(horizontal = 10.dp, vertical = 8.dp)) {
            Text(
                titolo,
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.primary,
            )
            Text(
                testo,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        IconButton(onClick = onAnnulla) {
            Icon(Icons.Filled.Close, contentDescription = Frasi.t("messaggi.annulla_risposta"))
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

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun Nuvoletta(
    m: Messaggio,
    conversazione: Conversazione,
    citazione: Citazione?,
    puoRispondere: Boolean,
    puoRitirare: Boolean,
    onRispondi: () -> Unit,
    onRitira: () -> Unit,
    onCitazione: (String) -> Unit,
) {
    val evento = m.evento
    if (evento != null) {
        val di = nomeNellaConversazione(conversazione, evento.chi)
        val chi = if (m.mio) Frasi.t("messaggi.tu") else nomeNellaConversazione(conversazione, m.mittente)
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

    var menu by remember { mutableStateOf(false) }
    val appunti = LocalClipboardManager.current
    val mio = m.mio
    val forma = RoundedCornerShape(18.dp)
    val sfondo = if (mio) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceContainerHigh
    val inchiostro = if (mio) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface
    val testo = m.testo
    val siCopia = m.stato == StatoMessaggio.LETTO && !testo.isNullOrEmpty()
    val haAzioni = puoRispondere || siCopia || puoRitirare

    Row(Modifier.fillMaxWidth()) {
        if (mio) Spacer(Modifier.weight(1f))
        Box {
            Surface(
                color = sfondo,
                contentColor = inchiostro,
                shape = forma,
                modifier = Modifier
                    .widthIn(max = 300.dp)
                    .clip(forma)
                    .combinedClickable(
                        enabled = haAzioni,
                        onLongClickLabel = Frasi.t("comune.altre_azioni"),
                        // Il tocco lungo vibra da sé.
                        onLongClick = { menu = true },
                        onClick = {},
                    )
                    .semantics(mergeDescendants = true) {},
            ) {
                Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (conversazione.gruppo && !mio) {
                        Text(
                            nomeNellaConversazione(conversazione, m.mittente),
                            style = MaterialTheme.typography.labelMedium,
                            fontWeight = FontWeight.SemiBold,
                            color = MaterialTheme.colorScheme.tertiary,
                        )
                    }
                    citazione?.let { Citato(it, mio, onCitazione) }
                    when (m.stato) {
                        StatoMessaggio.LETTO -> Text(testo ?: "", style = MaterialTheme.typography.bodyLarge)
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
                            Icon(Icons.Filled.Warning, contentDescription = Frasi.t("messaggi.non_attestato"))
                        }
                        oraDi(m.creatoIl)?.let {
                            Text(it, style = MaterialTheme.typography.labelSmall, color = inchiostro.copy(alpha = 0.7f))
                        }
                    }
                }
            }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                if (puoRispondere) {
                    DropdownMenuItem(
                        text = { Text(Frasi.t("commento.rispondi")) },
                        onClick = {
                            menu = false
                            onRispondi()
                        },
                    )
                }
                if (siCopia) {
                    DropdownMenuItem(
                        text = { Text(Frasi.t("comune.copia")) },
                        onClick = {
                            menu = false
                            appunti.setText(AnnotatedString(testo ?: ""))
                        },
                    )
                }
                if (puoRitirare) {
                    DropdownMenuItem(
                        text = { Text(Frasi.t("app_messaggi.ritira"), color = MaterialTheme.colorScheme.error) },
                        leadingIcon = {
                            Icon(Icons.Filled.Delete, contentDescription = null, tint = MaterialTheme.colorScheme.error)
                        },
                        onClick = {
                            menu = false
                            onRitira()
                        },
                    )
                }
            }
        }
        if (!mio) Spacer(Modifier.weight(1f))
    }
}

/** Il messaggio citato, dentro la nuvoletta che gli risponde. */
@Composable
private fun Citato(citazione: Citazione, mio: Boolean, onCitazione: (String) -> Unit) {
    val inchiostro = if (mio) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant
    val fondo = if (mio) {
        MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.12f)
    } else {
        MaterialTheme.colorScheme.surfaceContainerHighest
    }
    val barra = if (mio) MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.6f) else MaterialTheme.colorScheme.primary
    Row(
        Modifier
            .clip(RoundedCornerShape(10.dp))
            .background(fondo)
            .clickable(enabled = citazione.autore != null) { onCitazione(citazione.id) }
            .padding(end = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .width(3.dp)
                .height(34.dp)
                .background(barra, RoundedCornerShape(2.dp)),
        )
        Column(Modifier.padding(start = 8.dp, top = 4.dp, bottom = 4.dp)) {
            citazione.autore?.let {
                Text(it, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = inchiostro)
            }
            Text(
                citazione.testo,
                style = MaterialTheme.typography.bodySmall,
                fontStyle = if (citazione.autore == null) FontStyle.Italic else FontStyle.Normal,
                color = inchiostro,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
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
        val persona = personaDaInvitare(chi) ?: return
        inCorso = true
        errore = null
        ambito.launch {
            try {
                onCreata(casa.sessioniPronte().creaDiretta(persona))
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
            TextButton(onClick = { comincia() }, enabled = !inCorso && personaDaInvitare(chi) != null) {
                Text(Frasi.t("app_messaggi.comincia"))
            }
        },
        dismissButton = { TextButton(onClick = onChiudi) { Text(Frasi.t("comune.annulla")) } },
    )
}
