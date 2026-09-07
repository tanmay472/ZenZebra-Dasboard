import type { NeonQueryFunction } from "@neondatabase/serverless";
import type { DashboardFilters } from "@/lib/founder/types";
import { FOOD_CATEGORIES } from "./filter-sql";

type FounderSql = NeonQueryFunction<false, false>;

export interface StoreForecastResult {
	workingDaysPassed: number;
	remainingWorkingDays: number;
	runRate: number;
	expectedClosing: number | null;
	previousMonthClosing: number;
	growthVsPrevMonth: number | "NEW STORE" | null;
	confidence: "HIGH" | "LOW";
	reason: string;
}

function retailFilter(filters: DashboardFilters) {
	return filters.categoryScope === "retail" ? [...FOOD_CATEGORIES] : null;
}

export function computeForecastFromParts(
	completedDays: number,
	remainingDays: number,
	totalDays: number,
	currentMtdRevenue: number,
	previousMonthClosing: number,
	isFirstDayOfMonth: boolean,
): StoreForecastResult {
	if (completedDays === 0 || isFirstDayOfMonth) {
		return {
			workingDaysPassed: 0,
			remainingWorkingDays: totalDays,
			runRate: 0,
			expectedClosing: null,
			previousMonthClosing,
			growthVsPrevMonth: null,
			confidence: "LOW",
			reason: "Insufficient data (New store or first operating day)",
		};
	}

	const runRate = currentMtdRevenue / completedDays;
	const expectedClosing = currentMtdRevenue + runRate * remainingDays;

	let confidence: "HIGH" | "LOW" = "HIGH";
	let reason = "Stable monthly run rate";
	if (completedDays < 7) {
		confidence = "LOW";
		reason = `Based on first ${completedDays} operating days`;
	}

	let growthVsPrevMonth: number | "NEW STORE" | null = null;
	if (previousMonthClosing === 0) {
		growthVsPrevMonth = "NEW STORE";
	} else if (expectedClosing !== null) {
		growthVsPrevMonth =
			Math.round(
				((expectedClosing - previousMonthClosing) / previousMonthClosing) *
					1000,
			) / 10;
	}

	return {
		workingDaysPassed: completedDays,
		remainingWorkingDays: remainingDays,
		runRate: Math.round(runRate * 100) / 100,
		expectedClosing: Math.round(expectedClosing * 100) / 100,
		previousMonthClosing,
		growthVsPrevMonth,
		confidence,
		reason,
	};
}

/**
 * Single-store forecast — kept for any future direct caller, but no longer
 * used by getStoreDiagnostics (see getStoreForecastsBatch below), which
 * previously called this once per store, each doing its own calendar +
 * MTD + previous-month round trips. A forensic performance audit proved
 * the SQL itself is fast (EXPLAIN ANALYZE ~8ms) — the cost was purely the
 * NUMBER of sequential Neon round trips (N stores x ~4 round trips each),
 * not the query plans. Same formulas as the batched version; this is the
 * reference implementation they're both derived from.
 */
export async function getStoreForecast(
	db: FounderSql,
	filters: DashboardFilters,
	billedBy: string,
): Promise<StoreForecastResult> {
	const result = await getStoreForecastsBatch(db, filters, [billedBy]);
	return (
		result.get(billedBy) ?? {
			workingDaysPassed: 0,
			remainingWorkingDays: 0,
			runRate: 0,
			expectedClosing: null,
			previousMonthClosing: 0,
			growthVsPrevMonth: null,
			confidence: "LOW",
			reason: "No data",
		}
	);
}

/**
 * Batched forecast for every store in `billedByList` in one round of
 * grouped queries instead of one query set per store. Store list is
 * always supplied by the caller (discovered dynamically from real
 * performance data, e.g. getStorePerformance's own GROUP BY billed_by
 * result) — never hardcoded here.
 *
 * Preserves the exact formulas from the original per-store
 * getStoreForecast: run rate = MTD revenue / completed working days;
 * expected closing = MTD + run rate * remaining working days; growth vs
 * previous month closing; the same confidence/reason rules; the same
 * store_calendar override lookup with a per-store fallback to standard
 * Mon-Fri counting when a store has no override rows for the month.
 */
