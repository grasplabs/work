/**
 * The React SDK of an App's pages: the platform's
 * session client in a component, and the App's queries, mutations and
 * actions through the references the host generated for it (`@server/_generated/api`).
 *
 * ```tsx
 * import { useMutation, useQuery } from "@grasp-os/sdk/react";
 * import { api } from "@server/_generated/api";
 *
 * const Notes = () => {
 *   const notes = useQuery(api.notes.list, { pagination: { pageSize: 50 } });
 *   const create = useMutation(api.notes.create);
 *   if (notes === undefined) return <output>Loading notes…</output>;
 *   …
 * };
 *
 * export default Notes;
 * ```
 *
 * The platform mounts one `GraspProvider` per App session; a page never
 * makes a client or mounts a provider. Queries answer their declared
 * value directly, or `undefined` while loading or skipped (`"skip"`): a
 * `null` result is the App's data. A query's failure is thrown while
 * rendering, to the platform's error boundary; a mutation's or action's
 * rejects its promise. `useWorkflow` starts, follows and controls a run
 * of a workflow the App binds, on its generated reference's own queries
 * and mutations.
 *
 * A query that answers pages is shown as a live list with
 * `usePaginatedQuery`:
 *
 * ```tsx
 * const { items, hasMore, isLoading, loadMore } = usePaginatedQuery(
 *   api.notes.list,
 *   {},
 *   { initialPageSize: 50 },
 * );
 * ```
 */
export { useAction, useMutation } from "./react/mutations.ts";
export { useFile, useUpload } from "./react/files.ts";
export { useForm } from "./react/form.ts";
export { usePeople, useUser } from "./react/people.ts";
export { GraspProvider, useClient } from "./react/provider.ts";
export {
  usePaginatedQuery,
  useQuery,
  useRetryFailed,
} from "./react/queries.ts";
export type {
  PageItemOf,
  PaginatedArgsOf,
  QueryArgsOrSkip,
} from "./react/queries.ts";
export { useStream } from "./react/stream.ts";
export { useWorkflow } from "./react/workflow.ts";
export type { WorkflowViewOf } from "./react/workflow.ts";
export { GraspError } from "./client-error.ts";
export type { ErrorCategory } from "./client-error.ts";
export type {
  QueryOptions,
  StreamOptions,
  SubmitOptions,
} from "./client-core.ts";
export type { PaginatedQueryView } from "./pager.ts";
export type {
  ObservedRun,
  PendingControl,
  WorkflowCommands,
  WorkflowRunView,
  WorkflowView,
} from "./workflow-view.ts";
export type { WorkflowEventReference } from "./workflow-events.ts";
export type { WorkflowReference } from "./workflow-references.ts";
export type {
  AppErrorPayload,
  RunHandle,
  WorkflowWait,
} from "./workflow-runs.ts";
export type {
  DeleteOptions,
  DownloadOptions,
  FileView,
  UploadOptions,
} from "./client-files.ts";
export type { Declaring, FileRef } from "./file-references.ts";
export type { OpenLinkOptions } from "./client-links.ts";
export type {
  PageOptions,
  PeopleDirectory,
  PeoplePage,
  Person,
  TeamRef,
  User,
} from "./people.ts";
export type { UploadView } from "./upload-transfer.ts";
export type {
  DecisionAnswer,
  DecisionFormOptions,
  FormFailure,
  FormStatus,
  GraspForm,
  FunctionFormOptions,
  SchemaFormOptions,
  SubmitPhase,
  TextFieldName,
} from "./form.ts";
