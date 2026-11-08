import { clarifyQuestion, clarifyThread } from "@/src/server";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const toolCallId = new URL(req.url).searchParams.get("toolCallId") ?? "";
	if (!toolCallId) return Response.json({ error: "toolCallId is required" }, { status: 400 });
	const thread = await clarifyThread(id, toolCallId);
	if (thread === null) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json({ thread });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = await req.json().catch(() => null);
	const res = await clarifyQuestion(id, body, req.signal);
	if (!res.ok) return Response.json({ error: res.error }, { status: res.status });
	return Response.json({ exchange: res.exchange, thread: res.thread });
}
