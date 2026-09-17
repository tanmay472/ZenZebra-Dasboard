/**
 * Claude tool implementations — the only functions Claude can trigger,
 * and each one is a plain read-only query against the same canonical
 * tables the rest of this dashboard reads (`sales_fact_v`, `dim_products`,
 * `dim_customers`). No Odoo credential, database password, or other
 * secret is ever passed to or through Claude — these functions return
 * only the aggregated business data needed to answer a question.
 *
 * Framework-agnostic on purpose: this module has no Anthropic-specific
 * types, so the same functions can be registered as tools for a different
 * provider (e.g. Gemini) later without any change here.
 */
import { sql } from "@/lib/db";
import { getItemVelocityPaged } from "@/lib/repositories/inventory.repository";
import { getWorkerHeartbeat } from "@/lib/repositories/odoo.repository";

export interface ToolResult {
	success: boolean;
	data?: unknown;
	error?: string;
}

function isValidDate(value: unknown): value is string {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Evidence-based, reproducible anomaly classification for one store's
 * order count on a given day vs. its own real trailing 7-day average
 * (never a fabricated/assumed baseline). INSUFFICIENT_DATA when fewer
 * than 3 of the trailing 7 days have any data for that store.
 */
export interface StoreOrderAnomaly {
	status: "NORMAL" | "WATCH" | "ANOMALY" | "INSUFFICIENT_DATA";
	baselineAvgOrders: number | null;
	deviationPct: number | null;
	baselineDays: number;
}

export type FreshnessLevel = "LIVE" | "RECENT" | "STALE" | "UNKNOWN";

export interface DataFreshness {
	level: FreshnessLevel;
	/** Seconds since the sync worker last wrote a heartbeat, or null if no
	 * heartbeat row exists at all. */
	syncSecondsAgo: number | null;
	/** The most recent sale_date present in the canonical sales_fact_v view
	 * (ISO date string), or null if the table is empty. */
	latestDataDate: string | null;
}

const FRESHNESS_LIVE_SECONDS = 120;
const FRESHNESS_RECENT_SECONDS = 900;

/**
 * The single authoritative freshness signal for AI answers. Deliberately
 * does NOT use the `data_freshness` SQL view — that view only aggregates
 * the legacy `sales_fact` (Excel-import) table via a join on
 * `upload_batches`, which hasn't been written to since Excel ingestion was
 * deprecated (Phase 6A). Querying it here would report the data as ~50
 * days stale even when the real canonical pipeline (Odoo → sales_fact_v)
 * is current to within the last hour — confirmed by direct comparison
 * during this phase's audit. The worker heartbeat + a live MAX(sale_date)
 * against sales_fact_v are the only two things that actually reflect
 * whether the canonical data path is current.
 */
export async function getDataFreshness(): Promise<DataFreshness> {
	let syncSecondsAgo: number | null = null;
	try {
		const heartbeat = await getWorkerHeartbeat("main");
		syncSecondsAgo = heartbeat ? heartbeat.secondsAgo : null;
	} catch {
		syncSecondsAgo = null;
	}

	let latestDataDate: string | null = null;
	try {
		const [row] = await sql`
			SELECT MAX(sale_date)::text AS latest FROM sales_fact_v
		`;
		latestDataDate = row?.latest ?? null;
	} catch {
		latestDataDate = null;
	}

	let level: FreshnessLevel = "UNKNOWN";
	if (syncSecondsAgo !== null) {
		if (syncSecondsAgo <= FRESHNESS_LIVE_SECONDS) level = "LIVE";
		else if (syncSecondsAgo <= FRESHNESS_RECENT_SECONDS) level = "RECENT";
		else level = "STALE";
	}

	return { level, syncSecondsAgo, latestDataDate };
}

/** Today's revenue/orders/AOV/tax — mirrors the logic already proven in ai/briefing/route.ts. */
export async function getTodaySales(): Promise<ToolResult> {
	try {
		const [row] = await sql`
			SELECT
				COALESCE(SUM(net_amount), 0)::numeric AS revenue,
				COALESCE(SUM(gross_amount), 0)::numeric AS collection,
				COALESCE(SUM(tax_amount), 0)::numeric AS gst,
				COUNT(DISTINCT order_id)::int AS orders,
				ROUND(COALESCE(SUM(net_amount) / NULLIF(COUNT(DISTINCT order_id), 0), 0)::numeric, 2) AS aov
			FROM sales_fact_v
			WHERE sale_date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date
		`;
		const freshness = await getDataFreshness();
		const todayKolkata = new Intl.DateTimeFormat("en-CA", {
			timeZone: "Asia/Kolkata",
		}).format(new Date());
		return {
			success: true,
			data: {
				date: todayKolkata,
				revenue: Number(row.revenue),
				collection: Number(row.collection),
				gst: Number(row.gst),
				orders: Number(row.orders),
				aov: Number(row.aov),
				freshness,
			},
		};
	} catch (err: any) {
		return { success: false, error: "Failed to retrieve today's sales data." };
	}
}

/**
 * Rich single-call sales summary for one day: totals (incl. discount, units),
 * a same-store-filter comparison against the previous day, and a per-store
 * breakdown with contribution % — everything a "give me today's sales" /
 * "how is business today" question needs, in one query round-trip instead of
 * several. Stores are never hardcoded; the breakdown comes from whatever
 * `billed_by` values actually exist for that date. If the requested date is
 * today, `isPeriodComplete` is false and the comparison is flagged as
 * partial-day-vs-full-day so the caller never presents it as a clean,
 * like-for-like delta.
 */
export async function getSalesSummary(args: {
	date?: string;
	store?: string;
}): Promise<ToolResult> {
	const todayKolkata = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Kolkata",
	}).format(new Date());
	const date = isValidDate(args.date) ? args.date : todayKolkata;
	const todayStr = todayKolkata;
	const isPeriodComplete = date < todayStr;
	const storeFilter = args.store ? `%${args.store.trim()}%` : null;

	const prev = new Date(`${date}T12:00:00Z`);
	prev.setUTCDate(prev.getUTCDate() - 1);
	const previousDate = prev.toISOString().split("T")[0];

	try {
		async function totalsFor(d: string) {
			const [row] = await sql`
				SELECT
					COALESCE(SUM(net_amount), 0)::numeric AS revenue,
					COALESCE(SUM(gross_amount), 0)::numeric AS collection,
					COALESCE(SUM(tax_amount), 0)::numeric AS gst,
					COALESCE(SUM(discount_amount), 0)::numeric AS discount,
					COALESCE(SUM(quantity), 0)::int AS units,
					COUNT(DISTINCT order_id)::int AS orders,
					ROUND(COALESCE(SUM(net_amount) / NULLIF(COUNT(DISTINCT order_id), 0), 0)::numeric, 2) AS aov
				FROM sales_fact_v
				WHERE sale_date = ${d}::date
					AND (${storeFilter}::text IS NULL OR billed_by ILIKE ${storeFilter})
			`;
			return {
				revenue: Number(row.revenue),
				collection: Number(row.collection),
				gst: Number(row.gst),
				discount: Number(row.discount),
				units: Number(row.units),
				orders: Number(row.orders),
				aov: Number(row.aov),
			};
		}

		const current = await totalsFor(date);
		const previous = await totalsFor(previousDate);
		const previousHasData = previous.orders > 0;

		const pctChange = (curr: number, prev: number): number | null =>
			prev > 0 ? Number((((curr - prev) / prev) * 100).toFixed(1)) : null;

		const comparison = previousHasData
			? {
					previousDate,
					previous,
					revenueChangePct: pctChange(current.revenue, previous.revenue),
					ordersChangePct: pctChange(current.orders, previous.orders),
					aovChangePct: pctChange(current.aov, previous.aov),
					caveat: isPeriodComplete
						? null
						: `${date} is still in progress (partial day) — compared against the full previous day (${previousDate}), not a like-for-like same-time comparison.`,
				}
			: null;

		let byStore: Array<{
			store: string;
			revenue: number;
			orders: number;
			aov: number;
			contributionPct: number;
			anomaly: StoreOrderAnomaly;
		}> | null = null;

		if (!args.store) {
			const rows = await sql`
				SELECT
					billed_by AS store,
					COALESCE(SUM(net_amount), 0)::numeric AS revenue,
					COUNT(DISTINCT order_id)::int AS orders,
					ROUND(COALESCE(SUM(net_amount) / NULLIF(COUNT(DISTINCT order_id), 0), 0)::numeric, 2) AS aov
				FROM sales_fact_v
				WHERE sale_date = ${date}::date
				GROUP BY billed_by
				ORDER BY revenue DESC
			`;

			// Evidence-based anomaly signal: each store's order count today vs
			// its own real trailing 7-day daily average (the 7 days strictly
			// before `date`, excluding `date` itself so the baseline is never
			// contaminated by the value being evaluated). Never a fabricated
			// baseline — INSUFFICIENT_DATA when fewer than 3 of those 7 days
			// actually have data for that store.
			const baselineRows = await sql`
				SELECT
					billed_by AS store,
					COUNT(DISTINCT sale_date)::int AS days_with_data,
					AVG(daily_orders)::numeric AS avg_daily_orders
				FROM (
					SELECT billed_by, sale_date, COUNT(DISTINCT order_id) AS daily_orders
					FROM sales_fact_v
					WHERE sale_date >= ${date}::date - INTERVAL '7 days'
						AND sale_date < ${date}::date
					GROUP BY billed_by, sale_date
				) daily
				GROUP BY billed_by
			`;
			const baselineByStore = new Map(
				baselineRows.map((r) => [
					r.store,
					{
						daysWithData: Number(r.days_with_data),
						avgDailyOrders: Number(r.avg_daily_orders),
					},
				]),
			);

			const totalRevenue = current.revenue;
			byStore = rows.map((r) => {
				const orders = Number(r.orders);
				const baseline = baselineByStore.get(r.store);
				let anomaly: StoreOrderAnomaly;
				if (!baseline || baseline.daysWithData < 3) {
					anomaly = {
						status: "INSUFFICIENT_DATA",
						baselineAvgOrders: null,
						deviationPct: null,
						baselineDays: baseline?.daysWithData ?? 0,
					};
				} else {
					const deviationPct =
						baseline.avgDailyOrders > 0
							? Number(
									(
										((orders - baseline.avgDailyOrders) /
											baseline.avgDailyOrders) *
										100
									).toFixed(1),
								)
							: null;
					const absDev = deviationPct === null ? 0 : Math.abs(deviationPct);
					anomaly = {
						status: absDev > 40 ? "ANOMALY" : absDev > 20 ? "WATCH" : "NORMAL",
						baselineAvgOrders: Number(baseline.avgDailyOrders.toFixed(1)),
						deviationPct,
						baselineDays: baseline.daysWithData,
					};
				}
				return {
					store: r.store,
					revenue: Number(r.revenue),
					orders,
					aov: Number(r.aov),
					contributionPct:
						totalRevenue > 0
							? Number(((Number(r.revenue) / totalRevenue) * 100).toFixed(1))
							: 0,
					anomaly,
				};
			});
		}

		const freshness = await getDataFreshness();

		return {
			success: true,
			data: {
				date,
				isPeriodComplete,
				store: args.store || null,
				current,
				comparison,
				byStore,
				freshness,
			},
		};
	} catch {
		return { success: false, error: "Failed to retrieve the sales summary." };
	}
}

