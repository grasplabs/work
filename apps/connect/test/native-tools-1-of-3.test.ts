import { everyNativeTool } from "./native-tool-checks.ts";

// Every native tool refuses a second resource selector: the part of them
// this file's name says (native-tool-checks.ts).
everyNativeTool(import.meta.url);
