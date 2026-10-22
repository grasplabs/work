// The platform's sensitive-data minimum: what no Knowledge save, upload,
// memory or App entry may store, whatever a company's own topics say.
// Each topic is a record (name, coverage, examples per language, owner,
// revision, effective time), kept versioned in core's database
// (`admission_topics`) by admission.ts, and the word lists that detect it
// here. The word lists are code on purpose: a topic row edited or deleted
// in the database can't switch a platform detector off. Changing a list
// means a new revision of its topic.
//
// Exclusion topics are not statement categories: they decide what is never
// stored, not how a stored statement is filed.
//
// Detection is deterministic, in the five product languages, on text
// lowercased with its accents removed (`normalized`):
// - `strong`: phrases that only ever describe one person's sensitive data
//   ("diagnosed with"): the text is excluded wherever they appear.
// - `weak`: sensitive words that also appear in policy text ("salary",
//   "sick leave"): held when the same sentence, or table, also refers to a
//   person (`personReferences`); admitted otherwise, so a salary-band
//   policy or "we don't discriminate on religion" can still be saved.
// - `amounts`: for pay only: a pay word, an amount and a person together
//   are excluded.
// A trailing `*` matches any ending ("salar*": "salary", "salaries");
// spaces match any run of whitespace. Known misses: a person named
// without a pronoun or role ("Jan has diabetes"), paraphrase, misspelling,
// other languages, and text in images, which extraction doesn't read.
// Operational words that look sensitive ("health check", "race
// condition", "union type", "SSH key fingerprint", "pay the invoice") are
// deliberately not on the lists.

/** The product's languages, which every topic's examples cover. */
export const admissionLanguages = ["en", "nl", "de", "fr", "es"] as const;
export type AdmissionLanguage = (typeof admissionLanguages)[number];

/** Who owns a topic: the platform's minimum, or a company's own. */
export type TopicOwner = "platform" | "company";

/** An example of what a topic covers, in one language. */
export interface TopicExample {
  language: AdmissionLanguage;
  text: string;
}

/** One revision of an exclusion topic, as recorded. */
export interface TopicRecord {
  id: string;
  revision: number;
  name: string;
  coverage: string;
  examples: TopicExample[];
  owner: TopicOwner;
  /** From when this revision applies. */
  effectiveAt: Date;
}

/** How a platform topic is detected, at its revision. */
export interface TopicRules {
  strong: readonly string[];
  weak: readonly string[];
  /** Whether a weak word, an amount and a person together exclude. */
  amounts?: true;
}

/** A platform topic: its record and its detector, one revision of both. */
export interface PlatformTopic {
  record: TopicRecord;
  rules: TopicRules;
}

/** When the platform minimum's first revision took effect. */
const minimumSince = new Date("2026-10-21T00:00:00.000Z");

const platform = (
  record: Omit<TopicRecord, "owner" | "effectiveAt" | "revision">,
  rules: TopicRules
): PlatformTopic => ({
  record: {
    ...record,
    owner: "platform",
    revision: 1,
    effectiveAt: minimumSince,
  },
  rules,
});

/**
 * Words that refer to a person: pronouns, roles and honorifics. A weak
 * word in the same sentence as one of these is about someone. Short,
 * common ones ("il", "su", "ze") make some policy sentences held: when
 * unsure, hold.
 */
export const personReferences: readonly string[] = [
  // English ("me" is also Dutch, as in "bel me", so it isn't here)
  "i",
  "my",
  "mine",
  "he",
  "him",
  "his",
  "she",
  "her",
  "hers",
  "they",
  "them",
  "their",
  "employee*",
  "colleague*",
  "coworker*",
  "co worker*",
  "candidate*",
  "applicant*",
  "patient*",
  "staff member*",
  "team member*",
  "intern",
  "interns",
  "contractor*",
  "mr",
  "mrs",
  "ms",
  "dr",
  // Dutch ("zijn" is also "to be", so it isn't here)
  "ik",
  "mij",
  "mijn",
  "hij",
  "hem",
  "zij",
  "ze",
  "haar",
  "hen",
  "hun",
  "medewerker*",
  "werknemer*",
  "collega*",
  "kandidaat",
  "kandidaten",
  "sollicitant*",
  "stagiair*",
  "dhr",
  "mevr",
  "meneer",
  "mevrouw",
  // German
  "ich",
  "mich",
  "mir",
  "mein*",
  "er",
  "ihn",
  "ihm",
  "sein",
  "seine*",
  "sie",
  "ihr",
  "ihre*",
  "mitarbeiter*",
  "kollege*",
  "kollegin*",
  "bewerber*",
  "kandidat",
  "kandidatin*",
  "angestellte*",
  "praktikant*",
  "herr",
  "herrn",
  "frau",
  // French ("je" alone is also Dutch "you", the voice handbooks are
  // written in, so only phrases Dutch can't have)
  "je suis",
  "je me sens",
  "je me suis",
  "je souffre",
  "j'ai",
  "j ai",
  "moi",
  "mon",
  "ma",
  "mes",
  "il",
  "lui",
  "elle",
  "son",
  "sa",
  "ses",
  "leur",
  "leurs",
  "employe*",
  // "salariés" would read as English "salaries", a pay word.
  "salarie",
  "salariee*",
  "collegue*",
  "candidat",
  "candidats",
  "stagiaire*",
  "mme",
  "monsieur",
  "madame",
  // Spanish ("el" is also "the", so "él" isn't here)
  "yo",
  "mi",
  "mis",
  "ella",
  "ellas",
  "ellos",
  "su",
  "sus",
  "empleado*",
  "empleada*",
  "companero*",
  "companera*",
  "candidato*",
  "candidata*",
  "sr",
  "sra",
  "senor",
  "senora",
];

