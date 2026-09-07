import { type NextRequest, NextResponse } from "next/server";
import { type ChatMessage, runChat } from "@/lib/ai/claude/chat";
import { checkRateLimit, getClientIp } from "@/lib/security/rate-limit";

export const runtime = "nodejs";

/**
 * POST /api/ai/chat
 *
 * Authenticated Claude assistant endpoint — protected by the existing
 * proxy.ts session check (this route is not in proxy.ts's publicPaths),
 * the same as every other /api/* route in this app. No separate auth
 * system is introduced here.
 *
 * ANTHROPIC_API_KEY stays server-side only: it is read inside
 * getAnthropicClient() (src/lib/ai/claude/client.ts) and never appears in
 * the request/response body, headers, or logs below.
 */
const CHAT_RATE_LIMIT_MAX_ATTEMPTS = 20;
const CHAT_RATE_LIMIT_WINDOW_SECONDS = 60;

export async function POST(req: NextRequest) {
	if (!process.env.ANTHROPIC_API_KEY) {
		return NextResponse.json(
			{ success: false, error: "AI assistant is not configured." },
			{ status: 500 },
		);
	}

	const rateLimit = await checkRateLimit(
		`ai-chat:${getClientIp(req)}`,
		CHAT_RATE_LIMIT_MAX_ATTEMPTS,
		CHAT_RATE_LIMIT_WINDOW_SECONDS,
	);
	if (!rateLimit.allowed) {
		return NextResponse.json(
			{
				success: false,
				error: "Too many requests. Please wait a moment and try again.",
			},
			{ status: 429 },
		);
	}

	let body: any;
	try {
		body = await req.json();
	} catch {
		return NextResponse.json(
			{ success: false, error: "Invalid request body." },
			{ status: 400 },
		);
	}

	const message = typeof body?.message === "string" ? body.message.trim() : "";
	if (!message) {
		return NextResponse.json(
			{ success: false, error: "A non-empty 'message' field is required." },
			{ status: 400 },
		);
	}
	if (message.length > 2000) {
		return NextResponse.json(
			{ success: false, error: "Message is too long (max 2000 characters)." },
			{ status: 400 },
		);
	}

	const history: ChatMessage[] = Array.isArray(body?.history)
		? body.history
				.filter(
					(m: any) =>
						m &&
						(m.role === "user" || m.role === "assistant") &&
						typeof m.content === "string",
				)
				.slice(-10)
		: [];

	try {
		const result = await runChat(message, history);
		return NextResponse.json({
			success: true,
			answer: result.answer,
			toolCalls: result.toolCalls,
			reports: result.reports,
		});
	} catch (error: any) {
		// Never leak the raw error (may contain provider-internal detail) —
		// log server-side only, return a clean message to the client.
		console.error("[ai/chat] error:", error?.message || error);
		return NextResponse.json(
			{
				success: false,
				error: "The AI assistant is temporarily unavailable. Please try again.",
			},
			{ status: 502 },
		);
	}
}
