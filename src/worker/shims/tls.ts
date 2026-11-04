export const tls = {
	connect() {
		throw new Error("tls.connect not supported in Web Worker");
	},
	createServer() {
		throw new Error("tls.createServer not supported in Web Worker");
	},
};
export const { connect, createServer } = tls;
export default tls;
