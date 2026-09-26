import { type NextRequest, NextResponse } from "next/server";
import {
	cleanDashboardFilters,
	getDefaultPeriod,
} from "@/lib/business-logic/comparison";
import { sql } from "@/lib/db";
import type { DashboardFilters } from "@/lib/founder/types";
import { getCacReportData } from "@/lib/services/cac.service";
import { getLtvReportData, getTopCustomers } from "@/lib/services/ltv.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: NextRequest) {
	try {
		const { searchParams } = req.nextUrl;
		const defaults = getDefaultPeriod().current;

		const store = searchParams.get("store") || null;
		const storeParam = store === "ALL" ? undefined : store || undefined;

		const filters = cleanDashboardFilters({
			startDate: searchParams.get("startDate") ?? defaults.startDate,
			endDate: searchParams.get("endDate") ?? defaults.endDate,
			store: storeParam,
			categoryScope: "all",
		} as DashboardFilters);

		// Fetch metric reports sequentially to prevent Neon socket exhaustion
		const ltvData = await getLtvReportData(filters.store ?? null);
		const cacData = await getCacReportData(
			sql,
			filters.startDate,
			filters.endDate,
			filters.store ?? null,
		);
		const topCustomers = await getTopCustomers(sql, filters);

		return NextResponse.json({
			success: true,
			data: {
				ltvData,
				cacData,
				topCustomers,
			},
		});
	} catch (error) {
		console.error("Failed to fetch LTV-CAC-AOV metrics:", error);
		return NextResponse.json(
			{
				success: false,
				error: error instanceof Error ? error.message : "Failed",
			},
			{ status: 500 },
		);
	}
}
