import { workflowTests } from "@grasp-os/sdk/testing";

import extract from "./extract.ts";

const input = {
  source: {
    title: "Interview with the controller",
    medium: "interview",
    date: "2026-09-21",
    from: "Anna",
  },
  notes: "Closing the month takes three days.",
};

const found = {
  statements: [
    {
      text: "Closing the month takes three days.",
      tags: ["time_sink"],
      quote: "Closing the month takes three days.",
    },
  ],
};

export default workflowTests(extract, [
  {
    name: "keeps what the model found in the notes as a draft for review",
    input,
    mocks: { extract: found, propose: "draft-1" },
    expect: {
      output: { draft: "draft-1", statements: 1 },
      sideEffects: [
        {
          name: "propose",
          input: {
            source: { ...input.source, notes: input.notes },
            statements: found.statements,
            guest: false,
          },
        },
      ],
    },
  },
  {
    name: "reads a stakeholder's chat as notes, and keeps a guest's draft",
    input: { chat: "chat-1" },
    mocks: {
      "read-chat": {
        source: input.source,
        notes: input.notes,
        lines: [{ role: "guest", text: input.notes }],
      },
      extract: found,
      propose: "draft-2",
    },
    expect: {
      output: { draft: "draft-2", statements: 1 },
      sideEffects: [
        {
          name: "propose",
          input: {
            source: { ...input.source, notes: input.notes },
            statements: found.statements,
            guest: true,
          },
        },
      ],
    },
  },
]);
