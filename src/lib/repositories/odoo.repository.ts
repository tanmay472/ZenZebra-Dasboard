import { sql } from "../db";

export interface OdooStore {
	id: number;
	name: string;
	code?: string;
	locationId?: number;
}

export interface OdooProduct {
	id: number;
	name: string;
	defaultCode?: string;
	barcode?: string;
	listPrice?: number;
	costPrice?: number;
	qtyAvailable?: number;
	freeQty?: number;
	active: boolean;
	category?: string;
	isStorable?: boolean;
}

export interface OdooCustomer {
	id: number;
	name: string;
	email?: string;
	mobile?: string;
	city?: string;
	customerRank?: number;
	active: boolean;
}

export interface OdooSalesOrder {
	id: string; // prefixed: sale_{id} or pos_{id}
	name: string;
	dateOrder: string; // ISO string
	partnerId?: number | null;
	storeId?: number | null;
	amountTotal: number;
	amountUntaxed: number;
	state: string;
	orderType: "sale" | "pos";
}

export interface OdooSalesLine {
	id: string; // prefixed: sale_line_{id} or pos_line_{id}
	orderId: string;
	productId: number;
	priceUnit: number;
	discount: number;
	qty: number;
	priceSubtotal: number;
	taxAmount?: number;
}

export interface OdooInventory {
	productId: number;
	locationId: number;
	locationName?: string;
	quantity: number;
	reservedQuantity: number;
}

/**
 * Repository layer for Canonical Odoo Sync tables.
 * Contains all raw SQL database operations.
 */

export async function upsertStores(stores: OdooStore[]): Promise<void> {
	if (stores.length === 0) return;
	for (const store of stores) {
		await sql`
			INSERT INTO dim_stores (id, name, code, location_id)
			VALUES (${store.id}, ${store.name}, ${store.code || null}, ${store.locationId ?? null})
			ON CONFLICT (id) DO UPDATE SET
				name = EXCLUDED.name,
				-- Store-identity reliability fix (multi-store scalability audit):
				-- 'code' here is only ever a name-substring guess ("klj"/"swn"/
				-- "smartworks"/"zenzebra" -> known code, else the generic "STORE"
				-- placeholder — see syncSales.ts/reconciliation.ts). The real code
				-- comes from backfillStoreSourceFields() joining Odoo's own
				-- dim_pos_configs.warehouse_code. That backfill call has been
				-- observed to silently stop running in production (dim_pos_configs
				-- staying stale for 33+ hours while dim_stores kept updating), which
				-- meant this UPDATE was unconditionally re-clobbering an already
				-- backfilled/correct code with the stale guess on every single sync
				-- cycle. Once a real code is present (anything other than NULL or
				-- the generic "STORE" placeholder), preserve it here — the guess
				-- only applies to a store that has never been correctly identified
				-- yet, so a fragile backfill step is no longer load-bearing for
				-- keeping an already-correct code alive.
				code = CASE
					WHEN dim_stores.code IS NULL OR dim_stores.code = 'STORE'
						THEN EXCLUDED.code
					ELSE dim_stores.code
				END,
				location_id = COALESCE(EXCLUDED.location_id, dim_stores.location_id),
				updated_at = NOW()
		`;
	}
}

export async function upsertProducts(products: OdooProduct[]): Promise<void> {
	if (products.length === 0) return;
	for (const prod of products) {
		await sql`
			INSERT INTO dim_products (
				id, name, default_code, barcode, list_price, cost_price, qty_available, free_qty, active, category, is_storable
			) VALUES (
				${prod.id}, ${prod.name}, ${prod.defaultCode || null}, ${prod.barcode || null},
				${Number(prod.listPrice || 0)}, ${Number(prod.costPrice || 0)},
				${Number(prod.qtyAvailable || 0)}, ${Number(prod.freeQty || 0)},
				${prod.active}, ${prod.category || null}, ${prod.isStorable ?? true}
			)
			ON CONFLICT (id) DO UPDATE SET
				name = EXCLUDED.name,
				default_code = EXCLUDED.default_code,
				barcode = EXCLUDED.barcode,
				list_price = EXCLUDED.list_price,
				cost_price = EXCLUDED.cost_price,
				qty_available = EXCLUDED.qty_available,
				free_qty = EXCLUDED.free_qty,
				active = EXCLUDED.active,
				category = EXCLUDED.category,
				is_storable = EXCLUDED.is_storable,
				updated_at = NOW()
		`;
	}
}

