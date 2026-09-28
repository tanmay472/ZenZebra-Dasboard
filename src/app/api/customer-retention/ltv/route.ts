import { type NextRequest, NextResponse } from "next/server";
import {
	cleanDashboardFilters,
	getComparisonPeriods,
	getDefaultPeriod,
} from "@/lib/business-logic/comparison";
import { sql } from "@/lib/db";
import type { DashboardFilters } from "@/lib/founder/types";
import {
	getLtvAovCacTrend,
	getLtvDistribution,
	getTopCustomers,
} from "@/lib/services/ltv.service";
import { getRetentionOverview } from "@/lib/services/retention.service";

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
			categoryScope:
				(searchParams.get(
					"categoryScope",
				) as DashboardFilters["categoryScope"]) ?? "all",
		} as DashboardFilters);
		const periods = getComparisonPeriods(filters);

		const distribution = await getLtvDistribution(sql, filters);
		const topCustomers = await getTopCustomers(sql, filters);
		const overview = await getRetentionOverview(sql, periods, filters);
		const trend = await getLtvAovCacTrend(sql, filters);

		return NextResponse.json({
			success: true,
			data: {
				distribution,
				topCustomers,
				overview,
				trend,
			},
		});
	} catch (error) {
		console.error("Failed to fetch LTV analytics:", error);
		return NextResponse.json(
			{
				success: false,
				error: error instanceof Error ? error.message : "Failed",
			},
			{ status: 500 },
		);
	}
}
