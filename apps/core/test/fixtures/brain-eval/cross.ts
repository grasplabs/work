import { answer } from "./company.ts";
import type { BrainEvalQuestion } from "./company.ts";

// Questions in one language whose answer is in a source in another, as
// people at Groenhaven ask them: each in their own language, about
// another site's documents. Some share a name or a code with their source
// (`words`, `exact`); the rest share nothing but their meaning
// (`paraphrase`), which only vectors can find.

export const crossQuestions: readonly BrainEvalQuestion[] = [
  {
    id: "x-nl-en-hotel-londen",
    language: "nl",
    question: "Hoeveel mag een hotelovernachting in Londen kosten?",
    expects: answer("paraphrase", "en-travel", "EUR 220 per night"),
  },
  {
    id: "x-nl-en-laptop",
    language: "nl",
    question: "Na hoeveel jaar krijg ik een nieuwe laptop?",
    expects: answer("paraphrase", "en-laptops", "replaced every four years"),
  },
  {
    id: "x-nl-de-inventaris",
    language: "nl",
    question: "Op welke dag is de inventarisatie in Duisburg?",
    expects: answer(
      "paraphrase",
      "de-lagerbesprechung",
      "am 27. Dezember statt"
    ),
  },
  {
    id: "x-nl-de-vakantiedagen",
    language: "nl",
    question: "Hoeveel vakantiedagen hebben de collega's in Duisburg?",
    expects: answer("paraphrase", "de-urlaub", "28 Urlaubstage im Jahr"),
  },
  {
    id: "x-nl-fr-beurs",
    language: "nl",
    question: "Wanneer staan we op de vakbeurs in Lyon?",
    expects: answer("paraphrase", "fr-salon", "du 3 au 6 février"),
  },
  {
    id: "x-nl-es-murcia",
    language: "nl",
    question:
      "Hoeveel vrachtwagens per week gaan er naar de nieuwe klant in Murcia?",
    expects: answer("words", "es-reunion-murcia", "tres camiones a la semana"),
  },
  {
    id: "x-en-nl-forklift-speed",
    language: "en",
    question: "What is the forklift speed limit in the Nieuwegein warehouse?",
    expects: answer("paraphrase", "nl-magazijn", "6 km per uur"),
  },
  {
    id: "x-en-nl-van-dijk",
    language: "en",
    question: "When does Van Dijk collect the shipments for Belgium now?",
    expects: answer("words", "nl-ophaaltijden", "om 15.30 uur op"),
  },
  {
    id: "x-en-nl-bike-plan",
    language: "en",
    question: "What is the most a bike can cost under the cycle scheme?",
    expects: answer("paraphrase", "nl-fiets", "maximaal 1.500 euro"),
  },
  {
    id: "x-en-de-early-shift",
    language: "en",
    question: "When does the early shift start in Duisburg?",
    expects: answer(
      "paraphrase",
      "de-schichten",
      "Frühschicht von 6:00 bis 14:00 Uhr"
    ),
  },
  {
    id: "x-en-fr-rtt",
    language: "en",
    question: "How many RTT days do staff in Lyon get?",
    expects: answer("words", "fr-conges", "10 jours de RTT par an"),
  },
  {
    id: "x-en-es-mileage",
    language: "en",
    question: "What is the mileage rate for using my own car in Spain?",
    expects: answer("paraphrase", "es-dietas", "0,26 € por kilómetro"),
  },
  {
    id: "x-de-nl-geburtsurlaub",
    language: "de",
    question:
      "Wie viel Urlaub bekommt der Partner in Utrecht nach einer Geburt?",
    expects: answer("paraphrase", "nl-verlof", "één werkweek geboorteverlof"),
  },
  {
    id: "x-de-en-hotel-paris",
    language: "de",
    question: "Wie teuer darf ein Hotel in Paris pro Nacht sein?",
    expects: answer("paraphrase", "en-travel", "in London and Paris"),
  },
  {
    id: "x-de-es-hermanos-gil",
    language: "de",
    question: "Wann holt Hermanos Gil die Sendungen nach Portugal ab?",
    expects: answer("words", "es-recogida-portugal", "a las 16:30"),
  },
  {
    id: "x-fr-nl-teletravail",
    language: "fr",
    question: "Quelle est l'indemnité de télétravail au siège d'Utrecht ?",
    expects: answer("paraphrase", "nl-reiskosten", "2,40 euro per dag"),
  },
  {
    id: "x-fr-en-hausse-prix",
    language: "fr",
    question: "De combien augmentent les prix du mobilier de jardin ?",
    expects: answer(
      "paraphrase",
      "en-price-increase",
      "price increase of 4.5%"
    ),
  },
  {
    id: "x-fr-de-rampe",
    language: "fr",
    question: "Quand le technicien vient-il réparer la porte de la rampe 4 ?",
    expects: answer(
      "paraphrase",
      "de-rolltor",
      "Der Techniker kommt am Donnerstag"
    ),
  },
  {
    id: "x-es-nl-enfermo",
    language: "es",
    question: "¿Antes de qué hora aviso de que estoy enfermo en Utrecht?",
    expects: answer("paraphrase", "nl-ziekte", "vóór 8.30 uur telefonisch"),
  },
  {
    id: "x-es-en-erp",
    language: "es",
    question: "¿Por qué falla la importación de pedidos grandes en el ERP?",
    expects: answer(
      "exact",
      "en-erp-import",
      "more than 250 lines fail to import"
    ),
  },
  {
    id: "x-es-fr-tilleuls",
    language: "es",
    question: "¿Cuántas sombrillas recibió la Jardinerie Les Tilleuls?",
    expects: answer("exact", "fr-reclamation", "12 parasols au lieu des 20"),
  },
];
