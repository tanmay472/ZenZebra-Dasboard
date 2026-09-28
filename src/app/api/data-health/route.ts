import { type NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(_req: NextRequest) {
	try {
		// 1. Total rows in sales_fact_v (blends legacy Excel + live Odoo)
		const totalRowsResult = await sql`
			SELECT COUNT(*)::int as count FROM sales_fact_v
		`;
		const totalRows = totalRowsResult[0]?.count || 0;

		// 2. Date range
		const dateRangeResult = await sql`
			SELECT MIN(sale_date) as start_date, MAX(sale_date) as end_date FROM sales_fact_v
		`;
		const rawStart = dateRangeResult[0]?.start_date;
		const rawEnd = dateRangeResult[0]?.end_date;

		const formatDbDate = (dVal: any): string | null => {
			if (!dVal) return null;
			if (dVal instanceof Date) {
				return dVal.toISOString().split("T")[0];
			}
			if (typeof dVal === "string") {
				return dVal.split("T")[0];
			}
			return String(dVal);
		};

		const start = formatDbDate(rawStart);
		const end = formatDbDate(rawEnd);

		// 3. Stores detected (canonical and total rows)
		const storesResult = await sql`
			SELECT billed_by as name, COUNT(*)::int as count 
			FROM sales_fact_v 
			GROUP BY billed_by 
			ORDER BY count DESC
		`;

		// 4. Latest upload batch
		const latestUploadResult = await sql`
			SELECT filename, uploaded_at, row_count as "rowCount"
			FROM upload_batches
			ORDER BY uploaded_at DESC
			LIMIT 1
		`;
		const latestUpload = latestUploadResult[0] || null;

		// 5. Missing dates (calculated in TS for robustness)
		const activeDatesResult = await sql`
			SELECT DISTINCT sale_date FROM sales_fact_v ORDER BY sale_date
		`;
		const activeDates = new Set(
			activeDatesResult.map((r: any) => formatDbDate(r.sale_date) || ""),
		);

		const missingDates: string[] = [];
		if (start && end) {
			const curr = new Date(start);
			const stop = new Date(end);
			// Security limit: do not infinite loop
			let safetyCounter = 0;
			while (curr <= stop && safetyCounter < 5000) {
				safetyCounter++;
				const y = curr.getFullYear();
				const m = String(curr.getMonth() + 1).padStart(2, "0");
				const d = String(curr.getDate()).padStart(2, "0");
				const dateStr = `${y}-${m}-${d}`;
				if (!activeDates.has(dateStr)) {
					missingDates.push(dateStr);
				}
				curr.setDate(curr.getDate() + 1);
			}
		}

		// 6. Duplicate bills (same bill_no, same sale_date, but different stores)
		const duplicateBillsResult = await sql`
			SELECT COUNT(*)::int as count FROM (
				SELECT sale_date, bill_no 
				FROM sales_fact_v 
				GROUP BY sale_date, bill_no 
				HAVING COUNT(DISTINCT billed_by) > 1
			) t
		`;
		const duplicateBillsCount = duplicateBillsResult[0]?.count || 0;

		// 7. Unattributed stores (billed_by values that are empty or null)
		const invalidStoresResult = await sql`
			SELECT billed_by as name, COUNT(*)::int as count
			FROM sales_fact_v
			WHERE billed_by IS NULL OR billed_by = ''
			GROUP BY billed_by
		`;
		const invalidStores = invalidStoresResult.map((r: any) => ({
			name: r.name || "Unknown",
			count: r.count,
		}));
		const invalidStoresCount = invalidStores.reduce(
			(sum: number, store: any) => sum + store.count,
			0,
		);

		// Overall database health status
		const isHealthy =
			totalRows > 0 &&
			invalidStoresCount === 0 &&
			duplicateBillsCount === 0 &&
			missingDates.length === 0;

		return NextResponse.json({
			success: true,
			data: {
				isHealthy,
				totalRows,
				dateRange: { start, end },
				storesDetected: storesResult,
				latestUpload,
				missingDatesCount: missingDates.length,
				missingDates: missingDates.slice(0, 50), // Cap output to avoid huge arrays
				duplicateBillsCount,
				invalidStoresCount,
				invalidStores,
			},
		});
	} catch (error) {
		console.error("GET /api/data-health failed:", error);
		return NextResponse.json(
			{
				success: false,
				error:
					error instanceof Error
						? error.message
						: "Failed to perform database health check",
			},
			{ status: 500 },
		);
	}
}
