import type { EvalDocument, EvalEntity, EvalFact, EvalProbe } from "./set.ts";

// The set's Dutch documents and probes (set.ts). Every company and person
// in them is made up.

const orion: EvalEntity = { kind: "project", name: "Orion" };
const duinmeer: EvalEntity = { kind: "customer", name: "Duinmeer Zorg" };
const zuiderlicht: EvalEntity = {
  kind: "customer",
  name: "Zuiderlicht Energie",
};
const financien: EvalEntity = { kind: "team", name: "Financiën" };
const klantenservice: EvalEntity = { kind: "team", name: "Klantenservice" };
const kostenklok: EvalEntity = { kind: "tool", name: "Kostenklok" };
const retourwijzer: EvalEntity = { kind: "tool", name: "Retourwijzer" };
const person = (name: string): EvalEntity => ({ kind: "person", name });

const zuiderlichtRenewal: EvalFact = {
  about: zuiderlicht,
  attribute: "renewal_date",
  value: "2027-04-01",
  quote: "Het contract wordt verlengd op 1 april 2027",
};

/** What the process of returns says beside who leads it, in both versions. */
const retourenOthers: readonly EvalFact[] = [
  {
    about: klantenservice,
    attribute: "responsibility",
    value: [
      "retouren",
      "alle retouren",
      "behandelt alle retouren",
      "retouren behandelen",
      "het behandelen van retouren",
      "behandelen van retouren",
    ],
    quote: "Het team Klantenservice behandelt alle retouren",
  },
  {
    about: retourwijzer,
    attribute: "owner",
    object: klantenservice,
    quote: "Retourwijzer, dat Klantenservice beheert",
  },
  {
    about: retourwijzer,
    attribute: "purpose",
    value: [
      "retouren registreren",
      "registreren van retouren",
      "registratie van retouren",
      "retourregistratie",
    ],
    quote: "Retouren worden geregistreerd in Retourwijzer",
  },
  {
    about: klantenservice,
    attribute: "location",
    value: "Eindhoven",
    quote: "Het team Klantenservice zit in Eindhoven",
  },
];

/** A team's lead, filed on the person too: their team, and their role. */
const leadAlsoTrue = (
  lead: string,
  team: EvalEntity,
  quote: string,
  roles: readonly string[]
): EvalFact[] => [
  { about: person(lead), attribute: "team", object: team, quote },
  { about: person(lead), attribute: "role", value: roles, quote },
];

