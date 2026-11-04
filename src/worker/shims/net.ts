import { net, SocketStub } from "./node-stubs.ts";

export const { createServer, connect, createConnection, isIP, isIPv4, isIPv6 } = net;
export const Socket = SocketStub;

export default net;
