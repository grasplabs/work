import { everyNativeTool } from "./native-tool-checks.ts";

// Every native tool refuses a second resource selector: part 1 of 3
// (native-tool-checks.ts).
everyNativeTool(0, 3);
