// Browser-safe node:fs/promises stub for Web Worker runtime

export * from "./fs.ts";
import { promises } from "./fs.ts";
export default promises;
