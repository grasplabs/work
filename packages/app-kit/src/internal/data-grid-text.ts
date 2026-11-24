import type { Texts } from "./language.ts";

/** What the data grid says, in the page's language unless the page says otherwise. */
export interface DataGridText {
  readonly search: string;
  readonly columns: string;
  readonly loadMore: string;
  readonly empty: string;
  /** When a search or filter answered nothing. */
  readonly noMatches: string;
  readonly failed: string;
  readonly tryAgain: string;
  /** A filter's choice of every value. */
  readonly all: string;
  readonly selectAll: string;
  /** A row's checkbox, by what names the row. */
  readonly selectRow: (row: string) => string;
  readonly selected: (count: number) => string;
  /** What the selected rows' actions are, as a group. */
  readonly bulkActions: string;
  readonly shown: (count: number) => string;
  /** The heading over the rows' menus. */
  readonly actions: string;
  /** A row's menu, by what names the row. */
  readonly rowActions: (row: string) => string;
  /** A cell's editor, by its column and what names the row. */
  readonly edit: (column: string, row: string) => string;
  readonly yes: string;
  readonly no: string;
  /** A file a cell holds. */
  readonly file: string;
  /** An inline edit of a number that isn't one. */
  readonly notANumber: string;
  /** An inline edit of a day or a moment that isn't one. */
  readonly notADate: string;
  /** An inline edit left empty where a value is needed. */
  readonly required: string;
  /** An action that failed without saying why. */
  readonly actionFailed: string;
}

export const dataGridTexts: Texts<DataGridText> = {
  en: {
    search: "Search",
    columns: "Columns",
    loadMore: "Load more",
    empty: "Nothing here yet.",
    noMatches: "Nothing matches.",
    failed: "This list couldn't load",
    tryAgain: "Try again",
    all: "All",
    selectAll: "Select all rows",
    selectRow: (row) => `Select ${row}`,
    selected: (count) => `${count} selected`,
    bulkActions: "Selected rows",
    shown: (count) => `${count} shown`,
    actions: "Actions",
    rowActions: (row) => `Actions for ${row}`,
    edit: (column, row) => `Edit ${column} for ${row}`,
    yes: "Yes",
    no: "No",
    file: "File",
    notANumber: "Enter a number.",
    notADate: "Enter a date.",
    required: "Enter a value.",
    actionFailed: "That didn't work.",
  },
  de: {
    search: "Suchen",
    columns: "Spalten",
    loadMore: "Mehr laden",
    empty: "Hier ist noch nichts.",
    noMatches: "Keine Treffer.",
    failed: "Diese Liste konnte nicht geladen werden",
    tryAgain: "Erneut versuchen",
    all: "Alle",
    selectAll: "Alle Zeilen auswählen",
    selectRow: (row) => `${row} auswählen`,
    selected: (count) => `${count} ausgewählt`,
    bulkActions: "Ausgewählte Zeilen",
    shown: (count) => `${count} angezeigt`,
    actions: "Aktionen",
    rowActions: (row) => `Aktionen für ${row}`,
    edit: (column, row) => `${column} für ${row} bearbeiten`,
    yes: "Ja",
    no: "Nein",
    file: "Datei",
    notANumber: "Geben Sie eine Zahl ein.",
    notADate: "Geben Sie ein Datum ein.",
    required: "Geben Sie einen Wert ein.",
    actionFailed: "Das hat nicht geklappt.",
  },
  nl: {
    search: "Zoeken",
    columns: "Kolommen",
    loadMore: "Meer laden",
    empty: "Hier staat nog niets.",
    noMatches: "Niets gevonden.",
    failed: "Deze lijst kon niet worden geladen",
    tryAgain: "Opnieuw proberen",
    all: "Alle",
    selectAll: "Alle rijen selecteren",
    selectRow: (row) => `${row} selecteren`,
    selected: (count) => `${count} geselecteerd`,
    bulkActions: "Geselecteerde rijen",
    shown: (count) => `${count} getoond`,
    actions: "Acties",
    rowActions: (row) => `Acties voor ${row}`,
    edit: (column, row) => `${column} van ${row} bewerken`,
    yes: "Ja",
    no: "Nee",
    file: "Bestand",
    notANumber: "Vul een getal in.",
    notADate: "Vul een datum in.",
    required: "Vul een waarde in.",
    actionFailed: "Dat is niet gelukt.",
  },
  es: {
    search: "Buscar",
    columns: "Columnas",
    loadMore: "Cargar más",
    empty: "Aún no hay nada aquí.",
    noMatches: "No hay coincidencias.",
    failed: "No se ha podido cargar esta lista",
    tryAgain: "Reintentar",
    all: "Todos",
    selectAll: "Seleccionar todas las filas",
    selectRow: (row) => `Seleccionar ${row}`,
    selected: (count) =>
      count === 1 ? "1 seleccionada" : `${count} seleccionadas`,
    bulkActions: "Filas seleccionadas",
    shown: (count) => (count === 1 ? "1 mostrada" : `${count} mostradas`),
    actions: "Acciones",
    rowActions: (row) => `Acciones de ${row}`,
    edit: (column, row) => `Editar ${column} de ${row}`,
    yes: "Sí",
    no: "No",
    file: "Archivo",
    notANumber: "Introduce un número.",
    notADate: "Introduce una fecha.",
    required: "Introduce un valor.",
    actionFailed: "No ha funcionado.",
  },
  fr: {
    search: "Rechercher",
    columns: "Colonnes",
    loadMore: "Charger plus",
    empty: "Rien ici pour l’instant.",
    noMatches: "Aucun résultat.",
    failed: "Impossible de charger cette liste",
    tryAgain: "Réessayer",
    all: "Tous",
    selectAll: "Sélectionner toutes les lignes",
    selectRow: (row) => `Sélectionner ${row}`,
    selected: (count) =>
      count > 1 ? `${count} sélectionnées` : `${count} sélectionnée`,
    bulkActions: "Lignes sélectionnées",
    shown: (count) => (count > 1 ? `${count} affichées` : `${count} affichée`),
    actions: "Actions",
    rowActions: (row) => `Actions pour ${row}`,
    edit: (column, row) => `Modifier ${column} pour ${row}`,
    yes: "Oui",
    no: "Non",
    file: "Fichier",
    notANumber: "Saisissez un nombre.",
    notADate: "Saisissez une date.",
    required: "Saisissez une valeur.",
    actionFailed: "Cela n’a pas fonctionné.",
  },
};