export async function upsertCustomers(
	customers: OdooCustomer[],
): Promise<void> {
	if (customers.length === 0) return;
	for (const cust of customers) {
		await sql`
			INSERT INTO dim_customers (
				id, name, email, mobile, city, customer_rank, active
			) VALUES (
				${cust.id}, ${cust.name}, ${cust.email || null}, ${cust.mobile || null},
				${cust.city || null}, ${Number(cust.customerRank || 0)}, ${cust.active}
			)
			ON CONFLICT (id) DO UPDATE SET
				name = EXCLUDED.name,
				email = EXCLUDED.email,
				mobile = EXCLUDED.mobile,
				city = EXCLUDED.city,
				customer_rank = EXCLUDED.customer_rank,
				active = EXCLUDED.active,
				updated_at = NOW()
		`;
	}
}

export async function upsertSalesOrders(
	orders: OdooSalesOrder[],
): Promise<void> {
	if (orders.length === 0) return;
	for (const order of orders) {
		if (order.partnerId) {
			const existsResult = await sql`
				SELECT 1 FROM dim_customers WHERE id = ${order.partnerId} LIMIT 1
			`;
			if (existsResult.length === 0) {
				await sql`
					INSERT INTO dim_customers (id, name, active)
					VALUES (${order.partnerId}, ${`Odoo Customer ${order.partnerId}`}, true)
					ON CONFLICT (id) DO NOTHING
				`;
			}
		}

		await sql`
			INSERT INTO fact_sales_orders (
				id, name, date_order, partner_id, store_id, amount_total, amount_untaxed, state, order_type
			) VALUES (
				${order.id}, ${order.name}, ${order.dateOrder}, ${order.partnerId || null},
				${order.storeId || null}, ${Number(order.amountTotal || 0)}, ${Number(order.amountUntaxed || 0)},
				${order.state}, ${order.orderType}
			)
			ON CONFLICT (id) DO UPDATE SET
				name = EXCLUDED.name,
				date_order = EXCLUDED.date_order,
				partner_id = EXCLUDED.partner_id,
				store_id = EXCLUDED.store_id,
				amount_total = EXCLUDED.amount_total,
				amount_untaxed = EXCLUDED.amount_untaxed,
				state = EXCLUDED.state,
				order_type = EXCLUDED.order_type,
				updated_at = NOW()
		`;
	}
}

export async function upsertSalesLines(
	lines: OdooSalesLine[],
): Promise<number[]> {
	if (lines.length === 0) return [];

	const productIds = [...new Set(lines.map((l) => l.productId))];
	const existingRows = await sql`
		SELECT id FROM dim_products WHERE id = ANY(${productIds})
	`;
	const existingProductIds = new Set(existingRows.map((r) => r.id));
	const missingProductIds: number[] = [];
	const seenKeys = new Set<string>();
	const validLines: OdooSalesLine[] = [];

	for (const line of lines) {
		if (!existingProductIds.has(line.productId)) {
			missingProductIds.push(line.productId);
			continue;
		}
		if (seenKeys.has(line.id)) continue;
		seenKeys.add(line.id);
		validLines.push(line);
	}

	if (validLines.length > 0) {
		const ids = validLines.map((l) => l.id);
		const orderIds = validLines.map((l) => l.orderId);
		const pIds = validLines.map((l) => l.productId);
		const priceUnits = validLines.map((l) => Number(l.priceUnit || 0));
		const discounts = validLines.map((l) => Number(l.discount || 0));
		const qtys = validLines.map((l) => Number(l.qty || 0));
		const priceSubtotals = validLines.map((l) => Number(l.priceSubtotal || 0));
		const taxAmounts = validLines.map((l) => Number(l.taxAmount || 0));

		await sql`
			INSERT INTO fact_sales_lines (
				id, order_id, product_id, price_unit, discount, qty, price_subtotal, tax_amount
			)
			SELECT * FROM UNNEST(
				${ids}::text[],
				${orderIds}::text[],
				${pIds}::int[],
				${priceUnits}::numeric[],
				${discounts}::numeric[],
				${qtys}::numeric[],
				${priceSubtotals}::numeric[],
				${taxAmounts}::numeric[]
			)
			ON CONFLICT (id) DO UPDATE SET
				order_id = EXCLUDED.order_id,
				product_id = EXCLUDED.product_id,
				price_unit = EXCLUDED.price_unit,
				discount = EXCLUDED.discount,
				qty = EXCLUDED.qty,
				price_subtotal = EXCLUDED.price_subtotal,
				tax_amount = EXCLUDED.tax_amount,
				updated_at = NOW()
		`;
	}

	return [...new Set(missingProductIds)];
}

