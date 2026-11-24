import { absent, answer, hidden } from "./company.ts";
import type { BrainEvalQuestion, BrainEvalSource } from "./company.ts";

// Groenhaven in German: the warehouse in Duisburg (company.ts). Written
// in German, never translated.

export const deSources: readonly BrainEvalSource[] = [
  {
    key: "de-schichten",
    language: "de",
    readers: { team: "planning" },
    text: `Schichtplan Lager Duisburg

Frühschicht von 6:00 bis 14:00 Uhr, Spätschicht von 14:00 bis 22:00 Uhr. Ein Schichttausch ist nur mit Zustimmung des Schichtleiters möglich und muss spätestens 48 Stunden vorher beantragt werden.

Für Arbeit am Samstag gibt es zusätzlich einen Zuschlag von 25 Prozent.`,
  },
  {
    key: "de-arbeitsschutz",
    language: "de",
    readers: { team: "everyone" },
    text: `Arbeitsschutz im Lager Duisburg

Jeder Gabelstapler wird alle 90 Tage geprüft; das Ergebnis steht im Prüfprotokoll GS-PR-07. An jedem Tor hängt ein Erste-Hilfe-Kasten.

Unfälle meldest du sofort dem Schichtleiter und trägst sie noch in derselben Schicht ins Verbandbuch ein.`,
  },
  {
    key: "de-wareneingang",
    language: "de",
    readers: { team: "planning" },
    text: `Wareneingang Duisburg

Lieferungen nehmen wir werktags zwischen 7:00 und 12:00 Uhr an. Spediteure buchen ihr Zeitfenster vorher online im Rampenportal.

Beschädigte Paletten werden fotografiert und der Schaden auf dem Lieferschein vermerkt, bevor der Fahrer unterschreibt.`,
  },
  {
    key: "de-rolltor",
    language: "de",
    readers: { team: "planning" },
    text: `Störung TK-5531 · Rampe 4 · Offen

Das Rolltor an Rampe 4 schließt nicht mehr vollständig, bei Wind schlägt es gegen die Führung. Der Techniker kommt am Donnerstag. Bis dahin ist Rampe 4 gesperrt, Anlieferungen laufen über Rampe 3.`,
  },
  {
    key: "de-lagerbesprechung",
    language: "de",
    readers: { team: "planning" },
    text: `Protokoll Lagerbesprechung 30. Oktober

1. Die Inventur findet am 27. Dezember statt; das Lager ist an diesem Tag geschlossen.
2. Für die Hochsaison holen wir ab März Leiharbeiter.
3. Die neue Regalreihe in Halle B ist bis Ende Januar aufgebaut.`,
  },
  {
    key: "de-staplerschein",
    language: "de",
    readers: { owner: "lukas" },
    text: `Von: Personalabteilung
An: Lukas Becker
Betreff: Ihr Staplerschein

Hallo Lukas,

Ihr Fahrausweis für Gabelstapler läuft am 15. Februar ab. Für die Auffrischung sind Sie am 22. Januar zum Kurs in Oberhausen angemeldet.

Mit freundlichen Grüßen`,
  },
  {
    key: "de-betriebsrat",
    language: "de",
    readers: { team: "hr" },
    text: `Vertraulich · Gespräch mit dem Betriebsrat, 5. November

Wir prüfen die Einführung von Kurzarbeit im Januar für den Versand in Duisburg. Betroffen wären 12 Beschäftigte. Eine Entscheidung fällt nach den Zahlen vom Dezember.`,
  },
  {
    key: "de-urlaub",
    language: "de",
    readers: { team: "everyone" },
    text: `Urlaub am Standort Duisburg

Beschäftigte in Duisburg haben 28 Urlaubstage im Jahr. Urlaubsanträge für den Sommer stellst du bis zum 15. Januar.

Vom 1. bis zum 23. Dezember gilt im Lager eine Urlaubssperre, weil dann das Weihnachtsgeschäft ausgeliefert wird.`,
  },
  {
    key: "de-parken",
    language: "de",
    readers: { team: "everyone" },
    text: `Parken und Anfahrt Duisburg

Der Parkplatz für Beschäftigte liegt hinter Halle C. Fahrräder stehen im überdachten Fahrradständer am Eingang. Dienstwagen laden kostenlos an den Ladesäulen neben dem Bürogebäude.`,
  },
];

