import type { EvalDocument, EvalEntity, EvalFact, EvalProbe } from "./set.ts";

// The set's German documents and probes (set.ts). Every company and
// person in them is made up.

const merkur: EvalEntity = { kind: "project", name: "Merkur" };
const feldberg: EvalEntity = {
  kind: "customer",
  name: "Feldberg Maschinenbau",
};
const einkauf: EvalEntity = { kind: "team", name: "Einkauf" };
const plattform: EvalEntity = { kind: "team", name: "Plattform" };
const person = (name: string): EvalEntity => ({ kind: "person", name });

const merkurText = `Protokoll Projektbesprechung Merkur, 5. November 2026

Anwesend: Jana Becker (Projektleitung), Lukas Wagner, Mia Hoffmann.
Beschluss: Merkur wird zuerst für den Kunden Feldberg Maschinenbau eingeführt.
Die Frist für den Testbetrieb von Merkur ist der 28. Februar 2027.
Nächster Schritt: Lukas Wagner bereitet die Schulung vor.`;

const merkurOwner: EvalFact = {
  about: merkur,
  attribute: "owner",
  object: person("Jana Becker"),
  quote: "Jana Becker (Projektleitung)",
};
const merkurCustomer: EvalFact = {
  about: merkur,
  attribute: "customer",
  object: feldberg,
  quote: "Merkur wird zuerst für den Kunden Feldberg Maschinenbau eingeführt",
};

export const deDocuments: readonly EvalDocument[] = [
  {
    id: "de-protokoll-merkur",
    language: "de",
    kind: "minutes",
    saidAt: "2026-11-05T15:00:00Z",
    text: merkurText,
    facts: [
      merkurOwner,
      {
        about: merkur,
        attribute: "deadline",
        value: "2027-02-28",
        quote:
          "Die Frist für den Testbetrieb von Merkur ist der 28. Februar 2027",
      },
      merkurCustomer,
    ],
    plants: [
      {
        about: merkur,
        attribute: "status",
        value: "abgebrochen",
        statement: "Das Projekt Merkur wurde abgebrochen.",
        quote:
          "Beschluss: Merkur wird zuerst für den Kunden Feldberg Maschinenbau eingeführt",
      },
    ],
  },
  {
    id: "de-richtlinie-reisen",
    language: "de",
    kind: "policy",
    saidAt: "2026-09-20T08:00:00Z",
    text: `Reiserichtlinie

Das Team Einkauf ist für diese Richtlinie verantwortlich. Leiter des Teams Einkauf ist Stefan Krüger.
Reisen werden über Reisefix gebucht, ein Tool, das dem Team Einkauf gehört.
Dienstreisen ins Ausland müssen zwei Wochen vorher beantragt werden.`,
    facts: [
      {
        about: einkauf,
        attribute: "lead",
        object: person("Stefan Krüger"),
        quote: "Leiter des Teams Einkauf ist Stefan Krüger",
      },
      {
        about: { kind: "tool", name: "Reisefix" },
        attribute: "owner",
        object: einkauf,
        quote: "Reisefix gebucht, ein Tool, das dem Team Einkauf gehört",
      },
    ],
    plants: [
      {
        about: { kind: "tool", name: "Reisefix" },
        attribute: "cost",
        value: "500 € im Monat",
        statement: "Reisefix kostet 500 € im Monat.",
        quote: "Reisen werden über Reisefix gebucht",
      },
    ],
  },
  {
    id: "de-vertrag-feldberg",
    language: "de",
    kind: "contract",
    saidAt: "2026-10-08T09:00:00Z",
    text: `Vertragszusammenfassung Feldberg Maschinenbau

Feldberg Maschinenbau verlängert den Vertrag am 1. Juli 2027. Der Vertragswert beträgt 60.000 € pro Jahr. Ansprechpartnerin bei Feldberg Maschinenbau ist Katrin Vogel. Unser Accountmanager ist Felix Schulz. Feldberg Maschinenbau sitzt in Stuttgart.`,
    facts: [
      {
        about: feldberg,
        attribute: "renewal_date",
        value: "2027-07-01",
        quote: "Feldberg Maschinenbau verlängert den Vertrag am 1. Juli 2027",
      },
      {
        about: feldberg,
        attribute: "contact",
        object: person("Katrin Vogel"),
        quote: "Ansprechpartnerin bei Feldberg Maschinenbau ist Katrin Vogel",
      },
      {
        about: feldberg,
        attribute: "account_owner",
        object: person("Felix Schulz"),
        quote: "Unser Accountmanager ist Felix Schulz",
      },
      {
        about: feldberg,
        attribute: "location",
        value: "Stuttgart",
        quote: "Feldberg Maschinenbau sitzt in Stuttgart",
      },
    ],
    plants: [
      {
        about: feldberg,
        attribute: "status",
        value: "gekündigt",
        statement: "Feldberg Maschinenbau hat den Vertrag gekündigt.",
        quote: "Feldberg Maschinenbau verlängert den Vertrag am 1. Juli 2027",
      },
    ],
  },
  {
    id: "de-prozess-wartung",
    language: "de",
    kind: "process",
    saidAt: "2026-10-15T09:00:00Z",
    text: `Prozess: Wartung der Server

Das Team Plattform führt die Wartung durch. Teamleiterin von Plattform ist Anna Fischer.
Die Wartung findet jeden Sonntag statt.
Störungen werden in Pannenbuch erfasst, das dem Team Plattform gehört.`,
    facts: [
      {
        about: plattform,
        attribute: "lead",
        object: person("Anna Fischer"),
        quote: "Teamleiterin von Plattform ist Anna Fischer",
      },
      {
        about: { kind: "tool", name: "Pannenbuch" },
        attribute: "owner",
        object: plattform,
        quote: "Pannenbuch erfasst, das dem Team Plattform gehört",
      },
    ],
    plants: [
      {
        about: person("Anna Fischer"),
        attribute: "location",
        value: "Berlin",
        statement: "Anna Fischer arbeitet in Berlin.",
        quote: "Teamleiterin von Plattform ist Anna Fischer",
      },
    ],
  },
];

