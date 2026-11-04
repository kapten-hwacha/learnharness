import { os } from "./node-stubs.ts";

export const {
	tmpdir,
	homedir,
	platform,
	arch,
	type,
	release,
	EOL,
	cpus,
	totalmem,
	freemem,
	uptime,
	networkInterfaces,
	userInfo,
} = os;

export default os;
