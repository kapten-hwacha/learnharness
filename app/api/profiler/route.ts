import {
	approveProfilerProposal,
	dismissProfilerProposal,
	getProfilerStatus,
	runMetacognitiveProfiler,
} from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const status = await getProfilerStatus();
	return Response.json(status);
}

export async function POST(req: Request) {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON" }, { status: 400 });
	}

	if (!body || typeof body !== "object") {
		return Response.json({ error: "Request body must be an object" }, { status: 400 });
	}

	const { action, text } = body as { action?: unknown; text?: unknown };

	if (action === "analyze") {
		const res = await runMetacognitiveProfiler();
		return Response.json(res);
	}

	if (action === "approve") {
		const res = await approveProfilerProposal(typeof text === "string" ? text : undefined);
		return Response.json(res);
	}

	if (action === "dismiss") {
		const res = await dismissProfilerProposal();
		return Response.json(res);
	}

	return Response.json({ error: "Invalid action" }, { status: 400 });
}