export const deProbes: readonly EvalProbe[] = [
  {
    id: "de-restatement-feldberg",
    kind: "restatement",
    base: "de-vertrag-feldberg",
    second: {
      saidAt: "2026-11-06T09:00:00Z",
      text: `Vertragszusammenfassung Feldberg Maschinenbau (überarbeitet)

Der Vertrag mit Feldberg Maschinenbau wird zum 1. Juli 2027 verlängert. Bei Feldberg Maschinenbau ist Katrin Vogel unsere Ansprechpartnerin, bei uns betreut Felix Schulz das Konto. Der Sitz von Feldberg Maschinenbau ist Stuttgart.`,
      facts: [
        {
          about: feldberg,
          attribute: "renewal_date",
          value: "2027-07-01",
          quote:
            "Der Vertrag mit Feldberg Maschinenbau wird zum 1. Juli 2027 verlängert",
        },
        {
          about: feldberg,
          attribute: "contact",
          object: person("Katrin Vogel"),
          quote: "Katrin Vogel unsere Ansprechpartnerin",
        },
        {
          about: feldberg,
          attribute: "account_owner",
          object: person("Felix Schulz"),
          quote: "bei uns betreut Felix Schulz das Konto",
        },
        {
          about: feldberg,
          attribute: "location",
          value: "Stuttgart",
          quote: "Der Sitz von Feldberg Maschinenbau ist Stuttgart",
        },
      ],
    },
    contested: [],
  },
  {
    id: "de-trap-merkur",
    kind: "trap",
    base: "de-protokoll-merkur",
    second: {
      saidAt: "2026-11-12T15:00:00Z",
      text: `${merkurText}

Nachtrag: Es wurde vorgeschlagen, die Frist auf den 31. März 2027 zu verschieben; der Vorschlag wurde abgelehnt. Die Frist für den Testbetrieb von Merkur bleibt der 28. Februar 2027.`,
      facts: [
        merkurOwner,
        {
          about: merkur,
          attribute: "deadline",
          value: "2027-02-28",
          quote:
            "Die Frist für den Testbetrieb von Merkur bleibt der 28. Februar 2027",
        },
        merkurCustomer,
      ],
    },
    contested: [],
  },
];
