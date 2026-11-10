import {
  dataModelSource,
  generatedPaths,
  serverModuleSource,
} from "@grasp-os/runtime/host";

// The modules the host adds to every build of an App's server code
// before it knows anything of its registration: the server builders and
// the data model's types under `server/_generated/`, the same for every
// App. The references (`api`, `internal`) come from its manifest
// (`generateModules`), or stand in for it until then (`symbolicModules`),
// and the entry the host runs from its file list (the compiler's build).

/** The modules the host adds to every build of an App's server code. */
export const hostModules: Readonly<Record<string, string>> = {
  [generatedPaths.server]: serverModuleSource,
  [generatedPaths.dataModel]: dataModelSource,
};
