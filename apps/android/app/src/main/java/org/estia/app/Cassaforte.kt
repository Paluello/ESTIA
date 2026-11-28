// La cassaforte del telefono (ADR 0044 §2, S6), il `Deposito` del nucleo.
//
// Una chiave AES-256 generata dentro l'Android Keystore, che non ne esce mai.
// I file del nucleo stanno in noBackupFilesDir, sigillati con AES-GCM e il loro
// nome come dato autenticato. Il backup è spento nel manifesto: su un telefono
// nuovo non si aprirebbero. Disinstallare toglie chiave e file insieme, quindi
// reinstallare fa un dispositivo nuovo (ADR 0044, verifica 4).

package org.estia.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.estia.nucleo.Deposito
import org.estia.nucleo.ErroreNucleo

class Cassaforte(context: Context) : Deposito {
    private val cartella = File(context.noBackupFilesDir, "cassaforte")
    private val chiave: SecretKey
    private val serratura = Any()

    init {
        val esistente = chiaveDelKeystore()
        if (esistente == null) {
            // File senza la loro chiave non si apriranno mai più.
            cartella.deleteRecursively()
        }
        cartella.mkdirs()
        chiave = esistente ?: nuovaChiave()
    }

    override fun leggi(nome: String): ByteArray? {
        synchronized(serratura) {
            val file = file(nome)
            if (!file.exists()) return null
            try {
                val dati = file.readBytes()
                val cifrario = Cipher.getInstance(TRASFORMAZIONE)
                cifrario.init(Cipher.DECRYPT_MODE, chiave, GCMParameterSpec(128, dati, 0, LUNGHEZZA_IV))
                cifrario.updateAAD(nome.toByteArray())
                return cifrario.doFinal(dati, LUNGHEZZA_IV, dati.size - LUNGHEZZA_IV)
            } catch (e: Exception) {
                throw ErroreNucleo.Deposito("$nome: ${e.message}")
            }
        }
    }

    override fun scrivi(nome: String, dati: ByteArray) {
        synchronized(serratura) {
            try {
                // L'IV lo sceglie il Keystore, a caso, a ogni cifratura.
                val cifrario = Cipher.getInstance(TRASFORMAZIONE)
                cifrario.init(Cipher.ENCRYPT_MODE, chiave)
                cifrario.updateAAD(nome.toByteArray())
                val sigillato = cifrario.iv + cifrario.doFinal(dati)
                val file = file(nome)
                val provvisorio = File(cartella, "${file.name}.nuovo")
                provvisorio.writeBytes(sigillato)
                if (!provvisorio.renameTo(file)) error("rinomina non riuscita")
            } catch (e: Exception) {
                throw ErroreNucleo.Deposito("$nome: ${e.message}")
            }
        }
    }

    /** Il nome del nucleo contiene «/»: sul disco diventa esadecimale. */
    private fun file(nome: String) =
        File(cartella, nome.toByteArray().joinToString("") { "%02x".format(it) })

    private companion object {
        const val ALIAS = "org.estia.app.cassaforte"
        const val TRASFORMAZIONE = "AES/GCM/NoPadding"
        const val LUNGHEZZA_IV = 12

        fun chiaveDelKeystore(): SecretKey? {
            val keystore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            return keystore.getKey(ALIAS, null) as SecretKey?
        }

        fun nuovaChiave(): SecretKey {
            val generatore = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            generatore.init(
                KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build(),
            )
            return generatore.generateKey()
        }
    }
}
