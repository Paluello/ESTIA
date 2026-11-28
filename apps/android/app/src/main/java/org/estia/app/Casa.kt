// Lo stato dell'app: se il telefono è già entrato in una Casa, e il
// collegamento con cui le parla. Tutto il resto lo chiedono le schermate.

package org.estia.app

import android.app.Application
import android.os.Build
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.estia.nucleo.Collegamento
import org.estia.nucleo.DomandaDiEntrare
import org.estia.nucleo.Sessioni

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

    /**
     * Ha chiesto di entrare con un invito, e l'amministratore non ha ancora
     * deciso: appena dice di sì, questa chiave è dentro.
     */
    data object InAttesa : Fase
    data object Dentro : Fase

    /** La cassaforte non si apre: le chiavi non avrebbero dove stare. */
    data class Guasto(val motivo: String) : Fase
}

class Casa(applicazione: Application) : AndroidViewModel(applicazione) {
    private val json = Json { ignoreUnknownKeys = true }
    private var collegamento: Collegamento? = null
    private var cassaforte: Cassaforte? = null

    /** Le conversazioni MLS, aperte la prima volta che servono. */
    private var sessioni: Sessioni? = null
    private val serraturaSessioni = Mutex()

    private val _fase = MutableStateFlow<Fase>(Fase.Avvio)
    val fase: StateFlow<Fase> = _fase.asStateFlow()

    private val _utente = MutableStateFlow<Utente?>(null)
    val utente: StateFlow<Utente?> = _utente.asStateFlow()

    /** Un collegamento `estia://ingresso` arrivato da fuori, per la schermata d'ingresso. */
    val collegamentoArrivato = MutableStateFlow<String?>(null)

    init {
        viewModelScope.launch {
            try {
                val aperta = withContext(Dispatchers.IO) { Cassaforte(getApplication()) }
                cassaforte = aperta
                val aperto = Collegamento.apri(aperta)
                collegamento = aperto
                when {
                    aperto.casa() != null -> {
                        _fase.value = Fase.Dentro
                        aggiornaUtente()
                    }
                    aperto.inAttesa() != null -> {
                        _fase.value = Fase.InAttesa
                        aspetta()
                    }
                    else -> _fase.value = Fase.Ingresso
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

    /**
     * La domanda con il QR d'invito (`estia://invito`), per chi non è ancora
     * membro. Se la Casa la registra si aspetta l'amministratore.
     */
    suspend fun chiediDiEntrare(testo: String, username: String, password: String, nome: String, messaggio: String) {
        val aperto = collegamento ?: throw ErroreCasa(null, null)
        aperto.chiediDiEntrare(
            testo.trim(),
            DomandaDiEntrare(
                username = username,
                password = password,
                nome = nome.ifBlank { null },
                messaggio = messaggio.ifBlank { null },
            ),
            "${Build.MANUFACTURER} ${Build.MODEL}".trim(),
        )
        _fase.value = Fase.InAttesa
        aspetta()
    }

    /** Se l'amministratore ha già detto di sì. Non dice mai di no: la Casa non lo dice. */
    suspend fun controllaRichiesta() {
        val aperto = collegamento ?: return
        if (_fase.value != Fase.InAttesa) return
        val ingresso = runCatching { aperto.controllaRichiesta() }.getOrNull() ?: return
        _utente.value = runCatching { json.decodeFromString(Utente.serializer(), ingresso.utente) }.getOrNull()
        _fase.value = Fase.Dentro
        aggiornaUtente()
    }

    fun smettiDiAspettare() {
        runCatching { collegamento?.dimenticaRichiesta() }
        attesa?.cancel()
        _fase.value = Fase.Ingresso
    }

    private var attesa: Job? = null

    /** Riprova ogni venti secondi finché la fase resta «in attesa». */
    private fun aspetta() {
        attesa?.cancel()
        attesa = viewModelScope.launch {
            while (_fase.value == Fase.InAttesa) {
                delay(20_000)
                controllaRichiesta()
            }
        }
    }

    fun esci() {
        viewModelScope.launch {
            runCatching { collegamento?.dimenticaCasa() }
            serraturaSessioni.withLock { sessioni = null }
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

    /**
     * Prepara il dispositivo per le conversazioni (identità MLS, chiave di
     * firma, KeyPackage) la prima volta, poi restituisce sempre le stesse.
     */
    suspend fun sessioniPronte(): Sessioni = serraturaSessioni.withLock {
        sessioni ?: run {
            val aperto = collegamento ?: throw ErroreCasa(null, null)
            val deposito = cassaforte ?: throw ErroreCasa(null, null)
            Sessioni.apri(aperto, deposito).also { sessioni = it }
        }
    }

    private suspend fun aggiornaUtente() {
        runCatching { chiedi(Utente.serializer(), "GET", "/api/v1/auth/me") }.onSuccess { _utente.value = it }
    }
}
