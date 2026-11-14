/**
 * The demo company's Brain, filled as its people fill it, through the
 * session API the Brain's pages use: Word files uploaded on Sources for
 * only the uploader, a team or everyone (the company's documents from
 * scripts/seed/documents.ts, and a few notes of people's own); the
 * company's instructions and its agent's, as Settings saves them; and
 * skills, one person's own and one shared with the company once an
 * admin approved it.
 *
 * One rule makes it safe to run again: the seed acts on a thing only in
 * the run that created it. Whatever is there already, from an earlier run
 * or made by someone since, it leaves alone, whatever happened to it in
 * between:
 *
 * - an upload already there gets nothing, so its next version is added
 *   only right after the seed's own first one, in the same run;
 * - an instruction file is written only while it was never written;
 * - a skill already there gets nothing, so it is shared and the share
 *   approved only right after the seed's own save, for the version that
 *   save made, and only the share that run asked for.
 *
 * A run that stopped half-way leaves what it made half-done for good (an
 * upload without its next version, a skill never shared). For the whole
 * demo again, start over (scripts/seed.ts says how). An upload or a skill
 * deleted in the demo stays deleted: its ID or name is closed for good,
 * which the seed says in one line.
 */
import { createHash } from "node:crypto";

import { firstAgentId } from "@grasp-os/shared/agents";
import {
  brainSourceErrors,
  brainUploadErrors,
} from "@grasp-os/shared/brain-sources";
import type { BrainUploadReaders } from "@grasp-os/shared/brain-sources";
import type { InstructionFileRef } from "@grasp-os/shared/instruction-files";
import { skillErrors } from "@grasp-os/shared/skills";
import { uploadErrors } from "@grasp-os/shared/uploads";

import type { ChatSeed } from "./chats.ts";
import type { PersonKey, TeamName } from "./company.ts";
import {
  aiGuideline,
  approvalLimits,
  codingRules,
  complaintsProcedure,
  handoverChecklist,
  handoverChecklistUpdated,
  kycPolicy,
  lenderRequirements,
  monthEndClose,
  monthEndCloseUpdated,
  requiredDocuments,
  responseTimes,
} from "./documents.ts";
import type { Api, Session } from "./local.ts";
import { wordDocument } from "./word.ts";

/**
 * A UUID fixed by `name`: the same on every run, so a second run sends
 * core the IDs it has already (RFC 9562's version 8, from SHA-256).
 */
