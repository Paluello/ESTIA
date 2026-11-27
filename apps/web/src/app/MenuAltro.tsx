import { useEffect, useState } from "react";
import type { RefObject } from "react";

import {
  applicaPreferenze,
  leggiPreferenze,
  scriviPreferenzeLocali,
  type Aspetto,
  type UiPreferences,
} from "../aspetto.js";
import { api } from "../api.js";
import { useApp } from "../state.js";
import { Choice, ListRow, Live, Sheet } from "../ui/index.js";
import { t, useT } from "../lingua.js";

/**
 * Il menù «altro»: impostazioni, aspetto rapido, esci.
 *
 * Sta dietro il burger in alto a sinistra sul telefono, e dietro «Altro» in
 * fondo alla sidebar sul desktop. Non è un cassetto di navigazione primaria:
 * è ciò che non ha bisogno di un posto fisso nella barra.
 */
export function MenuAltro({
  open,
  onClose,
  anchorRef,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
}): React.ReactElement {
  useT();
  const { signOut, token, user, refreshUser } = useApp();
  const [prefs, setPrefs] = useState<UiPreferences>(() => user?.appearance ?? leggiPreferenze());
  const [lavoro, setLavoro] = useState<string | undefined>();

  useEffect(() => {
    if (user?.appearance !== undefined) {
      setPrefs(user.appearance);
      applicaPreferenze(user.appearance);
    }
  }, [user?.appearance]);

  const scegli = (prossimo: Aspetto): void => {
    const aggiornato = { ...prefs, aspetto: prossimo };
    setPrefs(aggiornato);
    scriviPreferenzeLocali(aggiornato);
    setLavoro(`aspetto-${prossimo}`);

    if (token === undefined) {
      setLavoro(undefined);
      return;
    }

    void (async () => {
      try {
        const salvato = await api.updateAppearance(token, aggiornato);
        setPrefs(salvato);
        scriviPreferenzeLocali(salvato);
        await refreshUser();
      } catch {
        const ripristino = user?.appearance ?? leggiPreferenze();
        setPrefs(ripristino);
        applicaPreferenze(ripristino);
        scriviPreferenzeLocali(ripristino);
      } finally {
        setLavoro(undefined);
      }
    })();
  };

  const esci = async (): Promise<void> => {
    onClose();

    if (token !== undefined) {
      try {
        await api.logout(token);
      } catch {
        // La sessione può essere già finita.
      }
    }

    signOut();
  };

  return (
    /*
     * `title` non è una rifinitura: senza, questo `<dialog>` non ha nome
     * accessibile, e chi lo apre con lo schermo spento sente aprirsi qualcosa
     * che non si presenta. È stato così finché nessuno l'ha ascoltato.
     */
    <Sheet
      anchorRef={anchorRef}
      onClose={onClose}
      open={open}
      title={t("nav.altro")}
      variant="piccolo"
    >
      <nav aria-label={t("nav.altro")} className="menu-altro">
        <ListRow
          chevron={false}
          icon="settings"
          note={t("menu.impostazioni.nota")}
          onClick={onClose}
          title={t("nav.impostazioni")}
          to="/impostazioni"
        />
      </nav>

      <div className="menu-altro__sezione">
        <h3 className="gruppo">{t("menu.aspetto")}</h3>
        <Live>{lavoro !== undefined ? t("aspetto.salvo_aspetto") : ""}</Live>
        <Choice
          checked={prefs.aspetto === "sistema"}
          disabled={lavoro !== undefined}
          name="aspetto"
          note={lavoro === "aspetto-sistema" ? t("comune.salvo") : t("aspetto.sistema.nota")}
          onChoose={() => scegli("sistema")}
          title={t("aspetto.sistema.titolo")}
        />
        <Choice
          checked={prefs.aspetto === "chiaro"}
          disabled={lavoro !== undefined}
          name="aspetto"
          note={lavoro === "aspetto-chiaro" ? t("comune.salvo") : t("aspetto.chiaro.nota")}
          onChoose={() => scegli("chiaro")}
          title={t("aspetto.chiaro.titolo")}
        />
        <Choice
          checked={prefs.aspetto === "scuro"}
          disabled={lavoro !== undefined}
          name="aspetto"
          note={lavoro === "aspetto-scuro" ? t("comune.salvo") : t("aspetto.scuro.nota")}
          onChoose={() => scegli("scuro")}
          title={t("aspetto.scuro.titolo")}
        />
        <ListRow
          chevron={false}
          icon="settings"
          note={t("menu.altro_aspetto.nota")}
          onClick={onClose}
          title={t("menu.altro_aspetto.titolo")}
          to="/impostazioni/aspetto"
        />
      </div>

      <div className="menu-altro__sezione">
        <ListRow chevron={false} icon="logout" onClick={() => void esci()} title={t("menu.esci")} />
      </div>
    </Sheet>
  );
}
