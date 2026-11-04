export const https = {
	request() {
		throw new Error("https.request not supported in Web Worker");
	},
	get() {
		throw new Error("https.get not supported in Web Worker");
	},
	Agent: class Agent {},
	Server: class Server {},
};
export const { request, get, Agent, Server } = https;
export default https;