export interface UpsertInventoryResult {
	inserted: number;
	skippedMissingProduct: number;
	skippedDuplicateKey: number;
	/** Odoo product IDs that caused a skip, deduplicated (capped for log size). */
	missingProductIds: number[];
}

/**
 * Previously silently dropped rows whose product_id wasn't yet in
 * dim_products (a forensic audit found this explained a large share of a
 * confirmed inventory completeness gap). Now returns categorized counts
 * instead of swallowing them — callers are expected to log this, not treat
 * a skip as equivalent to success. Does not fabricate products; a missing
 * product must be synced through the normal product pipeline before its
 * inventory can land here.
 */
export async function upsertInventory(
	records: OdooInventory[],
): Promise<UpsertInventoryResult> {
	const empty: UpsertInventoryResult = {
		inserted: 0,
		skippedMissingProduct: 0,
		skippedDuplicateKey: 0,
		missingProductIds: [],
	};
	if (records.length === 0) return empty;

	// Batched existence check
	const productIds = [...new Set(records.map((r) => r.productId))];
	const existingRows = await sql`
		SELECT id FROM dim_products WHERE id = ANY(${productIds})
	`;
	const existingProductIds = new Set(existingRows.map((r) => r.id));

	const seenInventoryKeys = new Set<string>();
	const validRecords: OdooInventory[] = [];
	const missingProductIdSet = new Set<number>();
	let skippedMissingProduct = 0;
	let skippedDuplicateKey = 0;
	for (const r of records) {
		if (!existingProductIds.has(r.productId)) {
			skippedMissingProduct++;
			if (missingProductIdSet.size < 200) missingProductIdSet.add(r.productId);
			continue;
		}
		const key = `${r.productId}_${r.locationId}`;
		if (seenInventoryKeys.has(key)) {
			skippedDuplicateKey++;
			continue;
		}
		seenInventoryKeys.add(key);
		validRecords.push(r);
	}
	if (validRecords.length === 0) {
		return {
			inserted: 0,
			skippedMissingProduct,
			skippedDuplicateKey,
			missingProductIds: [...missingProductIdSet],
		};
	}

	const pIds = validRecords.map((r) => r.productId);
	const lIds = validRecords.map((r) => r.locationId);
	const lNames = validRecords.map((r) => r.locationName || null);
	const qtys = validRecords.map((r) => Number(r.quantity || 0));
	const resQtys = validRecords.map((r) => Number(r.reservedQuantity || 0));

	await sql`
		INSERT INTO fact_inventory (product_id, location_id, location_name, quantity, reserved_quantity)
		SELECT * FROM UNNEST(
			${pIds}::int[],
			${lIds}::int[],
			${lNames}::text[],
			${qtys}::numeric[],
			${resQtys}::numeric[]
		)
		ON CONFLICT (product_id, location_id) DO UPDATE SET
			location_name = EXCLUDED.location_name,
			quantity = EXCLUDED.quantity,
			reserved_quantity = EXCLUDED.reserved_quantity,
			updated_at = NOW()
	`;

	return {
		inserted: validRecords.length,
		skippedMissingProduct,
		skippedDuplicateKey,
		missingProductIds: [...missingProductIdSet],
	};
}

