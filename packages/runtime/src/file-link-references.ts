/** The operations a files resource declares. */
export type FilesOperation = "upload" | "read" | "attach" | "delete";

/** A generated reference to a files resource: its alias and operations. */
export interface FilesReference<
  Alias extends string = string,
  Operations extends readonly FilesOperation[] = readonly FilesOperation[],
> {
  readonly kind: "files";
  readonly alias: Alias;
  readonly operations: Operations;
}

/** A generated reference to a links resource: its exact HTTPS origins. */
export interface LinksReference<
  Alias extends string = string,
  Origins extends readonly string[] = readonly string[],
> {
  readonly kind: "links";
  readonly alias: Alias;
  readonly origins: Origins;
}
