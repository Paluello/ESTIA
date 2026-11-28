// I gruppi (M8), sopra le `Sessioni` del nucleo: crearne uno, vedere chi c'è,
// aggiungere, togliere, far entrare chi non è ancora dentro, uscire. Le
// regole sono quelle del web (`screens/gruppi`): aggiungono e tolgono il
// creatore e chi amministra, e chiunque esce da solo.

package org.estia.app.schermate

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ExitToApp
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
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
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.launch
import org.estia.app.Casa
import org.estia.app.Frasi
import org.estia.nucleo.Conversazione
import org.estia.nucleo.ErroreNucleo
import org.estia.nucleo.Io
import org.estia.nucleo.MembroDelGruppo
import org.estia.nucleo.Persona
import org.estia.nucleo.Sessioni

/** Il nome di una persona com'è da mostrare. */
private fun nomeDellaPersona(p: Persona): String = p.nome.ifBlank { p.username }

/** Perché una persona non è entrata nel gruppo cifrato. */
private fun percheNonEntra(e: Throwable, nome: String): String {
    val codice = codiceDellaCasa(e)
    return when {
        e is ErroreNucleo.ChiaveDiUnAltro -> Frasi.t("gruppi.entra.chiave_di_un_altro", mapOf("nome" to nome))
        e is ErroreNucleo.GruppoPieno || codice == "gruppo_pieno" -> Frasi.t("errori.gruppo_pieno")
        codice == "no_device_available" -> Frasi.t("gruppi.entra.senza_dispositivo", mapOf("nome" to nome))
        else -> Frasi.t("gruppi.entra.errore", mapOf("nome" to nome))
    }
}

/** Perché la Casa non ha cambiato chi c'è. */
private fun percheNo(e: Throwable, altrimenti: String): String = when (codiceDellaCasa(e)) {
    "user_not_found" -> Frasi.t("errori.user_not_found")
    "solo_amministratori" -> Frasi.t("errori.solo_amministratori")
    "gruppo_pieno" -> Frasi.t("errori.gruppo_pieno")
    "casa_che_ordina_non_raggiungibile" -> Frasi.t("errori.casa_che_ordina_non_raggiungibile")
    else -> altrimenti
}