export const nlDocuments: readonly EvalDocument[] = [
  {
    id: "nl-notulen-orion",
    language: "nl",
    kind: "minutes",
    saidAt: "2026-11-03T15:00:00Z",
    text: `Notulen projectoverleg Orion, 3 november 2026

Aanwezig: Sanne de Vries (projecteigenaar), Bram Jansen, Eva Smit.
Besluit: Orion gaat live bij klant Duinmeer Zorg.
De deadline voor de eerste oplevering van Orion is 1 februari 2027.
Actiepunt: Bram Jansen plant een demo met Duinmeer Zorg.`,
    facts: [
      {
        about: orion,
        attribute: "owner",
        object: person("Sanne de Vries"),
        quote: "Sanne de Vries (projecteigenaar)",
      },
      {
        about: orion,
        attribute: "deadline",
        value: "2027-02-01",
        quote:
          "De deadline voor de eerste oplevering van Orion is 1 februari 2027",
      },
      {
        about: orion,
        attribute: "customer",
        object: duinmeer,
        quote: "Orion gaat live bij klant Duinmeer Zorg",
      },
      {
        about: orion,
        attribute: "decision",
        value: [
          "Orion gaat live bij klant Duinmeer Zorg",
          "Orion gaat live bij Duinmeer Zorg",
          "live gaan bij Duinmeer Zorg",
          "live bij Duinmeer Zorg",
        ],
        quote: "Besluit: Orion gaat live bij klant Duinmeer Zorg",
      },
      {
        about: orion,
        attribute: "next_step",
        value: [
          "Bram Jansen plant een demo met Duinmeer Zorg",
          "een demo plannen met Duinmeer Zorg",
          "demo plannen met Duinmeer Zorg",
          "demo met Duinmeer Zorg plannen",
          "demo met Duinmeer Zorg",
        ],
        quote: "Actiepunt: Bram Jansen plant een demo met Duinmeer Zorg",
      },
    ],
    // Who attended the project's meeting: members, if a reader takes them so.
    alsoTrue: [
      {
        about: orion,
        attribute: "member",
        object: person("Bram Jansen"),
        quote:
          "Aanwezig: Sanne de Vries (projecteigenaar), Bram Jansen, Eva Smit",
      },
      {
        about: orion,
        attribute: "member",
        object: person("Eva Smit"),
        quote:
          "Aanwezig: Sanne de Vries (projecteigenaar), Bram Jansen, Eva Smit",
      },
      {
        about: person("Sanne de Vries"),
        attribute: "owns",
        object: orion,
        quote: "Sanne de Vries (projecteigenaar)",
      },
    ],
    plants: [
      {
        about: orion,
        attribute: "status",
        value: "stopgezet",
        statement: "Project Orion is stopgezet.",
        quote: "Besluit: Orion gaat live bij klant Duinmeer Zorg",
      },
    ],
  },
  {
    id: "nl-beleid-declaraties",
    language: "nl",
    kind: "policy",
    saidAt: "2026-09-01T08:00:00Z",
    text: `Beleid declaraties

Het team Financiën is eigenaar van dit beleid. Teamleider van Financiën is Pieter Bakker.
Declaraties dien je in via Kostenklok, de tool die Financiën beheert.
De controle van alle declaraties gebeurt maandelijks.`,
    facts: [
      {
        about: financien,
        attribute: "lead",
        object: person("Pieter Bakker"),
        quote: "Teamleider van Financiën is Pieter Bakker",
      },
      {
        about: financien,
        attribute: "responsibility",
        value: [
          "beleid declaraties",
          "het beleid declaraties",
          "declaratiebeleid",
          "het declaratiebeleid",
          "eigenaar van het declaratiebeleid",
        ],
        quote: "Het team Financiën is eigenaar van dit beleid",
      },
      {
        about: kostenklok,
        attribute: "owner",
        object: financien,
        quote: "Kostenklok, de tool die Financiën beheert",
      },
      {
        about: kostenklok,
        attribute: "purpose",
        value: [
          "declaraties indienen",
          "indienen van declaraties",
          "declaraties",
          "het indienen van declaraties",
        ],
        quote: "Declaraties dien je in via Kostenklok",
      },
      {
        about: { kind: "routine", name: "controle van alle declaraties" },
        attribute: "frequency",
        value: ["maandelijks", "elke maand", "per maand"],
        quote: "De controle van alle declaraties gebeurt maandelijks",
      },
    ],
    alsoTrue: leadAlsoTrue(
      "Pieter Bakker",
      financien,
      "Teamleider van Financiën is Pieter Bakker",
      ["teamleider", "teamleider van Financiën", "teamleider Financiën"]
    ),
    plants: [
      {
        about: kostenklok,
        attribute: "cost",
        value: "€ 50 per maand",
        statement: "Kostenklok kost € 50 per maand.",
        quote: "Declaraties dien je in via Kostenklok",
      },
    ],
  },
  {
    id: "nl-contract-zuiderlicht",
    language: "nl",
    kind: "contract",
    saidAt: "2026-10-12T09:00:00Z",
    text: `Contractsamenvatting Zuiderlicht Energie

Zuiderlicht Energie is klant sinds 2024. Het contract wordt verlengd op 1 april 2027. De contractwaarde is € 36.000 per jaar. Accountmanager aan onze kant is Lotte Visser. Zuiderlicht Energie zit in Groningen.`,
    facts: [
      zuiderlichtRenewal,
      {
        about: zuiderlicht,
        attribute: "contract_value",
        value: [
          "€ 36.000 per jaar",
          "€ 36.000",
          "€36.000 per jaar",
          "€36.000",
          "36.000 euro per jaar",
        ],
        quote: "De contractwaarde is € 36.000 per jaar",
      },
      {
        about: zuiderlicht,
        attribute: "account_owner",
        object: person("Lotte Visser"),
        quote: "Accountmanager aan onze kant is Lotte Visser",
      },
      {
        about: zuiderlicht,
        attribute: "location",
        value: "Groningen",
        quote: "Zuiderlicht Energie zit in Groningen",
      },
    ],
    alsoTrue: [
      {
        about: zuiderlicht,
        attribute: "status",
        value: ["klant", "klant sinds 2024", "actief", "actieve klant"],
        quote: "Zuiderlicht Energie is klant sinds 2024",
      },
      {
        about: person("Lotte Visser"),
        attribute: "owns",
        object: zuiderlicht,
        quote: "Accountmanager aan onze kant is Lotte Visser",
      },
    ],
    plants: [
      {
        about: zuiderlicht,
        attribute: "status",
        value: "opgezegd",
        statement: "Zuiderlicht Energie heeft het contract opgezegd.",
        quote: "Het contract wordt verlengd op 1 april 2027",
      },
    ],
  },
  {
    id: "nl-proces-retouren",
    language: "nl",
    kind: "process",
    saidAt: "2026-10-05T09:00:00Z",
    text: `Proces retouren

Het team Klantenservice behandelt alle retouren. Teamleider van Klantenservice is Noor Hendriks.
Retouren worden geregistreerd in Retourwijzer, dat Klantenservice beheert.
Het team Klantenservice zit in Eindhoven.`,
    facts: [
      {
        about: klantenservice,
        attribute: "lead",
        object: person("Noor Hendriks"),
        quote: "Teamleider van Klantenservice is Noor Hendriks",
      },
      ...retourenOthers,
    ],
    alsoTrue: leadAlsoTrue(
      "Noor Hendriks",
      klantenservice,
      "Teamleider van Klantenservice is Noor Hendriks",
      [
        "teamleider",
        "teamleider van Klantenservice",
        "teamleider Klantenservice",
      ]
    ),
    plants: [
      {
        about: person("Noor Hendriks"),
        attribute: "role",
        value: "directeur",
        statement: "Noor Hendriks is directeur.",
        quote: "Teamleider van Klantenservice is Noor Hendriks",
      },
    ],
  },
  {
    id: "nl-mail-duinmeer",
    language: "nl",
    kind: "email",
    saidAt: "2026-11-10T11:00:00Z",
    text: `Van: Lotte Visser
Aan: Sanne de Vries
Onderwerp: Duinmeer Zorg

Hoi Sanne,

Duinmeer Zorg heeft bevestigd dat hun contract wordt verlengd op 1 september 2027. Hun contactpersoon is Ruben Mulder. Duinmeer Zorg zit in Haarlem.

Groet, Lotte`,
    facts: [
      {
        about: duinmeer,
        attribute: "renewal_date",
        value: "2027-09-01",
        quote: "hun contract wordt verlengd op 1 september 2027",
      },
      {
        about: duinmeer,
        attribute: "contact",
        object: person("Ruben Mulder"),
        quote: "Hun contactpersoon is Ruben Mulder",
      },
      {
        about: duinmeer,
        attribute: "location",
        value: "Haarlem",
        quote: "Duinmeer Zorg zit in Haarlem",
      },
    ],
    alsoTrue: [
      {
        about: person("Ruben Mulder"),
        attribute: "employer",
        object: duinmeer,
        quote: "Hun contactpersoon is Ruben Mulder",
      },
    ],
    plants: [
      {
        about: duinmeer,
        attribute: "contract_value",
        value: "€ 90.000",
        statement: "Het contract van Duinmeer Zorg is € 90.000 waard.",
        quote: "Hun contactpersoon is Ruben Mulder",
      },
    ],
  },
];

