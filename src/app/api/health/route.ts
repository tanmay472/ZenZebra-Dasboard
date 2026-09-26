import { type NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { OdooClient } from "@/lib/odoo/client";
import { getWorkerHeartbeat } from "@/lib/repositories/odoo.repository";

const HEARTBEAT_FRESHNESS_SECONDS = 120;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(_req: NextRequest) {
	const startTime = Date.now();
	const healthReport: any = {
		timestamp: new Date().toISOString(),
		status: "healthy",
		checks: {},
	};

	// 1. Neon Database Check
	try {
		const dbStart = Date.now();
		await sql`SELECT 1;`;
		healthReport.checks.database = {
			status: "up",
			latencyMs: Date.now() - dbStart,
		};
	} catch (err) {
		healthReport.status = "unhealthy";
		healthReport.checks.database = {
			status: "down",
			error: err instanceof Error ? err.message : String(err),
		};
	}

	// 2. Webhook Queue Metrics
	try {
		const metrics = await sql`
			SELECT 
				COUNT(*)::int as total_events,
				COUNT(*) FILTER (WHERE status = 'pending')::int as pending_count,
				COUNT(*) FILTER (WHERE status = 'processed')::int as processed_count,
				COUNT(*) FILTER (WHERE status = 'failed')::int as failed_count,
				COUNT(*) FILTER (WHERE status = 'dead_letter')::int as dead_letter_count,
				MAX(received_at) as last_event_received
			FROM webhook_events
		`;
		const row = metrics[0] || {};
		healthReport.checks.webhookQueue = {
			status: row.dead_letter_count > 10 ? "degraded" : "healthy",
			totalEvents: row.total_events || 0,
			pending: row.pending_count || 0,
			processed: row.processed_count || 0,
			failed: row.failed_count || 0,
			deadLetter: row.dead_letter_count || 0,
			lastEventReceived: row.last_event_received || null,
		};
	} catch (err) {
		healthReport.checks.webhookQueue = {
			status: "unavailable",
			error: err instanceof Error ? err.message : String(err),
		};
	}

	// 2b. Polling Sync Dead-Letter Queue (mirrors the webhookQueue check above)
	try {
		const dlqMetrics = await sql`
			SELECT
				COUNT(*) FILTER (WHERE status = 'dead_letter')::int as dead_letter_count,
				MAX(created_at) as last_dead_letter_at
			FROM sync_dead_letter_queue
		`;
		const row = dlqMetrics[0] || {};
		healthReport.checks.syncQueue = {
			status: (row.dead_letter_count || 0) > 10 ? "degraded" : "healthy",
			deadLetter: row.dead_letter_count || 0,
			lastDeadLetterAt: row.last_dead_letter_at || null,
		};
	} catch (err) {
		healthReport.checks.syncQueue = {
			status: "unavailable",
			error: err instanceof Error ? err.message : String(err),
		};
	}

	// 2c. Always-On Worker Heartbeat — never claim a worker is alive without a
	// fresh, real heartbeat row (same principle as the sync telemetry fix).
	try {
		const heartbeat = await getWorkerHeartbeat("main");
		if (!heartbeat) {
			healthReport.checks.worker = { status: "never_started" };
		} else if (heartbeat.secondsAgo > HEARTBEAT_FRESHNESS_SECONDS) {
			healthReport.checks.worker = {
				status: "stale",
				hostname: heartbeat.hostname,
				secondsAgo: heartbeat.secondsAgo,
			};
		} else {
			healthReport.checks.worker = {
				status: "alive",
				hostname: heartbeat.hostname,
				secondsAgo: heartbeat.secondsAgo,
				state: heartbeat.state,
			};
		}
	} catch (err) {
		healthReport.checks.worker = {
			status: "unavailable",
			error: err instanceof Error ? err.message : String(err),
		};
	}

	// 3. Materialized View Freshness Check
	try {
		const mvRow = await sql`
			SELECT COUNT(*)::int as count FROM mv_customer_identity;
		`;
		healthReport.checks.materializedViews = {
			mv_customer_identity: {
				status: "populated",
				rowCount: mvRow[0]?.count || 0,
			},
		};
	} catch (err) {
		healthReport.checks.materializedViews = {
			status: "error",
			error: err instanceof Error ? err.message : String(err),
		};
	}

	// 4. Odoo SaaS Auth Connectivity Check (lightweight)
	try {
		const client = new OdooClient();
		const authStart = Date.now();
		const uid = await client.authenticate();
		healthReport.checks.odooSaaS = {
			status: "connected",
			uid,
			url:
				process.env.ODOO_URL ||
				(client.getMockModeStatus() ? "mock" : "configured"),
			latencyMs: Date.now() - authStart,
		};
	} catch (err) {
		if (healthReport.status === "healthy") {
			healthReport.status = "degraded";
		}
		healthReport.checks.odooSaaS = {
			status: "disconnected",
			error: err instanceof Error ? err.message : String(err),
		};
	}

	healthReport.totalLatencyMs = Date.now() - startTime;
	const httpStatus = healthReport.status === "unhealthy" ? 503 : 200;

	return NextResponse.json(healthReport, { status: httpStatus });
}
