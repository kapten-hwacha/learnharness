import { workerThreads } from "./node-stubs.ts";

export const { Worker, parentPort, isMainThread, workerData } = workerThreads;

export default workerThreads;