/** Sales for an explicit date range (inclusive). */
export async function getSalesByDate(args: {
	startDate: string;
	endDate: string;
}): Promise<ToolResult> {
	if (!isValidDate(args.startDate) || !isValidDate(args.endDate)) {
		return {
			success: false,
			error: "startDate and endDate must be YYYY-MM-DD.",
		};
	}
	try {
		const [row] = await sql`
			SELECT
				COALESCE(SUM(net_amount), 0)::numeric AS revenue,
				COALESCE(SUM(gross_amount), 0)::numeric AS collection,
				COALESCE(SUM(tax_amount), 0)::numeric AS gst,
				COUNT(DISTINCT order_id)::int AS orders,
				ROUND(COALESCE(SUM(net_amount) / NULLIF(COUNT(DISTINCT order_id), 0), 0)::numeric, 2) AS aov
			FROM sales_fact_v
			WHERE sale_date >= ${args.startDate}::date AND sale_date <= ${args.endDate}::date
		`;
		return {
			success: true,
			data: {
				startDate: args.startDate,
				endDate: args.endDate,
				revenue: Number(row.revenue),
				collection: Number(row.collection),
				gst: Number(row.gst),
				orders: Number(row.orders),
				aov: Number(row.aov),
			},
		};
	} catch {
		return {
			success: false,
			error: "Failed to retrieve sales data for that date range.",
		};
	}
}

