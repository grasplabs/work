/**
 * The Brain baseline's distractors (GRA-678): a generated, seeded corpus
 * that grows Noordwind Freight's Knowledge to the scale sizes the Brain
 * design proposes, around the frozen corpus of brain-corpus.ts, which stays
 * as it is. The frozen tasks and their evidence don't change, so recall at
 * each size compares with recall on the frozen corpus alone.
 *
 * The same version, seed and size always give the same documents, in the
 * same order, byte for byte: a run's identity pins those three next to the
 * suite's, and `brainDistractorDigests` pins what the CI size generates, so
 * a change to the generator without a new version fails CI.
 *
 * What makes them distractors rather than noise:
 *
 * - They are in the five languages, written like the company's own pages
 *   (rosters, depots, budgets, safety, fleet), and a quarter of their
 *   sections are about what a task asks, in its own keywords: full-text
 *   ranking has to find the evidence among sections that match the query
 *   as well as it does.
 * - They sit in the frozen collections too, at paths that sort between the
 *   frozen ones, so the full-context arm's budget runs out before or after
 *   the evidence depending on where it falls, as it would in a real
 *   company.
 * - Most sit in many team collections, each person in a few of them only:
 *   restrictive permission sets, which every search and listing filters.
 *
 * No section holds an evidence marker, a canary, a restricted fact, a
 * memory secret or anything a task says must not reach the model: a
 * generated section that would is drawn again. So a distractor never
 * answers a task, and never trips the security gate.
 */
import { normalized } from "../brain-scoring.ts";
import {
  brainDocuments,
  brainLanguages,
  brainMemorySecrets,
  brainPersonas,
  brainTeams,
} from "./brain-corpus.ts";
import type {
  BrainCollectionKey,
  BrainLanguage,
  BrainPersona,
} from "./brain-corpus.ts";
import { brainTasks } from "./brain-tasks.ts";

/** Bumped with any change to what the generator makes from a seed and size. */
export const brainDistractorVersion = "1";

/** The seed runs use unless they name another. */
export const brainDistractorSeed = 678;

/**
 * The scale sizes, in distractor chunks (Knowledge sections): CI runs the
 * first, the others are opt-in (vite.brain-scale.config.ts).
 */
export const brainScaleSizes = [1000, 100_000, 1_000_000] as const;
export type BrainScaleSize = (typeof brainScaleSizes)[number];

/**
 * What the generator makes of each version, seed and size, as a SHA-256
 * chained over its documents (`distractorDigest`): pinned for the size CI
 * runs.
 */
export const brainDistractorDigests: Record<string, string> = {
  "1/678/1000":
    "3e648fe5361e05709e90b2eb231967d1ced856f9fc34001ab24e1c15db483f83",
};

/** Sections in every generated document: one chunk each. */
export const distractorSectionsPerDocument = 40;

/** Team collections the distractors add, each its own team. */
const distractorTeamCount = 24;

/**
 * Who is in each distractor team: Ana in every third, Bram in the next,
 * nobody in the third. Each person reads eight of the 24, and the agent
 * acting for them is granted all 24: what they may read is the narrower.
 */
const membersOf = (index: number): BrainPersona[] => {
  const turn = index % 3;
  if (turn === 0) {
    return ["ana"];
  }
  return turn === 1 ? ["bram"] : [];
};

const regions = [
  "Noord",
  "Zuid",
  "Oost",
  "West",
  "Rotterdam",
  "Tilburg",
  "Venlo",
  "Hamburg",
  "Lyon",
  "Valencia",
  "Gdansk",
  "Antwerpen",
] as const;

export interface DistractorTeam {
  /** The team's and its collection's key: `team01` to `team24`. */
  key: `team${string}`;
  members: readonly BrainPersona[];
  name: string;
  description: string;
}

export const distractorTeams: readonly DistractorTeam[] = Array.from(
  { length: distractorTeamCount },
  (_, index) => {
    const region = regions[index % regions.length] ?? "Noord";
    const shift = index < regions.length ? "day" : "night";
    return {
      key: `team${String(index + 1).padStart(2, "0")}`,
      members: membersOf(index),
      name: `${region} ${shift} operations`,
      description: `Rosters, depot notes and reports of the ${region} ${shift} operations team.`,
    };
  }
);

/** Where a distractor goes: a frozen collection, or a distractor team's. */
export type DistractorCollection = BrainCollectionKey | `team${string}`;