export const deQuestions: readonly BrainEvalQuestion[] = [
  {
    id: "de-fruehschicht",
    language: "de",
    question: "Wann beginnt die Frühschicht?",
    expects: answer(
      "words",
      "de-schichten",
      "Frühschicht von 6:00 bis 14:00 Uhr"
    ),
  },
  {
    id: "de-gabelstapler-pruefung",
    language: "de",
    question: "Wie oft wird ein Gabelstapler geprüft?",
    expects: answer("words", "de-arbeitsschutz", "alle 90 Tage geprüft"),
  },
  {
    id: "de-inventur",
    language: "de",
    question: "Wann ist die Inventur?",
    expects: answer("words", "de-lagerbesprechung", "am 27. Dezember statt"),
  },
  {
    id: "de-urlaubstage",
    language: "de",
    question: "Wie viele Urlaubstage haben Beschäftigte in Duisburg?",
    expects: answer("words", "de-urlaub", "28 Urlaubstage im Jahr"),
  },
  {
    id: "de-urlaubsantrag",
    language: "de",
    question: "Bis wann muss mein Urlaubsantrag für den Sommer gestellt sein?",
    expects: answer("forms", "de-urlaub", "bis zum 15. Januar"),
  },
  {
    id: "de-beschaedigte-palette",
    language: "de",
    question: "Was tue ich mit einer beschädigten Palette?",
    expects: answer(
      "forms",
      "de-wareneingang",
      "der Schaden auf dem Lieferschein vermerkt"
    ),
  },
  {
    id: "de-samstagszuschlag",
    language: "de",
    question: "Wie hoch ist der Samstagszuschlag?",
    expects: answer("forms", "de-schichten", "Zuschlag von 25 Prozent"),
  },
  {
    id: "de-tk-5531",
    language: "de",
    question: "Was ist mit TK-5531?",
    expects: answer("exact", "de-rolltor", "Rampe 4 gesperrt"),
  },
  {
    id: "de-gs-pr-07",
    language: "de",
    question: "Was steht in GS-PR-07?",
    expects: answer("exact", "de-arbeitsschutz", "Prüfprotokoll GS-PR-07"),
  },
  {
    id: "de-dienste-tauschen",
    language: "de",
    question: "Darf ich mit einem Kollegen die Arbeitszeiten wechseln?",
    expects: answer(
      "paraphrase",
      "de-schichten",
      "nur mit Zustimmung des Schichtleiters"
    ),
  },
  {
    id: "de-auto-abstellen",
    language: "de",
    question: "Wo stelle ich morgens mein Auto ab?",
    expects: answer("paraphrase", "de-parken", "hinter Halle C"),
  },
  {
    id: "de-weihnachten-frei",
    language: "de",
    question: "Kann ich kurz vor Weihnachten freinehmen?",
    expects: answer(
      "paraphrase",
      "de-urlaub",
      "gilt im Lager eine Urlaubssperre"
    ),
  },
  {
    id: "de-staplerschein-erneuern",
    language: "de",
    asker: "lukas",
    question: "Wann muss ich meinen Staplerführerschein auffrischen?",
    expects: answer("forms", "de-staplerschein", "läuft am 15. Februar ab"),
  },
  {
    id: "de-kantine",
    language: "de",
    question: "Gibt es in Duisburg eine Kantine?",
    expects: absent,
  },
  {
    id: "de-weihnachtsgeld",
    language: "de",
    question: "Wie hoch ist das Weihnachtsgeld?",
    expects: absent,
  },
  {
    id: "de-kurzarbeit",
    language: "de",
    asker: "lukas",
    question: "Gibt es im Versand bald Kurzarbeit?",
    expects: hidden(
      "de-betriebsrat",
      "12 Beschäftigte",
      "Kurzarbeit im Januar"
    ),
  },
  {
    id: "de-staplerschein-lukas",
    language: "de",
    asker: "javier",
    question: "Wann läuft der Staplerschein von Lukas Becker ab?",
    expects: hidden("de-staplerschein", "15. Februar", "Oberhausen"),
  },
];
