import { answer } from "./company.ts";
import type { BrainEvalQuestion, BrainEvalSource } from "./company.ts";

// Dates: questions that ask for a day written another way than the
// passage that answers writes it, in each of the five languages. They
// came from GRA-1798 (a date way that read the days each passage writes
// at indexing), parked because recall by meaning already answers most of
// them; they stay so recall is judged on dates.
//
// - Notices writing their day the way their language does (a month's
//   name, an ordinal, day before month, ISO with a time, no year, month
//   before day), asked with the same day written another way: the words
//   alone find them only in part ("2027", and a day's number).
// - Answers writing their day in a form no table of dates reads
//   ("mid-April 2028", "week 11", "12.5.28", "T1 2028", "14/3/28") beside
//   another passage writing that day plainly: the words find these today.
// - A day several sources write, one of them answering; numbered
//   timelines; a question with a date and an ID beside a passage writing
//   only the day; an answer the words rank second beside a short passage
//   writing nothing but the day.

export const dateSources: readonly BrainEvalSource[] = [
  {
    key: "en-date-inspection",
    language: "en",
    readers: { team: "everyone" },
    text: "The north dock forklift inspection is on 22/11/2028.",
  },
  {
    key: "en-date-inspection-report",
    language: "en",
    readers: { team: "everyone" },
    text: "Forklift inspection, north dock: November 2028 report.",
  },
  {
    key: "en-date-lunch",
    language: "en",
    readers: { team: "everyone" },
    text: "Lunch on 22/11/2028.",
  },
  {
    key: "nl-date-keuring",
    language: "nl",
    readers: { team: "everyone" },
    text: "De keuring van de heftrucks bij dock noord is op 6-12-2028.",
  },
  {
    key: "nl-date-keuring-rapport",
    language: "nl",
    readers: { team: "everyone" },
    text: "Keuring heftrucks dock noord: rapport december 2028. Dank.",
  },
  {
    key: "nl-date-borrel",
    language: "nl",
    readers: { team: "everyone" },
    text: "Borrel op 6/12/2028. Dank.",
  },
  {
    key: "de-date-pruefung",
    language: "de",
    readers: { team: "everyone" },
    text: "Die Prüfung der Stapler am Nordtor ist am 14.11.2028.",
  },
  {
    key: "de-date-pruefung-bericht",
    language: "de",
    readers: { team: "everyone" },
    text: "Prüfung Stapler Nordtor: Bericht November 2028.",
  },
  {
    key: "de-date-grillfest",
    language: "de",
    readers: { team: "everyone" },
    text: "Grillfest am 14.11.2028.",
  },
  {
    key: "es-date-inspeccion",
    language: "es",
    readers: { team: "everyone" },
    text: "La inspección de las carretillas del muelle norte es el 9/10/2028.",
  },
  {
    key: "es-date-inspeccion-informe",
    language: "es",
    readers: { team: "everyone" },
    text: "Inspección carretillas muelle norte: informe octubre 2028. Gracias.",
  },
  {
    key: "es-date-comida",
    language: "es",
    readers: { team: "everyone" },
    text: "Comida el 9/10/2028. Gracias.",
  },
  {
    key: "en-date-forklift",
    language: "en",
    readers: { team: "everyone" },
    text: "The forklift fleet renewal slipped to mid-April 2028 after the board's long review.",
  },
  {
    key: "en-date-standup",
    language: "en",
    readers: { team: "everyone" },
    text: "Standup notes on 12 April 2028: nothing on the canteen menu.",
  },
  {
    key: "nl-date-archief",
    language: "nl",
    readers: { team: "everyone" },
    text: "De verhuizing van het archief schuift naar week 11 van 2028. Dank. Dank.",
  },
  {
    key: "nl-date-notulen",
    language: "nl",
    readers: { team: "everyone" },
    text: "Notulen van 15 maart 2028: geen punten over de parkeerplaats.",
  },
  {
    key: "de-date-inventur",
    language: "de",
    readers: { team: "everyone" },
    text: "Die Inventur im Ersatzteillager ist für den 12.5.28 angesetzt.",
  },
  {
    key: "de-date-protokoll",
    language: "de",
    readers: { team: "everyone" },
    text: "Protokoll vom 12. Mai 2028: keine Punkte zur Kantine. Gruß, HR.",
  },
  {
    key: "fr-date-paie",
    language: "fr",
    readers: { team: "everyone" },
    text: "Le nouvel outil de paie sera déployé au T1 2028, d'abord pour Lyon. Merci.",
  },
  {
    key: "fr-date-compte-rendu",
    language: "fr",
    readers: { team: "everyone" },
    text: "Compte rendu du 10 février 2028 : rien sur les congés. Merci beaucoup.",
  },
  {
    key: "es-date-uniformes",
    language: "es",
    readers: { team: "everyone" },
    text: "La entrega de los nuevos uniformes se retrasa hasta el 14/3/28. Muchas gracias.",
  },
  {
    key: "es-date-acta",
    language: "es",
    readers: { team: "everyone" },
    text: "Acta del 14 de marzo de 2028: sin novedades en el aparcamiento. Gracias. Gracias.",
  },
  {
    key: "en-date-parking",
    language: "en",
    readers: { team: "everyone" },
    text: "Visitor parking is closed on 7 September 2028.",
  },
  {
    key: "en-date-harvest",
    language: "en",
    readers: { team: "everyone" },
    text: "The canteen serves a harvest menu on 7 September 2028. Thank you.",
  },
  {
    key: "en-date-town-hall",
    language: "en",
    readers: { team: "everyone" },
    text: "The quarterly town hall takes place on 7 September 2028 in the main hall.",
  },
  {
    key: "nl-date-lift",
    language: "nl",
    readers: { team: "everyone" },
    text: "Op 3 oktober 2028 is de liftinstallatie buiten gebruik.",
  },
  {
    key: "nl-date-koffie",
    language: "nl",
    readers: { team: "everyone" },
    text: "De nieuwe koffieautomaat komt op 3 oktober 2028.",
  },
  {
    key: "nl-date-brandoefening",
    language: "nl",
    readers: { team: "everyone" },
    text: "Op 3 oktober 2028 is de brandoefening voor alle verdiepingen. Bedankt. Dank.",
  },
  {
    key: "de-date-werkstor",
    language: "de",
    readers: { team: "everyone" },
    text: "Am 20. Juni 2028 ist das Werkstor wegen Bauarbeiten gesperrt. Danke.",
  },
  {
    key: "de-date-ausflug",
    language: "de",
    readers: { team: "everyone" },
    text: "Der Betriebsausflug findet am 20. Juni 2028 statt.",
  },
  {
    key: "de-date-netzwerk",
    language: "de",
    readers: { team: "everyone" },
    text: "Am 20. Juni 2028 wird das Netzwerk im Lager umgestellt. Bitte beachten.",
  },
  {
    key: "fr-date-ascenseur",
    language: "fr",
    readers: { team: "everyone" },
    text: "Le 5 avril 2028, l'ascenseur sera en maintenance.",
  },
  {
    key: "fr-date-portes",
    language: "fr",
    readers: { team: "everyone" },
    text: "La journée portes ouvertes aura lieu le 5 avril 2028. Merci beaucoup.",
  },
  {
    key: "fr-date-wifi",
    language: "fr",
    readers: { team: "everyone" },
    text: "Le 5 avril 2028, le réseau wifi sera coupé le matin. Merci de votre compréhension.",
  },
  {
    key: "es-date-agua",
    language: "es",
    readers: { team: "everyone" },
    text: "El 9 de mayo de 2028 se corta el agua en la nave. Gracias. Gracias a todos.",
  },
  {
    key: "es-date-cena",
    language: "es",
    readers: { team: "everyone" },
    text: "La cena de empresa es el 9 de mayo de 2028 en el centro.",
  },
  {
    key: "es-date-camion",
    language: "es",
    readers: { team: "everyone" },
    text: "El 9 de mayo de 2028 llega el nuevo camión de reparto. Buen día.",
  },
  {
    key: "en-date-timeline",
    language: "en",
    readers: { team: "everyone" },
    text: "Migration timeline:\n1. January 10, 2028: freeze\n2. February 2, 2028: data copy\n3. March 6, 2028: switch-over",
  },
  {
    key: "nl-date-tijdlijn",
    language: "nl",
    readers: { team: "everyone" },
    text: "Tijdlijn nieuwe planning:\n1. 8 januari 2028: kick-off\n2. 5 februari 2028: training\n3. 4 maart 2028: livegang Dank.",
  },
  {
    key: "de-date-zeitplan",
    language: "de",
    readers: { team: "everyone" },
    text: "Zeitplan Umzug:\n1. 11. Januar 2028: Packen\n2. 9. Februar 2028: Transport\n3. 3. März 2028: Einzug",
  },
  {
    key: "fr-date-calendrier",
    language: "fr",
    readers: { team: "everyone" },
    text: "Calendrier du projet :\n1. 12 janvier 2028 : lancement\n2. 16 février 2028 : recette\n3. 15 mars 2028 : mise en service",
  },
  {
    key: "es-date-calendario",
    language: "es",
    readers: { team: "everyone" },
    text: "Calendario de la obra:\n1. 13 de enero de 2028: inicio\n2. 17 de febrero de 2028: estructura\n3. 16 de marzo de 2028: entrega",
  },
  {
    key: "en-date-invoice",
    language: "en",
    readers: { team: "everyone" },
    text: "Invoice INV-2028-0815 for the forklift repair is due on 30 June 2028. Thanks.",
  },
  {
    key: "en-date-payment-run",
    language: "en",
    readers: { team: "everyone" },
    text: "The supplier payment run is on 30 June 2028.",
  },
  {
    key: "nl-date-factuur",
    language: "nl",
    readers: { team: "everyone" },
    text: "Factuur FAC-2028-0412 voor het dakonderhoud vervalt op 28 april 2028. Dank. Bedankt.",
  },
  {
    key: "nl-date-betaalrun",
    language: "nl",
    readers: { team: "everyone" },
    text: "Op 28 april 2028 is de betaalrun voor alle leveranciers. Vriendelijke groet. Bedankt.",
  },
  {
    key: "de-date-bestellung",
    language: "de",
    readers: { team: "everyone" },
    text: "Bestellung BE-2028-771 für Paletten wird am 15. Juli 2028 geliefert. Vielen Dank. Danke.",
  },
  {
    key: "de-date-wareneingang",
    language: "de",
    readers: { team: "everyone" },
    text: "Am 15. Juli 2028 ist Inventur im Wareneingang. Vielen Dank. Danke für Ihr Verständnis.",
  },
  {
    key: "fr-date-ticket",
    language: "fr",
    readers: { team: "everyone" },
    text: "Le ticket TK-2028-330 sur l'imprimante sera traité le 21 août 2028. Merci. Merci beaucoup.",
  },
  {
    key: "fr-date-informatique",
    language: "fr",
    readers: { team: "everyone" },
    text: "Le 21 août 2028, le service informatique est fermé l'après-midi. Merci beaucoup.",
  },
  {
    key: "es-date-pedido",
    language: "es",
    readers: { team: "everyone" },
    text: "El pedido PED-2028-559 de cajas llega el 18 de octubre de 2028. Muchas gracias. Muchas gracias.",
  },
  {
    key: "es-date-inventario",
    language: "es",
    readers: { team: "everyone" },
    text: "El    18 de octubre de 2028 hay inventario en el almacén.",
  },
  {
    key: "en-date-fire-alarm",
    language: "en",
    readers: { team: "everyone" },
    text: "Facilities notice: the fire alarm test in the Arnhem office is scheduled for 17th March 2027, starting at ten. Expect the alarm to sound twice.",
  },
  {
    key: "en-date-portal",
    language: "en",
    readers: { team: "everyone" },
    text: "Release notes: the new ordering portal went live on June 3, 2027 after a two-week pilot with the Duisburg site and Arnhem. Thanks.",
  },
  {
    key: "en-date-pallets",
    language: "en",
    readers: { team: "everyone" },
    text: "Shipping schedule from our US supplier: the replacement pallets ship 04/05/2027 and arrive a week later.",
  },
  {
    key: "nl-date-inventaris",
    language: "nl",
    readers: { team: "everyone" },
    text: "Het magazijn in Tilburg is dicht op 9 februari 2027 vanwege de jaarlijkse inventarisatie van alle opslaglocaties.",
  },
  {
    key: "nl-date-kantine",
    language: "nl",
    readers: { team: "everyone" },
    text: "Goed nieuws: de vernieuwde kantine op de tweede verdieping gaat open op dinsdag 6 april. Dank.",
  },
  {
    key: "nl-date-declaraties",
    language: "nl",
    readers: { team: "everyone" },
    text: "Let op: uiterlijk 1 juli 2027 moeten alle reisdeclaraties over het voorjaar zijn ingediend bij de administratie.",
  },
  {
    key: "nl-date-onderhoud",
    language: "nl",
    readers: { team: "everyone" },
    text: "Gepland onderhoud aan de planningsserver begint op 2027-10-12T06:30:00Z en duurt ongeveer drie uur.",
  },
  {
    key: "de-date-versammlung",
    language: "de",
    readers: { team: "everyone" },
    text: "Die Betriebsversammlung findet am 14. Mai 2027 in der Kantine des Werks statt, Beginn nach der Frühschicht.",
  },
  {
    key: "de-date-schichtplan",
    language: "de",
    readers: { team: "everyone" },
    text: "Ab dem 1. August 2027 gilt im Lager der neue Schichtplan mit zwei statt drei Schichten.",
  },
  {
    key: "de-date-klima",
    language: "de",
    readers: { team: "everyone" },
    text: "Die Wartung der Klimaanlage im Bürogebäude ist für den 22.09.2027 vorgesehen; bitte Fenster geschlossen halten.",
  },
  {
    key: "fr-date-formation",
    language: "fr",
    readers: { team: "everyone" },
    text: "La formation incendie obligatoire aura lieu le 1er décembre 2027 dans la salle de réunion du rez-de-chaussée.",
  },
  {
    key: "fr-date-badges",
    language: "fr",
    readers: { team: "everyone" },
    text: "Les nouveaux badges d'accès seront remis le 8 mars 2027 à l'accueil, contre l'ancien badge.",
  },
  {
    key: "fr-date-demenagement",
    language: "fr",
    readers: { team: "everyone" },
    text: "Le déménagement du service comptable au troisième étage est prévu pour le 15/11/2027, cartons fournis.",
  },
  {
    key: "es-date-auditoria",
    language: "es",
    readers: { team: "everyone" },
    text: "La auditoría externa de las cuentas empieza el 20 de enero de 2027 en la oficina de Valencia.",
  },
  {
    key: "es-date-horario",
    language: "es",
    readers: { team: "everyone" },
    text: "El horario de verano de la nave entra en vigor el 1 de junio de 2027 y termina a finales de septiembre.",
  },
  {
    key: "es-date-extintores",
    language: "es",
    readers: { team: "everyone" },
    text: "La revisión anual de los extintores está prevista para el 30/09/2027; habrá técnicos en todas las plantas.",
  },
];