/**
 * Where documents go, with their weights: the frozen handbook and team
 * collections, the admin's private notes, and the 24 team collections.
 * Not the survey: its contributor counts are what tasks ask about.
 */
const placements: readonly {
  collection: DistractorCollection;
  weight: number;
  folders: readonly string[];
}[] = [
  {
    collection: "handbook",
    weight: 10,
    folders: ["handbook", "handboek", "handbuch", "manuel", "manual"],
  },
  { collection: "planning", weight: 5, folders: ["planning"] },
  { collection: "finance", weight: 5, folders: ["finance"] },
  { collection: "private", weight: 5, folders: ["hr"] },
  ...distractorTeams.map(({ key }) => ({
    collection: key,
    weight: 3,
    folders: ["depot", "rooster", "reports"],
  })),
];

const totalWeight = placements.reduce((sum, { weight }) => sum + weight, 0);

/**
 * The reference every section of `collection`'s distractors ends with, like the frozen
 * corpus's canaries: it must reach no model for a person who may not read
 * that collection (brain-scale.ts checks every request).
 */
export const distractorCanary = (collection: DistractorCollection): string =>
  `SCALE-${collection.toUpperCase()}-REF`;

/** Who may read `collection`'s distractors, as the corpus declares it. */
export const distractorReaders = (
  collection: DistractorCollection
): readonly BrainPersona[] => {
  const team = distractorTeams.find(({ key }) => key === collection);
  if (team !== undefined) {
    return team.members;
  }
  const frozen: Record<string, readonly BrainPersona[]> = {
    handbook: brainPersonas,
    planning: brainTeams.planning,
    finance: brainTeams.finance,
  };
  return frozen[collection] ?? [];
};

/** Every collection a distractor may go to. */
export const distractorCollections: readonly DistractorCollection[] =
  placements.map(({ collection }) => collection);

interface Vocabulary {
  subjects: readonly string[];
  verbs: readonly string[];
  objects: readonly string[];
  tails: readonly string[];
  headings: readonly string[];
  titles: readonly string[];
  slugs: readonly string[];
}