/** Per-store revenue breakdown, optionally scoped to a date range (defaults to last 30 days). */
export async function getSalesByStore(args: {
	startDate?: string;
	endDate?: string;
}): Promise<ToolResult> {
	const startDate = isValidDate(args.startDate) ? args.startDate : null;
	const endDate = isValidDate(args.endDate) ? args.endDate : null;
	try {
		const rows = await sql`
			SELECT
				billed_by AS store,
				COALESCE(SUM(net_amount), 0)::numeric AS revenue,
				COUNT(DISTINCT order_id)::int AS orders,
				ROUND(COALESCE(SUM(net_amount) / NULLIF(COUNT(DISTINCT order_id), 0), 0)::numeric, 2) AS aov
			FROM sales_fact_v
			WHERE (${startDate}::date IS NULL OR sale_date >= ${startDate}::date)
				AND (${endDate}::date IS NULL OR sale_date <= ${endDate}::date)
				AND (${startDate}::date IS NOT NULL OR ${endDate}::date IS NOT NULL OR sale_date >= CURRENT_DATE - INTERVAL '30 days')
			GROUP BY billed_by
			ORDER BY revenue DESC
		`;
		return {
			success: true,
			data: rows.map((r) => ({
				store: r.store,
				revenue: Number(r.revenue),
				orders: Number(r.orders),
				aov: Number(r.aov),
			})),
		};
	} catch {
		return {
			success: false,
			error: "Failed to retrieve store-level sales data.",
		};
	}
}

