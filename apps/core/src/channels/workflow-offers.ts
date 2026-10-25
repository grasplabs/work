import { actorOf } from "@grasp-os/shared/audit";
import { isExpectedError } from "@grasp-os/shared/errors";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { chatAuthority, chatContext } from "../agent-scope.ts";
import type { AgentScope } from "../agent-scope.ts";
import type { Member } from "../auth/identity.ts";
import { memberOf } from "../auth/identity.ts";
import {
  chatWorkflowOffers,
  workflowResources,
  workflowResourceVersions,
} from "../db/core/schema.ts";
import { inList } from "../db/d1.ts";
import { isRestricted } from "../restricted.ts";
import {
  listWorkflowResources,
  requireWorkflowRole,
} from "../workflow-resources.ts";
import { acceptedInput, pinned, startWorkflow } from "../workflow-starts.ts";
import { startOfferCard } from "./cards.tsx";
import type { Conversation } from "./connect-own.ts";
import type { ChannelLocale, LineName } from "./words.ts";

// Workflows people start by asking Stephen in a chat app. A workflow's
// owner lets people ask for it (`workflow_resources.askable`); the chat's
// agent may then offer it, on a card, to anyone who could start it
// themselves, with the values it would start with; the person's press on
// Start starts it, as them, and its run's end is told where they pressed.
//
// Threat model, and how each is closed:
//
// - A workflow its owner didn't open to asking: never listed nor offered
//   (`askableFor`, `offerStart`), and a press after the owner closed it
//   again is refused in the statement that admits the start (`stillAskable`).
// - The agent starting something on its own: it only offers. Nothing
//   starts until the person it acts for presses Start, and the start is
//   theirs, admitted as any start of theirs is (workflow-starts.ts): their
//   role in the workflow, read then, the version's contract, its bindings.
// - Someone else pressing the card (it was forwarded, or a group saw it):
//   the press is the offer's person's only; anyone else gets a line and
//   starts nothing. The door names who pressed by the platform's verified
//   id, never by a name (who.ts).
// - A press twice, or a resend: the offer is claimed once, and the start's
//   key is the offer's, so a second start of it is the same start.
// - Values changed between card and press: the press names only the
//   offer; what starts is the version and input kept with it, as the card
//   showed them whole.
// - Data from a restricted chat carried into a run: a restricted chat
//   offers nothing (`permission.restricted`), and a chat others share has
//   no workflows API at all (workspace.ts).
// - A stale card: an offer is good for a day unpressed.
//
// The run's end is told where it was pressed (offered-runs.ts).

/** How long an offer may be pressed. */
const offerMs = 24 * 60 * 60 * 1000;

/** The most values an offered start shows; one with more isn't offered. */
const maxOfferValues = 10;

/** The most text an offer's values may hold together, in characters. */
const maxOfferChars = 8000;

/** A workflow the person may ask for, as the chat's code reads it. */
export interface AskableWorkflow {
  id: string;
  name: string;
  /** The version a start of it would run now. */
  version: number;
  /** The JSON Schema its input must match, as published. */
  input: Json | null;
}

/** The person as a start of theirs acts: through the chat app. */
const actingIn = (person: Member, platform: string) => ({
  ...person,
  actor: actorOf({ userId: person.userId, staff: false }, platform),
});

const contractSchema = z.looseObject({ input: z.json().optional() });

/** The input schema of `contract`, a version's canonical JSON contract. */
const inputOf = (contract: string): Json | null => {
  try {
    return contractSchema.parse(JSON.parse(contract)).input ?? null;
  } catch {
    return null;
  }
};

/**
 * The workflows `person` could start themselves whose owners let people
 * ask for them, each at its current version, with the input it takes.
 */
