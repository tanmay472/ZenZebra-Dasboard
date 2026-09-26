import { type NextRequest, NextResponse } from "next/server";
import {
	cleanDashboardFilters,
	getComparisonPeriods,
	getDefaultPeriod,
} from "@/lib/business-logic/comparison";
import { getCustomerIntelligence } from "@/lib/business-logic/customer-intelligence";
import { FOOD_CATEGORIES } from "@/lib/business-logic/filter-sql";
import { METRICS } from "@/lib/business-logic/metrics";
import {
	getDailyHealthMetrics,
	getSkuPerformance,
} from "@/lib/business-logic/sales";
import { getStorePerformance } from "@/lib/business-logic/store-performance";
import { sql } from "@/lib/db";
import type { DashboardFilters } from "@/lib/founder/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: NextRequest) {
	try {
		const { searchParams } = req.nextUrl;
		const defaults = getDefaultPeriod().current;
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
		const food =
			filters.categoryScope === "retail" ? [...FOOD_CATEGORIES] : null;

		const [health, storePerformance, skuPerformance, customers] =
			await Promise.all([
				getDailyHealthMetrics(sql, periods, filters),
				getStorePerformance(sql, periods, filters),
				getSkuPerformance(sql, periods, filters),
				getCustomerIntelligence(sql, periods, filters),
			]);

		const trendsQueryString = `
      SELECT sale_date::text AS date, COALESCE(${METRICS.revenue},0)::numeric AS revenue,
        ${METRICS.bills}::integer AS orders, COALESCE(SUM(quantity),0)::integer AS units
      FROM sales_fact_v
      WHERE sale_date >= $1::date AND sale_date <= $2::date
        AND ($3::text IS NULL OR billed_by = $3)
        AND ($4::text IS NULL OR category = $4)
        AND ($5::text IS NULL OR brand = $5)
        AND ($6::text IS NULL OR (sku_code ILIKE '%' || $6 || '%' OR item_name ILIKE '%' || $6 || '%'))
        AND ($7::text[] IS NULL OR category <> ALL($7::text[]))
      GROUP BY sale_date ORDER BY sale_date ASC`;

		const recentOrdersQueryString = `
      SELECT id, bill_no, store_display_name, item_name, quantity, net_amount, customer_mobile, sale_date::text AS sale_date
      FROM sales_fact_v
      WHERE sale_date >= $1::date AND sale_date <= $2::date
        AND ($3::text IS NULL OR billed_by = $3)
        AND ($4::text IS NULL OR category = $4)
        AND ($5::text IS NULL OR brand = $5)
        AND ($6::text IS NULL OR (sku_code ILIKE '%' || $6 || '%' OR item_name ILIKE '%' || $6 || '%'))
        AND ($7::text[] IS NULL OR category <> ALL($7::text[]))
      ORDER BY sale_date DESC, id DESC LIMIT 20`;

		const [trendsResult, recentOrdersResult] = await Promise.all([
			(sql as any).query(trendsQueryString, [
				periods.currentStart,
				periods.currentEnd,
				filters.store ?? null,
				filters.category ?? null,
				filters.brand ?? null,
				filters.sku ?? null,
				food ?? null,
			]),
			(sql as any).query(recentOrdersQueryString, [
				periods.currentStart,
				periods.currentEnd,
				filters.store ?? null,
				filters.category ?? null,
				filters.brand ?? null,
				filters.sku ?? null,
				food ?? null,
			]),
		]);

		const adaptedStorePerformance = storePerformance.map((row) => ({
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
		}));

		return NextResponse.json({
			success: true,
			data: {
				filters,
				periods,
				comparisonLabel: periods.comparisonLabel,
				salesKpis: health.salesKpis,
				aovKpi: health.aovKpi,
				storePerformance: adaptedStorePerformance,
				productPerformance: skuPerformance,
				customers: {
					current: customers.totalCustomers,
					previous: customers.previousCustomers,
					growth: customers.customersGrowthPct,
				},
				dailyTrends: trendsResult.map((row: any) => ({
					date: row.date,
					revenue: Number(row.revenue ?? 0),
					orders: Number(row.orders ?? 0),
					units: Number(row.units ?? 0),
					// No per-day profit field: real profit requires a per-day
					// COGS join (see business-logic/margin.ts), not queried
					// here. A prior version fabricated this as revenue * 0.26
					// — removed rather than replaced with another guess. No
					// current UI component consumes this field.
				})),
				recentOrders: recentOrdersResult.map((row: any) => ({
					id: Number(row.id),
					billNo: String(row.bill_no),
					store: String(row.store_display_name),
					productName: String(row.item_name),
					quantity: Number(row.quantity),
					netAmount: Number(row.net_amount),
					customerId: row.customer_mobile
						? String(row.customer_mobile)
						: `CUST-${String(row.id).slice(-4)}`,
					saleDate: String(row.sale_date),
				})),
			},
		});
	} catch (error) {
		console.error("Failed to fetch extended dashboard data:", error);
		return NextResponse.json(
			{
				success: false,
				error: error instanceof Error ? error.message : "Failed",
			},
			{ status: 500 },
		);
	}
}
