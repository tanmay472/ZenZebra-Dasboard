import { type NextRequest, NextResponse } from "next/server";
import {
	cleanDashboardFilters,
	getDefaultPeriod,
} from "@/lib/business-logic/comparison";
import { sql } from "@/lib/db";
import type { DashboardFilters } from "@/lib/founder/types";
import {
	getBillCutCohorts,
	getCohortMetrics,
} from "@/lib/services/cohort.service";

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
		} as DashboardFilters);

		const customerType = searchParams.get("customerType") ?? "all";
		const billRange = searchParams.get("billRange") ?? "all";

		const cohorts = await getCohortMetrics(sql, {
			...filters,
			customerType,
			billRange,
		});
		const billCuts = await getBillCutCohorts(sql, filters);

		return NextResponse.json({
			success: true,
			data: {
				cohorts,
				billCuts,
			},
		});
	} catch (error) {
		console.error("Failed to fetch cohorts:", error);
		return NextResponse.json(
			{
				success: false,
				error: error instanceof Error ? error.message : "Failed",
			},
			{ status: 500 },
		);
	}
}
