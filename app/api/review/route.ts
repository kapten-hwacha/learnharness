import { readReview } from "@/src/server";

export async function GET() {
	const { due, nextDueAt, stages } = readReview();
	return Response.json({ due, nextDueAt, stages });
}
