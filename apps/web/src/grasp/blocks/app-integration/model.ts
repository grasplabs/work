// The data an app's tile, panel and page draw (app-integration.tsx): the app, its tools and what
// Grasp may do with each, and its connection when it has one. The host keeps it all and hands it in;
// a change of what a tool may do comes back through `onToolsChange`.
import type { ReactNode } from "react";

/** What a tool does: it only reads, or it changes something. */
export type AppToolKind = "read" | "write";

/**
 * What Grasp may do with a tool: `never`, it is not used; `read`, it runs without asking (only for a
 * tool that changes nothing); `write`, it waits for a person to confirm.
 */
export type AppToolChoice = "never" | "read" | "write";

/** One tool of an app. */
export interface AppTool {
  /** A short, lasting id ("HUBSPOT_LIST_CONTACTS"). */
  id: string;
  /** Its name in words, verb first ("List contacts"). */
  name: string;
  /** One sentence about it, from the app's catalogue. */
  description?: string;
  /** Whether it only reads or changes something. */
  kind: AppToolKind;
  /** What Grasp may do with it now. */
  choice: AppToolChoice;
  /**
   * Its group's name, in the page's language: what it acts on, in the plural ("Contacts"), or the
   * part of a suite it belongs to, as the host names it ("Excel", "To Do"). Without it the group is
   * read from the id's part before a dot ("todo.lists"), else from the name (tools.ts).
   */
  group?: string;
}

/**
 * How a connection stands: it works, its sign-in ran out, or it must be connected anew. For an app
 * with several accounts, `needs-you`: it works, but one of its accounts needs someone (an expired
 * account beside one that works). `rollUp` (state.ts) reads an app's state from its accounts'.
 */
export type AppState = "works" | "needs-you" | "sign-in" | "reconnect";

/** The account an app is connected with. */
export interface AppConnection {
  /** The account, as the app calls it ("Acme HubSpot"). */
  account: string;
  /** Who it is signed in as, as the app shows it ("sales@acme.com"). Without it, the account. */
  signedInAs?: string;
  /** Who it is for: the person alone, or everyone in the organisation. */
  forWhom: "you" | "everyone";
  /** Who connected it, in words ("You", "Sanne de Wit"). */
  by: string;
  /** When, in words, written by the host in the page's language ("Nov 14"). */
  on: string;
  /** How it stands. */
  state: AppState;
}

/** A workflow or an agent that uses the app. */
export interface AppWorkflow {
  /** Its name ("Weekly pipeline report"). */
  name: string;
  /** What it is: a workflow, or an agent. @default "workflow" */
  kind?: "workflow" | "agent";
  /** Where it opens. */
  href?: string;
  /** One quiet line about it ("Runs every Monday"). */
  description?: string;
}

/** One app: its mark, name, what it is for, and its tools. */
export interface App {
  /** A short, lasting id ("hubspot"). */
  id: string;
  /** Its name ("HubSpot"). */
  name: string;
  /** Its mark: a BrandIcon, or the host's own image. Without one, its first letter on a tile. */
  mark?: ReactNode;
  /** What it is for: at most two sentences, with one line break between them, shown whole. */
  description: string;
  /**
   * Its own colour, for the dither behind its head, where the host knows it. Without it, the colour
   * is read from `markSrc`, else the mint stays.
   */
  tint?: string;
  /** Its mark as an image the page may read (same origin, or CORS), for its colour (`useMarkTint`). */
  markSrc?: string;
  /** Its tools. Leave them out where the host has not loaded them yet; then `toolCount` says how many. */
  tools?: readonly AppTool[];
  /** How many tools it has, where `tools` is not loaded. */
  toolCount?: number;
  /** Its connection, when it has one. */
  connection?: AppConnection;
  /** The workflows that use it. */
  workflows?: readonly AppWorkflow[];
}
