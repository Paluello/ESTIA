import { Fragment, useRef, useState } from "react";
import { NavLink } from "react-router-dom";

import { useNotifiche } from "../notifiche.js";
import { useApp } from "../state.js";
import { Icon, type IconName } from "../ui/index.js";
import { destinazioni } from "./destinazioni.js";
import { MenuAltro } from "./MenuAltro.js";
import { t, useT } from "../lingua.js";

/**
 * La navigazione desktop, stile Threads: icone ed etichette in colonna.
 *
 * Compare da 600px, in overlay fisso a sinistra (non sposta il contenuto).
 * Cerca e impostazioni stanno qui (sul telefono sono in alto). In fondo «Altro»
 * apre lo stesso menù del burger.
 *
 * La disposizione in gruppi sta qui, non nelle voci: prima il fare (bacheca,
 * pubblicare, cercare), un respiro, poi le persone (messaggi, notifiche,
 * profilo), un respiro, in fondo il sistema. Le voci restano dichiarate una
 * volta sola in `destinazioni`: qui c'è solo l'ordine e il raggruppamento.
 */
// Le voci si riconoscono dall'icona, che non cambia con la lingua.
const GRUPPI: readonly { id: string; voci: readonly IconName[] }[] = [
  { id: "fare", voci: ["home", "plus", "search"] },
  { id: "persone", voci: ["send", "bell", "user"] },
  { id: "sistema", voci: ["settings"] },
];

export function Sidebar(): React.ReactElement {
  useT();
  const { instance, user } = useApp();
  const { nuove } = useNotifiche();
  const [menu, setMenu] = useState(false);
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const elenco = destinazioni(user?.username ?? "");
  const gruppi = GRUPPI.map((gruppo) => ({
    id: gruppo.id,
    voci: gruppo.voci.map((nome) => {
      const voce = elenco.find((d) => d.icona === nome);
      if (voce === undefined) {
        throw new Error(`La sidebar chiama una voce che non esiste più: «${nome}»`);
      }
      return voce;
    }),
  }));

  return (
    <>
      <div className="sidebar">
        <NavLink aria-label="ESTIA" className="sidebar__brand" end title="ESTIA" to="/">
          <Icon name="instance" size={20} />
          <span className="sidebar__label">ESTIA</span>
        </NavLink>
        <div className="sidebar__instance">{instance.name}</div>

        <nav aria-label={t("nav.etichetta")} className="sidebar__nav">
          {gruppi.map((gruppo, indice) => (
            <Fragment key={gruppo.id}>
              {indice > 0 && <div aria-hidden="true" className="sidebar__stacco" />}
              {gruppo.voci.map((destinazione) => (
                <NavLink
                  aria-label={
                    destinazione.icona === "bell" && nuove > 0
                      ? t("nav.notifiche_nuove", { voce: destinazione.etichetta, n: nuove })
                      : destinazione.etichetta
                  }
                  className="sidebar__item"
                  end={destinazione.esatta}
                  key={destinazione.to}
                  title={destinazione.etichetta}
                  to={destinazione.to}
                >
                  <span className="sidebar__icona">
                    <Icon name={destinazione.icona} size={20} />
                    {destinazione.icona === "bell" && nuove > 0 && (
                      <span aria-hidden="true" className="pallino">
                        {nuove > 99 ? "99+" : nuove}
                      </span>
                    )}
                  </span>
                  <span className="sidebar__label">{destinazione.etichetta}</span>
                </NavLink>
              ))}
            </Fragment>
          ))}
        </nav>

        <div className="sidebar__spacer" />

        <button
          aria-expanded={menu}
          aria-haspopup="dialog"
          aria-label={t("nav.altro")}
          className="sidebar__item sidebar__altro"
          onClick={() => setMenu(true)}
          ref={menuAnchor}
          title={t("nav.altro")}
          type="button"
        >
          <Icon name="menu" size={20} />
          <span className="sidebar__label">{t("nav.altro")}</span>
        </button>
      </div>

      <MenuAltro anchorRef={menuAnchor} onClose={() => setMenu(false)} open={menu} />
    </>
  );
}