/**
 * Dedicated trend capability — real per-period totals from sales_fact_v,
 * bucketed by day/week/month via date_trunc. No synthetic values, no
 * fixed growth assumption: every bucket is an independent real
 * aggregation, and period-over-period % change is computed only between
 * buckets that both have real data.
 */
export async function getSalesTrend(args: {
	startDate: string;
	endDate: string;
	store?: string;
	granularity?: "day" | "week" | "month";
}): Promise<ToolResult> {
	if (!isValidDate(args.startDate) || !isValidDate(args.endDate)) {
		return {
			success: false,
			error: "startDate and endDate (YYYY-MM-DD) are required for a trend.",
		};
	}
	const granularity: "day" | "week" | "month" =
		args.granularity === "week" || args.granularity === "month"
			? args.granularity
			: "day";
	const storeFilter = args.store ? `%${args.store.trim()}%` : null;

	try {
		const rows = await sql`
			SELECT
				date_trunc(${granularity}, sale_date)::date::text AS period,
				COALESCE(SUM(gross_amount), 0)::numeric AS gross,
				COALESCE(SUM(net_amount), 0)::numeric AS net,
				COALESCE(SUM(tax_amount), 0)::numeric AS tax,
				COUNT(DISTINCT order_id)::int AS orders,
				COALESCE(SUM(quantity), 0)::numeric AS units,
				ROUND(COALESCE(SUM(net_amount) / NULLIF(COUNT(DISTINCT order_id), 0), 0)::numeric, 2) AS aov
			FROM sales_fact_v
			WHERE sale_date >= ${args.startDate}::date AND sale_date <= ${args.endDate}::date
				AND (${storeFilter}::text IS NULL OR billed_by ILIKE ${storeFilter})
			GROUP BY 1
			ORDER BY 1 ASC
		`;

		const periods = rows.map((r) => ({
			period: r.period,
			gross: Number(r.gross),
			net: Number(r.net),
			tax: Number(r.tax),
			orders: Number(r.orders),
			units: Number(r.units),
			aov: Number(r.aov),
		}));

		let direction: "up" | "down" | "flat" | "insufficient_data" =
			"insufficient_data";
		let changePct: number | null = null;
		if (periods.length >= 2) {
			const first = periods[0]!.net;
			const last = periods[periods.length - 1]!.net;
			if (first > 0) {
				changePct = Number((((last - first) / first) * 100).toFixed(1));
				direction = changePct > 2 ? "up" : changePct < -2 ? "down" : "flat";
			}
		}

		const strongest = periods.length
			? periods.reduce((a, b) => (b.net > a.net ? b : a))
			: null;
		const weakest = periods.length
			? periods.reduce((a, b) => (b.net < a.net ? b : a))
			: null;

		return {
			success: true,
			data: {
				granularity,
				store: args.store || null,
				startDate: args.startDate,
				endDate: args.endDate,
				periods,
				direction,
				changePctFirstToLast: changePct,
				strongestPeriod: strongest,
				weakestPeriod: weakest,
			},
		};
	} catch {
		return { success: false, error: "Failed to retrieve the sales trend." };
	}
}

