import { after, type NextRequest, NextResponse } from "next/server";
import { SUPPORTED_ODOO_MODELS } from "@/lib/odoo/incremental-sync";
import {
	enqueueWebhookEvent,
	processWebhookEvent,
	verifyWebhookSecret,
	type WebhookPayload,
} from "@/lib/odoo/webhook-handler";

export const runtime = "nodejs";

/**
 * POST /api/webhooks/odoo
 * Real-time event-driven webhook handler for Odoo 19 SaaS.
 * Provides < 100 ms acknowledgment response and performs async background sync.
 */
export async function POST(req: NextRequest) {
	const startTime = Date.now();

	if (!verifyWebhookSecret(req.headers, req.nextUrl.searchParams)) {
		console.warn("[webhook/odoo] Rejected unauthorized webhook POST attempt");
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	let body: WebhookPayload;
	try {
		body = await req.json();
	} catch {
		return NextResponse.json(
			{ error: "Invalid JSON payload" },
			{ status: 400 },
		);
	}

	// Odoo's native ir.actions.server webhook (state="webhook") always sends
	// the triggering record's id/model as "_id"/"_model" (its own reserved
	// metadata keys — see the field's own help text: "The id and model of
	// the record are always sent as '_id' and '_model'"), never as bare
	// "id"/"model" — Odoo has no way to add a literal/static "model" field
	// via webhook_field_ids since "model" isn't a real field on pos.order.
	// Without this fallback, every genuine Odoo-originated delivery would
	// be rejected here (Phase 7A finding). Manually-constructed test
	// payloads that already send bare id/model are unaffected.
	if (body.id === undefined && body._id !== undefined) {
		body.id = body._id;
	}
	if (body.model === undefined && body._model !== undefined) {
		body.model = body._model;
	}

	if (!body.id || !body.model) {
		return NextResponse.json(
			{ error: "Missing required fields: id and model" },
			{ status: 400 },
		);
	}

	// Reject unknown models outright — never enqueue or write anything for a
	// model syncSingleRecord() cannot process. This must stay in sync with
	// SUPPORTED_ODOO_MODELS in incremental-sync.ts (single source of truth).
	if (!(SUPPORTED_ODOO_MODELS as readonly string[]).includes(body.model)) {
		console.warn(`[webhook/odoo] Rejected unsupported model: ${body.model}`);
		return NextResponse.json(
			{ error: `Unsupported model: ${body.model}` },
			{ status: 400 },
		);
	}

	// 1. Enqueue event for deduplication
	const { eventId, isDuplicate } = await enqueueWebhookEvent(body);

	// 2. Delegate background processing via Next.js after() or async execution
	if (!isDuplicate) {
		try {
			if (typeof after === "function") {
				after(async () => {
					await processWebhookEvent(eventId);
				});
			} else {
				processWebhookEvent(eventId).catch((err) =>
					console.error("[webhook/odoo] Background process error:", err),
				);
			}
		} catch {
			processWebhookEvent(eventId).catch((err) =>
				console.error("[webhook/odoo] Background process error:", err),
			);
		}
	}

	const elapsedMs = Date.now() - startTime;
	console.log(
		`[webhook/odoo] Accepted ${body.model} #${body.id} (eventId: ${eventId}, duplicate: ${isDuplicate}) in ${elapsedMs}ms`,
	);

	return NextResponse.json(
		{
			success: true,
			eventId,
			isDuplicate,
			message: isDuplicate
				? "Webhook event deduplicated"
				: "Webhook accepted for background processing",
			elapsedMs,
		},
		{ status: 200 },
	);
}
