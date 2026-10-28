import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";

// The company's policies for the apps its people use (core's
// policies.ts), as the prototype has them (`lib/policy.ts`): the policy
// documents it wrote, the rules drawn from them or made by hand, and the
// exceptions that let one app break one rule until a date. Everyone signed
// in reads them, as everyone sees the Landscape the rules act on; only the
// organization's own admins (never Grasp staff) change them, every change
// audited. Which apps a rule catches core works out from what it knows of
// them (core's policy-findings.ts, through policy-engine.ts).

/** The kinds of data an app can touch. */
export const dataExposureTypeSchema = z.enum([
  "customer",
  "employee",
  "code",
  "financial",
  "health",
  "credentials",
  "legal",
]);
export type DataExposureType = z.infer<typeof dataExposureTypeSchema>;

/** Where a vendor stores and processes the data put into its tool. */
export const hostingRegionSchema = z.enum(["eu", "uk", "us", "china"]);
export type HostingRegion = z.infer<typeof hostingRegionSchema>;

/** What kind of AI an app is, as a rule asks for it. */
export const aiKindSchema = z.enum(["tool", "builtIn", "none"]);
export type AiKind = z.infer<typeof aiKindSchema>;

/** Whether the vendor trains its models on the company's data. */
export const trainingKindSchema = z.enum([
  "trains",
  "optOut",
  "noTraining",
  "unknown",
]);
export type TrainingKind = z.infer<typeof trainingKindSchema>;

/** A certificate a rule can require of a vendor. */
export const requiredCertificateSchema = z.enum([
  "iso27001",
  "soc2",
  "iso27701",
  "iso42001",
]);
export type RequiredCertificate = z.infer<typeof requiredCertificateSchema>;

/** Where the processing agreement with the vendor stands. */
export const dpaStateSchema = z.enum(["signed", "pending", "notFound"]);
export type DpaState = z.infer<typeof dpaStateSchema>;

/** What a permission lets an app do with company data. */
export const dataAccessKindSchema = z.enum(["read", "write", "admin"]);
export type DataAccessKind = z.infer<typeof dataAccessKindSchema>;

/** Whether an app has a browser extension, and whether people in the company use it. */
export const extensionKindSchema = z.enum(["inUse", "available"]);
export type ExtensionKind = z.infer<typeof extensionKindSchema>;

/** Values a condition lists: at least one, each once. */
const listOf = <T extends z.ZodType>(item: T) =>
  z
    .array(item)
    .min(1)
    .max(20)
    .refine((values) => new Set(values).size === values.length, {
      message: "Each value once",
    });

/** A vendor's name, as a rule names it. */
const vendorSchema = z.string().trim().min(1).max(100);

/**
 * One thing a rule checks about an app. A rule matches an app when every
 * one of its conditions does. Each condition reads one fact Grasp keeps
 * about the app, so a rule never asks for more than Grasp knows.
 */
export const ruleConditionSchema = z.discriminatedUnion("field", [
  /** Hosted in one of these regions, or anywhere outside all of them. */
  z.strictObject({
    field: z.literal("hosting"),
    op: z.enum(["in", "outside"]),
    values: listOf(hostingRegionSchema),
  }),
  /** Made by one of these vendors, or by none of them. */
  z.strictObject({
    field: z.literal("vendor"),
    op: z.enum(["is", "isNot"]),
    values: listOf(vendorSchema),
  }),
  z.strictObject({ field: z.literal("ai"), values: listOf(aiKindSchema) }),
  z.strictObject({
    field: z.literal("training"),
    values: listOf(trainingKindSchema),
  }),
  /** Touches any of these kinds of data. */
  z.strictObject({
    field: z.literal("data"),
    values: listOf(dataExposureTypeSchema),
  }),
  /** Used by more than this many people. */
  z.strictObject({
    field: z.literal("people"),
    moreThan: z.int().nonnegative().max(1_000_000),
  }),
  /** Nobody owns it. */
  z.strictObject({ field: z.literal("owner") }),
  /**
   * The vendor lacks certificates: any one of these (every one is
   * required), or all of them (one of them is enough). A certificate the
   * vendor does not declare counts as lacking: no evidence is no
   * certificate.
   */
  z.strictObject({
    field: z.literal("certificate"),
    op: z.enum(["lacksAny", "lacksAll"]),
    values: listOf(requiredCertificateSchema),
  }),
  /** The processing agreement with the vendor is in one of these states. */
  z.strictObject({ field: z.literal("dpa"), values: listOf(dpaStateSchema) }),
  /** It holds a permission of one of these kinds on company data. */
  z.strictObject({
    field: z.literal("access"),
    values: listOf(dataAccessKindSchema),
  }),
  /** Its browser extension is in use, or offered but not seen in use. */
  z.strictObject({
    field: z.literal("extension"),
    values: listOf(extensionKindSchema),
  }),
]);
export type RuleCondition = z.infer<typeof ruleConditionSchema>;
export type RuleField = RuleCondition["field"];