/** Top-selling products by net revenue, optionally scoped to a date range (defaults to last 30 days). */
export async function getTopProducts(args: {
	limit?: number;
	startDate?: string;
	endDate?: string;
}): Promise<ToolResult> {
	const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
	const startDate = isValidDate(args.startDate) ? args.startDate : null;
	const endDate = isValidDate(args.endDate) ? args.endDate : null;
	try {
		const rows = await sql`
			SELECT
				item_name AS product,
				sku_code AS sku,
				SUM(quantity)::int AS units_sold,
				COALESCE(SUM(net_amount), 0)::numeric AS revenue
			FROM sales_fact_v
			WHERE (${startDate}::date IS NULL OR sale_date >= ${startDate}::date)
				AND (${endDate}::date IS NULL OR sale_date <= ${endDate}::date)
				AND (${startDate}::date IS NOT NULL OR ${endDate}::date IS NOT NULL OR sale_date >= CURRENT_DATE - INTERVAL '30 days')
			GROUP BY item_name, sku_code
			ORDER BY revenue DESC
			LIMIT ${limit}
		`;
		return {
			success: true,
			data: rows.map((r) => ({
				product: r.product,
				sku: r.sku,
				unitsSold: Number(r.units_sold),
				revenue: Number(r.revenue),
			})),
		};
	} catch {
		return { success: false, error: "Failed to retrieve top products." };
	}
}

/** Products at or below a low-stock threshold — same table/columns as ai/briefing/route.ts. */
export async function getLowStockProducts(args: {
	threshold?: number;
	limit?: number;
}): Promise<ToolResult> {
	const threshold = Math.max(Number(args.threshold) || 5, 0);
	const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
	try {
		const rows = await sql`
			SELECT name, default_code AS sku, qty_available, free_qty
			FROM dim_products
			WHERE qty_available <= ${threshold} AND active = true
			ORDER BY qty_available ASC
			LIMIT ${limit}
		`;
		return {
			success: true,
			data: rows.map((r) => ({
				product: r.name,
				sku: r.sku || "N/A",
				onHand: Number(r.qty_available),
				freeQty: Number(r.free_qty),
			})),
		};
	} catch {
		return { success: false, error: "Failed to retrieve low-stock products." };
	}
}

/**
 * Full in-stock product list for one store (not just low-stock items) —
 * reuses the same store-aware `fact_inventory`/`dim_stores` join already
 * proven in the Inventory dashboard's velocity table, so store names/codes
 * ("KLJ", "SWN", etc.) resolve exactly the way they do everywhere else.
 */
export async function getStoreInventory(args: {
	store: string;
	limit?: number;
}): Promise<ToolResult> {
	const store = typeof args.store === "string" ? args.store.trim() : "";
	if (!store) {
		return { success: false, error: "A store name is required." };
	}
	const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 100);
	try {
		const result = await getItemVelocityPaged({
			page: 1,
			pageSize: limit,
			sortBy: "soh",
			sortDir: "desc",
			store: `%${store}%`,
		});
		return {
			success: true,
			data: {
				store,
				totalItemsInStore: result.totalCount,
				returned: result.items.length,
				items: result.items.map((i) => ({
					product: i.name,
					sku: i.sku,
					category: i.category,
					onHand: i.qtyOnHand,
					unitsSold30d: i.unitsSold30d,
				})),
			},
		};
	} catch {
		return {
			success: false,
			error: `Failed to retrieve inventory for store "${store}".`,
		};
	}
}