export async function getStoreForecastsBatch(
	db: FounderSql,
	filters: DashboardFilters,
	billedByList: string[],
): Promise<Map<string, StoreForecastResult>> {
	const results = new Map<string, StoreForecastResult>();
	if (billedByList.length === 0) return results;

	const foodCategories = retailFilter(filters);
	const currentEnd = filters.endDate;
	const date = new Date(`${currentEnd}T00:00:00.000Z`);
	const year = date.getUTCFullYear();
	const month = date.getUTCMonth();
	const startOfMonth = new Date(Date.UTC(year, month, 1));
	const startOfMonthStr = startOfMonth.toISOString().slice(0, 10);
	const endOfMonth = new Date(Date.UTC(year, month + 1, 0));
	const endOfMonthStr = endOfMonth.toISOString().slice(0, 10);
	const isFirstDayOfMonth =
		new Date(`${currentEnd}T00:00:00.000Z`).getUTCDate() === 1;

	// One query for every store's calendar overrides for the whole month —
	// both the "total" and "completed" day counts are derived from this
	// same fetched set in-memory, instead of two separate per-store queries.
	const overrideRows = await db`
		SELECT billed_by, date::text AS date, is_open
		FROM store_calendar
		WHERE billed_by = ANY(${billedByList}) AND date >= ${startOfMonthStr}::date AND date <= ${endOfMonthStr}::date
	`;
	const overridesByStore = new Map<string, Map<string, boolean>>();
	for (const row of overrideRows) {
		const store = String(row.billed_by);
		if (!overridesByStore.has(store)) overridesByStore.set(store, new Map());
		overridesByStore.get(store)!.set(String(row.date), Boolean(row.is_open));
	}

	function workingDaysWithOverrides(
		startDate: string,
		endDate: string,
		overrides: Map<string, boolean> | undefined,
	): number {
		const start = new Date(`${startDate}T00:00:00.000Z`);
		const end = new Date(`${endDate}T00:00:00.000Z`);
		let workingDays = 0;
		const current = new Date(start);
		while (current <= end) {
			const dateStr = current.toISOString().slice(0, 10);
			const dayOfWeek = current.getUTCDay();
			const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
			if (overrides?.has(dateStr)) {
				if (overrides.get(dateStr) === true) workingDays++;
			} else if (!isWeekend) {
				workingDays++;
			}
			current.setUTCDate(current.getUTCDate() + 1);
		}
		return workingDays;
	}

	const calendarByStore = new Map<
		string,
		{ totalDays: number; completedDays: number; remainingDays: number }
	>();
	for (const billedBy of billedByList) {
		// Preserve the original fallback semantics: a store with zero
		// override rows for the month uses plain Mon-Fri counting (the
		// `overrides` map is simply empty/undefined for it, which
		// workingDaysWithOverrides already treats as "no override").
		const overrides = overridesByStore.get(billedBy);
		const total = workingDaysWithOverrides(
			startOfMonthStr,
			endOfMonthStr,
			overrides,
		);
		let completed = workingDaysWithOverrides(
			startOfMonthStr,
			currentEnd,
			overrides,
		);
		completed = Math.min(completed, total);
		calendarByStore.set(billedBy, {
			totalDays: total,
			completedDays: completed,
			remainingDays: total - completed,
		});
	}

	// One grouped query for MTD revenue across all stores, one for the
	// previous month's closing revenue — replaces N x 2 per-store queries.
	const mtdRows = await db`
		SELECT billed_by, COALESCE(SUM(net_amount), 0) AS revenue
		FROM sales_fact_v
		WHERE sale_date >= date_trunc('month', ${currentEnd}::date)::date
			AND sale_date <= ${currentEnd}::date
			AND billed_by = ANY(${billedByList})
			AND (${filters.category ?? null}::text IS NULL OR category = ${filters.category ?? null})
			AND (${filters.brand ?? null}::text IS NULL OR brand = ${filters.brand ?? null})
			AND (${filters.sku ?? null}::text IS NULL OR (sku_code ILIKE '%' || ${filters.sku ?? null} || '%' OR item_name ILIKE '%' || ${filters.sku ?? null} || '%'))
			AND (${foodCategories ?? null}::text[] IS NULL OR category <> ALL(${foodCategories ?? null}))
		GROUP BY billed_by
	`;
	const mtdByStore = new Map<string, number>(
		mtdRows.map((r) => [String(r.billed_by), Number(r.revenue)]),
	);

	const prevRows = await db`
		SELECT billed_by, COALESCE(SUM(net_amount), 0) AS revenue
		FROM sales_fact_v
		WHERE sale_date >= (date_trunc('month', ${currentEnd}::date) - INTERVAL '1 month')::date
			AND sale_date <= (date_trunc('month', ${currentEnd}::date) - INTERVAL '1 day')::date
			AND billed_by = ANY(${billedByList})
			AND (${filters.category ?? null}::text IS NULL OR category = ${filters.category ?? null})
			AND (${filters.brand ?? null}::text IS NULL OR brand = ${filters.brand ?? null})
			AND (${filters.sku ?? null}::text IS NULL OR (sku_code ILIKE '%' || ${filters.sku ?? null} || '%' OR item_name ILIKE '%' || ${filters.sku ?? null} || '%'))
			AND (${foodCategories ?? null}::text[] IS NULL OR category <> ALL(${foodCategories ?? null}))
		GROUP BY billed_by
	`;
	const prevByStore = new Map<string, number>(
		prevRows.map((r) => [String(r.billed_by), Number(r.revenue)]),
	);

	for (const billedBy of billedByList) {
		const calendar = calendarByStore.get(billedBy)!;
		const currentMtdRevenue = mtdByStore.get(billedBy) ?? 0;
		const previousMonthClosing = prevByStore.get(billedBy) ?? 0;
		results.set(
			billedBy,
			computeForecastFromParts(
				calendar.completedDays,
				calendar.remainingDays,
				calendar.totalDays,
				currentMtdRevenue,
				previousMonthClosing,
				isFirstDayOfMonth,
			),
		);
	}

	return results;
}