/** What happens to an app that breaks a rule. */
export const ruleEffectSchema = z.enum(["flag", "block"]);
export type RuleEffect = z.infer<typeof ruleEffectSchema>;

/** Watching shows what a rule would do without doing it; paused rules do nothing. */
export const ruleStatusSchema = z.enum(["watching", "active", "paused"]);
export type RuleStatus = z.infer<typeof ruleStatusSchema>;

/** One line of text, as a list shows it. */
const lineSchema = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}\p{Zl}\p{Zp}]*$/u);

/** A rule as an admin makes or changes it. */
export const ruleInputSchema = z.strictObject({
  name: lineSchema(120),
  /** What the rule is for, in the company's own words. */
  description: z.string().trim().max(2000),
  /** At least one: a rule without conditions would catch every app. */
  conditions: z.array(ruleConditionSchema).min(1).max(20),
  effect: ruleEffectSchema,
  status: ruleStatusSchema,
  /** The policy it comes from, or null for a rule made by hand. */
  policyId: z.string().min(1).max(64).nullable(),
  /** The passage in that policy the rule says, word for word. */
  excerpt: z.string().trim().min(1).max(4000).optional(),
});
export type RuleInput = z.input<typeof ruleInputSchema>;

/** A rule the company set for the apps its people use, usually drawn from one of its policies. */
export interface PolicyRule {
  id: string;
  name: string;
  description: string;
  conditions: RuleCondition[];
  effect: RuleEffect;
  status: RuleStatus;
  policyId: string | null;
  excerpt?: string;
  /** Who made it, by user ID. */
  createdBy: string;
  /** ISO 8601. */
  createdAt: string;
}

/** A rule Grasp proposed from a policy, waiting for someone to take or leave it. */
export interface RuleProposal {
  id: string;
  name: string;
  description: string;
  conditions: RuleCondition[];
  effect: RuleEffect;
  /** The passage in the policy it comes from, word for word. */
  excerpt: string;
  decision: "open" | "accepted" | "rejected";
}

/** A requirement in a policy that no rule can check yet, with the passage it comes from. */
export interface UncheckedRequirement {
  requirement: string;
  excerpt: string;
}

/** Why Grasp could not read a policy. */
export type PolicyReadingProblem =
  | "notSetUp"
  | "busy"
  | "badKey"
  | "unreadable"
  | "offline";

/** The most characters of a policy's text core keeps. */
export const policyTextMax = 200_000;

/** A policy document as an admin uploads it: its text, as extracted from its file. */
export const policyUploadSchema = z.strictObject({
  title: lineSchema(200),
  fileName: lineSchema(255),
  text: z.string().trim().min(1).max(policyTextMax),
});
export type PolicyUpload = z.input<typeof policyUploadSchema>;

/** A policy the company wrote, uploaded so its rules can be drawn from it. */
export interface PolicyDocument {
  id: string;
  title: string;
  fileName: string;
  /** Who uploaded it, by user ID. */
  uploadedBy: string;
  /** ISO 8601. */
  uploadedAt: string;
  /**
   * Reading: Grasp is going through it. Review: waiting for an admin to
   * publish it. Published: its rules are in use. Grasp doesn't read
   * policies yet, so an upload waits for review.
   */
  status: "reading" | "review" | "published" | "failed";
  /** Why reading failed. */
  error?: PolicyReadingProblem;
  /** What the policy covers, in a sentence or two. */
  summary?: string;
  /** Rules proposed from it: none until Grasp reads policies. */
  proposals: RuleProposal[];
  /** Requirements no rule can check: none until Grasp reads policies. */
  unchecked: UncheckedRequirement[];
  /** ISO 8601. */
  publishedAt?: string;
}

