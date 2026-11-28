// La bacheca della Casa: i post di chi vive qui (`feed=locale`, ADR 0018).

package org.estia.app.schermate

import android.text.format.DateUtils
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
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
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import java.time.Instant
import kotlinx.coroutines.launch
import org.estia.app.Casa
import org.estia.app.Frasi
import org.estia.app.PaginaBacheca
import org.estia.app.Post
import org.estia.app.aspetto.Besley

private enum class Stato { Carico, Pronto, Errore }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun Bacheca(casa: Casa, modifier: Modifier = Modifier) {
    var post by remember { mutableStateOf<List<Post>>(emptyList()) }
    var stato by remember { mutableStateOf(Stato.Carico) }
    var aggiorno by remember { mutableStateOf(false) }
    val ambito = rememberCoroutineScope()
    val barra = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()

    suspend fun carica() {
        stato = try {
            post = casa.chiedi(PaginaBacheca.serializer(), "GET", "/api/v1/posts?feed=locale").posts
            Stato.Pronto
        } catch (e: Exception) {
            Stato.Errore
        }
    }

    LaunchedEffect(Unit) { carica() }

    Scaffold(
        modifier = modifier.nestedScroll(barra.nestedScrollConnection),
        topBar = {
            LargeTopAppBar(title = { Text(Frasi.t("nav.home")) }, scrollBehavior = barra)
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
            when {
                post.isEmpty() && stato == Stato.Carico -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    CircularProgressIndicator()
                }
                post.isEmpty() && stato == Stato.Errore ->
                    Avviso(Frasi.t("feed.errore_lettura"), Frasi.t("comune.non_ha_funzionato"))
                // Il testo del web rimanda al pulsante «crea», che qui non c'è
                // ancora: si mostra solo il titolo.
                post.isEmpty() -> Avviso(Frasi.t("feed.vuoto.istanza.titolo"), "")
                else -> LazyColumn(Modifier.fillMaxSize()) {
                    items(post, key = { it.id }) { p ->
                        Riga(p)
                        HorizontalDivider(color = MaterialTheme.colorScheme.outline)
                    }
                }
            }
        }
    }
}

@Composable
private fun Riga(post: Post) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 12.dp)
            .semantics(mergeDescendants = true) {},
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Iniziale(post.author.displayName, post.author.id)
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    post.author.displayName,
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Text(
                    "@${post.author.username}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                Spacer(Modifier.weight(1f))
                quando(post.createdAt)?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Text(post.body, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurface)
        }
    }
}

/** Da quanto, nella lingua del telefono: «3 min fa». */
private fun quando(iso: String): String? = runCatching {
    DateUtils.getRelativeTimeSpanString(
        Instant.parse(iso).toEpochMilli(),
        System.currentTimeMillis(),
        DateUtils.MINUTE_IN_MILLIS,
        DateUtils.FORMAT_ABBREV_RELATIVE,
    ).toString()
}.getOrNull()

private val coloriAvatar = listOf(
    Color(0xFFF6E3B4) to Color(0xFF6B4700),
    Color(0xFFD5E6DA) to Color(0xFF1F4A39),
    Color(0xFFD7E5EE) to Color(0xFF204A62),
    Color(0xFFF3D9CF) to Color(0xFF7D2F1E),
    Color(0xFFE4DDF0) to Color(0xFF4A3A75),
    Color(0xFFE3E6C8) to Color(0xFF4A5216),
)

private val coloriAvatarScuri = listOf(
    Color(0xFF3B2E0E) to Color(0xFFEBC56E),
    Color(0xFF173326) to Color(0xFF93CFAB),
    Color(0xFF162F3D) to Color(0xFF8FC0DE),
    Color(0xFF3C1D15) to Color(0xFFEBA18D),
    Color(0xFF2A2240) to Color(0xFFC4B5EE),
    Color(0xFF2B2F12) to Color(0xFFC9D08A),
)

/** L'iniziale nel cerchio, con uno dei sei colori d'avatar scelto dalla chiave. */
@Composable
fun Iniziale(nome: String, chiave: String) {
    var somma = 0
    for (c in chiave) somma = (somma * 31 + c.code) and 0xFFFF
    val tavolozza = if (androidx.compose.foundation.isSystemInDarkTheme()) coloriAvatarScuri else coloriAvatar
    val (sfondo, testo) = tavolozza[somma % tavolozza.size]
    Surface(color = sfondo, contentColor = testo, shape = CircleShape, modifier = Modifier.size(40.dp).clearAndSetSemantics {}) {
        Box(contentAlignment = Alignment.Center) {
            Text(
                nome.take(1).uppercase(),
                fontFamily = Besley,
                style = MaterialTheme.typography.titleMedium,
            )
        }
    }
}

@Composable
fun Avviso(titolo: String, testo: String) {
    // Dentro PullToRefreshBox serve qualcosa che scorra, perché il gesto parta.
    LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center) {
        item {
            Column(
                Modifier.fillMaxWidth().padding(32.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(titolo, style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
                if (testo.isNotEmpty()) {
                    Text(
                        testo,
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                    )
                }
            }
        }
    }
}
