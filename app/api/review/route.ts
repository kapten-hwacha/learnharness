import { readReview } from "@/src/server";

export async function GET() {
	const { due, nextDueAt, stages } = await readReview();
	return Response.json({ due, nextDueAt, stages });
}
