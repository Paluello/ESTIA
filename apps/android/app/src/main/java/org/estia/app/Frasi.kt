// Le frasi dell'app vengono dalla stessa tabella del web, `packages/lingue`
// (ADR 0046, ADR 0051 §5): `scripts/prepara.sh` copia i JSON negli asset, e qui
// si leggono con le stesse regole di `packages/lingue/src/index.ts`. Una
// chiave senza frase nella lingua scelta cade sull'inglese, mai sulla chiave.

package org.estia.app

import android.content.Context
import org.json.JSONObject

object Frasi {
    private val disponibili = listOf("it", "en")
    private const val RIFERIMENTO = "en"

    @Volatile private var tabelle: Map<String, Map<String, String>> = emptyMap()

    /** La prima lingua del telefono che ESTIA conosce, altrimenti l'inglese. */
    var lingua: String = RIFERIMENTO
        private set

    fun carica(context: Context) {
        if (tabelle.isNotEmpty()) return
        tabelle = disponibili.associateWith { codice ->
            runCatching {
                val testo = context.assets.open("frasi/frasi-$codice.json").bufferedReader().use { it.readText() }
                val oggetto = JSONObject(testo)
                oggetto.keys().asSequence().associateWith { oggetto.getString(it) }
            }.getOrDefault(emptyMap())
        }
        val locali = context.resources.configuration.locales
        lingua = (0 until locali.size()).map { locali[it].language }.firstOrNull { it in disponibili } ?: RIFERIMENTO
    }

    fun t(chiave: String, valori: Map<String, String> = emptyMap()): String {
        var frase = tabelle[lingua]?.get(chiave) ?: tabelle[RIFERIMENTO]?.get(chiave) ?: chiave
        for ((nome, valore) in valori) frase = frase.replace("{$nome}", valore)
        return frase
    }
}
