// Colori e caratteri dello studio dell'interfaccia («la casa con la luce
// accesa»), dagli stessi token dell'app iPhone: stessi ruoli, valori chiari e
// scuri, ocra come accento. I componenti restano quelli di Material 3, con i
// loro gesti e le loro transizioni (ADR 0051 §1): qui si danno solo colori e
// caratteri.

package org.estia.app.aspetto

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import org.estia.app.R

private val chiaro = lightColorScheme(
    primary = Color(0xFFEDB03A),
    onPrimary = Color(0xFF221803),
    primaryContainer = Color(0xFFF6E3B4),
    onPrimaryContainer = Color(0xFF6B4700),
    secondaryContainer = Color(0xFFF6E3B4),
    onSecondaryContainer = Color(0xFF221803),
    tertiary = Color(0xFF7A5200),
    background = Color(0xFFFBFAF6),
    onBackground = Color(0xFF1B2420),
    surface = Color(0xFFFBFAF6),
    onSurface = Color(0xFF1B2420),
    surfaceVariant = Color(0xFFF3F0E8),
    onSurfaceVariant = Color(0xFF59605B),
    surfaceContainerLowest = Color(0xFFFFFFFF),
    surfaceContainerLow = Color(0xFFFFFFFF),
    surfaceContainer = Color(0xFFF3F0E8),
    surfaceContainerHigh = Color(0xFFF3F0E8),
    surfaceContainerHighest = Color(0xFFECE8DD),
    outline = Color(0xFFE4E0D4),
    outlineVariant = Color(0xFFE4E0D4),
    error = Color(0xFFA6322A),
    errorContainer = Color(0xFFFBEAE7),
    onErrorContainer = Color(0xFFA6322A),
)

private val scuro = darkColorScheme(
    primary = Color(0xFFF0B84A),
    onPrimary = Color(0xFF1F1603),
    primaryContainer = Color(0xFF3B2E0E),
    onPrimaryContainer = Color(0xFFEBC56E),
    secondaryContainer = Color(0xFF3B2E0E),
    onSecondaryContainer = Color(0xFFEBC56E),
    tertiary = Color(0xFFF0B84A),
    background = Color(0xFF111715),
    onBackground = Color(0xFFEEF0EA),
    surface = Color(0xFF111715),
    onSurface = Color(0xFFEEF0EA),
    surfaceVariant = Color(0xFF202A26),
    onSurfaceVariant = Color(0xFFA5AFA9),
    surfaceContainerLowest = Color(0xFF111715),
    surfaceContainerLow = Color(0xFF171F1C),
    surfaceContainer = Color(0xFF171F1C),
    surfaceContainerHigh = Color(0xFF202A26),
    surfaceContainerHighest = Color(0xFF2A3531),
    outline = Color(0xFF2A3531),
    outlineVariant = Color(0xFF2A3531),
    error = Color(0xFFEE8A7F),
    errorContainer = Color(0xFF2A1512),
    onErrorContainer = Color(0xFFEE8A7F),
)

/** Besley solo per i titoli, a peso 600. */
@OptIn(ExperimentalTextApi::class)
val Besley = FontFamily(
    Font(
        R.font.besley,
        weight = FontWeight.SemiBold,
        variationSettings = FontVariation.Settings(FontVariation.weight(600)),
    ),
)

/** Atkinson Hyperlegible Next per tutto ciò che si legge. */
@OptIn(ExperimentalTextApi::class)
val Atkinson = FontFamily(
    listOf(FontWeight.Normal, FontWeight.Medium, FontWeight.SemiBold, FontWeight.Bold).flatMap { peso ->
        listOf(
            Font(
                R.font.atkinson_hyperlegible_next,
                weight = peso,
                variationSettings = FontVariation.Settings(FontVariation.weight(peso.weight)),
            ),
            Font(
                R.font.atkinson_hyperlegible_next_italic,
                weight = peso,
                style = FontStyle.Italic,
                variationSettings = FontVariation.Settings(FontVariation.weight(peso.weight)),
            ),
        )
    },
)

private fun Typography.conCaratteri(): Typography {
    fun titolo(stile: TextStyle) = stile.copy(fontFamily = Besley, fontWeight = FontWeight.SemiBold)
    fun corpo(stile: TextStyle) = stile.copy(fontFamily = Atkinson)
    return copy(
        displayLarge = titolo(displayLarge),
        displayMedium = titolo(displayMedium),
        displaySmall = titolo(displaySmall),
        headlineLarge = titolo(headlineLarge),
        headlineMedium = titolo(headlineMedium),
        headlineSmall = titolo(headlineSmall),
        titleLarge = titolo(titleLarge),
        titleMedium = corpo(titleMedium),
        titleSmall = corpo(titleSmall),
        bodyLarge = corpo(bodyLarge),
        bodyMedium = corpo(bodyMedium),
        bodySmall = corpo(bodySmall),
        labelLarge = corpo(labelLarge),
        labelMedium = corpo(labelMedium),
        labelSmall = corpo(labelSmall),
    )
}

private val caratteri = Typography().conCaratteri()

@Composable
fun EstiaTema(contenuto: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) scuro else chiaro,
        typography = caratteri,
        content = contenuto,
    )
}