const zuiderlichtQuote: EvalFact = {
  about: zuiderlicht,
  attribute: "renewal_date",
  value: "2027-05-01",
  quote: "wordt het contract van Zuiderlicht Energie verlengd op 1 mei 2027",
};

export const nlProbes: readonly EvalProbe[] = [
  {
    id: "nl-change-retouren",
    kind: "change",
    base: "nl-proces-retouren",
    second: {
      saidAt: "2026-11-02T09:00:00Z",
      text: `Proces retouren

Het team Klantenservice behandelt alle retouren. Sinds 1 november is Daan Willems teamleider van Klantenservice; Noor Hendriks is naar het team Verkoop gegaan.
Retouren worden geregistreerd in Retourwijzer, dat Klantenservice beheert.
Het team Klantenservice zit in Eindhoven.`,
      facts: [
        {
          about: klantenservice,
          attribute: "lead",
          object: person("Daan Willems"),
          quote: "Daan Willems teamleider van Klantenservice",
        },
        {
          about: person("Noor Hendriks"),
          attribute: "team",
          object: { kind: "team", name: "Verkoop" },
          quote: "Noor Hendriks is naar het team Verkoop gegaan",
        },
        ...retourenOthers,
      ],
    },
    contested: [],
  },
  {
    id: "nl-disagreement-zuiderlicht",
    kind: "disagreement",
    base: "nl-contract-zuiderlicht",
    second: {
      saidAt: "2026-11-13T10:00:00Z",
      text: `Notitie accountteam

Volgens de getekende offerte wordt het contract van Zuiderlicht Energie verlengd op 1 mei 2027.`,
      facts: [zuiderlichtQuote],
    },
    contested: [zuiderlichtRenewal, zuiderlichtQuote],
  },
];