/** Highest lifetime-spend customers, derived from sales_fact_v (no stored LTV column exists). */
export async function getTopCustomers(args: {
	limit?: number;
}): Promise<ToolResult> {
	const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
	try {
		const rows = await sql`
			SELECT
				MAX(customer_name) AS name,
				customer_mobile AS mobile,
				COUNT(DISTINCT order_id)::int AS orders,
				COALESCE(SUM(net_amount), 0)::numeric AS lifetime_spend
			FROM sales_fact_v
			WHERE customer_mobile IS NOT NULL AND customer_mobile <> ''
			GROUP BY customer_mobile
			ORDER BY lifetime_spend DESC
			LIMIT ${limit}
		`;
		return {
			success: true,
			data: rows.map((r) => ({
				name: r.name || "Unknown",
				mobile: r.mobile,
				orders: Number(r.orders),
				lifetimeSpend: Number(r.lifetime_spend),
			})),
		};
	} catch {
		return { success: false, error: "Failed to retrieve top customers." };
	}
}

/** A single combined snapshot: today's sales + best-performing store + any low-stock items. */
export async function getDashboardSummary(): Promise<ToolResult> {
	const [today, byStore, lowStock] = await Promise.all([
		getTodaySales(),
		getSalesByStore({}),
		getLowStockProducts({ threshold: 5, limit: 5 }),
	]);
	if (!today.success) {
		return { success: false, error: "Failed to retrieve dashboard summary." };
	}
	return {
		success: true,
		data: {
			today: today.data,
			topStore:
				byStore.success &&
				Array.isArray(byStore.data) &&
				byStore.data.length > 0
					? byStore.data[0]
					: null,
			lowStockCount:
				lowStock.success && Array.isArray(lowStock.data)
					? lowStock.data.length
					: null,
		},
	};
}

/** Revenue/units by product category, optionally scoped to a date range (defaults to last 30 days). */
export async function getCategoryPerformance(args: {
	limit?: number;
	startDate?: string;
	endDate?: string;
}): Promise<ToolResult> {
	const limit = Math.min(Math.max(Number(args.limit) || 15, 1), 50);
	const startDate = isValidDate(args.startDate) ? args.startDate : null;
	const endDate = isValidDate(args.endDate) ? args.endDate : null;
	try {
		const rows = await sql`
			SELECT
				category,
				COALESCE(SUM(net_amount), 0)::numeric AS revenue,
				SUM(quantity)::int AS units,
				COUNT(DISTINCT order_id)::int AS orders
			FROM sales_fact_v
			WHERE category IS NOT NULL AND category <> ''
				AND (${startDate}::date IS NULL OR sale_date >= ${startDate}::date)
				AND (${endDate}::date IS NULL OR sale_date <= ${endDate}::date)
				AND (${startDate}::date IS NOT NULL OR ${endDate}::date IS NOT NULL OR sale_date >= CURRENT_DATE - INTERVAL '30 days')
			GROUP BY category
			ORDER BY revenue DESC
			LIMIT ${limit}
		`;
		return {
			success: true,
			data: rows.map((r) => ({
				category: r.category,
				revenue: Number(r.revenue),
				units: Number(r.units),
				orders: Number(r.orders),
			})),
		};
	} catch {
		return {
			success: false,
			error: "Failed to retrieve category performance.",
		};
	}
}

/**
 * CRM pipeline summary — real crm_leads data only. Returns success:false
 * (not fabricated zeros) if the table can't be read; a genuinely empty
 * pipeline (0 active leads) is a real, sayable fact returned via
 * getCrmPipelineSummary's own null-vs-zero handling (winRate is null when
 * there are 0 leads, never a fabricated 0%).
 */
export async function getCrmPipeline(): Promise<ToolResult> {
	try {
		const { getCrmPipelineSummary } = await import(
			"@/lib/repositories/crm.repository"
		);
		const summary = await getCrmPipelineSummary();
		return { success: true, data: summary };
	} catch {
		return { success: false, error: "Failed to retrieve CRM pipeline data." };
	}
}

