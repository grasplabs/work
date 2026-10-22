import { sha256Hex } from "@grasp-os/shared/encoding";
import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import type { SessionApi } from "@grasp-os/shared/rpc";
import type { Upload } from "@grasp-os/shared/uploads";
import { env } from "cloudflare:workers";
import { zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { platformTopics } from "../src/knowledge/admission-topics.ts";
import { screen } from "../src/knowledge/admission.ts";
import { saveUserMemory } from "../src/knowledge/memory.ts";
import { originalKey } from "../src/knowledge/uploads.ts";
import { actingFor, newChat } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import { auditedDuring, outcome, signedInApi, unique } from "./sign-in.ts";

// Knowledge admission: nothing in the platform's sensitive-data minimum
// (health, pay, the other GDPR Article 9 categories, and Article 10
// criminal data) becomes canonical Knowledge, by any route. These tests
// start from the ways it can fail: a person's sensitive data in a
// language or layout the detectors miss; operational words refused as
// sensitive; a route that stores text without passing the gate (a save,
// a restore of an older version, an upload, an agent's memory); a refusal
// that keeps the text, an upload's original, or a trace of the topic in
// the audit log; a topic row edited to loosen the minimum; a topic core
// can't enforce; and a policy core can't read, letting a write through.

const idp = mockIdp();

/** The one model the tests' gateway allows (vite.config.ts). */
const testModel = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Someone signed in, with a collection of their own. */
const personWithCollection = async () => {
  const person = await signedInApi(idp, "user");
  const collection = await person.api.knowledge.createCollection({
    name: `Notes ${unique()}`,
    access: "me",
  });
  return { ...person, collectionId: collection.id };
};

/** Every text in the Brain bucket, as stored: each version's payload. */
const storedObjectTexts = async (): Promise<string[]> => {
  const texts: string[] = [];
  let cursor: string | undefined = undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- one page at a time
    const page: R2Objects = await env.BRAIN_OBJECTS.list({ cursor });
    // oxlint-disable-next-line no-await-in-loop -- one page at a time
    const read = await Promise.all(
      page.objects.map(async ({ key }) => {
        const object = await env.BRAIN_OBJECTS.get(key);
        return object === null ? "" : await object.text();
      })
    );
    texts.push(...read);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return texts;
};

/** Every stored version, section and document title holding `marker`. */
const storedWith = async (marker: string): Promise<number> => {
  const like = `%${marker}%`;
  const row = await env.KNOWLEDGE.prepare(
    `SELECT
       (SELECT count(*) FROM sections WHERE text LIKE ?1)
       + (SELECT count(*) FROM documents WHERE title LIKE ?1 OR path LIKE ?1)
       AS stored`
  )
    .bind(like)
    .first<{ stored: number }>();
  const texts = await storedObjectTexts();
  const objects = texts.filter((text) => text.includes(marker));
  return (row?.stored ?? 0) + objects.length;
};

/** A Word file whose one paragraph is `text`. */
const wordFile = (text: string): Uint8Array => {
  const encoder = new TextEncoder();
  return zipSync({
    "word/document.xml": encoder.encode(
      `<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`
    ),
    "word/styles.xml": encoder.encode("<w:styles></w:styles>"),
  });
};

/** The upload once its extraction has ended, ready or failed. */
const ended = async (api: SessionApi, uploadId: string): Promise<Upload> =>
  await vi.waitFor(
    async () => {
      const upload = await api.uploads.get(uploadId);
      if (upload.status !== "ready" && upload.status !== "failed") {
        throw new Error(`Upload ${uploadId} is ${upload.status}`);
      }
      return upload;
    },
    { timeout: 20_000, interval: 100 }
  );

/** Runs `run` with `rows` in the topic records, removed afterwards. */
const withTopicRows = async (
  rows: { id: string; revision: number; owner: string }[],
  run: () => Promise<void>
): Promise<void> => {
  for (const { id, revision, owner } of rows) {
    // oxlint-disable-next-line no-await-in-loop -- one row at a time
    await env.DB.prepare(
      `INSERT INTO admission_topics
         (id, revision, name, coverage, examples, owner, effective_at, created_at)
       VALUES (?, ?, 'Test topic', 'Test coverage', '[]', ?, ?, ?)`
    )
      .bind(id, revision, owner, Date.now() - 1000, Date.now())
      .run();
  }
  try {
    await run();
  } finally {
    for (const { id, revision } of rows) {
      // oxlint-disable-next-line no-await-in-loop -- one row at a time
      await env.DB.prepare(
        "DELETE FROM admission_topics WHERE id = ? AND revision = ?"
      )
        .bind(id, revision)
        .run();
    }
  }
};

describe("Knowledge admission", { timeout: 60_000 }, () => {
  it("keep out every topic's examples, in every product language", () => {
    const examples = platformTopics.flatMap(({ record }) =>
      record.examples.map(({ language, text }) => ({
        topic: record.id,
        language,
        text,
      }))
    );
    const admitted = examples.filter(({ text }) => screen(text) === "admitted");

    expect({
      languages: new Set(examples.map(({ language }) => language)).size,
      admitted,
    }).toStrictEqual({ languages: 5, admitted: [] });
  });

  it("keep out a person's sensitive data in the layouts that hide the person", () => {
    const hidden = {
      honorific: "Dhr. Jansen verdient €4.000 per maand.",
      possessive: "Jan's bonus was €2,000 this year.",
      email: "Ask jan@example.com: back from sick leave next week.",
      wrapped: "Please note that she has been\non sick leave since May.",
      table: "| Name | Salary |\n| --- | --- |\n| Jan | 4200 |",
      listItem: "- His therapy runs until June",
      frontmatter: "---\ntitle: Notes\n---\nZij heeft een burn-out.",
      definite: "Every employee who is pregnant may work from home.",
      // As PDF and Word extracts and Markdown write words.
      softHyphen: "She has a bur\u00ADnout.",
      zeroWidth: "She has a bur\u200Bnout.",
      emphasis: "She is on **sick** leave.",
      // An HR record's lines, together.
      record: "- Employee: Jan Jansen\n- Team: Sales\n- Status: sick leave",
      quote: "> Colleague Jan said:\n> back from sick leave next week",
      // A heading's person, for the block under it.
      underHeading: "## Employee Jan Jansen\n\nOn sick leave since May.",
      headingTopic: "## Sick leave\n\nJan's back on Monday.",
      // Headings of every level above it.
      headingStack: "# Employee Jan Jansen\n\n## Status\n\nOn sick leave.",
      setext: "Employee Jan Jansen\n===\n\nOn sick leave since May.",
      // A heading under a person's, with no body.
      headingsOnly: "# Employee Jan Jansen\n## Cancer",
      deepHeadings: "# Employee Jan Jansen\n## Status\n### Sick leave",
      setextHeadings: "Employee Jan Jansen\n===\nSick leave\n---",
      headingAfterBody: "# Employee Jan Jansen\nWorks in sales.\n## Cancer",
      // An amount in such a heading is certain, as in a sentence.
      headingAmount: "# Employee Jan Jansen\n## Salary: €4,200",
      // Every line of the paragraph above a setext underline is its heading.
      setextLines: "Employee Jan Jansen\nSick leave\n---",
      setextLinesTopic: "Employee Jan Jansen\nCancer\n===",
      setextLinesOver: "Employee\nJan Jansen\n===\n\nOn sick leave since May.",
      // A heading with no blank line above it, read with the lines above.
      headingUnderLine: "Employee Jan Jansen\n## Cancer",
      headingInListItem: "- Employee Jan Jansen\n  ## Cancer",
      headingsInListItem: "- # Employee Jan Jansen\n  ## Cancer",
      // The lines a heading joins, for the section under it.
      sectionInListItem:
        "- Employee Jan Jansen\n  ## Status\n  On sick leave since May.",
      setextSectionInListItem:
        "- Employee Jan Jansen\n  Status\n  ---\n  On sick leave since May.",
      looseSectionInListItem:
        "- Employee Jan Jansen\n\n  ## Status\n\n  On sick leave since May.",
      sectionThenListItem:
        "- Employee Jan Jansen\n  ## Status\n- On sick leave since May.",
      sectionUnderLine:
        "Employee Jan Jansen\n## Status\nOn sick leave since May.",
      sectionUnderQuote:
        "> Employee Jan Jansen\n## Status\nOn sick leave since May.",
      sectionUnderTable:
        "| Employee |\n| Jan Jansen |\n## Status\nOn sick leave since May.",
      // Runs of lines, whatever their blocks.
      looseList: "- Employee: Jan Jansen\n\n- Status: sick leave",
      proseAndList: "Jan Jansen is an employee.\n- Status: sick leave",
      tableAndList:
        "| Name | Team |\n| --- | --- |\n| Jan | Sales |\n- Status: sick leave",
      // Markup inside the words.
      tagged: 'She is a trade <span class="x">union</span> member.',
      linked: "She is a trade [union](https://hr.example) member.",
      // Markup the Knowledge reader drops, joining the halves of a word.
      emptyTag: "She has can<b></b>cer.",
      comment: "She is preg<!-- x -->nant.",
      // A word a line-end hyphen breaks, as PDF text keeps it.
      lineBreakHyphen: "She has can-\ncer.",
      lineBreakPay: "Her sal- \nary is €4,200.",
      // An abbreviation's full stop, read as a sentence's end.
      abbreviation: "She has a Ph.D. and is on sick leave.",
      abbreviations: "E.g. she is on sick leave, i.e. off work.",
      // What only looks like a tag is read as written too.
      comparison: "Jan's hours < 8, on sick leave > 5 days.",
      underTaggedHeading:
        "## Employee Jan Jansen\n#todo #42\nOn sick leave since May.",
      french: "J'ai un cancer.",
      frenchCurly: "J’ai un cancer.",
      frenchIam: "Je suis malade depuis lundi.",
    };

    expect(
      Object.fromEntries(
        Object.entries(hidden).map(([layout, text]) => [layout, screen(text)])
      )
    ).toStrictEqual({
      honorific: "excluded",
      possessive: "excluded",
      email: "held",
      wrapped: "held",
      table: "held",
      listItem: "held",
      frontmatter: "held",
      definite: "excluded",
      softHyphen: "held",
      zeroWidth: "held",
      emphasis: "held",
      record: "held",
      quote: "held",
      underHeading: "held",
      headingTopic: "held",
      headingStack: "held",
      setext: "held",
      headingsOnly: "held",
      deepHeadings: "held",
      setextHeadings: "held",
      headingAfterBody: "held",
      headingAmount: "excluded",
      setextLines: "held",
      setextLinesTopic: "held",
      setextLinesOver: "held",
      headingUnderLine: "held",
      headingInListItem: "held",
      headingsInListItem: "held",
      sectionInListItem: "held",
      setextSectionInListItem: "held",
      looseSectionInListItem: "held",
      sectionThenListItem: "held",
      sectionUnderLine: "held",
      sectionUnderQuote: "held",
      sectionUnderTable: "held",
      looseList: "held",
      proseAndList: "held",
      tableAndList: "held",
      tagged: "held",
      linked: "held",
      emptyTag: "held",
      comment: "excluded",
      lineBreakHyphen: "held",
      lineBreakPay: "excluded",
      comparison: "held",
      abbreviation: "held",
      abbreviations: "held",
      underTaggedHeading: "held",
      french: "held",
      frenchCurly: "held",
      frenchIam: "held",
    });
  });

  it("screen any text in time linear in its length", () => {
    const size = 160_000;
    // Each built to make a backtracking pattern try every start again.
    const crafted = [
      "!".repeat(size),
      `${"Ab".repeat(size / 2)}x`,
      "a".repeat(size),
      `his salary ${"1,".repeat(size / 2)}`,
      `his salary ${"1".repeat(size)} x`,
      "x@".repeat(size / 2),
      `sick ${" ".repeat(size)}x`,
      "- ".repeat(size / 2),
      "<a".repeat(size / 2),
      `<${"a".repeat(size)}`,
      "[a](".repeat(size / 4),
      `-${" ".repeat(size)}a`,
      "-\n".repeat(size / 2),
      // A long heading over many short sentences.
      `# ${"heading ".repeat(size / 16)}\n${"Ok. ".repeat(size / 4)}`,
    ];
    const slowest = Math.max(
      ...crafted.map((text) => {
        const started = performance.now();
        screen(text);
        return performance.now() - started;
      })
    );

    // Each takes milliseconds; a backtracking pattern, seconds to minutes.
    expect(slowest).toBeLessThan(1000);
  });

  it("admit operational words, and policy text that names no one", () => {
    const benign = [
      "The health check endpoint returns 200 when the service is up.",
      "Fix the race condition in the job queue before the release.",
      "Use a union type for the response.",
      "Pay the invoice within 30 days.",
      "Rotate the SSH key fingerprint every quarter.",
      "The deploy has a bonus step for caching.",
      "Salary bands are reviewed every year by the board.",
      "We don't discriminate on religion, ethnicity or sexual orientation.",
      "See [[handbook/sick-leave]] for the leave policy.",
      "Het salarisbeleid wordt elk jaar herzien.",
      "Meld je vóór negen uur ziek bij je leidinggevende en de arbodienst.",
      "Kun je me bellen als je ziek bent?",
      "# Leave policy\n\n## Sick leave\n\nReport sick before nine.\n\n- Call the office.\n\n- Rest.",
      "# Leave policy\n## Sick leave\n### Reporting sick",
      // A topic heading beside a person's, not under it.
      "## Employee Jan Jansen\n## Sick leave policy",
      // A sibling heading ends the section of the lines a heading joined.
      "- Employee Jan Jansen\n  ## Team\n\n## Sick leave policy\n\nReport sick before nine.",
      "Die Gehaltsbänder werden jährlich überprüft.",
      "La politique de rémunération est revue chaque année.",
      "La política salarial se revisa cada año.",
    ];

    expect(benign.filter((text) => screen(text) !== "admitted")).toStrictEqual(
      []
    );
  });

  it("refuse a save of a person's sensitive data, keep nothing of it, and record only the outcome", async () => {
    const person = await personWithCollection();
    const marker = `marker${unique()}`;
    const save = async (path: string, text: string) =>
      await person.api.knowledge.saveDocument({
        collectionId: person.collectionId,
        path,
        text,
        ifVersion: 0,
      });
    let refusals: string[] = [];
    let message = "";
    const events = await auditedDuring(async () => {
      try {
        await save(`${marker}-held.md`, `# ${marker}\nShe is on sick leave.`);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      refusals = [
        await outcome(
          save(`${marker}-pay.md`, `${marker}: his salary is €4,200.`)
        ),
      ];
    });
    const benign = await save(
      "benign.md",
      "# Runbook\nThe health check endpoint returns 200."
    );
    const { documents } = await person.api.knowledge.listDocuments(
      person.collectionId
    );
    const refused = events.filter(
      ({ action }) => action === "knowledge.admission.refused"
    );

    expect({
      message,
      refusals,
      stored: await storedWith(marker),
      documents: documents.map(({ path }) => path),
      events: events.map(({ action }) => action),
      refused: refused.map(({ target, detail }) => ({
        target,
        outcome: detail.outcome,
        keys: Object.keys(detail).toSorted(),
      })),
      // Not the text, the words, or the topic: anywhere in the events.
      leaks: ["sick", "salary", "health", "pay", marker].filter((word) =>
        JSON.stringify(refused).includes(word)
      ),
      benign: benign.currentVersion,
    }).toStrictEqual({
      message: knowledgeErrors.create("knowledge.held").message,
      refusals: ["knowledge.excluded"],
      stored: 0,
      documents: ["benign.md"],
      events: ["knowledge.admission.refused", "knowledge.admission.refused"],
      refused: [
        {
          target: { type: "collection", id: person.collectionId },
          outcome: "held",
          keys: ["outcome", "policy"],
        },
        {
          target: { type: "collection", id: person.collectionId },
          outcome: "excluded",
          keys: ["outcome", "policy"],
        },
      ],
      leaks: [],
      benign: 1,
    });
  });

  it("refuse to restore a version that holds sensitive data under today's policy", async () => {
    const person = await personWithCollection();
    const saved = await person.api.knowledge.saveDocument({
      collectionId: person.collectionId,
      path: "team.md",
      text: "# Team\nWe meet on Mondays.",
      ifVersion: 0,
    });
    // A version from before the gate, as a database restored from then
    // would hold it.
    const marker = `marker${unique()}`;
    const before = `# Team\n${marker}: he was convicted of fraud.`;
    const sha256 = await sha256Hex(before);
    const key = `payloads/${sha256}/${crypto.randomUUID()}`;
    await env.BRAIN_OBJECTS.put(key, before);
    await env.KNOWLEDGE.batch([
      env.KNOWLEDGE.prepare(
        `INSERT INTO brain_payloads (key, collection_id, sha256, bytes, state, created_at)
         VALUES (?, ?, ?, ?, 'committed', ?)`
      ).bind(
        key,
        person.collectionId,
        sha256,
        new TextEncoder().encode(before).byteLength,
        Date.now()
      ),
      env.KNOWLEDGE.prepare(
        `INSERT INTO versions (document_id, number, payload_key, author, created_at)
         VALUES (?, 99, ?, ?, ?)`
      ).bind(saved.id, key, person.userId, Date.now()),
    ]);
    const restored = await outcome(
      person.api.knowledge.restoreVersion({
        documentId: saved.id,
        version: 99,
        ifVersion: 1,
      })
    );
    const read = await person.api.knowledge.getDocument(saved.id);

    expect({
      restored,
      current: read.version.number,
      text: read.version.text,
    }).toStrictEqual({
      restored: "knowledge.excluded",
      current: 1,
      text: "# Team\nWe meet on Mondays.",
    });
  });

  it("refuse an agent's memory of its person's sensitive data", async () => {
    const user = await signedInApi(idp, "user");
    const agent = { type: "agent" as const, agentId: `agent-${unique()}` };
    const asAgent = actingFor(agent, user.userId);
    const work = await newChat(agent);
    const remember = async (text: string) =>
      await outcome(
        saveUserMemory(
          env,
          asAgent,
          work,
          { type: "own" },
          {
            text,
            ifVersion: 0,
          }
        )
      );

    expect([
      await remember(
        "Is on sick leave with burnout since May; her manager knows."
      ),
      await remember("Works in Utrecht. Likes tea."),
    ]).toStrictEqual(["knowledge.held", "ok"]);
  });

  it("refuse a save whose path, title or message holds sensitive data, as its text would be", async () => {
    const person = await personWithCollection();
    const marker = `marker${unique()}`;
    const save = async (path: string, message?: string) =>
      await outcome(
        person.api.knowledge.saveDocument({
          collectionId: person.collectionId,
          path,
          text: "# Notes\nWe meet on Mondays.",
          ifVersion: 0,
          ...(message === undefined ? {} : { message }),
        })
      );

    const abbreviated = await outcome(
      person.api.knowledge.saveDocument({
        collectionId: person.collectionId,
        path: `${marker}-notes.md`,
        text: `${marker}: she has a Ph.D. and is on sick leave.`,
        ifVersion: 0,
      })
    );

    expect({
      abbreviated,
      path: await save(`${marker}/jan-is-diagnosed-with-cancer.md`),
      message: await save(`${marker}-a.md`, "His salary is €4,200."),
      collection: await outcome(
        person.api.knowledge.createCollection({
          name: "Jan's burnout notes",
          access: "me",
        })
      ),
      description: await outcome(
        person.api.knowledge.createCollection({
          name: `Notes ${unique()}`,
          description: "She is on sick leave; her notes.",
          access: "me",
        })
      ),
      stored: await storedWith(marker),
    }).toStrictEqual({
      abbreviated: "knowledge.held",
      path: "knowledge.excluded",
      message: "knowledge.excluded",
      collection: "knowledge.held",
      description: "knowledge.held",
      stored: 0,
    });
  });

  it("refuse a save whose escapes hide sensitive data, as YAML or Markdown decode them", async () => {
    const person = await personWithCollection();
    const marker = `marker${unique()}`;
    const save = async (name: string, text: string) =>
      await outcome(
        person.api.knowledge.saveDocument({
          collectionId: person.collectionId,
          path: `${marker}-${name}.md`,
          text,
          ifVersion: 0,
        })
      );

    expect({
      description: await save(
        "description",
        '---\ndescription: "She has \\u0063ancer."\n---\n# Notes\nWe meet on Mondays.'
      ),
      title: await save(
        "title",
        '---\ntitle: "Her \\x73alary is \\u20ac4,200"\n---\nWe meet on Mondays.'
      ),
      otherKey: await save(
        "other-key",
        '---\nstatus: "She has \\u0063ancer"\n---\nWe meet on Mondays.'
      ),
      tag: await save(
        "tag",
        '---\ntags: ["Her \\u0063ancer"]\n---\nWe meet on Mondays.'
      ),
      decimalEntity: await save("decimal", "# Notes\nShe has &#99;ancer."),
      hexEntity: await save("hex", "# Notes\nHer &#x73;alary is &euro;4,200."),
      namedEntity: await save("named", "# Notes\nShe has &cscr;an&shy;cer."),
      plain: await save(
        "plain",
        '---\ndescription: "Caf\\u00e9 &amp; tea"\n---\nTom &amp; Ann meet on Mondays.'
      ),
      stored: await storedWith(`${marker}-`),
    }).toStrictEqual({
      description: "knowledge.held",
      title: "knowledge.excluded",
      otherKey: "knowledge.held",
      tag: "knowledge.held",
      decimalEntity: "knowledge.held",
      hexEntity: "knowledge.excluded",
      namedEntity: "knowledge.held",
      plain: "ok",
      stored: 1,
    });
  });

  it("refuse an agent's memory whose message holds sensitive data", async () => {
    const user = await signedInApi(idp, "user");
    const agent = { type: "agent" as const, agentId: `agent-${unique()}` };
    const work = await newChat(agent);

    await expect(
      outcome(
        saveUserMemory(
          env,
          actingFor(agent, user.userId),
          work,
          { type: "own" },
          {
            text: "Works in Utrecht.",
            ifVersion: 0,
            message: "She told me she is pregnant.",
          }
        )
      )
    ).resolves.toBe("knowledge.excluded");
  });

  it("hold every save while a topic row's effective time can't be read", async () => {
    const person = await personWithCollection();
    const id = `company-${unique()}`;
    await env.DB.prepare(
      `INSERT INTO admission_topics
         (id, revision, name, coverage, examples, owner, effective_at, created_at)
       VALUES (?, 1, 'Test topic', 'Test coverage', '[]', 'company', 'soon', ?)`
    )
      .bind(id, Date.now())
      .run();
    let held = "";
    try {
      held = await outcome(
        person.api.knowledge.saveDocument({
          collectionId: person.collectionId,
          path: "runbook.md",
          text: "# Runbook\nRestart the queue.",
          ifVersion: 0,
        })
      );
    } finally {
      await env.DB.prepare("DELETE FROM admission_topics WHERE id = ?")
        .bind(id)
        .run();
    }

    expect(held).toBe("knowledge.held");
  });

  describe("uploads", () => {
    // Every file is extracted in the sandbox, as uploads.test.ts sets up.
    let gatewayBefore: unknown;
    beforeAll(() => {
      gatewayBefore = env.MODEL_GATEWAY;
      env.MODEL_GATEWAY = {
        gateway: "grasp-os-test",
        models: [testModel],
        eu: { models: [testModel], deployment: true },
      };
    });

    afterAll(() => {
      env.MODEL_GATEWAY = gatewayBefore;
    });

    it("refuse a file whose name holds sensitive data, before anything of it is stored", async () => {
      const person = await personWithCollection();
      const marker = `marker${unique()}`;
      const refused = await outcome(
        person.api.uploads.upload({
          collectionId: person.collectionId,
          name: `${marker} jan diagnosed with cancer.docx`,
          bytes: wordFile("We meet on Mondays."),
        })
      );
      const kept = await env.KNOWLEDGE.prepare(
        "SELECT count(*) AS kept FROM uploads WHERE path LIKE ?"
      )
        .bind(`%${marker}%`)
        .first<{ kept: number }>();

      expect({ refused, kept: kept?.kept }).toStrictEqual({
        refused: "knowledge.excluded",
        kept: 0,
      });
    });

    it("fail an upload of a person's sensitive data, say why, and delete its original", async () => {
      const person = await personWithCollection();
      const marker = `marker${unique()}`;
      const upload = await person.api.uploads.upload({
        collectionId: person.collectionId,
        name: `${marker}.docx`,
        bytes: wordFile(`${marker}: her salary is 5100 EUR a month.`),
      });
      const failed = await ended(person.api, upload.id);

      expect({
        status: failed.status,
        failure: failed.failure,
        original:
          (await env.FILES.head(
            originalKey(person.collectionId, upload.id)
          )) !== null,
        stored: await storedWith(marker),
      }).toStrictEqual({
        status: "failed",
        failure: {
          code: "knowledge.excluded",
          message: knowledgeErrors.create("knowledge.excluded").message,
        },
        original: false,
        stored: 0,
      });
    });
  });

  it("keep enforcing the platform minimum whatever its topic rows say", async () => {
    const person = await personWithCollection();
    // Records the platform topics, if this isolate hasn't yet.
    await person.api.knowledge.saveDocument({
      collectionId: person.collectionId,
      path: "first.md",
      text: "# First",
      ifVersion: 0,
    });
    const { results } = await env.DB.prepare(
      "SELECT * FROM admission_topics WHERE owner = 'platform'"
    ).all();
    // A revision can't be rewritten, so a row's owner can't be swapped
    // nor its effective time moved, and nothing changes.
    const edited = await outcome(
      env.DB.prepare(
        "UPDATE admission_topics SET owner = 'company', effective_at = ? WHERE owner = 'platform'"
      )
        .bind(Date.now() + 86_400_000)
        .run()
    );
    const { results: afterEdit } = await env.DB.prepare(
      "SELECT * FROM admission_topics WHERE owner = 'platform'"
    ).all();
    let deleted = "";
    try {
      await env.DB.prepare(
        "DELETE FROM admission_topics WHERE owner = 'platform'"
      ).run();
      deleted = await outcome(
        person.api.knowledge.saveDocument({
          collectionId: person.collectionId,
          path: "deleted.md",
          text: "She is on sick leave.",
          ifVersion: 0,
        })
      );
    } finally {
      await env.DB.prepare(
        "DELETE FROM admission_topics WHERE owner = 'platform'"
      ).run();
      for (const row of results) {
        // oxlint-disable-next-line no-await-in-loop -- one row at a time
        await env.DB.prepare(
          `INSERT INTO admission_topics
             (id, revision, name, coverage, examples, owner, effective_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            row.id,
            row.revision,
            row.name,
            row.coverage,
            row.examples,
            row.owner,
            row.effective_at,
            row.created_at
          )
          .run();
      }
    }

    expect({
      edited: edited === "ok",
      unchanged: afterEdit,
      deleted,
    }).toStrictEqual({
      edited: false,
      unchanged: results,
      deleted: "knowledge.held",
    });
  });

  it("hold every save while a topic is in effect that core has no detector for", async () => {
    const person = await personWithCollection();
    const save = async (path: string) =>
      await outcome(
        person.api.knowledge.saveDocument({
          collectionId: person.collectionId,
          path,
          text: "# Runbook\nRestart the queue.",
          ifVersion: 0,
        })
      );
    let company = "";
    let newer = "";
    await withTopicRows(
      [{ id: `company-${unique()}`, revision: 1, owner: "company" }],
      async () => {
        company = await save("company.md");
      }
    );
    await withTopicRows(
      [{ id: "health", revision: 999, owner: "platform" }],
      async () => {
        newer = await save("newer.md");
      }
    );

    expect({ company, newer, after: await save("after.md") }).toStrictEqual({
      company: "knowledge.held",
      newer: "knowledge.held",
      after: "ok",
    });
  });

  it("store nothing while the policy can't be read", async () => {
    const person = await personWithCollection();
    const database: D1Database = env.DB;
    const prepare = database.prepare.bind(database);
    const failing = vi
      .spyOn(database, "prepare")
      .mockImplementation((query: string) => {
        if (query.includes("admission_topics")) {
          throw new Error("Core's database is down for a moment");
        }
        return prepare(query);
      });
    let saved = "";
    try {
      saved = await outcome(
        person.api.knowledge.saveDocument({
          collectionId: person.collectionId,
          path: "runbook.md",
          text: "# Runbook\nRestart the queue.",
          ifVersion: 0,
        })
      );
    } finally {
      failing.mockRestore();
    }
    const { documents } = await person.api.knowledge.listDocuments(
      person.collectionId
    );

    expect({
      refused: saved !== "ok",
      documents: documents.length,
    }).toStrictEqual({ refused: true, documents: 0 });
  });
});
