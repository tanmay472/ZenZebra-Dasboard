import { sql } from "../db";
import { syncSingleRecord } from "./incremental-sync";

export interface WebhookPayload {
	id: number;
	model: string;
	event_id?: string;
	write_date?: string;
	// Odoo's native ir.actions.server webhook always includes these two
	// (its own reserved metadata keys); the route normalizes them into
	// id/model when those are absent. See route.ts for the full rationale.
	_id?: number;
	_model?: string;
	[key: string]: any;
}

/**
 * Validates webhook security secret token.
 */
export function verifyWebhookSecret(
	headers: Headers,
	searchParams: URLSearchParams,
): boolean {
	const expectedSecret = process.env.ODOO_WEBHOOK_SECRET;
	if (!expectedSecret) {
		console.error(
			"[webhookSecret] ODOO_WEBHOOK_SECRET is not configured — rejecting all webhook requests (fail closed).",
		);
		return false;
	}

	const headerSecret = headers.get("x-webhook-secret");
	const authHeader = headers.get("authorization");
	const bearerToken = authHeader?.startsWith("Bearer ")
		? authHeader.substring(7)
		: null;
	const querySecret = searchParams.get("secret");

	const providedSecret = headerSecret || bearerToken || querySecret;
	return providedSecret === expectedSecret;
}

/**
 * Enrolls an incoming webhook event into `webhook_events` table for deduplication and audit logging.
 */
export async function enqueueWebhookEvent(payload: WebhookPayload): Promise<{
	eventId: string;
	isDuplicate: boolean;
}> {
	const model = String(payload.model || "unknown");
	const recordId = Number(payload.id || 0);
	const eventId = payload.event_id || `evt_${model}_${recordId}_${Date.now()}`;

	try {
		const existing = await sql`
			SELECT id, status FROM webhook_events
			WHERE event_id = ${eventId} OR (model = ${model} AND record_id = ${recordId} AND status = 'processed' AND received_at > NOW() - INTERVAL '10 seconds')
			LIMIT 1
		`;

		if (existing && existing.length > 0) {
			console.log(
				`[webhookHandler] Deduplicated event ${eventId} (already ${existing[0].status})`,
			);
			return { eventId, isDuplicate: true };
		}

		await sql`
			INSERT INTO webhook_events (
				event_id, model, record_id, payload, status
			) VALUES (
				${eventId}, ${model}, ${recordId}, ${JSON.stringify(payload)}, 'pending'
			)
			ON CONFLICT (event_id) DO NOTHING
		`;

		return { eventId, isDuplicate: false };
	} catch (err) {
		console.error("[webhookHandler] Error enqueuing webhook event:", err);
		return { eventId, isDuplicate: false };
	}
}

/**
 * Processes a queued webhook event with PostgreSQL advisory locking to prevent race conditions.
 */
export async function processWebhookEvent(eventId: string): Promise<void> {
	try {
		// Acquire PostgreSQL advisory lock based on hashtext of eventId
		await sql`SELECT pg_advisory_xact_lock(hashtext(${eventId}));`;

		const rows = await sql`
			SELECT id, model, record_id, payload, retry_count
			FROM webhook_events
			WHERE event_id = ${eventId} AND status IN ('pending', 'failed')
			LIMIT 1
		`;

		if (!rows || rows.length === 0) {
			return; // already processed or non-existent
		}

		const eventRow = rows[0];
		const model = String(eventRow.model);
		const recordId = Number(eventRow.record_id);
		const retryCount = Number(eventRow.retry_count || 0);

		console.log(
			`[webhookHandler] Processing event ${eventId} (${model} #${recordId})`,
		);

		const result = await syncSingleRecord(model, recordId);

		if (result.success) {
			await sql`
				UPDATE webhook_events SET
					status = 'processed',
					processed_at = NOW(),
					error_message = NULL
				WHERE event_id = ${eventId}
			`;
			console.log(`[webhookHandler] Successfully processed event ${eventId}`);
		} else {
			const newRetry = retryCount + 1;
			const isDead = newRetry >= 3;
			const newStatus = isDead ? "dead_letter" : "failed";

			await sql`
				UPDATE webhook_events SET
					status = ${newStatus},
					retry_count = ${newRetry},
					error_message = ${result.message}
				WHERE event_id = ${eventId}
			`;
			console.warn(
				`[webhookHandler] Event ${eventId} failed (attempt ${newRetry}): ${result.message}`,
			);
		}
	} catch (err) {
		const errMsg = err instanceof Error ? err.message : String(err);
		console.error(
			`[webhookHandler] Unhandled error processing ${eventId}:`,
			errMsg,
		);

		await sql`
			UPDATE webhook_events SET
				status = 'failed',
				retry_count = retry_count + 1,
				error_message = ${errMsg}
			WHERE event_id = ${eventId}
		`;
	}
}

const MAX_WEBHOOK_RETRIES = 3;

/**
 * Safety-net sweep for events that reached 'failed' status.
 *
 * enqueueWebhookEvent() deliberately treats any redelivery of the same
 * event_id as a duplicate (correct — Odoo may retry its own delivery, and
 * that must not double-process a record). The side effect is that nothing
 * else re-invokes processWebhookEvent() for an event once it has failed —
 * redelivery of the identical event_id is swallowed as "already seen", not
 * retried. This closes that gap the same way the cron backup sync already
 * closes the AlwaysOnSyncWorker's gap: a secondary, throttled safety net,
 * not the primary path. Only events below MAX_WEBHOOK_RETRIES are retried;
 * processWebhookEvent() itself is what marks an event 'dead_letter' once it
 * reaches that count, so this function never loops a dead event forever.
 */
export async function retryFailedWebhookEvents(): Promise<{
	attempted: number;
	succeeded: number;
}> {
	const rows = await sql`
		SELECT event_id FROM webhook_events
		WHERE status = 'failed' AND retry_count < ${MAX_WEBHOOK_RETRIES}
		ORDER BY received_at ASC
		LIMIT 50
	`;

	let succeeded = 0;
	for (const row of rows) {
		const eventId = String(row.event_id);
		await processWebhookEvent(eventId);
		const [after] = await sql`
			SELECT status FROM webhook_events WHERE event_id = ${eventId}
		`;
		if (after?.status === "processed") succeeded++;
	}

	return { attempted: rows.length, succeeded };
}