export const askableFor = async (
  env: Env,
  person: Member
): Promise<AskableWorkflow[]> => {
  const listed = await listWorkflowResources(env, person);
  const theirs = listed.filter(({ currentVersion }) => currentVersion !== null);
  if (theirs.length === 0) {
    return [];
  }
  const rows = await drizzle(env.DB)
    .select({
      id: workflowResources.id,
      version: workflowResources.currentVersion,
      contract: workflowResourceVersions.contract,
    })
    .from(workflowResources)
    .innerJoin(
      workflowResourceVersions,
      and(
        eq(workflowResourceVersions.workflowResourceId, workflowResources.id),
        eq(workflowResourceVersions.version, workflowResources.currentVersion)
      )
    )
    .where(
      and(
        inList(
          workflowResources.id,
          theirs.map(({ id }) => id)
        ),
        eq(workflowResources.askable, true),
        isNull(workflowResources.deletedAt)
      )
    );
  const found = new Map(rows.map((row) => [row.id, row]));
  return theirs.flatMap(({ id, name }) => {
    const row = found.get(id);
    return row?.version === null || row === undefined
      ? []
      : [{ id, name, version: row.version, input: inputOf(row.contract) }];
  });
};

/** Whether workflow `id` is live and open to asking, as a statement runs. */
const stillAskable = (id: string) =>
  sql`EXISTS (SELECT 1 FROM ${workflowResources} WHERE ${workflowResources.id} = ${id} AND ${workflowResources.askable} = 1 AND ${workflowResources.deletedAt} IS NULL)`;

/** What a value shows on a card: text as it is, anything else as JSON. */
const shownValue = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);

/**
 * The values `input` starts with, as a card shows them: each top-level
 * field by its name. An input that isn't an object shows as one value.
 */
export const shownValues = (
  input: unknown
): { label: string; value: string }[] =>
  typeof input === "object" && input !== null && !Array.isArray(input)
    ? Object.entries(input).map(([label, value]) => ({
        label,
        value: shownValue(value),
      }))
    : [{ label: "input", value: shownValue(input) }];

/**
 * Offers workflow `workflowId` with `input` to the person the chat's
 * agent acts for, as `scope` says, for the chat's answer to put on a card.
 * Only in a chat app's chat, never a restricted one; only a workflow they
 * could start themselves whose owner lets people ask for it, at its
 * current version, with input its contract takes, few and short enough to
 * show whole. Starts nothing.
 */
export const offerStart = async (
  env: Env,
  scope: AgentScope,
  person: Member,
  workflowId: unknown,
  input: unknown
): Promise<{ offer: string; workflow: string; version: number }> => {
  if (scope.via === undefined || scope.via === "web") {
    throw permissionErrors.create("permission.context_invalid");
  }
  if (await isRestricted(env, chatAuthority(scope), chatContext(scope))) {
    throw permissionErrors.create("permission.restricted");
  }
  const workflow = await requireWorkflowRole(env, person, workflowId, "user");
  const [open] = await drizzle(env.DB)
    .select({ askable: workflowResources.askable })
    .from(workflowResources)
    .where(eq(workflowResources.id, workflow.id));
  if (open?.askable !== true || workflow.currentVersion === null) {
    throw workflowResourceErrors.create("workflow.start_denied");
  }
  const version = workflow.currentVersion;
  const { inputDescriptor } = await pinned(env, workflow.id, version);
  const text = acceptedInput(inputDescriptor, input);
  const values = shownValues(JSON.parse(text));
  const chars = values.reduce(
    (sum, { label, value }) => sum + label.length + value.length,
    0
  );
  if (values.length > maxOfferValues || chars > maxOfferChars) {
    throw workflowResourceErrors.create("workflow.start_invalid", {
      issues: [
        `input: Too much to show on a card: at most ${maxOfferValues} values and ${maxOfferChars} characters.`,
      ],
    });
  }
  const id = crypto.randomUUID();
  const now = Date.now();
  await drizzle(env.DB)
    .insert(chatWorkflowOffers)
    .values({
      id,
      userId: person.userId,
      workspaceId: scope.workspaceId,
      chatId: scope.chatId,
      workflowId: workflow.id,
      workflowName: workflow.name,
      version,
      input: text,
      createdAt: new Date(now),
      expiresAt: new Date(now + offerMs),
    });
  return { offer: id, workflow: workflow.id, version };
};