/**
 * A table's header words that name a person's column: a table with one,
 * and a weak word, is about people.
 */
export const personColumns: readonly string[] = [
  "name",
  "names",
  "first name",
  "last name",
  "naam",
  "voornaam",
  "achternaam",
  "vorname",
  "nachname",
  "nom",
  "prenom",
  "nombre",
  "apellido*",
];

/** The platform's sensitive-data minimum, revision by revision. */
export const platformTopics: readonly PlatformTopic[] = [
  platform(
    {
      id: "health",
      name: "Health",
      coverage:
        "A person's physical or mental health, illness, sick leave, pregnancy, disability, medication or treatment (GDPR Article 9).",
      examples: [
        { language: "en", text: "She is on sick leave with burnout." },
        { language: "nl", text: "Hij is ziek gemeld vanwege een depressie." },
        { language: "de", text: "Sie ist schwanger und bald im Mutterschutz." },
        { language: "fr", text: "Il est en arrêt maladie pour un cancer." },
        { language: "es", text: "Ella está de baja médica por diabetes." },
      ],
    },
    {
      strong: [
        "diagnosed with",
        "diagnosed as",
        "is pregnant",
        "gediagnosticeerd met",
        "is zwanger",
        "diagnostiziert mit",
        "wurde diagnostiziert",
        "ist schwanger",
        "a ete diagnostique*",
        "est enceinte",
        "diagnosticado con",
        "diagnosticada con",
        "esta embarazada",
      ],
      weak: [
        "health condition*",
        "medical condition*",
        "mental health",
        "illness*",
        "ill",
        "sick",
        "sickness",
        "sick leave",
        "sick note*",
        "burnout",
        "burn out",
        "burned out",
        "depress*",
        "anxiety",
        "pregnan*",
        "maternity leave",
        "disabilit*",
        "disabled",
        "medication*",
        "therap*",
        "diagnos*",
        "cancer",
        "diabetes",
        "hiv",
        "surgery",
        "hospital*",
        "chronic*",
        "ziek*",
        "ziekte*",
        "ziekmelding*",
        "ziekteverlof",
        "depressie*",
        "overspannen",
        "zwanger*",
        "handicap*",
        "arbeidsongeschikt*",
        "medicatie",
        "medicijn*",
        "therapie*",
        "diagnose*",
        "kanker",
        "ziekenhuis*",
        "chronisch*",
        "krank*",
        "depression*",
        "schwanger*",
        "mutterschutz",
        "behinderung*",
        "schwerbehindert*",
        "medikament*",
        "krebs",
        "arbeitsunfahig*",
        "psychisch*",
        "malade*",
        "maladie*",
        "arret maladie",
        "conge maladie",
        "enceinte",
        "grossesse",
        "medicament*",
        "therapie*",
        "diagnostic*",
        "diabete",
        "hopital*",
        "sante mentale",
        "invalidite",
        "enferm*",
        "baja medica",
        "baja por enfermedad",
        "depresion",
        "embarazad*",
        "embarazo",
        "discapacidad*",
        "medicamento*",
        "medicacion",
        "terapia*",
        "salud mental",
        "incapacidad",
      ],
    }
  ),
  platform(
    {
      id: "pay",
      name: "Pay",
      coverage:
        "What a person earns: salary, wages, bonuses, pay rises and payslips.",
      examples: [
        { language: "en", text: "His salary is €4,200 a month." },
        { language: "nl", text: "Haar salaris gaat naar €5.100 per maand." },
        { language: "de", text: "Sein Gehalt steigt auf 60.000 EUR." },
        { language: "fr", text: "Son salaire est de 3 800 € par mois." },
        { language: "es", text: "Su sueldo es de 2.900 € al mes." },
      ],
    },
    {
      strong: [],
      amounts: true,
      weak: [
        "salary",
        "salaries",
        "wage*",
        "pay rise*",
        "pay raise*",
        "pay grade*",
        "payslip*",
        "pay slip*",
        "paycheck*",
        "bonus*",
        "compensation",
        "remuneration",
        "earns",
        "earning*",
        "income*",
        "salaris*",
        "loon",
        "lonen",
        "loonstrook*",
        "salarisstrook*",
        "loonsverhoging*",
        "beloning*",
        "inkomen*",
        "verdient",
        "gehalt*",
        "lohn",
        "lohne",
        "lohnabrechnung*",
        "gehaltserhohung*",
        "vergutung*",
        "einkommen*",
        "salaire*",
        "remuneration*",
        "fiche de paie",
        "bulletin de salaire",
        "bulletin de paie",
        "prime",
        "primes",
        "augmentation de salaire",
        "revenu*",
        "gagne",
        "salario*",
        "sueldo*",
        "nomina*",
        "aumento de sueldo",
        "bonificacion*",
        "bono",
        "bonos",
        "ingreso*",
        "gana",
      ],
    }
  ),
  platform(
    {
      id: "beliefs",
      name: "Religious or philosophical beliefs",
      coverage:
        "A person's religion, faith or philosophical beliefs (GDPR Article 9).",
      examples: [
        { language: "en", text: "He is Muslim and fasts during Ramadan." },
        {
          language: "nl",
          text: "Zij is katholiek en gaat elke week naar de kerk.",
        },
        { language: "de", text: "Er ist Atheist." },
        { language: "fr", text: "Elle est juive." },
        {
          language: "es",
          text: "Su religión no le permite trabajar el sábado.",
        },
      ],
    },
    {
      strong: [],
      weak: [
        "religion*",
        "religious",
        "muslim*",
        "christianity",
        "jewish",
        "jew",
        "hindu*",
        "buddhis*",
        "atheist*",
        "catholic*",
        "protestant*",
        "religie*",
        "gelovig*",
        "moslim*",
        "christendom",
        "christelijk*",
        "joods*",
        "hindoe*",
        "katholiek*",
        "christentum",
        "judisch*",
        "jude",
        "katholisch*",
        "evangelisch*",
        "musulman*",
        "christianisme",
        "juif",
        "juive",
        "catholique*",
        "athee*",
        "cristianismo",
        "judio*",
        "judia*",
        "catolic*",
        "ateo",
        "atea",
      ],
    }
  ),
  platform(
    {
      id: "ethnicity",
      name: "Racial or ethnic origin",
      coverage: "A person's racial or ethnic origin (GDPR Article 9).",
      examples: [
        { language: "en", text: "Her ethnic background is Moroccan." },
        { language: "nl", text: "Hij is van Turkse etnische afkomst." },
        { language: "de", text: "Seine ethnische Herkunft ist kurdisch." },
        { language: "fr", text: "Son origine ethnique est berbère." },
        { language: "es", text: "Su etnia es gitana." },
      ],
    },
    {
      strong: [],
      weak: [
        "ethnicity",
        "ethnic*",
        "racial*",
        "skin colour",
        "skin color",
        "etniciteit",
        "etnisch*",
        "huidskleur",
        "ethnie",
        "ethnisch*",
        "hautfarbe",
        "rasse",
        "ethnique*",
        "couleur de peau",
        "etnia",
        "etnic*",
        "raza",
        "color de piel",
      ],
    }
  ),
  platform(
    {
      id: "politics",
      name: "Political opinions",
      coverage:
        "A person's political opinions, votes or party membership (GDPR Article 9).",
      examples: [
        {
          language: "en",
          text: "He voted for the Greens and is a party member.",
        },
        { language: "nl", text: "Zij stemt op de SP." },
        { language: "de", text: "Er ist Parteimitglied der SPD." },
        { language: "fr", text: "Elle a voté pour le parti socialiste." },
        { language: "es", text: "Su ideología política es de izquierdas." },
      ],
    },
    {
      strong: [],
      weak: [
        "political part*",
        "political opinion*",
        "political view*",
        "votes for",
        "voted for",
        "party member*",
        "politieke partij*",
        "politieke voorkeur",
        "politieke mening",
        "stemt op",
        "stemde op",
        "partijlid*",
        "politische partei*",
        "politische meinung",
        "politische einstellung",
        "parteimitglied*",
        "parti politique",
        "opinion politique",
        "opinions politiques",
        "vote pour",
        "a vote pour",
        "partido politico",
        "opinion politica",
        "ideologia politica",
      ],
    }
  ),
  platform(
    {
      id: "union",
      name: "Trade union membership",
      coverage:
        "Whether a person is a member of a trade union (GDPR Article 9).",
      examples: [
        { language: "en", text: "She is a trade union member." },
        { language: "nl", text: "Hij is lid van de vakbond." },
        { language: "de", text: "Sie ist Gewerkschaftsmitglied." },
        { language: "fr", text: "Il est syndiqué." },
        { language: "es", text: "Ella está afiliada al sindicato." },
      ],
    },
    {
      strong: [],
      weak: [
        "trade union*",
        "labour union*",
        "labor union*",
        "union member*",
        "vakbond*",
        "gewerkschaft*",
        "syndicat*",
        "syndique*",
        "sindicato*",
        "sindical*",
      ],
    }
  ),
  platform(
    {
      id: "sexuality",
      name: "Sex life or sexual orientation",
      coverage:
        "A person's sex life, sexual orientation or gender identity (GDPR Article 9).",
      examples: [
        { language: "en", text: "He is gay." },
        { language: "nl", text: "Zij is lesbisch." },
        { language: "de", text: "Er ist bisexuell." },
        {
          language: "fr",
          text: "Son orientation sexuelle ne regarde personne.",
        },
        { language: "es", text: "Ella es transgénero." },
      ],
    },
    {
      strong: [],
      weak: [
        "sexual orientation",
        "sexuality",
        "gay",
        "lesbian*",
        "bisexual*",
        "homosexual*",
        "transgender*",
        "sex life",
        "seksuele geaardheid",
        "seksuele orientatie",
        "homo",
        "homoseksue*",
        "lesbisch*",
        "biseksue*",
        "seksleven",
        "sexuelle orientierung",
        "sexualitat",
        "schwul*",
        "bisexuell*",
        "homosexuell*",
        "sexualleben",
        "orientation sexuelle",
        "sexualite",
        "lesbienne*",
        "bisexuel*",
        "homosexuel*",
        "transgenre*",
        "vie sexuelle",
        "orientacion sexual",
        "sexualidad",
        "lesbiana*",
        "transgenero*",
        "vida sexual",
      ],
    }
  ),
  platform(
    {
      id: "genetic-biometric",
      name: "Genetic or biometric data",
      coverage:
        "A person's genetic data, or biometric data that identifies them (GDPR Article 9).",
      examples: [
        { language: "en", text: "His DNA test showed a genetic risk." },
        { language: "nl", text: "Haar genetische test is positief." },
        { language: "de", text: "Seine biometrischen Daten liegen vor." },
        { language: "fr", text: "Son test génétique est positif." },
        { language: "es", text: "Su prueba de ADN es positiva." },
      ],
    },
    {
      strong: [],
      weak: [
        "genetic*",
        "dna",
        "biometric*",
        "facial recognition",
        "genetisch*",
        "biometrisch*",
        "vingerafdruk*",
        "fingerabdruck*",
        "genetique*",
        "adn",
        "biometrique*",
        "empreinte digitale",
        "empreintes digitales",
        "huella dactilar",
        "huellas dactilares",
      ],
    }
  ),
  platform(
    {
      id: "criminal",
      name: "Criminal convictions and offences",
      coverage:
        "A person's criminal convictions, offences, arrests or record (GDPR Article 10).",
      examples: [
        { language: "en", text: "He was convicted of fraud in 2019." },
        { language: "nl", text: "Zij heeft een strafblad." },
        { language: "de", text: "Er wurde wegen Betrugs verurteilt." },
        { language: "fr", text: "Il a été condamné pour vol." },
        { language: "es", text: "Ella tiene antecedentes penales." },
      ],
    },
    {
      strong: [
        "was convicted",
        "convicted of",
        "convicted for",
        "werd veroordeeld",
        "veroordeeld voor",
        "veroordeeld tot",
        "wurde verurteilt",
        "verurteilt wegen",
        "a ete condamne*",
        "condamne pour",
        "condamnee pour",
        "fue condenado",
        "fue condenada",
        "condenado por",
        "condenada por",
      ],
      weak: [
        "criminal record*",
        "convicted",
        "conviction*",
        "arrested",
        "criminal offence*",
        "criminal offense*",
        "prison",
        "jail",
        "strafblad*",
        "veroordeeld*",
        "veroordeling*",
        "gearresteerd",
        "strafbaar feit",
        "gevangenis*",
        "vorstrafe*",
        "verurteilt*",
        "verurteilung*",
        "festgenommen",
        "verhaftet",
        "straftat*",
        "gefangnis*",
        "casier judiciaire",
        "condamne*",
        "condamnation*",
        "infraction penale",
        "antecedentes penales",
        "condenado*",
        "condenada*",
        "condena*",
        "detenido*",
        "detenida*",
        "delito*",
        "carcel",
      ],
    }
  ),
];
