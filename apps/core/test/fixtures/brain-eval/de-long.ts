import { absent, answer, hidden } from "./company.ts";
import type { BrainEvalQuestion, BrainEvalSource } from "./company.ts";

// Groenhaven's long documents in German, from the warehouse in Duisburg:
// a chapter of the warehouse handbook and the minutes of a site meeting.
// Written in German, sources and questions alike; never translated.

export const deLongSources: readonly BrainEvalSource[] = [
  {
    key: "de-handbuch-kommissionierung",
    language: "de",
    readers: { team: "planning" },
    text: `Lagerhandbuch Duisburg, Kapitel 5: Kommissionierung, Verpackung und Versand

Stand: Oktober 2026, Version 3.2. Verantwortlich für dieses Kapitel ist Lukas Becker aus der Planung. Verbesserungsvorschläge gibst du bei deiner Schichtleitung ab; sie werden zweimal im Jahr, im April und im Oktober, in das Handbuch eingearbeitet.

5.1 Pickrunden
Das Lagerverwaltungssystem bündelt die offenen Kundenaufträge zu Pickrunden. Eine Pickrunde umfasst höchstens 40 Positionen oder einen voll beladenen Kommissionierwagen, je nachdem, was zuerst erreicht ist. Die Runden werden in Wellen freigegeben, im normalen Tagesgeschäft alle 90 Minuten, in der Hochsaison stündlich. Du startest die Runde im Handscanner und läufst die Lagerplätze in der Reihenfolge ab, die der Scanner vorgibt; sie ist nach Gängen sortiert und spart Laufwege. Schwere und sperrige Artikel wie Gartenstühle, Grillwagen oder Pflanzkübel nimmst du zuerst und stellst sie unten auf den Wagen, Kleinteile wie Grillbesteck oder Ersatzbezüge kommen zuletzt in die Kisten obenauf. Jeden Pick bestätigst du mit einem Scan von Lagerplatz und Artikel. Eine angefangene Pickrunde gibst du nicht an Kollegen weiter: Entweder schließt du sie ab oder du brichst sie im Scanner mit Angabe eines Grundes ab.

5.2 Fehlmengen
Findest du am Lagerplatz weniger Ware, als auf der Pickliste steht, buchst du sofort eine Fehlmenge im Scanner und wählst einen Grundcode: FM-01 für einen leeren Platz, FM-02 für Bruch, FM-03 für einen falschen Artikel am Platz. Das System prüft dann, ob im Reservelager Bestand liegt, und erzeugt einen Nachschubauftrag für die Staplerfahrer. Kommt der Nachschub nicht innerhalb von 30 Minuten, stellst du den unvollständigen Auftrag ins Klärregal neben Packplatz 1. Teillieferungen schickst du nur raus, wenn im Auftrag das Kennzeichen „TL erlaubt“ gesetzt ist; das vereinbart der Vertrieb vorher mit dem Kunden. Ohne dieses Kennzeichen bleibt der Auftrag im Klärregal, bis die Ware vollständig ist. Bruchware mit FM-02 legst du in die rote Gitterbox am Ende von Gang 12. Die Bestandskorrektur im System macht ausschließlich die Lagerleitung.

5.3 Verpackungsmaterial
An jedem Packplatz stehen Versandkartons in fünf Größen, von G1 (klein) bis G5 (groß). Das System schlägt beim Abschluss der Pickrunde eine Kartongröße vor; nimm sie, solange die Ware darin nicht lose hin und her rutscht. Als Füllmaterial verwenden wir nur Papierpolster aus dem Spender, seit 2025 keine Schaumstoffchips und keine Luftpolsterfolie mehr. Paletten wickelst du mit Stretchfolie in mindestens fünf Lagen; ab Januar 2027 gilt dafür eine neue Regelung, die rechtzeitig am Packplatz ausgehängt wird. Geht ein Material zur Neige, also sobald die gelbe Markierung am Regal frei liegt, bestellst du es mit dem Formular VM-14 nach; das ausgefüllte Formular wirfst du in den Briefkasten am Lagerbüro. Leere Umkartons von Lieferanten gehören nicht in den Restmüll, sondern in die Ballenpresse neben Packplatz 4.

5.4 Paketversand
Den Paketversand nutzen wir für Sendungen an Endkunden unserer Onlinehändler und für kleine Nachbestellungen von Fachhändlern. Unser Paketdienst ist Velpaq. Annahmeschluss für den Paketversand ist 15:00 Uhr: Was bis dahin verpackt, gewogen und etikettiert in den Rollcontainern an Rampe 8 steht, nimmt der Fahrer um 16:15 Uhr mit. Ein Paket darf höchstens 31,5 kg wiegen, und die längste Seite darf höchstens 1,20 m messen. Das Versandlabel druckst du am Packplatz aus dem System und klebst es flach auf die größte Fläche des Kartons, nie über eine Kante oder über Klebeband. Den Lieferschein steckst du in die Dokumententasche auf dem Paket. Vor der Abholung druckt die Schichtleitung die Tagesabschlussliste aus, die der Fahrer unterschreibt; das Original bleibt im Ordner Paketversand im Lagerbüro.

5.5 Speditionsversand
Den Speditionsversand nutzen wir für Paletten an Gartencenter, Baumärkte und Fachhändler sowie für alle Auslandssendungen, die keine Pakete sind. Unser Hauptspediteur in Duisburg ist Wiegand Transporte aus Moers. Annahmeschluss für den Speditionsversand ist 11:00 Uhr am Vortag der Abholung: Bis dahin muss die Sendung im System avisiert sein, damit die Spedition den Lkw einplanen kann. Eine Palette darf höchstens 1.000 kg wiegen und mit Ladung höchstens 1,80 m hoch sein. Das Palettenlabel druckst du zweimal aus und klebst es an zwei gegenüberliegende Seiten der Palette, wo es von außen gut lesbar ist. Zu jeder Sendung gehören der Lieferschein in dreifacher Ausfertigung und die Ladeliste; bei Auslandssendungen kommt ein CMR-Frachtbrief dazu, den der Fahrer gegenzeichnet. Die unterschriebenen Papiere legst du anschließend in den Ordner Speditionsversand im Lagerbüro.

5.6 Sperrgut und Gefahrgut
Als Sperrgut gilt bei uns jedes Packstück, das über Gewicht oder Länge hinausgeht, die im Paketversand erlaubt sind, vor allem Loungesets, Ampelschirme und große Grillstationen. Sperrgut geht nie als Paket raus, sondern immer auf Palette mit der Spedition, auch wenn es nur ein einzelnes Stück ist. Als Gefahrgut gelten in unserem Sortiment vor allem Gaskartuschen für Tischgrills, flüssige Grillanzünder und die Lithium-Akkus der Akku-Heckenscheren. Gefahrgut verpacken nur Beschäftigte mit gültiger Gefahrgutschulung; die Liste der Geschulten hängt im Lagerbüro aus. Vor dem Verschließen arbeitest du die Checkliste GG-03 ab und legst sie unterschrieben zum Lieferschein. Gaskartuschen verschicken wir ausschließlich mit der Spedition. Bei Unklarheiten hilft unser externer Gefahrgutbeauftragter Thomas Brinkmann, den du über die Schichtleitung erreichst.

5.7 Verladung
Der Versand lädt an den Rampen 6 bis 8. Die Ladefolge richtet sich nach dem Tourenplan: Was als Letztes entladen wird, kommt als Erstes auf den Lkw. Vor dem Beladen schaust du dir die Ladefläche an; ist sie verschmutzt oder hat der Boden Löcher, lädst du nicht und rufst die Schichtleitung. Unter jede Palette kommt eine Antirutschmatte. Für die Ladungssicherung ist der Fahrer verantwortlich, du sprichst ihn aber an, wenn dir die Ladung nicht sicher vorkommt. Bevor die Türen des Lkw geschlossen werden, fotografierst du die beladene Ladefläche mit dem Handscanner; das Foto wird automatisch der Sendung zugeordnet und hilft uns, wenn später ein Transportschaden gemeldet wird. Pakete lädt der Fahrer des Paketdienstes selbst aus den Rollcontainern.

5.8 Kontrolle
Jeder Karton läuft am Packplatz über die Kontrollwaage. Weicht das Gewicht um mehr als 5 Prozent vom Sollgewicht ab, öffnest du den Karton und zählst nach. Zusätzlich prüft die Schichtleitung jeden 20. Auftrag vollständig gegen den Lieferschein und hält das Ergebnis im Prüfbogen QK-5 fest. Unser Ziel ist eine Fehlerquote von unter 0,3 Prozent der versandten Aufträge. Lukas Becker wertet die Prüfbögen monatlich aus; die häufigsten Fehler kommen in der Schichtübergabe zur Sprache. Reklamationen von Kunden wegen falscher oder fehlender Ware gehen an den Vertrieb und werden mit dem Foto aus der Verladung und dem Prüfbogen abgeglichen.`,
  },
  {
    key: "de-protokoll-standortversammlung",
    language: "de",
    readers: { team: "everyone" },
    text: `Protokoll der Standortversammlung Duisburg

Datum: Dienstag, 10. November 2026, 13:45 bis 15:15 Uhr, Pausenzone in Halle A. Leitung: Jörg Pfeiffer, Standortleiter. Gast: Eva, Operations Director. Protokoll: Melanie Schreiber, Lagerbüro. Anwesend waren 64 Beschäftigte aus Früh- und Spätschicht, alle Schichtleitungen sowie Lukas Becker aus der Planung, der für Rückfragen zur Verfügung stand. Die Versammlung wurde bewusst auf den Schichtwechsel gelegt, damit beide Schichten teilnehmen konnten.

TOP 1 Begrüßung und Rückblick
Jörg Pfeiffer begrüßt die Anwesenden, besonders Eva, die aus Utrecht angereist ist. Eva bedankt sich für die Saison: Duisburg hat von Januar bis Oktober rund 41.000 Aufträge verschickt, 14 Prozent mehr als im Vorjahr, und deutlich weniger Falschlieferungen gehabt. Groenhaven will den Standort weiter ausbauen, vor allem für Kunden in Deutschland und Österreich.

TOP 2 Hallenerweiterung
Die Stadt Duisburg hat den Bauantrag für die neue Halle D am 21. Oktober 2026 genehmigt, Projektnummer DU-BAU-27-01. Halle D entsteht an der Ostseite neben Halle C, wird 4.800 Quadratmeter groß und bekommt sechs zusätzliche Rampen. Die Bauarbeiten beginnen im März 2027, in Betrieb gehen soll die Halle im Oktober 2027. Während der Bauzeit ist die Ostzufahrt gesperrt; Lkw fahren dann über die Nordzufahrt am Hafenweg. Auf die Frage, ob der Baulärm die Arbeit stört, antwortet Jörg Pfeiffer, dass die Baufirma nur montags bis freitags zwischen 7 und 17 Uhr arbeiten darf. Als Ansprechpersonen der Belegschaft für die Bauphase werden Ömer Yılmaz (Frühschicht) und Katarzyna Nowak (Spätschicht) benannt.

TOP 3 Heizung und Beleuchtung
Mehrere Beschäftigte der Frühschicht haben sich beschwert, dass es morgens in Halle A zu kalt ist; Ende Oktober wurden dort um 6:30 Uhr nur 9 Grad gemessen. Ursache ist die defekte Steuerung der Deckenstrahler, gemeldet als Störungsticket TK-5602. Ein Heizungsbauer hat sie am 5. November notdürftig repariert, die neue Steuerung wird am 24. November eingebaut. Bis dahin laufen die Deckenstrahler in Halle A rund um die Uhr. Außerdem stehen seit dieser Woche zwei mobile Heizgeräte an den Packplätzen.

In den Hallen B und C werden bis Ende Februar 2027 alle Leuchten auf LED umgerüstet, in Halle A ist das schon 2024 passiert. In den Gängen kommen Bewegungsmelder dazu, damit nur dort Licht brennt, wo gearbeitet wird. Die Elektriker arbeiten gangweise in der Spätschicht ab 20 Uhr; welche Gänge betroffen sind, steht am Vortag im Scanner, die Lagerplätze dort sind dann gesperrt. Eva rechnet damit, dass der Standort so gut die Hälfte des Stroms für Licht einspart.

TOP 4 Neue Pausenregelung
Ab Montag, 4. Januar 2027 gilt in Duisburg eine gestaffelte Pausenregelung. Bisher haben alle gleichzeitig Pause gemacht, die Packplätze standen eine halbe Stunde still und die Fahrer mussten warten. Künftig gibt es zwei Pausengruppen: Die Kommissionierung macht in der Frühschicht von 9:30 bis 10:00 Uhr Pause, Verpackung und Verladung von 10:00 bis 10:30 Uhr; in der Spätschicht beginnen die Pausen entsprechend um 17:30 und um 18:00 Uhr. Die kurze Pause von 15 Minuten bleibt wie bisher; sie wird mit der Schichtleitung abgestimmt. Rückfrage aus der Spätschicht: Was passiert, wenn ein Lkw mitten in der Pause kommt? Antwort Lukas Becker: Dann lädt die Gruppe, die gerade arbeitet; der Fahrer wartet nicht mehr. Die Liste, wer zu welcher Gruppe gehört, hängt vor dem Start am Schwarzen Brett aus.

TOP 5 Schulungen
Am Standort gibt es zurzeit neun ausgebildete Ersthelferinnen und Ersthelfer, für beide Schichten zusammen werden mindestens vierzehn gebraucht. Am 2. und 3. Februar 2027 findet in Duisburg je ein eintägiger Erste-Hilfe-Lehrgang statt; die Kosten trägt die Berufsgenossenschaft, die Kurszeit gilt als Arbeitszeit. Für alle, die an den Rampen arbeiten, gibt es im Januar eine halbtägige Schulung zur Ladungssicherung, die genauen Termine folgen. Mit dem Update der Handscanner im Dezember bekommen alle eine Einweisung von 30 Minuten zu Beginn ihrer Schicht. Anmeldungen für die Lehrgänge und die Schulung zur Ladungssicherung laufen über das Formular SCH-21, das bei den Schichtleitungen ausliegt.

TOP 6 Fragen aus der Belegschaft
Frage: Wann gibt es mehr Spinde in der Umkleide? Antwort Jörg Pfeiffer: 40 zusätzliche Spinde sind bestellt und werden bis zum 18. Dezember in der Umkleide in Halle C aufgestellt. Bis dahin können Taschen im abschließbaren Schrank im Lagerbüro aufbewahrt werden.
Frage: Wann gibt es die Winterjacken? Antwort: Die Ausgabe der Winterjacken beginnt am 16. November; sie findet werktags von 13:30 bis 14:30 Uhr im Lagerbüro statt. Wer eine andere Größe als im letzten Jahr braucht, trägt sich vorher in die Liste an der Bürotür ein.
Frage: Wann wird der Trinkwasserspender in Halle B repariert? Er ist seit Wochen kaputt. Antwort: Eine Reparatur lohnt sich nicht mehr, ein neues Gerät ist bestellt und kommt Ende November.
Frage: Können wir Fahrgemeinschaften bilden, vor allem für die Spätschicht? Antwort Jörg Pfeiffer: Gerne; am Schwarzen Brett gibt es ab sofort eine Mitfahrbörse, in die sich jeder mit Wohnort und Schicht eintragen kann.

TOP 7 Beschlüsse
1. Die gestaffelte Pausenregelung wird wie vorgestellt eingeführt und nach drei Monaten mit den Schichtleitungen ausgewertet.
2. Die Mitfahrbörse am Schwarzen Brett bleibt dauerhaft bestehen.
3. Die nächste Standortversammlung findet im Mai 2027 statt, dann voraussichtlich schon mit einem Rundgang über die Baustelle.

TOP 8 Aufgaben
Melanie Schreiber: Protokoll aushängen und per Mail verteilen, bis 13. November 2026.
Lukas Becker: Einteilung der Pausengruppen erstellen und aushängen, bis 15. Dezember 2026.
Jörg Pfeiffer: Teilnehmende für die beiden Erste-Hilfe-Lehrgänge bei der Berufsgenossenschaft anmelden, bis 15. Januar 2027.
Schichtleitungen: Anmeldungen mit SCH-21 sammeln und an Jörg Pfeiffer geben, bis 8. Januar 2027.
Frank Albers, Haustechnik: neuen Trinkwasserspender in Halle B anschließen, sobald er geliefert ist.
Lukas Becker mit der Bauleitung: Plan für die Lkw-Umleitung über die Nordzufahrt vorstellen, bis 19. Februar 2027.`,
  },
];

