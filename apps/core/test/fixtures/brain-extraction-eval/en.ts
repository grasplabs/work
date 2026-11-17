import type { EvalDocument, EvalEntity, EvalFact, EvalProbe } from "./set.ts";

// The set's English documents and probes (set.ts). Every company and
// person in them is made up.

const brightmoor: EvalEntity = {
  kind: "customer",
  name: "Brightmoor Analytics",
};
const harrowgate: EvalEntity = { kind: "customer", name: "Harrowgate Retail" };
const tarnby: EvalEntity = { kind: "supplier", name: "Tarnby Paper Co." };
const atlas: EvalEntity = { kind: "project", name: "Atlas" };
const finance: EvalEntity = { kind: "team", name: "Finance" };
const procurement: EvalEntity = { kind: "team", name: "Procurement" };
const peopleOps: EvalEntity = { kind: "team", name: "People Operations" };
const spendwell: EvalEntity = { kind: "tool", name: "Spendwell" };
const vendorly: EvalEntity = { kind: "tool", name: "Vendorly" };
const kestrel: EvalEntity = { kind: "supplier", name: "Kestrel Freight" };
const helpDesk: EvalEntity = { kind: "tool", name: "HelpDesk Plus" };
const person = (name: string): EvalEntity => ({ kind: "person", name });

const brightmoorText = `Contract summary: Brightmoor Analytics

Brightmoor Analytics signed a two-year subscription that renews on 1 March 2027. The annual contract value is €48,000. Their account owner on our side is Jonas Whitfield. Brightmoor Analytics is based in Leeds. Priya Natarajan is our main contact there.`;

const atlasText = `Minutes, project Atlas weekly sync, 4 November 2026

Present: Leah Okafor (project owner), Tom Brandt, Sven Aaltonen.
Decision: we will launch Atlas in the Benelux first.
The deadline for the pilot of Atlas is 15 January 2027.
Atlas is built for our customer Harrowgate Retail.
Next step: Tom Brandt drafts the pilot plan by Friday.`;

const harrowgateText = `From: Jonas Whitfield
To: Leah Okafor
Subject: Harrowgate Retail renewal

Hi Leah,

Harrowgate Retail confirmed today that their contract renews on 30 June 2027. They want the new loyalty module before then. Their contact for the pilot is Ines Moreau.

Best, Jonas

> From: Leah Okafor
> Can you check when the Harrowgate contract renews?`;

const tarnbyText = `Supplier contract summary: Tarnby Paper Co.

Tarnby Paper Co. supplies our printing paper. The contract with Tarnby Paper Co. ends on 31 December 2026. Payment terms are 30 days net. Our account owner for Tarnby Paper Co. is Dana Kowalski. Tarnby Paper Co. is located in Gothenburg.`;

const brightmoorRenewal: EvalFact = {
  about: brightmoor,
  attribute: "renewal_date",
  value: "2027-03-01",
  quote: "renews on 1 March 2027",
};
const brightmoorOthers: readonly EvalFact[] = [
  {
    about: brightmoor,
    attribute: "contract_value",
    value: ["€48,000", "€48,000 per year", "€48,000 a year", "48,000 EUR"],
    quote: "The annual contract value is €48,000",
  },
  {
    about: brightmoor,
    attribute: "account_owner",
    object: person("Jonas Whitfield"),
    quote: "Their account owner on our side is Jonas Whitfield",
  },
  {
    about: brightmoor,
    attribute: "location",
    value: "Leeds",
    quote: "Brightmoor Analytics is based in Leeds",
  },
  {
    about: brightmoor,
    attribute: "contact",
    object: person("Priya Natarajan"),
    quote: "Priya Natarajan is our main contact there",
  },
];

const atlasOwner: EvalFact = {
  about: atlas,
  attribute: "owner",
  object: person("Leah Okafor"),
  quote: "Leah Okafor (project owner)",
};
const atlasCustomer: EvalFact = {
  about: atlas,
  attribute: "customer",
  object: harrowgate,
  quote: "Atlas is built for our customer Harrowgate Retail",
};

const harrowgateRenewal: EvalFact = {
  about: harrowgate,
  attribute: "renewal_date",
  value: "2027-06-30",
  quote:
    "Harrowgate Retail confirmed today that their contract renews on 30 June 2027",
};

