import { childProcess } from "./node-stubs.ts";

export const { spawn, execSync, execFile, exec, fork } = childProcess;

export default childProcess;
