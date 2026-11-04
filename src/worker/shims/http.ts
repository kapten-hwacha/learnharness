import { http } from "./node-stubs.ts";

export class ServerResponse {}
export class IncomingMessage {}
export class Agent {}

export const { createServer, get, request, STATUS_CODES, METHODS } = http;

export default {
	...http,
	ServerResponse,
	IncomingMessage,
	Agent,
};