/** La finestra per creare un gruppo: un nome, e almeno altre due persone. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun NuovoGruppo(casa: Casa, io: Io?, onChiudi: () -> Unit, onCreato: (Conversazione) -> Unit) {
    var nome by rememberSaveable { mutableStateOf("") }
    var chi by rememberSaveable { mutableStateOf("") }
    // Le persone scelte, come sono state scritte: `nome` o `nome@casa`.
    var scelti by remember { mutableStateOf<List<String>>(emptyList()) }
    var inCorso by remember { mutableStateOf(false) }
    var errore by remember { mutableStateOf<String?>(null) }
    val ambito = rememberCoroutineScope()
    val pronto = nome.isNotBlank() && scelti.size >= 2

    fun aggiungi() {
        val persona = personaDaInvitare(chi) ?: return
        val scritto = persona.casa?.let { "${persona.username}@$it" } ?: persona.username
        chi = ""
        errore = null
        // Sé stessi non si aggiungono: nel gruppo ci si è già.
        val sonoIo = persona.username == io?.username && (persona.casa == null || persona.casa == io?.casa)
        if (!sonoIo && scritto !in scelti) scelti = scelti + scritto
    }

    fun crea() {
        val pulito = nome.trim()
        if (pulito.isEmpty()) {
            errore = Frasi.t("gruppi.nuovo.manca_nome")
            return
        }
        if (scelti.size < 2) {
            errore = Frasi.t("gruppi.nuovo.manca_persone")
            return
        }
        inCorso = true
        errore = null
        ambito.launch {
            try {
                val gruppo = casa.sessioniPronte().creaGruppo(pulito, scelti.mapNotNull { personaDaInvitare(it) })
                onCreato(gruppo)
            } catch (e: Exception) {
                errore = when (codiceDellaCasa(e)) {
                    "user_not_found" -> Frasi.t("messaggi.nessuno_trovato")
                    "gruppo_pieno" -> Frasi.t("gruppi.nuovo.troppe")
                    else -> Frasi.t("gruppi.nuovo.errore")
                }
            } finally {
                inCorso = false
            }
        }
    }

    Dialog(
        onDismissRequest = { if (!inCorso) onChiudi() },
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Scaffold(
            topBar = {
                TopAppBar(
                    title = { Text(Frasi.t("gruppi.nuovo.titolo")) },
                    navigationIcon = {
                        IconButton(onClick = onChiudi, enabled = !inCorso) {
                            Icon(Icons.Filled.Close, contentDescription = Frasi.t("comune.annulla"))
                        }
                    },
                    actions = {
                        if (inCorso) {
                            CircularProgressIndicator(Modifier.padding(end = 16.dp).size(24.dp), strokeWidth = 2.dp)
                        } else {
                            TextButton(onClick = { crea() }, enabled = pronto) {
                                Text(Frasi.t("gruppi.nuovo.crea"))
                            }
                        }
                    },
                )
            },
        ) { margini ->
            LazyColumn(
                Modifier.padding(margini).fillMaxSize().imePadding(),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item(key = "nome") {
                    OutlinedTextField(
                        value = nome,
                        onValueChange = { nome = it },
                        label = { Text(Frasi.t("gruppi.nuovo.nome")) },
                        singleLine = true,
                        enabled = !inCorso,
                        keyboardOptions = KeyboardOptions(
                            capitalization = KeyboardCapitalization.Sentences,
                            imeAction = ImeAction.Next,
                        ),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                item(key = "spiegazione") {
                    Text(
                        Frasi.t("gruppi.nuovo.spiegazione"),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                item(key = "cerca") {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(Frasi.t("gruppi.nuovo.cerca"), style = MaterialTheme.typography.titleSmall)
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedTextField(
                                value = chi,
                                onValueChange = { chi = it },
                                placeholder = { Text(Frasi.t("messaggi.cerca.segnaposto")) },
                                singleLine = true,
                                enabled = !inCorso,
                                keyboardOptions = KeyboardOptions(
                                    capitalization = KeyboardCapitalization.None,
                                    autoCorrectEnabled = false,
                                    imeAction = ImeAction.Done,
                                ),
                                keyboardActions = KeyboardActions(onDone = { aggiungi() }),
                                modifier = Modifier.weight(1f),
                            )
                            FilledTonalButton(onClick = { aggiungi() }, enabled = !inCorso && personaDaInvitare(chi) != null) {
                                Text(Frasi.t("gruppi.aggiungi.conferma"))
                            }
                        }
                        Text(
                            Frasi.t("app_messaggi.gruppo.chi.aiuto"),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                items(scelti, key = { it }) { scelto ->
                    ListItem(
                        headlineContent = { Text(scelto, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        leadingContent = { Iniziale(scelto, scelto) },
                        trailingContent = {
                            IconButton(onClick = { scelti = scelti - scelto }, enabled = !inCorso) {
                                Icon(
                                    Icons.Filled.Close,
                                    contentDescription = Frasi.t("gruppi.nuovo.togli", mapOf("nome" to scelto)),
                                )
                            }
                        },
                        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                    )
                }
                item(key = "stato") {
                    val (frase, colore) = when {
                        errore != null -> errore.orEmpty() to MaterialTheme.colorScheme.error
                        scelti.size >= 2 -> Frasi.t("gruppi.nuovo.pronto", mapOf("n" to "${scelti.size + 1}")) to
                            MaterialTheme.colorScheme.primary
                        else -> Frasi.t("gruppi.nuovo.manca_persone") to MaterialTheme.colorScheme.onSurfaceVariant
                    }
                    Text(frase, style = MaterialTheme.typography.bodyMedium, color = colore)
                }
            }
        }
    }
}

/** Com'è andato l'ultimo gesto sul gruppo, da dire in cima. */
private data class Esito(val testo: String, val guasto: Boolean)