export async function getLastSyncTime(
	syncType: string,
): Promise<string | null> {
	const result = await sql`
		SELECT completed_at::text 
		FROM sync_telemetry 
		WHERE sync_type = ${syncType} AND status = 'success'
		ORDER BY completed_at DESC 
		LIMIT 1
	`;
	return result[0]?.completed_at || null;
}

export async function getAllLastSyncTimes(): Promise<
	Record<string, string | null>
> {
	const map: Record<string, string | null> = {
		products: null,
		customers: null,
		inventory: null,
		sales_orders: null,
	};
	try {
		const rows = await sql`
			SELECT sync_type, MAX(completed_at)::text AS completed_at
			FROM sync_telemetry
			WHERE status = 'success'
			GROUP BY sync_type
		`;
		for (const row of rows) {
			map[String(row.sync_type)] = row.completed_at || null;
		}
	} catch {
		// Fallback for uninitialized table
	}
	return map;
}

export interface Phase3TelemetryExtra {
	traceId?: string;
	workerId?: string;
	durationMs?: number;
	pollIntervalMs?: number;
	rowsFetched?: number;
	rowsInserted?: number;
	rowsUpdated?: number;
	rowsSkipped?: number;
	writeDateCursor?: string;
	odooResponseMs?: number;
	databaseWriteMs?: number;
	processingMs?: number;
}

export async function logSyncTelemetry(
	syncType: string,
	startedAt: string,
	completedAt: string | null,
	status: "success" | "failed" | "syncing",
	recordsProcessed: number,
	errorMessage: string | null,
	retryCount = 0,
	queueLength = 0,
	workerState = "active",
	extra?: Phase3TelemetryExtra,
): Promise<number> {
	const result = await sql`
		INSERT INTO sync_telemetry (
			sync_type, records_processed, status, started_at, completed_at, error_message,
			retry_count, queue_length, worker_state,
			trace_id, worker_id, duration_ms, poll_interval_ms, entity,
			rows_fetched, rows_inserted, rows_updated, rows_skipped, write_date_cursor,
			odoo_response_ms, database_write_ms, processing_ms
		) VALUES (
			${syncType}, ${recordsProcessed}, ${status}, ${startedAt}, 
			${completedAt || null}, ${errorMessage || null},
			${retryCount}, ${queueLength}, ${workerState},
			${extra?.traceId || `tr_${Date.now()}`}, ${extra?.workerId || "worker_main"},
			${extra?.durationMs || 0}, ${extra?.pollIntervalMs || 2000}, ${syncType},
			${extra?.rowsFetched || recordsProcessed}, ${extra?.rowsInserted || recordsProcessed},
			${extra?.rowsUpdated || 0}, ${extra?.rowsSkipped || 0}, ${extra?.writeDateCursor || null},
			${extra?.odooResponseMs || 0}, ${extra?.databaseWriteMs || 0}, ${extra?.processingMs || 0}
		)
		RETURNING id
	`;
	return Number(result[0]?.id || 0);
}

export interface EntityTelemetryStatus {
	syncType: string;
	lastSyncAt: string | null;
	recordsProcessed: number;
	status: string;
	errorMessage: string | null;
	secondsAgo: number | null;
	isStale: boolean; // > 60 seconds
}

