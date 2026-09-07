import type { NeonQueryFunction } from "@neondatabase/serverless";
import type { ComparisonPeriods } from "@/lib/business-logic/comparison";
import type { StoreProfitabilityRow } from "@/lib/business-logic/profitability";
import { diagnoseStore } from "@/lib/business-logic/store-diagnosis";
import { getStoreForecastsBatch } from "@/lib/business-logic/store-forecast";
import {
	getStoreAovBillsHistory,
	type StorePerformanceRow,
} from "@/lib/business-logic/store-performance";
import type { DashboardFilters } from "@/lib/founder/types";

type FounderSql = NeonQueryFunction<false, false>;

/**
 * Per-store diagnosis + forecast composition, shared by /api/sales/store-overview
 * and /api/sales/dashboard's rootCause field. Extracted verbatim from the logic
 * that used to be inlined only in the store-overview route, so both routes stay
 * on one source of truth instead of re-deriving this twice.
 *
 * Composition only — every calculation (getStorePerformance, getStoreAovBillsHistory,
 * diagnoseStore, getStoreForecast, getStoreProfitability) is untouched business logic.
 *
 * `performances` and `storeProfitability` are taken as PARAMETERS, computed
 * once by the caller (e.g. the dashboard route already calls
 * getStorePerformance/getStoreProfitability directly) — this function used
 * to re-fetch both itself, doubling that work on every dashboard request. A
 * forensic performance audit measured this function at ~5.5s, dominated by
 * a per-store forecast loop (~3-4 Neon round trips x N stores) plus this
 * duplicate computation; the forecast loop is now one batched call
 * (getStoreForecastsBatch) instead of N individual ones. No formula changed.
 */
export async function getStoreDiagnostics(
	db: FounderSql,
	periods: ComparisonPeriods,
	filters: DashboardFilters,
	performances: StorePerformanceRow[],
	storeProfitability: StoreProfitabilityRow[],
) {
	const profitByBilledBy = new Map(
		storeProfitability.map((s) => [s.billedBy, s]),
	);

	const aovBillsHistory = await getStoreAovBillsHistory(db, periods, filters);

	const billedByList = performances.map((perf) => perf.billedBy);
	const forecastByStore = await getStoreForecastsBatch(
		db,
		filters,
		billedByList,
	);

	const stores = performances.map((perf) => {
		const forecast = forecastByStore.get(perf.billedBy) ?? {
			workingDaysPassed: 0,
			remainingWorkingDays: 0,
			runRate: 0,
			expectedClosing: null,
			previousMonthClosing: 0,
			growthVsPrevMonth: null,
			confidence: "LOW" as const,
			reason: "No data",
		};
		const diagnosis = diagnoseStore(
			perf.performance.revenue.growth,
			perf.performance.billCuts.growth,
			perf.performance.aov.growth,
		);

		const history = aovBillsHistory.find(
			(h: any) => h.billedBy === perf.billedBy,
		) || {
			periods: [],
			diagnosis: {
				type: "STABLE",
				owner: "STORE_OPS",
				message: "",
				affectedCategories: [],
			},
			momentum: { billCutsTrend: "stable", aovTrend: "stable" },
			revenueDriver: "",
		};

		const profit = profitByBilledBy.get(perf.billedBy);

		return {
			name: perf.name,
			billedBy: perf.billedBy,
			// Profit Intelligence — net sales / net purchase / gross profit / margin %
			netSales: profit?.netSales ?? perf.performance.revenue.current,
			netPurchase: profit?.netPurchase ?? 0,
			grossProfit: profit?.grossProfit ?? perf.performance.revenue.current,
			marginPercent: profit?.marginPercent ?? null,
			hasPurchase: profit?.hasPurchase ?? false,
			// Flattened metrics for the final production schema
			currentRevenue: perf.performance.revenue.current,
			previousRevenue: perf.performance.revenue.previous,
			growth:
				perf.performance.revenue.growth === "NEW STORE"
					? 0
					: perf.performance.revenue.growth,
			currentBills: perf.performance.billCuts.current,
			previousBills: perf.performance.billCuts.previous,
			aovCurrent: perf.performance.aov.current,
			aovPrevious: perf.performance.aov.previous,
			// Preserved nested keys for backwards compatibility
			performance: perf.performance,
			contributionPercent: perf.contributionPercent,
			forecast: {
				workingDaysPassed: forecast.workingDaysPassed,
				remainingWorkingDays: forecast.remainingWorkingDays,
				runRate: forecast.runRate,
				expectedClosing: forecast.expectedClosing,
				previousMonthClosing: forecast.previousMonthClosing,
				growthVsPrevMonth: forecast.growthVsPrevMonth,
				confidence: forecast.confidence,
				reason: forecast.reason,
			},
			diagnosis: {
				type: diagnosis.type,
				owner: diagnosis.owner,
				message: diagnosis.message,
				priority: diagnosis.priority,
			},
			aovBills: {
				periods: history.periods,
				diagnosis: history.diagnosis,
				momentum: history.momentum,
				revenueDriver: history.revenueDriver,
			},
		};
	});

	return {
		hasPurchaseData: storeProfitability.some((s) => s.hasPurchase),
		stores,
	};
}

export type StoreDiagnosticsResult = Awaited<
	ReturnType<typeof getStoreDiagnostics>
>;
export type StoreDiagnosticRow = StoreDiagnosticsResult["stores"][number];