/**
 * Chi c'è in un gruppo, e che cosa ci si può fare: aggiungere, togliere,
 * far entrare chi non è ancora nel gruppo cifrato, uscire.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun InfoGruppo(
    casa: Casa,
    conversazione: Conversazione,
    io: Io?,
    onIndietro: () -> Unit,
    onCambiata: () -> Unit,
    onUscita: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var membri by remember { mutableStateOf<List<MembroDelGruppo>>(emptyList()) }
    var carico by remember { mutableStateOf(true) }
    var lavoro by remember { mutableStateOf<String?>(null) }
    var esito by remember { mutableStateOf<Esito?>(null) }
    var aggiungendo by remember { mutableStateOf(false) }
    var chi by rememberSaveable { mutableStateOf("") }
    var daTogliere by remember { mutableStateOf<MembroDelGruppo?>(null) }
    var esco by remember { mutableStateOf(false) }
    val ambito = rememberCoroutineScope()

    val ruolo = membri.firstOrNull { it.persona.id == io?.id }?.persona?.ruolo
    // Aggiungono e tolgono il creatore e chi amministra (`gestisce` del web).
    val gestisce = !conversazione.congelata && (ruolo == "creatore" || ruolo == "amministratore")
    val nomeGruppo = conversazione.nome?.takeIf { it.isNotBlank() } ?: Frasi.t("gruppi.senza_nome")
    val quante = if (membri.isEmpty()) conversazione.membri.size else membri.size
    val persone = if (quante == 1) {
        Frasi.t("gruppi.persone.one", mapOf("n" to "1"))
    } else {
        Frasi.t("gruppi.persone.other", mapOf("n" to "$quante"))
    }
    val titoloMembri = if (membri.size == 1) {
        Frasi.t("gruppi.membri.titolo.one", mapOf("n" to "1"))
    } else {
        Frasi.t("gruppi.membri.titolo.other", mapOf("n" to "${membri.size}"))
    }
    val piede = when {
        membri.none { it.dispositivi == 0u } -> Frasi.t("gruppi.ruolo.spiegazione")
        gestisce -> Frasi.t("gruppi.assenti.gestisci")
        else -> Frasi.t("gruppi.assenti.aspetta")
    }

    suspend fun carica() {
        carico = true
        try {
            membri = casa.sessioniPronte().membri(conversazione.id)
        } catch (e: Exception) {
            esito = Esito(Frasi.t("comune.non_ha_funzionato"), true)
        } finally {
            carico = false
        }
    }

    LaunchedEffect(conversazione.id) { carica() }

    /**
     * Un gesto sul gruppo: il lavoro in corso mentre dura, poi chi c'è di
     * nuovo, l'elenco delle conversazioni avvisato, e `dopo` con il guasto
     * se c'è stato.
     */
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
            onCambiata()
            dopo(guasto)
        }
    }

    fun aggiungi() {
        val persona = personaDaInvitare(chi) ?: return
        val nome = persona.username
        gesto(
            Frasi.t("gruppi.aggiungi.lavoro", mapOf("nome" to nome)),
            { it.aggiungiMembro(conversazione.id, persona) },
        ) { guasto ->
            esito = if (guasto == null) {
                Esito(Frasi.t("gruppi.aggiungi.fatto", mapOf("nome" to nome)), false)
            } else {
                // Due passi: se è fra i membri, è il secondo che non è riuscito,
                // e la si fa entrare dopo dalla sua riga.
                val dentro = membri.any { it.persona.username == persona.username }
                Esito(
                    if (dentro) percheNonEntra(guasto, nome) else percheNo(guasto, Frasi.t("gruppi.aggiungi.errore")),
                    true,
                )
            }
        }
    }

    fun faiEntrare(m: MembroDelGruppo) {
        val nome = nomeDellaPersona(m.persona)
        gesto(
            Frasi.t("gruppi.entra.lavoro", mapOf("nome" to nome)),
            { it.faiEntrare(conversazione.id, m.persona.id) },
        ) { guasto ->
            esito = if (guasto == null) {
                Esito(Frasi.t("gruppi.entra.fatto", mapOf("nome" to nome)), false)
            } else {
                Esito(percheNonEntra(guasto, nome), true)
            }
        }
    }

    fun togli(m: MembroDelGruppo) {
        val nome = nomeDellaPersona(m.persona)
        gesto(
            Frasi.t("gruppi.togli.lavoro", mapOf("nome" to nome)),
            { it.togliMembro(conversazione.id, m.persona.id) },
        ) { guasto ->
            esito = when {
                guasto == null -> Esito(Frasi.t("gruppi.togli.fatto", mapOf("nome" to nome)), false)
                // Non è più fra i membri, ma la sua foglia è rimasta: finché c'è, legge.
                membri.none { it.persona.id == m.persona.id } ->
                    Esito(Frasi.t("gruppi.togli.a_meta", mapOf("nome" to nome)), true)
                else -> Esito(percheNo(guasto, Frasi.t("gruppi.togli.errore")), true)
            }
        }
    }

    fun esci() {
        lavoro = Frasi.t("gruppi.esci.lavoro")
        esito = null
        ambito.launch {
            try {
                casa.sessioniPronte().esci(conversazione.id)
                lavoro = null
                onUscita()
            } catch (e: Exception) {
                lavoro = null
                esito = Esito(percheNo(e, Frasi.t("gruppi.esci.errore")), true)
            }
        }
    }

    val occupato = lavoro != null

    Scaffold(
        modifier = modifier,
        topBar = {
            Column {
                TopAppBar(
                    title = { Text(Frasi.t("gruppi.membri.voce")) },
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
        LazyColumn(Modifier.padding(margini).fillMaxSize(), contentPadding = PaddingValues(vertical = 8.dp)) {
            item(key = "testa") {
                Column(
                    Modifier.fillMaxWidth().padding(16.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Box(Modifier.size(64.dp), contentAlignment = Alignment.Center) {
                        Box(Modifier.scale(1.6f)) { Iniziale(nomeGruppo, conversazione.id) }
                    }
                    Text(nomeGruppo, style = MaterialTheme.typography.headlineSmall, textAlign = TextAlign.Center)
                    Text(persone, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }

            val avviso = lavoro?.let { Esito(it, false) } ?: esito
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

            item(key = "titolo") {
                Text(
                    titoloMembri,
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 4.dp),
                )
            }
            if (carico && membri.isEmpty()) {
                item(key = "carico") {
                    Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }
                }
            }
            items(membri, key = { it.membro }) { m ->
                RigaMembro(
                    membro = m,
                    io = io,
                    puoFarEntrare = gestisce && !occupato && m.dispositivi == 0u,
                    puoTogliere = gestisce && !occupato && m.persona.id != io?.id,
                    onFaiEntrare = { faiEntrare(m) },
                    onTogli = { daTogliere = m },
                )
            }
            if (gestisce) {
                item(key = "aggiungi") {
                    ListItem(
                        headlineContent = {
                            Text(Frasi.t("gruppi.aggiungi.voce"), color = MaterialTheme.colorScheme.primary)
                        },
                        leadingContent = {
                            Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) {
                                Icon(Icons.Filled.Add, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                            }
                        },
                        modifier = Modifier.clickable(enabled = !occupato) {
                            chi = ""
                            aggiungendo = true
                        },
                    )
                }
            }
            item(key = "piede") {
                Text(
                    piede,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                )
            }
            item(key = "riga") { HorizontalDivider(Modifier.padding(vertical = 8.dp)) }
            item(key = "esci") {
                if (conversazione.congelata) {
                    Text(
                        Frasi.t("gruppi.trasloco.congelato"),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(16.dp),
                    )
                } else {
                    ListItem(
                        headlineContent = { Text(Frasi.t("gruppi.esci.voce"), color = MaterialTheme.colorScheme.error) },
                        supportingContent = { Text(Frasi.t("gruppi.esci.nota")) },
                        leadingContent = {
                            Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) {
                                Icon(
                                    Icons.AutoMirrored.Filled.ExitToApp,
                                    contentDescription = null,
                                    tint = MaterialTheme.colorScheme.error,
                                )
                            }
                        },
                        modifier = Modifier.clickable(enabled = !occupato) { esco = true },
                    )
                }
            }
        }
    }

    if (aggiungendo) {
        AlertDialog(
            onDismissRequest = { aggiungendo = false },
            title = { Text(Frasi.t("gruppi.aggiungi.cerca")) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(Frasi.t("gruppi.aggiungi.spiegazione"), style = MaterialTheme.typography.bodyMedium)
                    OutlinedTextField(
                        value = chi,
                        onValueChange = { chi = it },
                        placeholder = { Text(Frasi.t("messaggi.cerca.segnaposto")) },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(
                            capitalization = KeyboardCapitalization.None,
                            autoCorrectEnabled = false,
                        ),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Text(
                        Frasi.t("app_messaggi.chi.aiuto"),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        aggiungendo = false
                        aggiungi()
                    },
                    enabled = personaDaInvitare(chi) != null,
                ) {
                    Text(Frasi.t("gruppi.aggiungi.conferma"))
                }
            },
            dismissButton = { TextButton(onClick = { aggiungendo = false }) { Text(Frasi.t("comune.annulla")) } },
        )
    }

    daTogliere?.let { m ->
        val nome = mapOf("nome" to nomeDellaPersona(m.persona))
        AlertDialog(
            onDismissRequest = { daTogliere = null },
            title = { Text(Frasi.t("gruppi.togli.titolo", nome)) },
            text = { Text(Frasi.t("gruppi.togli.testo", nome)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        daTogliere = null
                        togli(m)
                    },
                ) {
                    Text(Frasi.t("gruppi.togli.conferma"), color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = { daTogliere = null }) { Text(Frasi.t("comune.annulla")) } },
        )
    }

    if (esco) {
        AlertDialog(
            onDismissRequest = { esco = false },
            title = { Text(Frasi.t("gruppi.esci.titolo")) },
            text = { Text(Frasi.t("gruppi.esci.testo")) },
            confirmButton = {
                TextButton(
                    onClick = {
                        esco = false
                        esci()
                    },
                ) {
                    Text(Frasi.t("gruppi.esci.conferma"), color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = { esco = false }) { Text(Frasi.t("comune.annulla")) } },
        )
    }
}

@Composable
private fun RigaMembro(
    membro: MembroDelGruppo,
    io: Io?,
    puoFarEntrare: Boolean,
    puoTogliere: Boolean,
    onFaiEntrare: () -> Unit,
    onTogli: () -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    val nome = nomeDellaPersona(membro.persona)
    val ruolo = when (membro.persona.ruolo) {
        "creatore" -> Frasi.t("gruppi.ruolo.creatore")
        "amministratore" -> Frasi.t("gruppi.ruolo.amministratore")
        else -> null
    }
    ListItem(
        headlineContent = {
            Text(
                if (membro.persona.id == io?.id) Frasi.t("gruppi.membri.tu", mapOf("nome" to nome)) else nome,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        },
        supportingContent = {
            if (membro.dispositivi == 0u) {
                Text(Frasi.t("gruppi.membri.non_entrato"), color = MaterialTheme.colorScheme.error)
            } else {
                Text("@${membro.persona.username}", maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        },
        leadingContent = { Iniziale(nome, membro.persona.id) },
        trailingContent = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (ruolo != null) {
                    Surface(color = MaterialTheme.colorScheme.secondaryContainer, shape = RoundedCornerShape(50)) {
                        Text(
                            ruolo,
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
                        )
                    }
                }
                if (puoFarEntrare || puoTogliere) {
                    Box {
                        IconButton(onClick = { menu = true }) {
                            Icon(Icons.Filled.MoreVert, contentDescription = Frasi.t("comune.altre_azioni"))
                        }
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            if (puoFarEntrare) {
                                DropdownMenuItem(
                                    text = { Text(Frasi.t("gruppi.entra.voce")) },
                                    onClick = {
                                        menu = false
                                        onFaiEntrare()
                                    },
                                )
                            }
                            if (puoTogliere) {
                                DropdownMenuItem(
                                    text = { Text(Frasi.t("gruppi.togli.voce"), color = MaterialTheme.colorScheme.error) },
                                    onClick = {
                                        menu = false
                                        onTogli()
                                    },
                                )
                            }
                        }
                    }
                }
            }
        },
    )
}