export const dateQuestions: readonly BrainEvalQuestion[] = [
  {
    id: "en-date-inspection",
    language: "en",
    question: "When is the north dock forklift inspection, 22 November 2028?",
    expects: answer(
      "date",
      "en-date-inspection",
      "forklift inspection is on 22/11/2028"
    ),
  },
  {
    id: "nl-date-keuring",
    language: "nl",
    question:
      "Wanneer is de keuring van de heftrucks bij dock noord, 6 december 2028?",
    expects: answer("date", "nl-date-keuring", "dock noord is op 6-12-2028"),
  },
  {
    id: "de-date-pruefung",
    language: "de",
    question:
      "Wann ist die Prüfung der Stapler am Nordtor, am 14. November 2028?",
    expects: answer("date", "de-date-pruefung", "am Nordtor ist am 14.11.2028"),
  },
  {
    id: "es-date-inspeccion",
    language: "es",
    question:
      "¿Cuándo es la inspección de las carretillas del muelle norte, el 9 de octubre de 2028?",
    expects: answer(
      "date",
      "es-date-inspeccion",
      "muelle norte es el 9/10/2028"
    ),
  },
  {
    id: "en-date-forklift",
    language: "en",
    question: "Did the forklift fleet renewal slip on 12 April 2028?",
    expects: answer(
      "date",
      "en-date-forklift",
      "fleet renewal slipped to mid-April 2028"
    ),
  },
  {
    id: "nl-date-archief",
    language: "nl",
    question: "Gaat de verhuizing van het archief door op 15 maart 2028?",
    expects: answer(
      "date",
      "nl-date-archief",
      "verhuizing van het archief schuift naar week 11"
    ),
  },
  {
    id: "de-date-inventur",
    language: "de",
    question: "Ist die Inventur im Ersatzteillager am 12. Mai 2028?",
    expects: answer(
      "date",
      "de-date-inventur",
      "Inventur im Ersatzteillager ist für den 12.5.28"
    ),
  },
  {
    id: "fr-date-paie",
    language: "fr",
    question: "L'outil de paie est-il déployé le 10 février 2028 ?",
    expects: answer(
      "date",
      "fr-date-paie",
      "outil de paie sera déployé au T1 2028"
    ),
  },
  {
    id: "es-date-uniformes",
    language: "es",
    question: "¿Se entregan los nuevos uniformes el 14 de marzo de 2028?",
    expects: answer(
      "date",
      "es-date-uniformes",
      "entrega de los nuevos uniformes se retrasa"
    ),
  },
  {
    id: "en-date-town-hall",
    language: "en",
    question: "When is the quarterly town hall, on 2028-09-07?",
    expects: answer(
      "date",
      "en-date-town-hall",
      "quarterly town hall takes place on 7 September 2028"
    ),
  },
  {
    id: "nl-date-brandoefening",
    language: "nl",
    question: "Wanneer is de brandoefening, op 03-10-2028?",
    expects: answer(
      "date",
      "nl-date-brandoefening",
      "is de brandoefening voor alle verdiepingen"
    ),
  },
  {
    id: "de-date-ausflug",
    language: "de",
    question: "Wann ist der Betriebsausflug, am 20.06.2028?",
    expects: answer(
      "date",
      "de-date-ausflug",
      "Betriebsausflug findet am 20. Juni 2028"
    ),
  },
  {
    id: "fr-date-portes",
    language: "fr",
    question: "Quand a lieu la journée portes ouvertes, le 05/04/2028 ?",
    expects: answer(
      "date",
      "fr-date-portes",
      "journée portes ouvertes aura lieu le 5 avril 2028"
    ),
  },
  {
    id: "es-date-cena",
    language: "es",
    question: "¿Cuándo es la cena de empresa, el 2028-05-09?",
    expects: answer(
      "date",
      "es-date-cena",
      "cena de empresa es el 9 de mayo de 2028"
    ),
  },
  {
    id: "en-date-timeline",
    language: "en",
    question: "What happens on 2 February 2028?",
    expects: answer("date", "en-date-timeline", "February 2, 2028: data copy"),
  },
  {
    id: "nl-date-tijdlijn",
    language: "nl",
    question: "Wat gebeurt er op 2028-02-05?",
    expects: answer("date", "nl-date-tijdlijn", "5 februari 2028: training"),
  },
  {
    id: "de-date-zeitplan",
    language: "de",
    question: "Was ist am 09.02.2028?",
    expects: answer("date", "de-date-zeitplan", "9. Februar 2028: Transport"),
  },
  {
    id: "fr-date-calendrier",
    language: "fr",
    question: "Que se passe-t-il le 2028-02-16 ?",
    expects: answer("date", "fr-date-calendrier", "16 février 2028 : recette"),
  },
  {
    id: "es-date-calendario",
    language: "es",
    question: "¿Qué pasa el 17/02/2028?",
    expects: answer(
      "date",
      "es-date-calendario",
      "17 de febrero de 2028: estructura"
    ),
  },
  {
    id: "en-date-invoice",
    language: "en",
    question: "Is INV-2028-0815 due on 2028-06-30?",
    expects: answer(
      "date",
      "en-date-invoice",
      "INV-2028-0815 for the forklift repair"
    ),
  },
  {
    id: "nl-date-factuur",
    language: "nl",
    question: "Vervalt FAC-2028-0412 op 28-04-2028?",
    expects: answer(
      "date",
      "nl-date-factuur",
      "FAC-2028-0412 voor het dakonderhoud"
    ),
  },
  {
    id: "de-date-bestellung",
    language: "de",
    question: "Kommt BE-2028-771 am 15.07.2028?",
    expects: answer("date", "de-date-bestellung", "BE-2028-771 für Paletten"),
  },
  {
    id: "fr-date-ticket",
    language: "fr",
    question: "Le ticket TK-2028-330 est-il traité le 2028-08-21 ?",
    expects: answer(
      "date",
      "fr-date-ticket",
      "ticket TK-2028-330 sur l'imprimante"
    ),
  },
  {
    id: "es-date-pedido",
    language: "es",
    question: "¿Llega el pedido PED-2028-559 el 18/10/2028?",
    expects: answer("date", "es-date-pedido", "pedido PED-2028-559 de cajas"),
  },
  {
    id: "en-date-fire-alarm",
    language: "en",
    question: "What is happening on 2027-03-17?",
    expects: answer(
      "date",
      "en-date-fire-alarm",
      "scheduled for 17th March 2027"
    ),
  },
  {
    id: "en-date-portal",
    language: "en",
    question: "What went live on 03/06/2027?",
    expects: answer("date", "en-date-portal", "went live on June 3, 2027"),
  },
  {
    id: "en-date-pallets",
    language: "en",
    question: "What ships on 5 April 2027?",
    expects: answer("date", "en-date-pallets", "pallets ship 04/05/2027"),
  },
  {
    id: "nl-date-inventaris",
    language: "nl",
    question: "Wat is er aan de hand op 09-02-2027?",
    expects: answer("date", "nl-date-inventaris", "dicht op 9 februari 2027"),
  },
  {
    id: "nl-date-kantine",
    language: "nl",
    question: "Wat gaat er open op 6-4-2027?",
    expects: answer("date", "nl-date-kantine", "open op dinsdag 6 april"),
  },
  {
    id: "nl-date-declaraties",
    language: "nl",
    question: "Welke deadline valt op 2027-07-01?",
    expects: answer("date", "nl-date-declaraties", "uiterlijk 1 juli 2027"),
  },
  {
    id: "nl-date-onderhoud",
    language: "nl",
    question: "Wat gebeurt er op 12 oktober 2027?",
    expects: answer(
      "date",
      "nl-date-onderhoud",
      "begint op 2027-10-12T06:30:00Z"
    ),
  },
  {
    id: "de-date-versammlung",
    language: "de",
    question: "Was findet am 14.05.2027 statt?",
    expects: answer("date", "de-date-versammlung", "findet am 14. Mai 2027"),
  },
  {
    id: "de-date-schichtplan",
    language: "de",
    question: "Was gilt ab 2027-08-01?",
    expects: answer("date", "de-date-schichtplan", "Ab dem 1. August 2027"),
  },
  {
    id: "de-date-klima",
    language: "de",
    question: "Was ist für den 22. September 2027 vorgesehen?",
    expects: answer("date", "de-date-klima", "für den 22.09.2027"),
  },
  {
    id: "fr-date-formation",
    language: "fr",
    question: "Que se passe-t-il le 01/12/2027 ?",
    expects: answer(
      "date",
      "fr-date-formation",
      "aura lieu le 1er décembre 2027"
    ),
  },
  {
    id: "fr-date-badges",
    language: "fr",
    question: "Qu'est-ce qui est remis le 2027-03-08 ?",
    expects: answer("date", "fr-date-badges", "remis le 8 mars 2027"),
  },
  {
    id: "fr-date-demenagement",
    language: "fr",
    question: "Qu'est-ce qui est prévu le 15 novembre 2027 ?",
    expects: answer("date", "fr-date-demenagement", "prévu pour le 15/11/2027"),
  },
  {
    id: "es-date-auditoria",
    language: "es",
    question: "¿Qué empieza el 20/01/2027?",
    expects: answer(
      "date",
      "es-date-auditoria",
      "empieza el 20 de enero de 2027"
    ),
  },
  {
    id: "es-date-horario",
    language: "es",
    question: "¿Qué entra en vigor el 2027-06-01?",
    expects: answer(
      "date",
      "es-date-horario",
      "en vigor el 1 de junio de 2027"
    ),
  },
  {
    id: "es-date-extintores",
    language: "es",
    question: "¿Qué está previsto para el 30 de septiembre de 2027?",
    expects: answer(
      "date",
      "es-date-extintores",
      "prevista para el 30/09/2027"
    ),
  },
];