const tarnbyEnd: EvalFact = {
  about: tarnby,
  attribute: "contract_end",
  value: "2026-12-31",
  quote: "The contract with Tarnby Paper Co. ends on 31 December 2026",
};
const tarnbyOthers: readonly EvalFact[] = [
  {
    about: tarnby,
    attribute: "supplies",
    object: { kind: "product", name: "printing paper" },
    quote: "Tarnby Paper Co. supplies our printing paper",
  },
  {
    about: tarnby,
    attribute: "terms",
    value: [
      "30 days net",
      "net 30 days",
      "net 30",
      "payment terms are 30 days net",
      "payment within 30 days",
      "30 days",
    ],
    quote: "Payment terms are 30 days net",
  },
  {
    about: tarnby,
    attribute: "account_owner",
    object: person("Dana Kowalski"),
    quote: "Our account owner for Tarnby Paper Co. is Dana Kowalski",
  },
  {
    about: tarnby,
    attribute: "location",
    value: "Gothenburg",
    quote: "Tarnby Paper Co. is located in Gothenburg",
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

export const enDocuments: readonly EvalDocument[] = [
  {
    id: "en-contract-brightmoor",
    language: "en",
    kind: "contract",
    saidAt: "2026-11-02T09:00:00Z",
    text: brightmoorText,
    facts: [brightmoorRenewal, ...brightmoorOthers],
    alsoTrue: [
      {
        about: brightmoor,
        attribute: "status",
        value: ["active", "subscribed", "customer", "active subscription"],
        quote: "Brightmoor Analytics signed a two-year subscription",
      },
      {
        about: person("Jonas Whitfield"),
        attribute: "owns",
        object: brightmoor,
        quote: "Their account owner on our side is Jonas Whitfield",
      },
      {
        about: person("Priya Natarajan"),
        attribute: "employer",
        object: brightmoor,
        quote: "Priya Natarajan is our main contact there",
      },
    ],
    plants: [
      {
        about: brightmoor,
        attribute: "status",
        value: "cancelled",
        statement: "Brightmoor Analytics has cancelled its subscription.",
        quote:
          "Brightmoor Analytics signed a two-year subscription that renews on 1 March 2027",
      },
    ],
  },
  {
    id: "en-minutes-atlas",
    language: "en",
    kind: "minutes",
    saidAt: "2026-11-04T16:00:00Z",
    text: atlasText,
    facts: [
      atlasOwner,
      {
        about: atlas,
        attribute: "deadline",
        value: "2027-01-15",
        quote: "The deadline for the pilot of Atlas is 15 January 2027",
      },
      atlasCustomer,
      {
        about: atlas,
        attribute: "decision",
        value: [
          "launch Atlas in the Benelux first",
          "launch in the Benelux first",
          "we will launch Atlas in the Benelux first",
          "launch in the Benelux",
          "Benelux first",
        ],
        quote: "Decision: we will launch Atlas in the Benelux first",
      },
      {
        about: atlas,
        attribute: "next_step",
        value: [
          "Tom Brandt drafts the pilot plan by Friday",
          "Tom Brandt drafts the pilot plan",
          "draft the pilot plan by Friday",
          "draft the pilot plan",
          "drafting the pilot plan",
        ],
        quote: "Next step: Tom Brandt drafts the pilot plan by Friday",
      },
    ],
    // Who attended the project's sync: members, if a reader takes them so.
    alsoTrue: [
      {
        about: atlas,
        attribute: "member",
        object: person("Tom Brandt"),
        quote:
          "Present: Leah Okafor (project owner), Tom Brandt, Sven Aaltonen",
      },
      {
        about: atlas,
        attribute: "member",
        object: person("Sven Aaltonen"),
        quote:
          "Present: Leah Okafor (project owner), Tom Brandt, Sven Aaltonen",
      },
      {
        about: person("Leah Okafor"),
        attribute: "owns",
        object: atlas,
        quote: "Leah Okafor (project owner)",
      },
    ],
    plants: [
      {
        about: atlas,
        attribute: "status",
        value: "cancelled",
        statement: "Project Atlas has been cancelled.",
        quote: "Decision: we will launch Atlas in the Benelux first",
      },
    ],
  },
  {
    id: "en-email-harrowgate",
    language: "en",
    kind: "email",
    saidAt: "2026-11-09T10:30:00Z",
    text: harrowgateText,
    facts: [
      harrowgateRenewal,
      {
        about: harrowgate,
        attribute: "requirement",
        value: [
          "the new loyalty module",
          "new loyalty module",
          "loyalty module",
          "the new loyalty module before 30 June 2027",
          "the new loyalty module before the renewal",
          "new loyalty module before renewal",
        ],
        quote: "They want the new loyalty module before then",
      },
      {
        about: harrowgate,
        attribute: "contact",
        object: person("Ines Moreau"),
        quote: "Their contact for the pilot is Ines Moreau",
      },
    ],
    alsoTrue: [
      {
        about: person("Ines Moreau"),
        attribute: "employer",
        object: harrowgate,
        quote: "Their contact for the pilot is Ines Moreau",
      },
    ],
    plants: [
      {
        about: harrowgate,
        attribute: "location",
        value: "Paris",
        statement: "Harrowgate Retail is based in Paris.",
        quote: "Their contact for the pilot is Ines Moreau",
      },
    ],
  },
  {
    id: "en-contract-tarnby",
    language: "en",
    kind: "contract",
    saidAt: "2026-10-01T08:00:00Z",
    text: tarnbyText,
    facts: [tarnbyEnd, ...tarnbyOthers],
    alsoTrue: [
      {
        about: person("Dana Kowalski"),
        attribute: "owns",
        object: tarnby,
        quote: "Our account owner for Tarnby Paper Co. is Dana Kowalski",
      },
    ],
    plants: [
      {
        about: tarnby,
        attribute: "status",
        value: "terminated",
        statement: "The contract with Tarnby Paper Co. has been terminated.",
        quote: "The contract with Tarnby Paper Co. ends on 31 December 2026",
      },
    ],
  },
  {
    id: "en-policy-expenses",
    language: "en",
    kind: "policy",
    saidAt: "2026-09-10T09:00:00Z",
    text: `Expense policy, effective 1 January 2027

The Finance team owns this policy. Mara Ellingsen leads the Finance team.
Claims are submitted through Spendwell within 30 days of the purchase. Spendwell is owned by the Finance team.
Travel above €1,000 needs approval from a team lead before booking.`,
    facts: [
      {
        about: finance,
        attribute: "lead",
        object: person("Mara Ellingsen"),
        quote: "Mara Ellingsen leads the Finance team",
      },
      {
        about: finance,
        attribute: "responsibility",
        value: [
          "expense policy",
          "the expense policy",
          "owns the expense policy",
          "owning the expense policy",
        ],
        quote: "The Finance team owns this policy",
      },
      {
        about: spendwell,
        attribute: "owner",
        object: finance,
        quote: "Spendwell is owned by the Finance team",
      },
      {
        about: spendwell,
        attribute: "purpose",
        value: [
          "expense claims",
          "submitting expense claims",
          "submitting claims",
          "submit expense claims",
          "claims",
        ],
        quote: "Claims are submitted through Spendwell",
      },
    ],
    alsoTrue: leadAlsoTrue(
      "Mara Ellingsen",
      finance,
      "Mara Ellingsen leads the Finance team",
      ["Finance team lead", "head of Finance", "Finance lead", "team lead"]
    ),
    plants: [
      {
        about: spendwell,
        attribute: "cost",
        value: "€1,000 per month",
        statement: "Spendwell costs €1,000 per month.",
        quote:
          "Travel above €1,000 needs approval from a team lead before booking",
      },
    ],
  },
  {
    id: "en-process-suppliers",
    language: "en",
    kind: "process",
    saidAt: "2026-10-20T09:00:00Z",
    text: `Process: onboarding a new supplier

The Procurement team runs supplier onboarding. Dana Kowalski leads Procurement.
Every new supplier is checked in Vendorly, the tool the Procurement team owns.
Kestrel Freight was onboarded last month. Kestrel Freight is based in Rotterdam.`,
    facts: [
      {
        about: procurement,
        attribute: "lead",
        object: person("Dana Kowalski"),
        quote: "Dana Kowalski leads Procurement",
      },
      {
        about: procurement,
        attribute: "responsibility",
        value: [
          "supplier onboarding",
          "runs supplier onboarding",
          "onboarding new suppliers",
          "onboarding a new supplier",
        ],
        quote: "The Procurement team runs supplier onboarding",
      },
      {
        about: vendorly,
        attribute: "owner",
        object: procurement,
        quote: "Vendorly, the tool the Procurement team owns",
      },
      {
        about: vendorly,
        attribute: "purpose",
        value: [
          "checking new suppliers",
          "checks new suppliers",
          "checking every new supplier",
          "supplier checks",
          "checking suppliers",
        ],
        quote: "Every new supplier is checked in Vendorly",
      },
      {
        about: kestrel,
        attribute: "status",
        value: ["onboarded", "onboarded last month", "active"],
        quote: "Kestrel Freight was onboarded last month",
      },
      {
        about: kestrel,
        attribute: "location",
        value: "Rotterdam",
        quote: "Kestrel Freight is based in Rotterdam",
      },
    ],
    alsoTrue: leadAlsoTrue(
      "Dana Kowalski",
      procurement,
      "Dana Kowalski leads Procurement",
      ["Procurement lead", "head of Procurement", "team lead"]
    ),
    plants: [
      {
        about: vendorly,
        attribute: "cost",
        value: "€200 per month",
        statement: "Vendorly costs €200 per month.",
        quote: "Every new supplier is checked in Vendorly",
      },
    ],
  },
  {
    id: "en-policy-remote",
    language: "en",
    kind: "policy",
    saidAt: "2026-09-15T09:00:00Z",
    text: `Remote work policy

People Operations owns this policy. Fatima Rahman leads People Operations.
Staff may work remotely up to three days a week.
The office in Utrecht is open on weekdays from 8:00 to 18:00.
Questions go to People Operations through HelpDesk Plus, a tool People Operations owns.`,
    facts: [
      {
        about: peopleOps,
        attribute: "lead",
        object: person("Fatima Rahman"),
        quote: "Fatima Rahman leads People Operations",
      },
      {
        about: peopleOps,
        attribute: "responsibility",
        value: [
          "remote work policy",
          "the remote work policy",
          "owns the remote work policy",
          "owning the remote work policy",
        ],
        quote: "People Operations owns this policy",
      },
      {
        about: helpDesk,
        attribute: "owner",
        object: peopleOps,
        quote: "HelpDesk Plus, a tool People Operations owns",
      },
      {
        about: helpDesk,
        attribute: "purpose",
        value: [
          "questions to People Operations",
          "questions for People Operations",
          "asking People Operations questions",
          "handling questions",
          "questions",
        ],
        quote: "Questions go to People Operations through HelpDesk Plus",
      },
    ],
    alsoTrue: [
      ...leadAlsoTrue(
        "Fatima Rahman",
        peopleOps,
        "Fatima Rahman leads People Operations",
        ["People Operations lead", "head of People Operations", "team lead"]
      ),
      {
        about: peopleOps,
        attribute: "responsibility",
        value: ["questions", "answering questions", "staff questions"],
        quote: "Questions go to People Operations through HelpDesk Plus",
      },
    ],
    plants: [
      {
        about: person("Fatima Rahman"),
        attribute: "location",
        value: "Utrecht",
        statement: "Fatima Rahman works from the office in Utrecht.",
        quote: "The office in Utrecht is open on weekdays from 8:00 to 18:00",
      },
    ],
  },
];

const brightmoorRenewalChanged: EvalFact = {
  about: brightmoor,
  attribute: "renewal_date",
  value: "2027-09-01",
  quote: "which now renews on 1 September 2027",
};

const harrowgateOrderForm: EvalFact = {
  about: harrowgate,
  attribute: "renewal_date",
  value: "2027-03-31",
  quote: "Harrowgate Retail renews on 31 March 2027",
};

export const enProbes: readonly EvalProbe[] = [
  {
    id: "en-change-brightmoor",
    kind: "change",
    base: "en-contract-brightmoor",
    second: {
      saidAt: "2026-11-16T09:00:00Z",
      text: `Contract summary: Brightmoor Analytics (updated)

Brightmoor Analytics extended its subscription, which now renews on 1 September 2027. The annual contract value is €48,000. Their account owner on our side is Jonas Whitfield. Brightmoor Analytics is based in Leeds. Priya Natarajan is our main contact there.`,
      facts: [brightmoorRenewalChanged, ...brightmoorOthers],
    },
    contested: [],
  },
  {
    id: "en-restatement-atlas",
    kind: "restatement",
    base: "en-minutes-atlas",
    second: {
      saidAt: "2026-11-11T16:00:00Z",
      text: `Minutes, project Atlas weekly sync, 11 November 2026

Present: Leah Okafor, Tom Brandt.
Leah Okafor remains the owner of Atlas, which we are building for Harrowgate Retail.
Reminder: the Atlas pilot has to be ready by 15 January 2027.
Tom Brandt shared the first draft of the pilot plan.`,
      facts: [
        {
          ...atlasOwner,
          quote: "Leah Okafor remains the owner of Atlas",
        },
        {
          about: atlas,
          attribute: "deadline",
          value: "2027-01-15",
          quote: "the Atlas pilot has to be ready by 15 January 2027",
        },
        {
          ...atlasCustomer,
          quote: "which we are building for Harrowgate Retail",
        },
      ],
    },
    contested: [],
  },
  {
    id: "en-disagreement-harrowgate",
    kind: "disagreement",
    base: "en-email-harrowgate",
    second: {
      saidAt: "2026-11-12T14:00:00Z",
      text: `Account note: Harrowgate Retail

According to the signed order form, Harrowgate Retail renews on 31 March 2027.`,
      facts: [harrowgateOrderForm],
    },
    contested: [harrowgateRenewal, harrowgateOrderForm],
  },
  {
    id: "en-trap-tarnby",
    kind: "trap",
    base: "en-contract-tarnby",
    second: {
      saidAt: "2026-11-05T08:00:00Z",
      text: `${tarnbyText}

Update after the supplier review: Procurement proposed extending the contract to 31 December 2027, but the extension was rejected. The contract with Tarnby Paper Co. still ends on 31 December 2026.`,
      facts: [
        {
          ...tarnbyEnd,
          quote:
            "The contract with Tarnby Paper Co. still ends on 31 December 2026",
        },
        ...tarnbyOthers,
      ],
    },
    contested: [],
  },
];
