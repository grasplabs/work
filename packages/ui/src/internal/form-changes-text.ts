import { textIn } from "./language.ts";
import type { Texts } from "./language.ts";

// What a record form's changes list (`FormChanges`) says, and how it says
// a field's value, in the page's language.

/** What `FormChanges` says, in each language the frontend speaks. */
export interface ChangesText {
  readonly title: string;
  readonly waiting: string;
  readonly latest: string;
  readonly yours: string;
  readonly reapply: string;
  /** A text field left empty. */
  readonly empty: string;
  /** A field with no value at all (`null`, or left out). */
  readonly none: string;
}

const englishChanges: ChangesText = {
  title: "This changed since you started editing",
  waiting: "Loading the latest version…",
  latest: "Latest version",
  yours: "Yours",
  reapply: "Re-apply my changes to the latest version",
  empty: "(empty)",
  none: "(no value)",
};

export const changesTexts: Texts<ChangesText> = {
  en: englishChanges,
  de: {
    title: "Das hat sich geändert, seit Sie mit der Bearbeitung begonnen haben",
    waiting: "Die neueste Version wird geladen…",
    latest: "Neueste Version",
    yours: "Ihre",
    reapply: "Meine Änderungen auf die neueste Version anwenden",
    empty: "(leer)",
    none: "(kein Wert)",
  },
  nl: {
    title: "Dit is veranderd sinds je begon met bewerken",
    waiting: "De nieuwste versie wordt geladen…",
    latest: "Nieuwste versie",
    yours: "Die van jou",
    reapply: "Mijn wijzigingen opnieuw toepassen op de nieuwste versie",
    empty: "(leeg)",
    none: "(geen waarde)",
  },
  es: {
    title: "Esto ha cambiado desde que empezaste a editar",
    waiting: "Cargando la versión más reciente…",
    latest: "Versión más reciente",
    yours: "La tuya",
    reapply: "Volver a aplicar mis cambios a la versión más reciente",
    empty: "(vacío)",
    none: "(sin valor)",
  },
  fr: {
    title: "Ceci a changé depuis que vous avez commencé à modifier",
    waiting: "Chargement de la dernière version…",
    latest: "Dernière version",
    yours: "La vôtre",
    reapply: "Réappliquer mes modifications à la dernière version",
    empty: "(vide)",
    none: "(aucune valeur)",
  },
};

/**
 * What `FormChanges` says in `language` (a document's `lang`, such as
 * the frame's, which the page sets to its own), English for any other.
 */
export const changesTextFor = (language: string): ChangesText =>
  textIn(changesTexts, language);

/**
 * A field's value as text to read: text as it is, an empty text and no
 * value each said apart, anything else as JSON.
 */
export const shownValue = (value: unknown, text: ChangesText): string => {
  if (typeof value === "string") {
    return value === "" ? text.empty : value;
  }
  if (value === null || value === undefined) {
    return text.none;
  }
  return JSON.stringify(value) ?? text.none;
};