/** An exception as an admin grants it. */
export const exceptionInputSchema = z.strictObject({
  ruleId: z.string().min(1).max(64),
  /** The app's row in the Landscape. */
  appId: z.string().min(1).max(200),
  reason: z.string().trim().min(1).max(2000),
  /** The exception's last day: `YYYY-MM-DD`. */
  until: z.iso.date(),
});
export type ExceptionInput = z.input<typeof exceptionInputSchema>;

/** An app allowed to break a rule for a while, and why. */
export interface PolicyException {
  ruleId: string;
  appId: string;
  reason: string;
  /** ISO date the exception ends, inclusive. */
  until: string;
  /** Who granted it, by user ID. */
  grantedBy: string;
  /** ISO 8601. */
  grantedAt: string;
}

/** The company's policies, its rules and their exceptions. */
export interface PolicyBook {
  policies: PolicyDocument[];
  rules: PolicyRule[];
  exceptions: PolicyException[];
}

/** Why a change to the policies was refused. */
/** What a rule does to an app it matches: blocks or flags it, would do so, or lets it be for now. */
export type FindingState = "blocked" | "flagged" | "watching" | "excepted";

/**
 * An app a rule can catch, as core knows it: one of the company's
 * integrations, by its key (`native:microsoft`), or an app its identity
 * provider granted access, by `landscape:<connection>:<client ID>`.
 */
export interface PolicyApp {
  id: string;
  name: string;
  kind: "integration" | "landscape";
  /** Who makes it, as the provider verified it; null while nothing says. */
  vendor: string | null;
  /** How many use it; null while nothing measures it. */
  people: number | null;
}

/** One app one rule catches, and what the rule does to it. */
export interface PolicyFinding {
  ruleId: string;
  app: PolicyApp;
  state: FindingState;
  /** The exception that lets the app be, when there is one. */
  exception: PolicyException | null;
}

/** How many apps a policy's proposed rule would catch, were it kept. */
export interface ProposalCatch {
  policyId: string;
  proposalId: string;
  apps: number;
}

/** Which apps the rules catch, as core works it out from what it knows of them. */
export interface PolicyFindings {
  /** The most serious first, then the most used, then by name. */
  findings: PolicyFinding[];
  /** For each proposal of each policy, whatever was decided of it. */
  proposals: ProposalCatch[];
}

export const policyErrors = defineErrorFamily({
  "policy.invalid":
    "That isn't a policy, rule or exception as Grasp keeps them: check each field.",
  "policy.not_found": "There's no such policy, rule or exception.",
  "policy.conflict":
    "A rule names a policy that isn't there, or the policy changed meanwhile.",
});

/** The company's policies, over `/rpc`. */
export interface PoliciesApi {
  /** Every policy, rule and exception, newest first. Everyone signed in. */
  book: () => Promise<PolicyBook>;
  /**
   * Which apps each watching or active rule catches, and how many each
   * policy's proposed rules would: over every app for the organization's
   * own admins, over the apps they can see for anyone else.
   */
  findings: () => Promise<PolicyFindings>;
  /** Keeps a policy document for review. The organization's own admins only; audited. */
  upload: (upload: PolicyUpload) => Promise<PolicyDocument>;
  /** Puts a policy in use. The organization's own admins only; audited. */
  publish: (policyId: string) => Promise<PolicyDocument>;
  /**
   * Removes a policy; its rules stay, as rules made by hand. The
   * organization's own admins only; audited.
   */
  removePolicy: (policyId: string) => Promise<void>;
  /** Makes a rule. The organization's own admins only; audited. */
  createRule: (rule: RuleInput) => Promise<PolicyRule>;
  /** Replaces a rule's name, conditions, effect or status. The organization's own admins only; audited. */
  updateRule: (ruleId: string, rule: RuleInput) => Promise<PolicyRule>;
  /** Removes a rule and its exceptions. The organization's own admins only; audited. */
  removeRule: (ruleId: string) => Promise<void>;
  /**
   * Lets one app break one rule until a date, in place of any exception it
   * had for it. The organization's own admins only; audited.
   */
  grantException: (exception: ExceptionInput) => Promise<PolicyException>;
  /** Ends an exception. The organization's own admins only; audited. */
  revokeException: (ruleId: string, appId: string) => Promise<void>;
}
