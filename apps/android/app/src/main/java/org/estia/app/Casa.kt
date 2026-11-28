// Lo stato dell'app: se il telefono è già entrato in una Casa, e il
// collegamento con cui le parla. Tutto il resto lo chiedono le schermate.

package org.estia.app

import android.app.Application
import android.os.Build
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.estia.nucleo.Collegamento

@Serializable
data class Utente(val id: String, val username: String, val displayName: String)

@Serializable
data class Autore(val id: String, val username: String, val displayName: String)

@Serializable
data class Post(
    val id: String,
    val author: Autore,
    val body: String,
    val createdAt: String,
    val likeCount: Int = 0,
    val commentCount: Int = 0,
)

@Serializable
data class PaginaBacheca(val posts: List<Post>, val nextCursor: String? = null)

/** La Casa ha risposto con uno stato che non è 2xx, o non ha risposto. */
class ErroreCasa(val stato: Int?, val codice: String?) : Exception("casa: $stato $codice")

sealed interface Fase {
    data object Avvio : Fase
    data object Ingresso : Fase
    data object Dentro : Fase

    /** La cassaforte non si apre: le chiavi non avrebbero dove stare. */
    data class Guasto(val motivo: String) : Fase
}

class Casa(applicazione: Application) : AndroidViewModel(applicazione) {
    private val json = Json { ignoreUnknownKeys = true }
    private var collegamento: Collegamento? = null

    private val _fase = MutableStateFlow<Fase>(Fase.Avvio)
    val fase: StateFlow<Fase> = _fase.asStateFlow()

    private val _utente = MutableStateFlow<Utente?>(null)
    val utente: StateFlow<Utente?> = _utente.asStateFlow()

    /** Un collegamento `estia://ingresso` arrivato da fuori, per la schermata d'ingresso. */
    val collegamentoArrivato = MutableStateFlow<String?>(null)

    init {
        viewModelScope.launch {
            try {
                val cassaforte = withContext(Dispatchers.IO) { Cassaforte(getApplication()) }
                val aperto = Collegamento.apri(cassaforte)
                collegamento = aperto
                if (aperto.casa() == null) {
                    _fase.value = Fase.Ingresso
                } else {
                    _fase.value = Fase.Dentro
                    aggiornaUtente()
                }
            } catch (e: Exception) {
                _fase.value = Fase.Guasto(e.message ?: e.javaClass.simpleName)
            }
        }
    }

    suspend fun entra(testo: String) {
        val aperto = collegamento ?: throw ErroreCasa(null, null)
        val ingresso = aperto.entra(testo.trim(), "${Build.MANUFACTURER} ${Build.MODEL}".trim())
        _utente.value = runCatching { json.decodeFromString(Utente.serializer(), ingresso.utente) }.getOrNull()
        _fase.value = Fase.Dentro
        aggiornaUtente()
    }

    fun esci() {
        viewModelScope.launch {
            runCatching { collegamento?.dimenticaCasa() }
            _utente.value = null
            _fase.value = Fase.Ingresso
        }
    }

    /** Una richiesta dell'API dei membri, sul filo verso la Casa. */
    suspend fun <T> chiedi(tipo: KSerializer<T>, metodo: String, percorso: String): T {
        val aperto = collegamento ?: throw ErroreCasa(null, null)
        val risposta = try {
            aperto.chiedi(metodo, percorso, mapOf("accept" to "application/json"), ByteArray(0))
        } catch (e: Exception) {
            throw ErroreCasa(null, null)
        }
        val stato = risposta.stato.toInt()
        val testo = risposta.corpo.decodeToString()
        if (stato !in 200..299) {
            val codice = runCatching {
                json.parseToJsonElement(testo).jsonObject["code"]?.jsonPrimitive?.contentOrNull
            }.getOrNull()
            throw ErroreCasa(stato, codice)
        }
        return json.decodeFromString(tipo, testo)
    }

    private suspend fun aggiornaUtente() {
        runCatching { chiedi(Utente.serializer(), "GET", "/api/v1/auth/me") }.onSuccess { _utente.value = it }
    }
}
