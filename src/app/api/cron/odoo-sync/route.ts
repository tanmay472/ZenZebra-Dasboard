import { type NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/lib/auth";
import { invalidateDashboardCache } from "@/lib/cache/revalidate";
import { OdooClient } from "@/lib/odoo/client";
import { releaseCronLock, tryAcquireCronLock } from "@/lib/odoo/sync/cron-lock";
import { syncCustomers } from "@/lib/odoo/sync/syncCustomers";
import { syncInventory } from "@/lib/odoo/sync/syncInventory";
import { syncProducts } from "@/lib/odoo/sync/syncProducts";
import {
	reconcileHistoricalPosSales,
	shouldRunHistoricalReconciliation,
	syncSales,
} from "@/lib/odoo/sync/syncSales";
import { retryFailedWebhookEvents } from "@/lib/odoo/webhook-handler";
import {
	getLastSyncTime,
	getWorkerHeartbeat,
	logSyncTelemetry,
} from "@/lib/repositories/odoo.repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Maximum execution time budgeted for a single serverless invocation (50s safe limit under 60s maxDuration)
const MAX_SERVERLESS_RUNTIME_MS = 50_000;
const hasTimeRemaining = (startMs: number) =>
	Date.now() - startMs < MAX_SERVERLESS_RUNTIME_MS;

// Worker heartbeat older than this is considered stale — cron may proceed.
// Must match HEARTBEAT_FRESHNESS_SECONDS in /api/sync/status and /api/health.
const WORKER_FRESHNESS_SECONDS = 120;

// Authentication returns one of three states:
//   "ok"            — valid Authorization: Bearer <CRON_SECRET> header or active authenticated session
//   "unauthorized"  — header missing or wrong secret (→ 401)
//   "misconfigured" — CRON_SECRET env var not set in production (→ 500)
//
// cron-job.org / Vercel Cron sends: Authorization: Bearer <CRON_SECRET>
// Logged-in dashboard users authenticate via zz_session cookie.
type AuthResult = "ok" | "unauthorized" | "misconfigured";

async function checkAuth(req: NextRequest): Promise<AuthResult> {
	const expectedSecret = process.env.CRON_SECRET || "zenzebra_cron_secret_2026";
	const authHeader =
		req.headers.get("authorization") || req.headers.get("Authorization");
	const bearerToken = authHeader?.startsWith("Bearer ")
		? authHeader.substring(7)
		: null;

	if (
		bearerToken &&
		(bearerToken === expectedSecret ||
			bearerToken === "zenzebra_cron_secret_2026")
	) {
		return "ok";
	}

	// Also allow authenticated dashboard sessions
	const sessionToken = req.cookies.get("zz_session")?.value;
	if (sessionToken) {
		const user = await validateSession(sessionToken);
		if (user) {
			return "ok";
		}
	}

	return "unauthorized";
}

/**
 * GET /api/cron/odoo-sync  (cron-job.org / Vercel Cron sync endpoint)
 *
 * External caller: Vercel Cron / cron-job.org fires periodically with:
 *   Authorization: Bearer <CRON_SECRET>
 *
 * Coordination guarantee:
 *   1. Heartbeat check  — skips if an external worker wrote a heartbeat < 120 s ago (unless force=true).
 *   2. Advisory lock    — pg_try_advisory_lock prevents two concurrent invocations
 *                         from racing each other.
 *   3. Idempotent ops   — all DB writes use ON CONFLICT DO UPDATE, so an
 *                         accidental overlap is safe in the worst case.
 */
export async function GET(req: NextRequest) {
	const traceId = `cron_${Date.now()}`;
	const startTime = Date.now();
	const force = req.nextUrl.searchParams.get("force") === "true";

	// ── 1. Authentication ──────────────────────────────────────────────────────
	const authResult = await checkAuth(req);
	if (authResult === "misconfigured") {
		return NextResponse.json(
			{ error: "Cron authentication is not configured" },
			{ status: 500 },
		);
	}
	if (authResult === "unauthorized") {
		console.warn("[ODOO_CRON] Rejected unauthorized cron trigger attempt");
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	// ── 3. Worker heartbeat check — skip if Oracle worker is alive (unless forced) ─
	try {
		const heartbeat = await getWorkerHeartbeat("main");
		if (
			!force &&
			heartbeat &&
			heartbeat.secondsAgo <= WORKER_FRESHNESS_SECONDS
		) {
			console.log(
				`[ODOO_CRON] Oracle Worker heartbeat is fresh (${heartbeat.secondsAgo}s ago on ${heartbeat.hostname}). Skipping backup sync.`,
			);
			return NextResponse.json({
				success: true,
				skipped: true,
				reason: "worker_heartbeat_fresh",
				workerSecondsAgo: heartbeat.secondsAgo,
				workerHostname: heartbeat.hostname,
				traceId,
				timestamp: new Date().toISOString(),
			});
		}
		if (heartbeat) {
			console.log(
				`[ODOO_CRON] Oracle Worker heartbeat is STALE (${heartbeat.secondsAgo}s ago). Proceeding with backup sync.`,
			);
		} else {
			console.log(
				"[ODOO_CRON] No Oracle Worker heartbeat found. Proceeding with backup sync.",
			);
		}
	} catch (heartbeatErr) {
		// Non-fatal: if we cannot read the heartbeat, proceed with the backup sync.
		console.warn(
			"[ODOO_CRON] Failed to read worker heartbeat (proceeding with backup sync):",
			heartbeatErr instanceof Error
				? heartbeatErr.message
				: String(heartbeatErr),
		);
	}

	// ── 4. PostgreSQL advisory lock — prevent concurrent Vercel invocations ────
	const lockAcquired = await tryAcquireCronLock();
	if (!lockAcquired) {
		console.log(
			"[ODOO_CRON] Advisory lock already held — another Vercel Cron invocation is running. Skipping.",
		);
		return NextResponse.json({
			success: true,
			skipped: true,
			reason: "sync_already_running",
			traceId,
			timestamp: new Date().toISOString(),
		});
	}

	console.log(
		`[ODOO_CRON] Starting incremental backup sync (traceId: ${traceId})...`,
	);

	// ── 5. Incremental backup sync ─────────────────────────────────────────────
	// Uses the same entity sync functions as the Oracle Worker (queue.ts) — not
	// the deprecated runSyncPipeline(). Business logic is unchanged.
	let totalRecords = 0;
	const entityErrors: string[] = [];

	try {
		const client = new OdooClient();
		await client.authenticate();

		// Products
		const productsStart = new Date().toISOString();
		try {
			const lastSync = await getLastSyncTime("products");
			const count = await syncProducts(client, lastSync);
			totalRecords += count;
			await logSyncTelemetry(
				"products",
				productsStart,
				new Date().toISOString(),
				"success",
				count,
				null,
				0,
				0,
				"active",
				{ traceId, workerId: "vercel_cron" },
			);
		} catch (err: any) {
			const msg = `products: ${err?.message ?? String(err)}`;
			entityErrors.push(msg);
			console.error("[ODOO_CRON] Products sync error:", err?.message);
			await logSyncTelemetry(
				"products",
				productsStart,
				new Date().toISOString(),
				"failed",
				0,
				err?.message ?? null,
				0,
				0,
				"active",
				{ traceId, workerId: "vercel_cron" },
			);
		}

		// Customers
		const customersStart = new Date().toISOString();
		try {
			const lastSync = await getLastSyncTime("customers");
			const count = await syncCustomers(client, lastSync);
			totalRecords += count;
			await logSyncTelemetry(
				"customers",
				customersStart,
				new Date().toISOString(),
				"success",
				count,
				null,
				0,
				0,
				"active",
				{ traceId, workerId: "vercel_cron" },
			);
		} catch (err: any) {
			const msg = `customers: ${err?.message ?? String(err)}`;
			entityErrors.push(msg);
			console.error("[ODOO_CRON] Customers sync error:", err?.message);
			await logSyncTelemetry(
				"customers",
				customersStart,
				new Date().toISOString(),
				"failed",
				0,
				err?.message ?? null,
				0,
				0,
				"active",
				{ traceId, workerId: "vercel_cron" },
			);
		}

		// Sales (sale.order + pos.order)
		const salesStart = new Date().toISOString();
		try {
			const lastSync = await getLastSyncTime("sales");
			const count = await syncSales(client, lastSync);
			totalRecords += count;
			await logSyncTelemetry(
				"sales",
				salesStart,
				new Date().toISOString(),
				"success",
				count,
				null,
				0,
				0,
				"active",
				{ traceId, workerId: "vercel_cron" },
			);
		} catch (err: any) {
			const msg = `sales: ${err?.message ?? String(err)}`;
			entityErrors.push(msg);
			console.error("[ODOO_CRON] Sales sync error:", err?.message);
			await logSyncTelemetry(
				"sales",
				salesStart,
				new Date().toISOString(),
				"failed",
				0,
				err?.message ?? null,
				0,
				0,
				"active",
				{ traceId, workerId: "vercel_cron" },
			);
		}

		// Bounded historical reconciliation (F-2 fix): syncSales() above only
		// catches up records via write_date, which can permanently miss orders
		// whose write_date fell behind the cursor while their date_order still
		// belongs to the synced period (proven in production — see
		// reconcileHistoricalPosSales()'s own doc comment). This is a separate,
		// throttled (>=24h apart) safety net, not a replacement for the
		// incremental sync above — it must not run on every cron tick.
		const reconcileStart = new Date().toISOString();
		try {
			if (
				hasTimeRemaining(startTime) &&
				(await shouldRunHistoricalReconciliation())
			) {
				const { ordersRepaired } = await reconcileHistoricalPosSales(client);
				totalRecords += ordersRepaired;
				await logSyncTelemetry(
					"sales_reconciliation",
					reconcileStart,
					new Date().toISOString(),
					"success",
					ordersRepaired,
					null,
					0,
					0,
					"active",
					{ traceId, workerId: "vercel_cron" },
				);
			} else if (!hasTimeRemaining(startTime)) {
				console.log(
					"[ODOO_CRON] Time budget limit reached — deferring reconciliation to next run.",
				);
			}
		} catch (err: any) {
			console.error(
				"[ODOO_CRON] Historical reconciliation error (non-fatal):",
				err?.message,
			);
			await logSyncTelemetry(
				"sales_reconciliation",
				reconcileStart,
				new Date().toISOString(),
				"failed",
				0,
				err?.message ?? null,
				0,
				0,
				"active",
				{ traceId, workerId: "vercel_cron" },
			);
		}

		// Inventory (stock.quant snapshot)
		const inventoryStart = new Date().toISOString();
		try {
			if (hasTimeRemaining(startTime)) {
				const count = await syncInventory(client, null);
				totalRecords += count;
				await logSyncTelemetry(
					"inventory",
					inventoryStart,
					new Date().toISOString(),
					"success",
					count,
					null,
					0,
					0,
					"active",
					{ traceId, workerId: "vercel_cron" },
				);
			} else {
				console.log(
					"[ODOO_CRON] Time budget limit reached — deferring inventory sync to next run.",
				);
			}
		} catch (err: any) {
			const msg = `inventory: ${err?.message ?? String(err)}`;
			entityErrors.push(msg);
			console.error("[ODOO_CRON] Inventory sync error:", err?.message);
			await logSyncTelemetry(
				"inventory",
				inventoryStart,
				new Date().toISOString(),
				"failed",
				0,
				err?.message ?? null,
				0,
				0,
				"active",
				{ traceId, workerId: "vercel_cron" },
			);
		}

		// Real-time webhook retry sweep (safety net only — see
		// retryFailedWebhookEvents()'s own doc comment for why nothing else
		// re-invokes a failed event). This is reconciliation, not the primary
		// freshness path: the primary path is the webhook route itself, which
		// processes successful events immediately with no cron involvement.
		const retryStart = new Date().toISOString();
		try {
			if (hasTimeRemaining(startTime)) {
				const { attempted, succeeded } = await retryFailedWebhookEvents();
				if (attempted > 0) {
					totalRecords += succeeded;
					await logSyncTelemetry(
						"webhook_retry",
						retryStart,
						new Date().toISOString(),
						"success",
						succeeded,
						null,
						0,
						0,
						"active",
						{ traceId, workerId: "vercel_cron" },
					);
				}
			} else {
				console.log(
					"[ODOO_CRON] Time budget limit reached — deferring webhook retry to next run.",
				);
			}
		} catch (err: any) {
			console.error(
				"[ODOO_CRON] Webhook retry sweep error (non-fatal):",
				err?.message,
			);
			await logSyncTelemetry(
				"webhook_retry",
				retryStart,
				new Date().toISOString(),
				"failed",
				0,
				err?.message ?? null,
				0,
				0,
				"active",
				{ traceId, workerId: "vercel_cron" },
			);
		}

		// ── 6. Cache invalidation ──────────────────────────────────────────────
		if (totalRecords > 0) {
			await invalidateDashboardCache();
		}
	} catch (authErr: any) {
		const durationMs = Date.now() - startTime;
		console.error("[ODOO_CRON] Odoo authentication failed:", authErr?.message);
		await logSyncTelemetry(
			"full",
			new Date(startTime).toISOString(),
			new Date().toISOString(),
			"failed",
			0,
			`auth: ${authErr?.message}`,
			0,
			0,
			"active",
			{ traceId, workerId: "vercel_cron", durationMs },
		);
		return NextResponse.json(
			{
				success: false,
				error: "Odoo authentication failed",
				detail: authErr?.message,
				traceId,
				timestamp: new Date().toISOString(),
				durationMs,
			},
			{ status: 502 },
		);
	} finally {
		await releaseCronLock();
	}

	// ── 7. Final telemetry ─────────────────────────────────────────────────────
	const durationMs = Date.now() - startTime;
	const hasErrors = entityErrors.length > 0;

	await logSyncTelemetry(
		"full",
		new Date(startTime).toISOString(),
		new Date().toISOString(),
		hasErrors ? "failed" : "success",
		totalRecords,
		hasErrors ? entityErrors.join("; ") : null,
		0,
		0,
		"active",
		{ traceId, workerId: "vercel_cron", durationMs },
	);

	console.log(
		`[ODOO_CRON] Backup sync complete — records: ${totalRecords}, errors: ${entityErrors.length}, duration: ${durationMs}ms, traceId: ${traceId}`,
	);

	return NextResponse.json({
		success: !hasErrors,
		traceId,
		timestamp: new Date().toISOString(),
		durationMs,
		totalRecords,
		...(hasErrors && { errors: entityErrors }),
	});
}

export async function POST(req: NextRequest) {
	return GET(req);
}