const seedUuid = (name: string): string => {
  const bytes = createHash("sha256").update(`grasp-seed:${name}`).digest();
  // oxlint-disable-next-line no-bitwise -- the version's and variant's bits
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  // oxlint-disable-next-line no-bitwise -- the version's and variant's bits
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** Who may read an upload, as its uploader chooses on Sources. */
type Readers = "me" | "everyone" | TeamName;

interface UploadSeed {
  /** The file's name, which is also the source's title. */
  name: string;
  by: PersonKey;
  readers: Readers;
  /** Its Markdown. */
  text: string;
  /** Its next version, uploaded over it. */
  update?: string;
}

export const uploads: UploadSeed[] = [
  // Everyone's, by the COO.
  {
    name: "Required documents.docx",
    by: "sanne",
    readers: "everyone",
    text: requiredDocuments.body,
  },
  {
    name: "Complaints procedure.docx",
    by: "sanne",
    readers: "everyone",
    text: complaintsProcedure.body,
  },
  {
    name: "Response times.docx",
    by: "sanne",
    readers: "everyone",
    text: responseTimes.body,
  },
  {
    name: "AI and data guideline.docx",
    by: "pieter",
    readers: "everyone",
    text: aiGuideline.body,
  },
  // A team's, by one of its members.
  {
    name: "Month-end close.docx",
    by: "eva",
    readers: "Finance",
    text: monthEndClose.body,
    update: monthEndCloseUpdated.body,
  },
  {
    name: "Coding supplier invoices.docx",
    by: "eva",
    readers: "Finance",
    text: codingRules.body,
  },
  {
    name: "Approval limits.docx",
    by: "eva",
    readers: "Finance",
    text: approvalLimits.body,
  },
  {
    name: "Lender requirements.docx",
    by: "mark",
    readers: "Mortgage advice",
    text: lenderRequirements.body,
  },
  {
    name: "Handing a file over.docx",
    by: "nina",
    readers: "Client onboarding",
    text: handoverChecklist.body,
    update: handoverChecklistUpdated.body,
  },
  {
    name: "Know your customer.docx",
    by: "joost",
    readers: "Compliance",
    text: kycPolicy.body,
  },
  // Only the uploader's: nobody else sees them, admins included.
  {
    name: "Board meeting notes.docx",
    by: "sanne",
    readers: "me",
    text: `
# Board meeting notes

- Customer service answers most emails within a working day again; the complaints backlog is down to four.
- Ask the CFO for the AI budget before the next meeting.
- Advisers want the affordability draft ready when they open a file: put it on the roadmap for next quarter.
`,
  },
  {
    name: "My close notes.docx",
    by: "eva",
    readers: "me",
    text: `
# My close notes

- Lender B's commission statement comes a day late: start the reconciliation with the others and add it on day 4.
- Jeroen takes over the commissions from this month; walk him through the lenders' statements first.
- The VAT return goes to Jeroen on day 3, not before the accruals are booked.
`,
  },
  {
    name: "Client calls this week.docx",
    by: "mark",
    readers: "me",
    text: `
# Client calls this week

- Tuesday: the Bos family, refinancing. They still owe the energy label for Lender B's discount.
- Wednesday: a self-employed client, first meeting. Ask for two years of annual accounts for Lender C.
- Friday: follow up on the valuation report that expired last month.
`,
  },
];

/** The upload's ID: fixed by whose it is and its name, so a second run is the same upload. */
const uploadIdOf = ({ by, name }: UploadSeed): string =>
  seedUuid(`brain-upload:${by}:${name}`);

/** An instruction file, by whom it is written. */
interface InstructionSeed {
  file: InstructionFileRef;
  by: PersonKey;
  text: string;
}

export const instructionFiles: InstructionSeed[] = [
  {
    file: { scope: "company", name: "instructions" },
    by: "sanne",
    text: `
Answer in the language the question is asked in, in plain words: most of us are not lawyers or accountants.

Name the document you answer from, and say so when it is past its review date.

Client data stays in the EU, in the tools the company approved. A person approves anything that leaves the company: an offer, a compensation, a letter to a lender.
`.trim(),
  },
  {
    file: { scope: "agent", agentId: firstAgentId },
    by: "sanne",
    text: `
You help the people of Noordkade Finance, a mortgage and lending adviser, with their work: client files, mortgage advice, customer service, finance and compliance.

When a question is about a client file, look in the CRM first, never answer from memory. Hand a question only an adviser can answer to the adviser, through the service desk.
`.trim(),
  },
];

/** A `SKILL.md`: its card, then how it is done. */
const skill = (name: string, description: string, steps: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${steps.trim()}\n`;

/** A person's own skill, and whether they share it with the company. */
interface SkillSeed {
  by: PersonKey;
  name: string;
  text: string;
  /** Shared with the company, and approved by this admin. */
  sharedBy?: PersonKey;
}

export const skills: SkillSeed[] = [
  {
    by: "nina",
    name: "chase-missing-documents",
    text: skill(
      "chase-missing-documents",
      "Draft the email that chases a client's missing payslip, identity document, employer statement or bank statements.",
      `
# Chase missing documents

1. Check which of the four required documents the application still lacks.
2. Write one short email that names each missing document and how recent it must be.
3. Ask the client to reply with a photo or a PDF.
4. After the third reminder without an answer, put the application on hold and call the client instead.
`
    ),
  },
  {
    by: "lisa",
    name: "acknowledge-a-complaint",
    text: skill(
      "acknowledge-a-complaint",
      "Write the written acknowledgement of a client's complaint, due within two working days.",
      `
# Acknowledge a complaint

1. Register the complaint the day it comes in, whatever the channel.
2. Thank the client, repeat the complaint in one sentence, and say who handles it.
3. Promise an answer within six weeks, or say why it takes longer.
4. Offer compensation only up to €250; above that, ask compliance first.
`
    ),
    sharedBy: "sanne",
  },
];

/** Chats whose question recall answers from an upload, each answer naming it. */
export const brainChats: ChatSeed[] = [
  {
    by: "jeroen",
    title: "Booking a new laptop",
    hoursAgo: 30,
    answeredBy: "Coding supplier invoices.docx",
    turns: [
      {
        question: "Which ledger account do I book a new laptop on?",
        answer:
          "On 4300 Software and data. Coding supplier invoices.docx, which Finance keeps in the Brain, books software, data, laptops and phones there. If the invoice has no VAT number, send it back to the supplier instead of booking it.",
      },
    ],
  },
  {
    by: "lisa",
    title: "Compensation for a complaint",
    hoursAgo: 8,
    answeredBy: "Complaints procedure.docx",
    turns: [
      {
        question: "Who approves a compensation above €250 for a complaint?",
        answer:
          "Compliance approves it first. Complaints procedure.docx says customer service offers compensation up to €250 itself; anything above that goes to compliance before you offer it.",
      },
    ],
  },
];

const readersOf = (
  readers: Readers,
  teams: ReadonlyMap<TeamName, string>
): BrainUploadReaders => {
  if (readers === "me" || readers === "everyone") {
    return { kind: readers };
  }
  const teamId = teams.get(readers);
  if (teamId === undefined) {
    throw new Error(`No team ${readers}`);
  }
  return { kind: "team", teamId };
};

/** Core's code for a refused upload, for the line that names the file. */
const codeOf = (error: unknown): string | undefined =>
  brainUploadErrors.codeOf(error) ??
  brainSourceErrors.codeOf(error) ??
  uploadErrors.codeOf(error);

/**
 * The upload, and right after it its next version, unless the upload is
 * there already (the rule above). One deleted in the demo is skipped with
 * a line, as its ID is closed for good; any other refusal stops the seed,
 * naming the file.
 */
const seedUpload = async (
  api: Api,
  upload: UploadSeed,
  teams: ReadonlyMap<TeamName, string>
): Promise<"added" | "there" | "deleted"> => {
  const id = uploadIdOf(upload);
  if ((await api.brainSources.uploadOf(id)) !== null) {
    return "there";
  }
  try {
    await api.brainSources.upload(
      { name: upload.name, bytes: wordDocument(upload.text) },
      readersOf(upload.readers, teams),
      id
    );
    if (upload.update !== undefined) {
      await api.brainSources.uploadVersion(
        id,
        { name: upload.name, bytes: wordDocument(upload.update) },
        seedUuid(`brain-upload-version:${upload.by}:${upload.name}:2`)
      );
    }
    return "added";
  } catch (error) {
    if (brainUploadErrors.codeOf(error) === "brain.upload_retry_refused") {
      console.info(
        `Skipped ${upload.name} of ${upload.by}: deleted in the demo`
      );
      return "deleted";
    }
    const code = codeOf(error);
    throw new Error(
      `Uploading ${upload.name} as ${upload.by} was refused${code === undefined ? "" : ` (${code})`}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
};

/** The file, written only while it was never written (the rule above). */
const seedInstructions = async (
  api: Api,
  seed: InstructionSeed
): Promise<boolean> => {
  if ((await api.instructions.read(seed.file)) !== null) {
    return false;
  }
  await api.instructions.save({
    file: seed.file,
    change: seedUuid(`instructions:${JSON.stringify(seed.file)}`),
    text: seed.text,
    after: 0,
  });
  return true;
};

/**
 * The skill, unless it is there already (the rule above), and only right
 * after the seed's own save: its share with the company, for the version
 * that save made, and the admin's approval of that share alone. One
 * deleted in the demo is skipped with a line, as its name is closed.
 */
const seedSkill = async (
  sessionFor: (key: PersonKey) => Session,
  seed: SkillSeed
): Promise<void> => {
  const { skills: own } = sessionFor(seed.by).api;
  const overview = await own.overview();
  if (overview.own.some(({ name }) => name === seed.name)) {
    console.info(
      `Left the skill ${seed.name} of ${seed.by} alone: it is there already`
    );
    return;
  }
  let saved: Awaited<ReturnType<typeof own.save>>;
  try {
    saved = await own.save(seed.text);
  } catch (error) {
    if (skillErrors.codeOf(error) !== "skills.name_erased") {
      throw error;
    }
    console.info(
      `Skipped the skill ${seed.name} of ${seed.by}: deleted in the demo`
    );
    return;
  }
  if (seed.sharedBy === undefined) {
    return;
  }
  const share = await own.share(saved.name, saved.version, "company");
  await sessionFor(seed.sharedBy).api.skills.approve(share.id);
};

/**
 * Fills the Brain as the company's people: their uploads, the instruction
 * files and the skills. Returns how many instruction files it wrote.
 */
export const seedBrain = async (
  sessionFor: (key: PersonKey) => Session,
  teams: ReadonlyMap<TeamName, string>
): Promise<{
  uploadsAdded: number;
  uploadsThere: number;
  instructionsWritten: number;
}> => {
  let uploadsAdded = 0;
  let uploadsThere = 0;
  for (const upload of uploads) {
    // oxlint-disable-next-line no-await-in-loop -- one file at a time
    const outcome = await seedUpload(sessionFor(upload.by).api, upload, teams);
    if (outcome === "added") {
      uploadsAdded += 1;
    } else if (outcome === "there") {
      uploadsThere += 1;
    }
  }
  let instructionsWritten = 0;
  for (const seed of instructionFiles) {
    // oxlint-disable-next-line no-await-in-loop -- one file at a time
    if (await seedInstructions(sessionFor(seed.by).api, seed)) {
      instructionsWritten += 1;
    }
  }
  for (const seed of skills) {
    // oxlint-disable-next-line no-await-in-loop -- one skill at a time
    await seedSkill(sessionFor, seed);
  }
  return { uploadsAdded, uploadsThere, instructionsWritten };
};

/**
 * Refuses unless recall, as the person who asks `chat`'s first question,
 * finds the upload `answeredBy` (its name) for it.
 */
export const confirmAnsweredBy = async (
  api: Api,
  chat: ChatSeed,
  answeredBy: string
): Promise<void> => {
  const upload = uploads.find(({ name }) => name === answeredBy);
  if (upload === undefined) {
    throw new Error(`No seeded upload ${answeredBy}`);
  }
  const id = uploadIdOf(upload);
  const [first] = chat.turns;
  const { items } = await api.brainSources.search(first?.question ?? "");
  if (
    !items.some(
      ({ source }) => source.producer === "upload" && source.id === id
    )
  ) {
    throw new Error(
      `Recall as ${chat.by} doesn't find ${answeredBy} for "${first?.question}"`
    );
  }
};
