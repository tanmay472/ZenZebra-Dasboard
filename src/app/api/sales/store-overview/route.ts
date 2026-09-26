import { type NextRequest, NextResponse } from "next/server";
import {
	type ComparisonPeriods,
	cleanDashboardFilters,
	formatDateShort,
	getComparisonPeriods,
} from "@/lib/business-logic/comparison";
import { getStoreProfitability } from "@/lib/business-logic/profitability";
import { getStoreCommandDefaultPeriod } from "@/lib/business-logic/store-command-period";
import { getStorePerformance } from "@/lib/business-logic/store-performance";
import { getStoreTrend } from "@/lib/business-logic/store-trend";
import { sql } from "@/lib/db";
import type { DashboardFilters } from "@/lib/founder/types";
import { getStoreDiagnostics } from "@/lib/intelligence/store-diagnostics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

function getPeriodResponseLabel(startDate: string, endDate: string): string {
	const monthsFull = [
		"January",
		"February",
		"March",
		"April",
		"May",
		"June",
		"July",
		"August",
		"September",
		"October",
		"November",
		"December",
	];
	const [sYear, sMonth, sDay] = startDate.split("-");
	const [eYear, eMonth, eDay] = endDate.split("-");

	if (sYear === eYear && sMonth === eMonth) {
		const monthName = monthsFull[parseInt(sMonth, 10) - 1];
		const startDay = parseInt(sDay, 10);
		const endDay = parseInt(eDay, 10);
		return `${monthName} ${sYear} (${startDay}-${endDay})`;
	}

	return `${formatDateShort(startDate)} - ${formatDateShort(endDate)}`;
}

export async function GET(req: NextRequest) {
	try {
		const { searchParams } = req.nextUrl;
		const startParam = searchParams.get("startDate");
		const endParam = searchParams.get("endDate");

		let periods: ComparisonPeriods;
		let periodMode: "default_mtd" | "custom" = "custom";

		if (!startParam || !endParam) {
			const defaultPeriod = getStoreCommandDefaultPeriod();
			periods = {
				currentStart: defaultPeriod.current.startDate,
				currentEnd: defaultPeriod.current.endDate,
				previousStart: defaultPeriod.previous.startDate,
				previousEnd: defaultPeriod.previous.endDate,
				label: `Current: ${formatDateShort(defaultPeriod.current.startDate)} – ${formatDateShort(defaultPeriod.current.endDate)} | Compared: vs ${formatDateShort(defaultPeriod.previous.startDate)} – ${formatDateShort(defaultPeriod.previous.endDate)}`,
				comparisonLabel: `vs ${formatDateShort(defaultPeriod.previous.startDate)} – ${formatDateShort(defaultPeriod.previous.endDate)}`,
			};
			periodMode = "default_mtd";
		} else {
			let startDateVal = startParam;
			let endDateVal = endParam;

			// Clamp future end date to today (India Time)
			const defaultPeriod = getStoreCommandDefaultPeriod();
			const todayStr = defaultPeriod.current.endDate;
			if (endDateVal > todayStr) {
				endDateVal = todayStr;
			}
			if (startDateVal > todayStr) {
				startDateVal = todayStr;
			}

			const tempFilters = {
				startDate: startDateVal,
				endDate: endDateVal,
				compareMode: searchParams.get(
					"compareMode",
				) as DashboardFilters["compareMode"],
				compareStartDate: searchParams.get("compareStartDate") ?? undefined,
				compareEndDate: searchParams.get("compareEndDate") ?? undefined,
			} as DashboardFilters;

			periods = getComparisonPeriods(tempFilters);
		}

		const filters = cleanDashboardFilters({
			startDate: periods.currentStart,
			endDate: periods.currentEnd,
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

		// 1-2. Store performance, profitability, AOV/bills history, forecast, and
		// diagnosis per store — shared with /api/sales/dashboard's rootCause field.
		// getStoreDiagnostics takes performance/profitability as params (computed
		// once here) rather than re-fetching them itself — see that function's
		// doc comment for why (a forensic audit found this was being computed
		// twice per /api/sales/dashboard request).
		const [performances, storeProfitability] = await Promise.all([
			getStorePerformance(sql, periods, filters),
			getStoreProfitability(sql, periods, filters),
		]);
		const { hasPurchaseData, stores: storesData } = await getStoreDiagnostics(
			sql,
			periods,
			filters,
			performances,
			storeProfitability,
		);

		// 3. Get normalized trends
		const trends = await getStoreTrend(sql, filters);

		// Debug log before returning response
		console.log({
			currentPeriod: {
				start: periods.currentStart,
				end: periods.currentEnd,
			},
			previousPeriod: {
				start: periods.previousStart,
				end: periods.previousEnd,
			},
			storesFound: storesData.map((s) => s.name),
		});

		const getPeriodMonthName = (dateStr: string) => {
			const monthsFull = [
				"January",
				"February",
				"March",
				"April",
				"May",
				"June",
				"July",
				"August",
				"September",
				"October",
				"November",
				"December",
			];
			const [, m] = dateStr.split("-");
			return monthsFull[parseInt(m, 10) - 1];
		};

		const formatShortRange = (startStr: string, endStr: string) => {
			const monthsShort = [
				"Jan",
				"Feb",
				"Mar",
				"Apr",
				"May",
				"Jun",
				"Jul",
				"Aug",
				"Sep",
				"Oct",
				"Nov",
				"Dec",
			];
			const sParts = startStr.split("-");
			const eParts = endStr.split("-");
			if (sParts.length !== 3 || eParts.length !== 3)
				return `${startStr} - ${endStr}`;
			const sDay = parseInt(sParts[2], 10);
			const sMonth = monthsShort[parseInt(sParts[1], 10) - 1];
			const eDay = parseInt(eParts[2], 10);
			const eMonth = monthsShort[parseInt(eParts[1], 10) - 1];
			return `${sDay.toString().padStart(2, "0")} ${sMonth} - ${eDay.toString().padStart(2, "0")} ${eMonth}`;
		};

		const context = {
			title:
				periodMode === "default_mtd"
					? `${getPeriodMonthName(periods.currentStart)} ${periods.currentStart.split("-")[0]} MTD vs ${getPeriodMonthName(periods.previousStart)} ${periods.previousStart.split("-")[0]} MTD`
					: `${getPeriodResponseLabel(periods.currentStart, periods.currentEnd)} vs ${getPeriodResponseLabel(periods.previousStart, periods.previousEnd)}`,
			current: formatShortRange(periods.currentStart, periods.currentEnd),
			previous: formatShortRange(periods.previousStart, periods.previousEnd),
		};

		return NextResponse.json({
			success: true,
			data: {
				context,
				period: {
					mode: periodMode,
					current: {
						label: getPeriodResponseLabel(
							periods.currentStart,
							periods.currentEnd,
						),
						start: periods.currentStart,
						end: periods.currentEnd,
					},
					previous: {
						label: getPeriodResponseLabel(
							periods.previousStart,
							periods.previousEnd,
						),
						start: periods.previousStart,
						end: periods.previousEnd,
					},
				},
				comparisonLabel: periods.comparisonLabel,
				hasPurchaseData,
				stores: storesData,
				trends,
			},
		});
	} catch (error) {
		console.error("Store Overview API failed:", error);
		return NextResponse.json(
			{
				success: false,
				error: error instanceof Error ? error.message : "Internal Server Error",
			},
			{ status: 500 },
		);
	}
}
