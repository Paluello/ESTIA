// Dentro la Casa: la barra di navigazione di Material 3, con le sue
// transizioni, e una schermata per scheda (ADR 0051 §1).

package org.estia.app.schermate

import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import org.estia.app.Casa
import org.estia.app.Frasi

private data class Scheda(val frase: String, val piena: ImageVector, val vuota: ImageVector)

private val schede = listOf(
    Scheda("nav.home", Icons.Filled.Home, Icons.Outlined.Home),
    Scheda("nav.profilo", Icons.Filled.AccountCircle, Icons.Outlined.AccountCircle),
)

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun Dentro(casa: Casa) {
    var scelta by rememberSaveable { mutableIntStateOf(0) }
    Scaffold(
        // I margini di sistema li prendono le barre in alto di ogni scheda.
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        bottomBar = {
            NavigationBar {
                schede.forEachIndexed { indice, scheda ->
                    val etichetta = Frasi.t(scheda.frase)
                    NavigationBarItem(
                        selected = scelta == indice,
                        onClick = { scelta = indice },
                        icon = { Icon(if (scelta == indice) scheda.piena else scheda.vuota, contentDescription = null) },
                        label = { Text(etichetta) },
                    )
                }
            }
        },
    ) { margini ->
        val modificatore = Modifier.padding(margini).consumeWindowInsets(margini)
        when (scelta) {
            0 -> Bacheca(casa, modificatore)
            else -> Profilo(casa, modificatore)
        }
    }
}