export async function getLatestTelemetryStatus(): Promise<{
	overallStatus: "live" | "syncing" | "delayed" | "offline";
	lastSyncAt: string | null;
	maxSecondsAgo: number | null;
	entityStatuses: Record<string, EntityTelemetryStatus>;
}> {
	// Exclude 'heartbeat' rows — they're a liveness ping, not a real sync event
	// (always 0 records processed). Folding them into this query previously
	// masked real sync staleness, since a heartbeat written seconds ago would
	// dominate maxSecondsAgo/lastSyncAt even when the real data was hours stale.
	const result = await sql`
		SELECT DISTINCT ON (sync_type)
			sync_type, completed_at::text, records_processed, status, error_message,
			EXTRACT(EPOCH FROM (NOW() - completed_at))::int AS seconds_ago
		FROM sync_telemetry
		WHERE sync_type <> 'heartbeat'
		ORDER BY sync_type, completed_at DESC
	`;

	const entityStatuses: Record<string, EntityTelemetryStatus> = {};
	let maxSecondsAgo: number | null = null;
	let mostRecentCompletedAt: string | null = null;
	let hasSuccess = false;
	let hasSyncing = false;

	for (const row of result) {
		const seconds = row.seconds_ago !== null ? Number(row.seconds_ago) : null;
		const isStale = seconds === null || seconds > 60;

		entityStatuses[row.sync_type] = {
			syncType: row.sync_type,
			lastSyncAt: row.completed_at || null,
			recordsProcessed: Number(row.records_processed || 0),
			status: String(row.status),
			errorMessage: row.error_message || null,
			secondsAgo: seconds,
			isStale,
		};

		if (row.status === "syncing") hasSyncing = true;
		if (row.status === "success") hasSuccess = true;
		// Track the entity with the smallest secondsAgo — i.e. the single most
		// recently completed real sync — not result[0], which is only the
		// alphabetically-first sync_type (an unrelated, arbitrary ordering that
		// previously made `lastSyncAt` contradict `maxSecondsAgo`).
		if (
			seconds !== null &&
			(maxSecondsAgo === null || seconds < maxSecondsAgo)
		) {
			maxSecondsAgo = seconds;
			mostRecentCompletedAt = row.completed_at || null;
		}
	}

	let overallStatus: "live" | "syncing" | "delayed" | "offline" = "offline";
	if (hasSyncing) {
		overallStatus = "syncing";
	} else if (hasSuccess && maxSecondsAgo !== null && maxSecondsAgo <= 60) {
		overallStatus = "live";
	} else if (hasSuccess && maxSecondsAgo !== null && maxSecondsAgo > 60) {
		overallStatus = "delayed";
	}

	return {
		overallStatus,
		lastSyncAt: mostRecentCompletedAt,
		maxSecondsAgo,
		entityStatuses,
	};
}

/**
 * Real business-data freshness signature for /api/sales/dashboard's
 * response cache — the GREATEST `updated_at`/`uploaded_at` across every
 * table that actually feeds the dashboard's numbers (sales_fact_v's two
 * sources, plus purchase data for profitability).
 *
 * This replaces using sync_telemetry.lastSyncAt as the cache-invalidation
 * key: a forensic performance audit proved that value changes on nearly
 * every poll cycle (every 1-8s) even when zero records actually changed —
 * e.g. `products`/`customers`/`analytics_refresh` telemetry rows get
 * written every cycle regardless of `hasChanges`. Keying the cache on that
 * defeated the cache almost as fast as it was populated. These four
 * columns, by contrast, are only ever written when a row is genuinely
 * inserted/updated (upsertSalesLines/upsertSalesOrders only run their
 * ON CONFLICT DO UPDATE when there's at least one real row; Excel uploads
 * insert a new upload_batches row only on a real upload) — so this value
 * is stable across routine no-op sync cycles and changes exactly when the
 * dashboard's real numbers would change.
 */
export async function getDashboardDataFreshness(): Promise<string | null> {
	const [row] = await sql`
		SELECT GREATEST(
			(SELECT MAX(updated_at) FROM fact_sales_orders),
			(SELECT MAX(updated_at) FROM fact_sales_lines),
			(SELECT MAX(uploaded_at) FROM upload_batches),
			(SELECT MAX(updated_at) FROM purchase_orders)
		)::text AS freshness
	`;
	return row?.freshness ?? null;
}

// ── Persisted sync dead-letter queue ─────────────────────────────────
// Mirrors the existing webhook_events dead-letter pattern, but for jobs
// that exhaust retries in the polling SyncQueueManager — previously only
// held in an in-memory array, lost on every worker restart.

export interface DeadLetterJobRow {
	id: number;
	jobType: string;
	attempts: number;
	errorMessage: string;
	lastSyncTime: string | null;
	createdAt: string;
	resolvedAt: string | null;
	status: "dead_letter" | "retried" | "resolved";
}

/**
 * Idempotent: an already-unresolved DLQ row for the same job_type is updated
 * in place (attempts/error/last_sync_time refreshed) rather than duplicated.
 * Without this, retrying the same permanently-failing job type would create
 * a new row every retry, inflating the persisted count against reality.
 */