export const deLongQuestions: readonly BrainEvalQuestion[] = [
  {
    id: "de-long-kontrollwaage",
    language: "de",
    question:
      "Was mache ich, wenn das Gewicht um mehr als 5 Prozent vom Sollgewicht abweicht?",
    expects: answer(
      "words",
      "de-handbuch-kommissionierung",
      "öffnest du den Karton und zählst nach"
    ),
  },
  {
    id: "de-long-teillieferung",
    language: "de",
    question: "Darf ich einen Auftrag auch teilweise liefern?",
    expects: answer(
      "forms",
      "de-handbuch-kommissionierung",
      "Teillieferungen schickst du nur raus"
    ),
  },
  {
    id: "de-long-vm-14",
    language: "de",
    question: "Wofür brauche ich VM-14?",
    expects: answer(
      "exact",
      "de-handbuch-kommissionierung",
      "bestellst du es mit dem Formular VM-14 nach"
    ),
  },
  {
    id: "de-long-foto-lkw",
    language: "de",
    question: "Muss ich ein Bild machen, wenn der Laster voll ist?",
    expects: answer(
      "paraphrase",
      "de-handbuch-kommissionierung",
      "fotografierst du die beladene Ladefläche"
    ),
  },
  {
    id: "de-long-annahmeschluss-paket",
    language: "de",
    question: "Wann ist Annahmeschluss für den Paketversand?",
    expects: answer(
      "words",
      "de-handbuch-kommissionierung",
      "Annahmeschluss für den Paketversand ist 15:00 Uhr",
      "Annahmeschluss für den Speditionsversand ist 11:00 Uhr am Vortag"
    ),
  },
  {
    id: "de-long-halle-d",
    language: "de",
    question: "Wie groß wird die neue Halle D?",
    expects: answer(
      "words",
      "de-protokoll-standortversammlung",
      "wird 4.800 Quadratmeter groß"
    ),
  },
  {
    id: "de-long-winterjacken",
    language: "de",
    question: "Ab wann wird die Winterjacke ausgegeben?",
    expects: answer(
      "forms",
      "de-protokoll-standortversammlung",
      "Ausgabe der Winterjacken beginnt am 16. November"
    ),
  },
  {
    id: "de-long-tk-5602",
    language: "de",
    question: "Wann ist TK-5602 erledigt?",
    expects: answer(
      "exact",
      "de-protokoll-standortversammlung",
      "die neue Steuerung wird am 24. November eingebaut"
    ),
  },
  {
    id: "de-long-lampen",
    language: "de",
    question: "Bis wann sind bei uns überall die alten Lampen ausgetauscht?",
    expects: answer(
      "paraphrase",
      "de-protokoll-standortversammlung",
      "alle Leuchten auf LED umgerüstet"
    ),
  },
  {
    id: "de-long-palette-spedition",
    language: "de",
    asker: "sophie",
    question:
      "Wie schwer und wie hoch darf eine Palette im Speditionsversand aus Duisburg sein?",
    expects: hidden(
      "de-handbuch-kommissionierung",
      "höchstens 1.000 kg",
      "höchstens 1,80 m hoch"
    ),
  },
  {
    id: "de-long-kommissionierer-pro-schicht",
    language: "de",
    question:
      "Wie viele Kommissionierer sind in Duisburg pro Schicht eingeteilt?",
    expects: absent,
  },
];