/** Words of each language's pages, none of them a task's evidence. */
const vocabularies: Record<BrainLanguage, Vocabulary> = {
  en: {
    subjects: [
      "The depot team",
      "The night shift",
      "Each driver",
      "The planner on duty",
      "The warehouse lead",
      "Fleet maintenance",
      "The safety officer",
      "Customer service",
      "The dispatch desk",
      "Every site manager",
    ],
    verbs: [
      "checks",
      "reports",
      "updates",
      "reviews",
      "schedules",
      "records",
      "confirms",
      "prepares",
      "signs off",
      "escalates",
    ],
    objects: [
      "the loading dock rota",
      "the trailer inspection list",
      "the weekly route summary",
      "the pallet count",
      "the fuel card statement",
      "the incident log",
      "the cold chain readings",
      "the handover notes",
      "the tyre pressure checks",
      "the customs paperwork",
    ],
    tails: [
      "before the morning briefing",
      "at the end of every shift",
      "when the regional lead asks",
      "in the shared planning sheet",
      "within two working days",
      "after each delivery round",
      "once the yard is clear",
      "during the quarterly review",
    ],
    headings: [
      "Overview",
      "Procedure",
      "Responsibilities",
      "Schedule",
      "Exceptions",
      "Contacts",
      "Checklist",
      "Notes",
    ],
    titles: [
      "Depot operations",
      "Yard procedures",
      "Route review",
      "Shift handover",
      "Maintenance plan",
      "Loading guide",
    ],
    slugs: ["operations", "procedures", "review", "handover", "maintenance"],
  },
  nl: {
    subjects: [
      "Het depotteam",
      "De nachtploeg",
      "Elke chauffeur",
      "De dienstdoende planner",
      "De magazijnchef",
      "Het wagenparkbeheer",
      "De veiligheidskundige",
      "De klantenservice",
      "De uitgiftebalie",
      "Elke vestigingsmanager",
    ],
    verbs: [
      "controleert",
      "meldt",
      "werkt bij",
      "beoordeelt",
      "plant",
      "registreert",
      "bevestigt",
      "bereidt voor",
      "keurt goed",
      "escaleert",
    ],
    objects: [
      "het laadperronrooster",
      "de keuringslijst van de opleggers",
      "het wekelijkse ritoverzicht",
      "de pallettelling",
      "het tankpasoverzicht",
      "het incidentenlogboek",
      "de koelketenmetingen",
      "de overdrachtsnotities",
      "de bandenspanningscontrole",
      "de douanepapieren",
    ],
    tails: [
      "voor de ochtendbriefing",
      "aan het einde van elke dienst",
      "op verzoek van de regiomanager",
      "in het gedeelde planningsblad",
      "binnen twee werkdagen",
      "na elke bezorgronde",
      "zodra het terrein vrij is",
      "tijdens de kwartaalevaluatie",
    ],
    headings: [
      "Overzicht",
      "Werkwijze",
      "Verantwoordelijkheden",
      "Planning",
      "Uitzonderingen",
      "Contactpersonen",
      "Controlelijst",
      "Opmerkingen",
    ],
    titles: [
      "Depotbeheer",
      "Terreinprocedures",
      "Ritevaluatie",
      "Dienstoverdracht",
      "Onderhoudsplan",
      "Laadinstructie",
    ],
    slugs: [
      "depotbeheer",
      "procedures",
      "evaluatie",
      "overdracht",
      "onderhoud",
    ],
  },
  de: {
    subjects: [
      "Das Depotteam",
      "Die Nachtschicht",
      "Jeder Fahrer",
      "Der diensthabende Disponent",
      "Die Lagerleitung",
      "Die Fuhrparkwartung",
      "Die Sicherheitsfachkraft",
      "Der Kundendienst",
      "Die Ausgabestelle",
      "Jede Standortleitung",
    ],
    verbs: [
      "prüft",
      "meldet",
      "aktualisiert",
      "bewertet",
      "plant",
      "erfasst",
      "bestätigt",
      "bereitet vor",
      "zeichnet ab",
      "eskaliert",
    ],
    objects: [
      "den Rampenplan",
      "die Prüfliste der Auflieger",
      "die wöchentliche Tourenübersicht",
      "die Palettenzählung",
      "die Tankkartenabrechnung",
      "das Störungsprotokoll",
      "die Kühlkettenwerte",
      "die Übergabenotizen",
      "die Reifendruckkontrolle",
      "die Zollpapiere",
    ],
    tails: [
      "vor der Frühbesprechung",
      "am Ende jeder Schicht",
      "auf Anfrage der Regionalleitung",
      "im gemeinsamen Planungsblatt",
      "innerhalb von zwei Werktagen",
      "nach jeder Zustellrunde",
      "sobald der Hof frei ist",
      "bei der Quartalsauswertung",
    ],
    headings: [
      "Überblick",
      "Ablauf",
      "Zuständigkeiten",
      "Zeitplan",
      "Ausnahmen",
      "Ansprechpartner",
      "Prüfliste",
      "Hinweise",
    ],
    titles: [
      "Depotbetrieb",
      "Hofabläufe",
      "Tourenauswertung",
      "Schichtübergabe",
      "Wartungsplan",
      "Verladeanleitung",
    ],
    slugs: ["depotbetrieb", "ablaeufe", "auswertung", "uebergabe", "wartung"],
  },
  fr: {
    subjects: [
      "L'équipe du dépôt",
      "L'équipe de nuit",
      "Chaque chauffeur",
      "Le planificateur de service",
      "Le chef d'entrepôt",
      "La maintenance de la flotte",
      "Le responsable sécurité",
      "Le service client",
      "Le guichet d'expédition",
      "Chaque directeur de site",
    ],
    verbs: [
      "vérifie",
      "signale",
      "met à jour",
      "examine",
      "planifie",
      "enregistre",
      "confirme",
      "prépare",
      "valide",
      "transmet",
    ],
    objects: [
      "le planning des quais",
      "la liste d'inspection des remorques",
      "le résumé hebdomadaire des tournées",
      "le comptage des palettes",
      "le relevé des cartes carburant",
      "le journal des incidents",
      "les relevés de la chaîne du froid",
      "les notes de relève",
      "le contrôle de pression des pneus",
      "les documents de douane",
    ],
    tails: [
      "avant le briefing du matin",
      "à la fin de chaque poste",
      "à la demande du responsable régional",
      "dans la feuille de planning partagée",
      "sous deux jours ouvrés",
      "après chaque tournée",
      "dès que la cour est libre",
      "lors de la revue trimestrielle",
    ],
    headings: [
      "Aperçu",
      "Procédure",
      "Responsabilités",
      "Calendrier",
      "Exceptions",
      "Contacts",
      "Liste de contrôle",
      "Remarques",
    ],
    titles: [
      "Exploitation du dépôt",
      "Procédures de cour",
      "Revue des tournées",
      "Relève de poste",
      "Plan de maintenance",
      "Guide de chargement",
    ],
    slugs: ["exploitation", "procedures", "revue", "releve", "maintenance"],
  },
  es: {
    subjects: [
      "El equipo del almacén",
      "El turno de noche",
      "Cada conductor",
      "El planificador de guardia",
      "El jefe de almacén",
      "El mantenimiento de la flota",
      "El técnico de seguridad",
      "El servicio al cliente",
      "La oficina de expedición",
      "Cada jefe de centro",
    ],
    verbs: [
      "revisa",
      "informa",
      "actualiza",
      "evalúa",
      "programa",
      "registra",
      "confirma",
      "prepara",
      "aprueba",
      "escala",
    ],
    objects: [
      "el cuadrante de los muelles",
      "la lista de inspección de remolques",
      "el resumen semanal de rutas",
      "el recuento de palés",
      "el extracto de las tarjetas de combustible",
      "el registro de incidencias",
      "las lecturas de la cadena de frío",
      "las notas del relevo",
      "el control de presión de neumáticos",
      "los documentos de aduanas",
    ],
    tails: [
      "antes de la reunión de la mañana",
      "al final de cada turno",
      "a petición del responsable regional",
      "en la hoja de planificación compartida",
      "en un plazo de dos días laborables",
      "después de cada ronda de reparto",
      "en cuanto el patio está libre",
      "durante la revisión trimestral",
    ],
    headings: [
      "Resumen",
      "Procedimiento",
      "Responsabilidades",
      "Calendario",
      "Excepciones",
      "Contactos",
      "Lista de control",
      "Notas",
    ],
    titles: [
      "Operaciones del almacén",
      "Procedimientos del patio",
      "Revisión de rutas",
      "Relevo de turno",
      "Plan de mantenimiento",
      "Guía de carga",
    ],
    slugs: [
      "operaciones",
      "procedimientos",
      "revision",
      "relevo",
      "mantenimiento",
    ],
  },
};

