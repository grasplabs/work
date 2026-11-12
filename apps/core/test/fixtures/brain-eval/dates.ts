import { answer } from "./company.ts";
import type { BrainEvalQuestion, BrainEvalSource } from "./company.ts";

// Dates (GRA-1798): notices in each of the five languages, each writing
// its day the way that language writes it (a month's name, an ordinal, day
// before month, ISO with a time, no year, month before day), asked with the
// same day written another way. Found by the date way, which reads the
// days a passage writes when it is indexed; by the words alone only in
// part ("2027", and a day's number).

export const dateSources: readonly BrainEvalSource[] = [
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
    text: "Release notes: the new ordering portal went live on June 3, 2027 after a two-week pilot with the Duisburg site and Arnhem.",
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
    text: "Goed nieuws: de vernieuwde kantine op de tweede verdieping gaat open op dinsdag 6 april.",
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
