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
const person = (name: string): EvalEntity => ({ kind: "person", name });

const zuiderlichtRenewal: EvalFact = {
  about: zuiderlicht,
  attribute: "renewal_date",
  value: "2027-04-01",
  quote: "Het contract wordt verlengd op 1 april 2027",
};

const retourwijzerOwner: EvalFact = {
  about: { kind: "tool", name: "Retourwijzer" },
  attribute: "owner",
  object: klantenservice,
  quote: "Retourwijzer, dat Klantenservice beheert",
};
const klantenserviceLocation: EvalFact = {
  about: klantenservice,
  attribute: "location",
  value: "Eindhoven",
  quote: "Het team Klantenservice zit in Eindhoven",
};

const retourenText = `Proces retouren

Het team Klantenservice behandelt alle retouren. Teamleider van Klantenservice is Noor Hendriks.
Retouren worden geregistreerd in Retourwijzer, dat Klantenservice beheert.
Het team Klantenservice zit in Eindhoven.`;

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
        about: { kind: "tool", name: "Kostenklok" },
        attribute: "owner",
        object: financien,
        quote: "Kostenklok, de tool die Financiën beheert",
      },
    ],
    plants: [
      {
        about: { kind: "tool", name: "Kostenklok" },
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
    text: retourenText,
    facts: [
      {
        about: klantenservice,
        attribute: "lead",
        object: person("Noor Hendriks"),
        quote: "Teamleider van Klantenservice is Noor Hendriks",
      },
      retourwijzerOwner,
      klantenserviceLocation,
    ],
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
        retourwijzerOwner,
        klantenserviceLocation,
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