/**
 * Posts in `thread` a card for each offer chat `chatId`'s turns made for
 * `userId` that none was posted for yet, each once.
 */
export const postOffers = async (
  env: Env,
  thread: Pick<Conversation, "post">,
  { chatId, userId }: { chatId: string; userId: string },
  locale: ChannelLocale
): Promise<void> => {
  const now = new Date();
  const offers = await drizzle(env.DB)
    .update(chatWorkflowOffers)
    .set({ postedAt: now })
    .where(
      and(
        eq(chatWorkflowOffers.chatId, chatId),
        eq(chatWorkflowOffers.userId, userId),
        isNull(chatWorkflowOffers.postedAt),
        gt(chatWorkflowOffers.expiresAt, now)
      )
    )
    .returning();
  for (const offer of offers.toSorted(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
  )) {
    // oxlint-disable-next-line no-await-in-loop -- in the order offered
    await thread.post(
      startOfferCard({
        locale,
        offerId: offer.id,
        workflow: offer.workflowName,
        values: shownValues(JSON.parse(offer.input)),
      })
    );
  }
};

/** Where a press came from, as the door verified it. */
export interface StartPress {
  offerId: string;
  /** The member who pressed, by the platform's verified id. */
  userId: string;
  platform: string;
  threadId: string;
  locale: ChannelLocale;
}

/** What a press made, as one of Stephen's lines. */
export type PressLine = Extract<
  LineName,
  "started" | "startGone" | "startRefused" | "notYours" | "alreadyAnswered"
>;

/**
 * Starts what offer `offerId` showed, as the person who pressed, if it is
 * theirs, unpressed and not expired: once, under the offer's own key,
 * only while its workflow is still open to asking. Says how it went.
 */
export const pressOffer = async (
  env: Env,
  press: StartPress
): Promise<{ line: PressLine; workflow?: string }> => {
  const db = drizzle(env.DB);
  const now = new Date();
  const [offer] = await db
    .update(chatWorkflowOffers)
    .set({
      pressedAt: now,
      platform: press.platform,
      threadId: press.threadId,
      locale: press.locale,
    })
    .where(
      and(
        eq(chatWorkflowOffers.id, press.offerId),
        eq(chatWorkflowOffers.userId, press.userId),
        isNull(chatWorkflowOffers.pressedAt),
        gt(chatWorkflowOffers.expiresAt, now)
      )
    )
    .returning();
  if (offer === undefined) {
    const [found] = await db
      .select({
        userId: chatWorkflowOffers.userId,
        pressedAt: chatWorkflowOffers.pressedAt,
      })
      .from(chatWorkflowOffers)
      .where(eq(chatWorkflowOffers.id, press.offerId));
    if (found !== undefined && found.userId !== press.userId) {
      return { line: "notYours" };
    }
    const pressed = found?.pressedAt !== undefined && found.pressedAt !== null;
    return { line: pressed ? "alreadyAnswered" : "startGone" };
  }
  const workflow = offer.workflowName;
  const person = await memberOf(env.DB, offer.userId);
  if (person === undefined) {
    return { line: "startRefused", workflow };
  }
  try {
    const start = await startWorkflow(
      env,
      { type: "person", person: actingIn(person, press.platform) },
      offer.workflowId,
      {
        version: offer.version,
        input: z.json().parse(JSON.parse(offer.input)),
        key: `chat-offer-${offer.id}`,
      },
      stillAskable(offer.workflowId)
    );
    await db
      .update(chatWorkflowOffers)
      .set({ startId: start.id, runId: start.runId })
      .where(eq(chatWorkflowOffers.id, offer.id));
    return { line: "started", workflow };
  } catch (error) {
    if (!isExpectedError(error)) {
      throw error;
    }
    log.info("channel.start_refused", {
      platform: press.platform,
      ...errorFields(error),
    });
    return { line: "startRefused", workflow };
  }
};
