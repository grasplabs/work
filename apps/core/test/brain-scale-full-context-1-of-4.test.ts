import { scaleArmPartFile } from "./brain-scale-arm.ts";

// The Brain baseline at scale (GRA-678), the arm and part this file's name
// says: brain-scale-full-text-1-of-2.test.ts says what the run is, and
// brain-scale-arm.ts why each arm runs in parts.

scaleArmPartFile(import.meta.url);
