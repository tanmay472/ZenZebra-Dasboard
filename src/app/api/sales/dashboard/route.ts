import { type NextRequest, NextResponse } from "next/server";

import { getCategoryAov, getCategoryBillCuts } from "@/lib/business-logic/aov";
import {
	cleanDashboardFilters,
	getComparisonPeriods,
	getDefaultPeriod,
} from "@/lib/business-logic/comparison";
import { getCustomerIntelligence } from "@/lib/business-logic/customer-intelligence";
import { getPaymentAnalysis } from "@/lib/business-logic/payment-analysis";
import {
	getBrandProfitability,
	getCategoryProfitability,
	getProfitability,
	getSkuProfitability,
	getStoreProfitability,
} from "@/lib/business-logic/profitability";
import { computeRevenueDriver } from "@/lib/business-logic/revenue-driver";
import {
	getBrandPerformance,
	getDailyHealthMetrics,
	getSkuPerformance,
} from "@/lib/business-logic/sales";
import { getStorePerformance } from "@/lib/business-logic/store-performance";
import { sql } from "@/lib/db";
import type { DashboardFilters } from "@/lib/founder/types";
import {
	buildAovExplanation,
	buildBillsExplanation,
} from "@/lib/intelligence/kpi-explanations";
import { generateRootCauseRecommendation } from "@/lib/intelligence/recommendation-rules";
import { buildRootCause } from "@/lib/intelligence/root-cause-engine";
import { getStoreDiagnostics } from "@/lib/intelligence/store-diagnostics";
import {
	getDashboardDataFreshness,
	getLatestTelemetryStatus,
} from "@/lib/repositories/odoo.repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const responseCache = new Map<
	string,
	{ timestamp: number; dataFreshness: string | null; payload: any }
>();

function getDefaultDateRange() {
	const defaults = getDefaultPeriod();
	return {
		startDate: defaults.current.startDate,
		endDate: defaults.current.endDate,
	};
}

