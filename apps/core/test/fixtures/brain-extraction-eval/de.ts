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
const reisefix: EvalEntity = { kind: "tool", name: "Reisefix" };
const pannenbuch: EvalEntity = { kind: "tool", name: "Pannenbuch" };
const wartung: EvalEntity = { kind: "routine", name: "Wartung der Server" };
const person = (name: string): EvalEntity => ({ kind: "person", name });

const merkurText = `Protokoll Projektbesprechung Merkur, 5. November 2026

Anwesend: Jana Becker (Projektleitung), Lukas Wagner, Mia Hoffmann.
Beschluss: Merkur wird zuerst für den Kunden Feldberg Maschinenbau eingeführt.
Die Frist für den Testbetrieb von Merkur ist der 28. Februar 2027.
Nächster Schritt: Lukas Wagner bereitet die Schulung vor.`;

/** What the minutes of Merkur say beside its deadline, in both versions. */
const merkurOthers: readonly EvalFact[] = [
  {
    about: merkur,
    attribute: "owner",
    object: person("Jana Becker"),
    quote: "Jana Becker (Projektleitung)",
  },
  {
    about: merkur,
    attribute: "customer",
    object: feldberg,
    quote: "Merkur wird zuerst für den Kunden Feldberg Maschinenbau eingeführt",
  },
  {
    about: merkur,
    attribute: "decision",
    value: [
      "Merkur wird zuerst für den Kunden Feldberg Maschinenbau eingeführt",
      "Merkur wird zuerst für Feldberg Maschinenbau eingeführt",
      "zuerst für Feldberg Maschinenbau einführen",
      "Einführung zuerst bei Feldberg Maschinenbau",
      "zuerst bei Feldberg Maschinenbau einführen",
    ],
    quote:
      "Beschluss: Merkur wird zuerst für den Kunden Feldberg Maschinenbau eingeführt",
  },
  {
    about: merkur,
    attribute: "next_step",
    value: [
      "Lukas Wagner bereitet die Schulung vor",
      "die Schulung vorbereiten",
      "Schulung vorbereiten",
      "Vorbereitung der Schulung",
    ],
    quote: "Nächster Schritt: Lukas Wagner bereitet die Schulung vor",
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

export const deDocuments: readonly EvalDocument[] = [
  {
    id: "de-protokoll-merkur",
    language: "de",
    kind: "minutes",
    saidAt: "2026-11-05T15:00:00Z",
    text: merkurText,
    facts: [
      {
        about: merkur,
        attribute: "deadline",
        value: "2027-02-28",
        quote:
          "Die Frist für den Testbetrieb von Merkur ist der 28. Februar 2027",
      },
      ...merkurOthers,
    ],
    // Who attended the project's meeting: members, if a reader takes them so.
    alsoTrue: [
      {
        about: merkur,
        attribute: "member",
        object: person("Lukas Wagner"),
        quote:
          "Anwesend: Jana Becker (Projektleitung), Lukas Wagner, Mia Hoffmann",
      },
      {
        about: merkur,
        attribute: "member",
        object: person("Mia Hoffmann"),
        quote:
          "Anwesend: Jana Becker (Projektleitung), Lukas Wagner, Mia Hoffmann",
      },
      {
        about: person("Jana Becker"),
        attribute: "owns",
        object: merkur,
        quote: "Jana Becker (Projektleitung)",
      },
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
        about: einkauf,
        attribute: "responsibility",
        value: [
          "Reiserichtlinie",
          "die Reiserichtlinie",
          "verantwortlich für die Reiserichtlinie",
        ],
        quote: "Das Team Einkauf ist für diese Richtlinie verantwortlich",
      },
      {
        about: reisefix,
        attribute: "owner",
        object: einkauf,
        quote: "Reisefix gebucht, ein Tool, das dem Team Einkauf gehört",
      },
      {
        about: reisefix,
        attribute: "purpose",
        value: [
          "Reisen buchen",
          "Buchung von Reisen",
          "Reisebuchung",
          "Reisebuchungen",
        ],
        quote: "Reisen werden über Reisefix gebucht",
      },
    ],
    alsoTrue: leadAlsoTrue(
      "Stefan Krüger",
      einkauf,
      "Leiter des Teams Einkauf ist Stefan Krüger",
      [
        "Leiter des Teams Einkauf",
        "Teamleiter Einkauf",
        "Teamleiter",
        "Leiter Einkauf",
      ]
    ),
    plants: [
      {
        about: reisefix,
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
        attribute: "contract_value",
        value: [
          "60.000 € pro Jahr",
          "60.000 €",
          "60.000 Euro pro Jahr",
          "60.000 Euro",
          "60.000 € jährlich",
        ],
        quote: "Der Vertragswert beträgt 60.000 € pro Jahr",
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
    alsoTrue: [
      {
        about: person("Katrin Vogel"),
        attribute: "employer",
        object: feldberg,
        quote: "Ansprechpartnerin bei Feldberg Maschinenbau ist Katrin Vogel",
      },
      {
        about: person("Felix Schulz"),
        attribute: "owns",
        object: feldberg,
        quote: "Unser Accountmanager ist Felix Schulz",
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
        about: plattform,
        attribute: "responsibility",
        value: [
          "Wartung der Server",
          "Serverwartung",
          "die Wartung der Server",
          "Wartung",
          "die Wartung",
        ],
        quote: "Das Team Plattform führt die Wartung durch",
      },
      {
        about: wartung,
        attribute: "owner",
        object: plattform,
        quote: "Das Team Plattform führt die Wartung durch",
      },
      {
        about: wartung,
        attribute: "frequency",
        value: [
          "jeden Sonntag",
          "sonntags",
          "wöchentlich",
          "wöchentlich am Sonntag",
        ],
        quote: "Die Wartung findet jeden Sonntag statt",
      },
      {
        about: pannenbuch,
        attribute: "owner",
        object: plattform,
        quote: "Pannenbuch erfasst, das dem Team Plattform gehört",
      },
      {
        about: pannenbuch,
        attribute: "purpose",
        value: [
          "Störungen erfassen",
          "Erfassung von Störungen",
          "Störungserfassung",
          "Störungen",
        ],
        quote: "Störungen werden in Pannenbuch erfasst",
      },
    ],
    alsoTrue: leadAlsoTrue(
      "Anna Fischer",
      plattform,
      "Teamleiterin von Plattform ist Anna Fischer",
      ["Teamleiterin", "Teamleiterin von Plattform", "Teamleiterin Plattform"]
    ),
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
        {
          about: merkur,
          attribute: "deadline",
          value: "2027-02-28",
          quote:
            "Die Frist für den Testbetrieb von Merkur bleibt der 28. Februar 2027",
        },
        ...merkurOthers,
      ],
    },
    contested: [],
  },
];
