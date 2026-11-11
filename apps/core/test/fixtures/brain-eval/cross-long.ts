import { answer } from "./company.ts";
import type { BrainEvalQuestion } from "./company.ts";

// Questions in one language about a passage of a long document in another,
// as people at Groenhaven ask them: each in their own language, about
// another site's handbooks, policies, threads and minutes. Some ask for one
// of two passages that read alike (`lookalike`).

export const crossLongQuestions: readonly BrainEvalQuestion[] = [
  {
    id: "x-long-nl-en-klantcontract",
    language: "nl",
    question:
      "Hoe lang moeten we een getekende overeenkomst met een klant bewaren nadat die is afgelopen?",
    expects: answer(
      "paraphrase",
      "en-records-retention",
      "seven years after the contract ends, counted",
      "ten years after the contract ends, counted"
    ),
  },
  {
    id: "x-long-nl-de-palletzending",
    language: "nl",
    question:
      "Wanneer moet een palletzending in Duisburg uiterlijk zijn aangemeld?",
    expects: answer(
      "words",
      "de-handbuch-kommissionierung",
      "Speditionsversand ist 11:00 Uhr am Vortag",
      "Paketversand ist 15:00 Uhr"
    ),
  },
  {
    id: "x-long-nl-fr-printen",
    language: "nl",
    question: "Hoe krijg ik op het kantoor in Lyon mijn afdruk uit de printer?",
    expects: answer(
      "words",
      "fr-livret-accueil-lyon",
      "lorsque vous présentez votre badge devant l'imprimante"
    ),
  },
  {
    id: "x-long-en-nl-course-repay",
    language: "en",
    question:
      "If I resign a few months after finishing an expensive course the company paid for, how much of it do I have to pay back?",
    expects: answer(
      "paraphrase",
      "nl-handboek-opleiding",
      "75 procent als je binnen het eerste jaar vertrekt"
    ),
  },
  {
    id: "x-long-en-nl-pick-errors-valencia",
    language: "en",
    question: "What was Valencia's picking error rate last quarter?",
    expects: answer(
      "words",
      "nl-notulen-kwartaaloverleg",
      "Valencia kwam in het derde kwartaal uit op 0,58 procent",
      "Nieuwegein kwam in het derde kwartaal uit op 0,42 procent"
    ),
  },
  {
    id: "x-long-de-nl-rahmenvertrag",
    language: "de",
    asker: "lukas",
    question: "Wie lange darf ein Rahmenvertrag bei uns höchstens laufen?",
    expects: answer(
      "paraphrase",
      "nl-inkoopbeleid",
      "Een raamcontract loopt hoogstens drie jaar"
    ),
  },
  {
    id: "x-long-es-nl-devolucion-tienda-online",
    language: "es",
    question:
      "¿Cuántos días tiene una tienda online para devolvernos mercancía en buen estado?",
    expects: answer(
      "paraphrase",
      "nl-handboek-retouren",
      "tot zestig dagen na levering terugsturen",
      "tot dertig dagen na levering terugsturen"
    ),
  },
  {
    id: "x-long-fr-es-retour-fournisseur",
    language: "fr",
    question:
      "Combien de temps un fournisseur a-t-il pour venir reprendre une marchandise refusée à Valence ?",
    expects: answer(
      "paraphrase",
      "es-manual-recepcion",
      "diez días laborables para recoger la devolución"
    ),
  },
  {
    id: "x-long-de-en-generalprobe",
    language: "de",
    question:
      "Wann findet die Generalprobe für die Umstellung auf das ERP-Release 26.12 statt?",
    expects: answer(
      "exact",
      "en-thread-erp-cutover",
      "dress rehearsal on the test system on Saturday 28 November"
    ),
  },
  {
    id: "x-long-es-de-muelles-nave-nueva",
    language: "es",
    asker: "javier",
    question:
      "¿Cuántos muelles de carga nuevos tendrá la nave que se va a construir en Duisburg?",
    expects: answer(
      "words",
      "de-protokoll-standortversammlung",
      "bekommt sechs zusätzliche Rampen"
    ),
  },
];