/**
 * LTV/CAC/AOV for one store (or all stores when omitted). Reuses the exact
 * report functions the LTV/CAC/AOV dashboard page itself calls — same
 * canonical numbers, not a re-derivation. CAC/payback come back as
 * unavailable (not fabricated) when dim_marketing_spend has no row for
 * this store, per getCacReportData's own documented handling.
 *
 * Deliberately does NOT expose getCacReportData's internal paybackTable
 * field — it's a per-store breakdown (all real stores, discovered
 * dynamically as of Phase 6) rather than the single store this tool was
 * actually asked about, so returning it here would be off-topic noise
 * rather than an answer to the question asked. Only the top-level,
 * store-parameterized result is used here, which is computed correctly
 * for whatever store is actually requested. paybackMonths is always null
 * (see cac.service.ts) since no documented margin assumption exists to
 * compute a real payback period from.
 */
export async function getLtvCac(args: {
	store?: string;
	startDate?: string;
	endDate?: string;
}): Promise<ToolResult> {
	const storeName = args.store?.trim() || null;
	const endDate = isValidDate(args.endDate)
		? args.endDate
		: new Date().toISOString().split("T")[0];
	const startDate = isValidDate(args.startDate)
		? args.startDate
		: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
				.toISOString()
				.split("T")[0];
	try {
		const { getLtvReportData } = await import("@/lib/services/ltv.service");
		const { getCacReportData } = await import("@/lib/services/cac.service");
		const [ltv, cac] = await Promise.all([
			getLtvReportData(storeName),
			getCacReportData(sql, startDate, endDate, storeName),
		]);
		const ltvCacRatio =
			cac.hasMarketingSpendData && cac.cac ? ltv.ltv / cac.cac : null;
		return {
			success: true,
			data: {
				store: storeName || "All Stores",
				period: { startDate, endDate },
				// ltv is a LIFETIME metric (getLtvReportData has no date
				// scoping) — it will be identical no matter what period is
				// requested. Only cac/aov below are actually scoped to
				// `period`. Surfacing this explicitly so the answer doesn't
				// imply LTV changed between two different requested windows
				// when it's really the same lifetime number both times.
				ltvIsLifetimeNotPeriodScoped: true,
				ltv: ltv.ltv,
				firstOrderAov: ltv.firstOrderAov,
				latestOrderAov: ltv.latestOrderAov,
				hasMarketingSpendData: cac.hasMarketingSpendData,
				cac: cac.cac,
				ltvCacRatio,
				paybackPeriodMonths: cac.paybackMonths,
			},
		};
	} catch {
		return { success: false, error: "Failed to retrieve LTV/CAC data." };
	}
}

/**
 * Customer retention overview for one store (or all stores). Reuses the
 * exact function the retention dashboard page calls — same canonical
 * numbers. CAC/LTV:CAC ratio come back null when no marketing-spend row
 * exists, per this function's own existing null-vs-zero handling.
 */
export async function getCustomerRetention(args: {
	store?: string;
	startDate?: string;
	endDate?: string;
}): Promise<ToolResult> {
	const endDate = isValidDate(args.endDate)
		? args.endDate
		: new Date().toISOString().split("T")[0];
	const startDate = isValidDate(args.startDate)
		? args.startDate
		: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
				.toISOString()
				.split("T")[0];
	try {
		const { getComparisonPeriods, cleanDashboardFilters } = await import(
			"@/lib/business-logic/comparison"
		);
		const { getRetentionOverview } = await import(
			"@/lib/services/retention.service"
		);
		const filters = cleanDashboardFilters({
			startDate,
			endDate,
			store: args.store,
			categoryScope: "all",
		} as any);
		const periods = getComparisonPeriods(filters);
		const overview = await getRetentionOverview(sql, periods, filters);
		return {
			success: true,
			data: {
				store: args.store || "All Stores",
				period: { startDate, endDate },
				...overview,
			},
		};
	} catch {
		return {
			success: false,
			error: "Failed to retrieve customer retention data.",
		};
	}
}