export async function GET(req: NextRequest) {
	try {
		const { searchParams } = req.nextUrl;
		const defaults = getDefaultDateRange();
		const filters = cleanDashboardFilters({
			startDate: searchParams.get("startDate") ?? defaults.startDate,
			endDate: searchParams.get("endDate") ?? defaults.endDate,
			store: searchParams.get("store") ?? undefined,
			category: searchParams.get("category") ?? undefined,
			brand: searchParams.get("brand") ?? undefined,
			sku: searchParams.get("sku") ?? undefined,
			categoryScope:
				(searchParams.get(
					"categoryScope",
				) as DashboardFilters["categoryScope"]) ?? "all",
			compareMode:
				(searchParams.get("compareMode") as DashboardFilters["compareMode"]) ??
				undefined,
			compareStartDate: searchParams.get("compareStartDate") ?? undefined,
			compareEndDate: searchParams.get("compareEndDate") ?? undefined,
		} satisfies DashboardFilters);
		const periods = getComparisonPeriods(filters);

		const [telemetry, dataFreshness] = await Promise.all([
			getLatestTelemetryStatus(),
			getDashboardDataFreshness(),
		]);

		const cacheKey = JSON.stringify({ filters, periods });
		const now = Date.now();
		const cached = responseCache.get(cacheKey);
		if (
			cached &&
			now - cached.timestamp < 15000 &&
			cached.dataFreshness === dataFreshness
		) {
			return NextResponse.json(cached.payload, {
				headers: {
					"X-Dashboard-Cache": "HIT",
					"X-Response-Time-Ms": (Date.now() - now).toString(),
				},
			});
		}

		let skuName: string | null = null;
		if (filters.sku) {
			const [skuRow] = await sql`
        SELECT COALESCE(MAX(item_name), ${filters.sku}) AS item_name
        FROM sales_fact_v
        WHERE sku_code ILIKE ${`%${filters.sku}%`} OR item_name ILIKE ${`%${filters.sku}%`}
        LIMIT 1
      `;
			if (skuRow) {
				skuName = skuRow.item_name;
			}
		}

		// storePerformance/storeProfitability are needed both directly by this
		// route AND by getStoreDiagnostics below — each started ONCE as a
		// shared promise and consumed by both, instead of getStoreDiagnostics
		// re-fetching them itself (it used to, doubling this work on every
		// request; see getStoreDiagnostics's doc comment). Deliberately NOT
		// awaited before the main Promise.all: doing so would force all the
		// other, unrelated functions to wait on these two as well, trading
		// one bottleneck for another. Only getStoreDiagnostics's own branch
		// awaits them, so every branch still runs fully concurrently.
		const storePerformancePromise = getStorePerformance(sql, periods, filters);
		const storeProfitabilityPromise = getStoreProfitability(
			sql,
			periods,
			filters,
		);

		const [
			dailyHealthResult,
			storePerformance,
			brandPerformance,
			skuPerformance,
			billCutAnalysis,
			aovAnalysis,
			customerIntelligence,
			paymentAnalysis,
			profitability,
			storeProfitability,
			brandProfitability,
			skuProfitability,
			categoryProfitability,
			storeDiagnostics,
		] = await Promise.all([
			getDailyHealthMetrics(sql, periods, filters),
			storePerformancePromise,
			getBrandPerformance(sql, periods, filters),
			getSkuPerformance(sql, periods, filters),
			getCategoryBillCuts(sql, periods, filters),
			getCategoryAov(sql, periods, filters),
			getCustomerIntelligence(sql, periods, filters),
			getPaymentAnalysis(sql, periods, filters),
			getProfitability(sql, periods, filters),
			storeProfitabilityPromise,
			getBrandProfitability(sql, periods, filters),
			getSkuProfitability(sql, periods, filters),
			getCategoryProfitability(sql, periods, filters),
			(async () => {
				const [perf, profit] = await Promise.all([
					storePerformancePromise,
					storeProfitabilityPromise,
				]);
				return getStoreDiagnostics(sql, periods, filters, perf, profit);
			})(),
		]);

		// Purchase availability drives graceful "Purchase data unavailable" states.
		const hasPurchaseData = profitability.hasPurchase;

		// Estimated profit contribution by payment channel. COGS cannot be tied to a
		// payment method, so profit is allocated proportionally to each channel's
		// revenue share (only when purchase data exists).
		const overallMargin = profitability.marginPercent;
		const paymentAnalysisWithProfit = {
			...paymentAnalysis,
			hasPurchaseData,
			methods: paymentAnalysis.methods.map(
				(m: (typeof paymentAnalysis.methods)[number]) => ({
					...m,
					estimatedProfit:
						hasPurchaseData && overallMargin != null
							? Math.round((m.revenue * overallMargin) / 100)
							: null,
					profitSharePct: hasPurchaseData ? m.revenueSharePct : null,
				}),
			),
		};

		// Merge profit metrics into the store-performance rows the UI already renders.
		const storeProfitByBilledBy = new Map(
			storeProfitability.map((s) => [s.billedBy, s]),
		);

		const revenueDriver = computeRevenueDriver(
			dailyHealthResult.salesKpis.revenue.current,
			dailyHealthResult.salesKpis.revenue.previous,
			dailyHealthResult.salesKpis.billCuts.current,
			dailyHealthResult.salesKpis.billCuts.previous,
		);

		// Root Cause Engine — composes the above (already-computed) outputs into
		// one consistent "why did revenue move" narrative. Pure composition, no
		// new calculations: see src/lib/intelligence/root-cause-engine.ts.
		const rootCause = buildRootCause({
			revenueDriver,
			storeDiagnostics: storeDiagnostics.stores,
			brandPerformance,
			skuPerformance,
			categoryBillCuts: billCutAnalysis,
			categoryAov: aovAnalysis,
			totalBillCuts: dailyHealthResult.salesKpis.billCuts.current,
		});

		// Sprint 2 — Explainable KPI Framework: Bills/AOV explanations and the
		// recommendation line are composed entirely from data already fetched
		// above (customerIntelligence, dailyHealth, billCutAnalysis/aovAnalysis
		// via rootCause.topCategory) — no new queries.
		const recommendation = generateRootCauseRecommendation(rootCause);
		const explanations = {
			bills: buildBillsExplanation({
				revenueDriver,
				dailyHealth: dailyHealthResult.metrics,
				customerIntelligence: {
					repeatCustomers: customerIntelligence.repeatCustomers,
					newCustomers: customerIntelligence.newCustomers,
				},
				storeDiagnostics: storeDiagnostics.stores,
			}),
			aov: buildAovExplanation({
				revenueDriver,
				topCategory: rootCause.topCategory,
				topCustomers: customerIntelligence.topCustomers,
			}),
		};

		const adaptedStorePerformance = storePerformance.map((row) => {
			const profit = storeProfitByBilledBy.get(row.billedBy);
			return {
				storeDisplayName: row.name,
				billedBy: row.billedBy,
				revenue: row.performance.revenue.current,
				revenueGrowth:
					row.performance.revenue.growth === "NEW STORE"
						? 0
						: row.performance.revenue.growth,
				billCuts: row.performance.billCuts.current,
				billCutsGrowth:
					row.performance.billCuts.growth === "NEW STORE"
						? 0
						: row.performance.billCuts.growth,
				units: row.performance.units.current,
				aov: row.performance.aov.current,
				contributionPercent: row.contributionPercent,
				// Profit Intelligence — net sales, net purchase, gross profit, margin %.
				netSales: profit?.netSales ?? row.performance.revenue.current,
				netPurchase: profit?.netPurchase ?? 0,
				grossProfit: profit?.grossProfit ?? row.performance.revenue.current,
				marginPercent: profit?.marginPercent ?? null,
				hasPurchase: profit?.hasPurchase ?? false,
			};
		});

		const payload = {
			success: true,
			data: {
				filters,
				periods,
				comparisonLabel: periods.comparisonLabel,
				skuName,
				dailyHealth: dailyHealthResult.metrics,
				salesKpis: dailyHealthResult.salesKpis,
				aovKpi: dailyHealthResult.aovKpi,
				storePerformance: adaptedStorePerformance,
				brandPerformance,
				skuPerformance,
				billCutAnalysis,
				aovAnalysis,
				customerIntelligence,
				paymentAnalysis: paymentAnalysisWithProfit,
				revenueDriver,
				rootCause: { ...rootCause, recommendation },
				explanations,
				// Profit Intelligence layer
				hasPurchaseData,
				profitability,
				storeProfitability,
				brandProfitability,
				skuProfitability,
				categoryProfitability,
				freshness: telemetry,
			},
		};

		responseCache.set(cacheKey, {
			timestamp: Date.now(),
			dataFreshness,
			payload,
		});

		return NextResponse.json(payload, {
			headers: {
				"X-Dashboard-Cache": "MISS",
				"X-Response-Time-Ms": (Date.now() - now).toString(),
			},
		});
	} catch (error) {
		console.error("Failed to fetch dashboard data:", error);
		return NextResponse.json(
			{
				success: false,
				error:
					error instanceof Error
						? error.message
						: "Failed to fetch dashboard data",
			},
			{ status: 500 },
		);
	}
}