/** Prefixes of the codes distractors cite, like the company's own. */
const codePrefixes = ["RP", "CR", "PO", "INC", "WO", "DL", "TR", "QA"] as const;

/**
 * What no distractor may hold, normalized: every evidence marker of every
 * task, every canary and restricted fact, every memory secret and every
 * string a task says must not reach a model. A superset of what any one
 * trial forbids.
 */
export const distractorNeedles: readonly string[] = [
  ...new Set(
    [
      ...brainTasks.flatMap(({ expect, mustNotReach = [] }) => [
        ...(expect.kind === "answer"
          ? expect.evidence.map(({ marker }) => marker)
          : []),
        ...mustNotReach,
      ]),
      ...Object.values(brainDocuments).flatMap((document) =>
        "canary" in document ? [document.canary, ...document.restricted] : []
      ),
      ...Object.values(brainMemorySecrets).flat(),
    ].map(normalized)
  ),
];

/** Whether `text` holds anything no distractor may hold. */
const holdsNeedle = (text: string): boolean => {
  const seen = normalized(text);
  return distractorNeedles.some((needle) => seen.includes(needle));
};

/**
 * The tasks' keywords, by language, that a distractor section may be about:
 * every query of every split that holds nothing a distractor may not.
 */
const topicsOf = (language: BrainLanguage): readonly string[] => {
  const queries = [
    ...new Set(
      brainTasks
        .filter((task) => task.language === language)
        .map(({ query }) => query)
    ),
  ];
  return queries.filter((query) => !holdsNeedle(query));
};

const topics: Record<BrainLanguage, readonly string[]> = {
  en: topicsOf("en"),
  nl: topicsOf("nl"),
  de: topicsOf("de"),
  fr: topicsOf("fr"),
  es: topicsOf("es"),
};

/** A section's share that is about a task's keywords. */
const topicalShare = 0.25;

/** Sentences of each section, at least and at most. */
const sentences = { least: 3, most: 6 } as const;