export async function insertDeadLetterJob(job: {
	jobType: string;
	attempts: number;
	errorMessage: string;
	lastSyncTime: string | null;
}): Promise<void> {
	const existing = await sql`
		SELECT id FROM sync_dead_letter_queue
		WHERE job_type = ${job.jobType} AND status = 'dead_letter'
		LIMIT 1
	`;
	if (existing.length > 0) {
		await sql`
			UPDATE sync_dead_letter_queue
			SET attempts = ${job.attempts}, error_message = ${job.errorMessage},
				last_sync_time = ${job.lastSyncTime}, created_at = NOW()
			WHERE id = ${existing[0].id}
		`;
		return;
	}
	await sql`
		INSERT INTO sync_dead_letter_queue (job_type, attempts, error_message, last_sync_time)
		VALUES (${job.jobType}, ${job.attempts}, ${job.errorMessage}, ${job.lastSyncTime})
	`;
}

/**
 * Authoritative, persisted DLQ count — used by the worker heartbeat instead
 * of the in-memory SyncQueueManager counter, which is process-local and was
 * confirmed (forensic audit) to diverge from this table whenever the DB
 * insert in insertDeadLetterJob fails independently of the in-memory push.
 */
export async function getDeadLetterQueueCount(
	status: "dead_letter" | "retried" | "resolved" = "dead_letter",
): Promise<number> {
	const result = await sql`
		SELECT COUNT(*)::int AS count FROM sync_dead_letter_queue WHERE status = ${status}
	`;
	return Number(result[0]?.count || 0);
}

export async function getDeadLetterJobs(
	status: "dead_letter" | "retried" | "resolved" = "dead_letter",
): Promise<DeadLetterJobRow[]> {
	const rows = await sql`
		SELECT id, job_type, attempts, error_message, last_sync_time,
			created_at::text, resolved_at::text, status
		FROM sync_dead_letter_queue
		WHERE status = ${status}
		ORDER BY created_at DESC
	`;
	return rows.map((r) => ({
		id: Number(r.id),
		jobType: String(r.job_type),
		attempts: Number(r.attempts),
		errorMessage: String(r.error_message),
		lastSyncTime: r.last_sync_time || null,
		createdAt: r.created_at,
		resolvedAt: r.resolved_at || null,
		status: r.status,
	}));
}

export async function markDeadLetterResolved(id: number): Promise<void> {
	await sql`
		UPDATE sync_dead_letter_queue
		SET status = 'resolved', resolved_at = NOW()
		WHERE id = ${id}
	`;
}

// ── Persisted worker heartbeat ───────────────────────────────────────
// Lets /api/sync/status and /api/health report the real state of a worker
// process running on a separate host, instead of an in-process singleton
// that may never have been started on the machine serving the API request.

export async function upsertWorkerHeartbeat(
	workerId: string,
	hostname: string,
	state: object,
): Promise<void> {
	await sql`
		INSERT INTO worker_heartbeat (worker_id, hostname, state, updated_at)
		VALUES (${workerId}, ${hostname}, ${JSON.stringify(state)}, NOW())
		ON CONFLICT (worker_id) DO UPDATE SET
			hostname = EXCLUDED.hostname,
			state = EXCLUDED.state,
			updated_at = NOW()
	`;
}

export interface WorkerHeartbeatRow {
	workerId: string;
	hostname: string | null;
	state: Record<string, unknown>;
	updatedAt: string;
	secondsAgo: number;
}

export async function getWorkerHeartbeat(
	workerId = "main",
): Promise<WorkerHeartbeatRow | null> {
	const rows = await sql`
		SELECT worker_id, hostname, state, updated_at::text,
			EXTRACT(EPOCH FROM (NOW() - updated_at))::int AS seconds_ago
		FROM worker_heartbeat
		WHERE worker_id = ${workerId}
		LIMIT 1
	`;
	if (rows.length === 0) return null;
	const row = rows[0];
	return {
		workerId: String(row.worker_id),
		hostname: row.hostname || null,
		state: row.state,
		updatedAt: row.updated_at,
		secondsAgo: Number(row.seconds_ago || 0),
	};
}
