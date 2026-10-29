/**
 * API route handler for Quaderno Companion round-trip PDF bridge.
 * GET /api/quaderno -> returns daemon and device connection status.
 * POST /api/quaderno -> executes sendProblem, exportSheet, or pullPdf actions.
 */

import { getQuadernoStatus, executeQuadernoAction } from "@/src/server";
import type { QuadernoActionRequest } from "@/src/core";

export async function GET() {
	const status = await getQuadernoStatus();
	return Response.json(status);
}

export async function POST(req: Request) {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json(
			{ ok: false, mode: "filesystem", message: "Invalid JSON request body" },
			{ status: 400 },
		);
	}

	if (
		!body ||
		typeof body !== "object" ||
		!("action" in body) ||
		!["sendProblem", "exportSheet", "pullPdf"].includes((body as { action?: string }).action ?? "")
	) {
		return Response.json(
			{ ok: false, mode: "filesystem", message: "Invalid or missing action in request body" },
			{ status: 400 },
		);
	}

	const actionReq = body as QuadernoActionRequest;
	const result = await executeQuadernoAction(actionReq);
	return Response.json(result, { status: result.ok ? 200 : 404 });
}