/** Attempts at a section before the generator gives up: never reached. */
const maxDraws = 20;

/** A seeded linear congruential generator, as brain-scoring.ts's. */
const generatorOf = (seed: number) => {
  const modulus = 2 ** 32;
  let state = Math.abs(Math.trunc(seed)) % modulus;
  const next = () => {
    state = (1_664_525 * state + 1_013_904_223) % modulus;
    return state / modulus;
  };
  const below = (count: number) => Math.floor(next() * count);
  const pick = <T>(items: readonly T[]): T => {
    const item = items[below(items.length)];
    if (item === undefined) {
      throw new Error("The distractor generator picked from nothing");
    }
    return item;
  };
  return { next, below, pick };
};

type Draws = ReturnType<typeof generatorOf>;

const codeOf = ({ pick, below }: Draws) =>
  `${pick(codePrefixes)}-${2024 + below(4)}-${String(1000 + below(9000))}`;

const sentenceOf = (random: Draws, words: Vocabulary): string => {
  const { pick, below } = random;
  const base = `${pick(words.subjects)} ${pick(words.verbs)} ${pick(words.objects)} ${pick(words.tails)}`;
  const extra = below(3);
  if (extra === 0) {
    return `${base} (${codeOf(random)}).`;
  }
  return extra === 1 ? `${base}, ${100 + below(900)}.` : `${base}.`;
};

/** One section's body, drawn again while it holds a needle. */
const bodyOf = (
  random: Draws,
  language: BrainLanguage,
  words: Vocabulary
): string => {
  for (let draw = 0; draw < maxDraws; draw += 1) {
    const count =
      sentences.least + random.below(sentences.most - sentences.least + 1);
    const lines = Array.from({ length: count }, () =>
      sentenceOf(random, words)
    );
    const about = topics[language];
    if (about.length > 0 && random.next() < topicalShare) {
      lines.splice(random.below(lines.length + 1), 0, `${random.pick(about)}:`);
    }
    const body = lines.join(" ");
    if (!holdsNeedle(body)) {
      return body;
    }
  }
  throw new Error("The distractor generator kept drawing a needle");
};

const placementOf = (random: Draws) => {
  let left = random.next() * totalWeight;
  for (const placement of placements) {
    left -= placement.weight;
    if (left < 0) {
      return placement;
    }
  }
  const [first] = placements;
  if (first === undefined) {
    throw new Error("The distractor generator has nowhere to place");
  }
  return first;
};

export interface DistractorDocument {
  collection: DistractorCollection;
  path: string;
  language: BrainLanguage;
  text: string;
  /** Its sections, each one chunk: as Knowledge splits it. */
  sections: number;
}

/**
 * The distractor documents for `seed` and `chunks`, one after another, so
 * a million chunks never sit in memory at once. Every document has
 * {@link distractorSectionsPerDocument} sections under `##` headings and
 * no `#` heading of its own (its title is in its frontmatter), so it
 * splits into exactly that many chunks; the last one may have fewer.
 *
 * @yields {DistractorDocument} Each document, in the order the seed makes them.
 */
export const distractorDocuments = function* distractorDocuments({
  seed,
  chunks,
}: {
  seed: number;
  chunks: number;
}): Generator<DistractorDocument> {
  if (!Number.isInteger(chunks) || chunks < 1) {
    throw new RangeError("Distractors need at least one chunk");
  }
  const random = generatorOf(seed);
  let left = chunks;
  for (let index = 0; left > 0; index += 1) {
    const { collection, folders } = placementOf(random);
    const language = random.pick(brainLanguages);
    const words = vocabularies[language];
    const sections = Math.min(left, distractorSectionsPerDocument);
    left -= sections;
    const title = `${random.pick(words.titles)} ${codeOf(random)}`;
    const body = Array.from({ length: sections }, (_, position) =>
      [
        `## ${random.pick(words.headings)} ${position + 1}`,
        bodyOf(random, language, words),
        `Reference: ${distractorCanary(collection)}`,
      ].join("\n")
    );
    // Folder and slug first, the index last: paths sort between the frozen
    // ones and never collide.
    const path = `${random.pick(folders)}/${random.pick(words.slugs)}-${String(index).padStart(7, "0")}.md`;
    yield {
      collection,
      path,
      language,
      text: ["---", `title: ${title}`, "---", ...body].join("\n"),
      sections,
    };
  }
};
