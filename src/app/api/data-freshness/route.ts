import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { getLatestTelemetryStatus } from "@/lib/repositories/odoo.repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
	try {
		const [salesResult, syncResult, countsResult, telemetry] =
			await Promise.all([
				sql`SELECT MAX(sale_date) as latest_sale_date FROM sales_fact_v`,
				sql`
				SELECT COALESCE(
					(SELECT MAX(completed_at) FROM sync_telemetry WHERE status = 'success'),
					(SELECT MAX(uploaded_at) FROM upload_batches WHERE status = 'success')
				) as last_uploaded_at
			`,
				sql`
				SELECT COUNT(*)::int AS total_rows,
					COUNT(DISTINCT order_id)::int AS total_bills,
					COALESCE(SUM(net_amount), 0) AS total_revenue
				FROM sales_fact_v
			`,
				getLatestTelemetryStatus(),
			]);

		const latestSaleDate = salesResult[0]?.latest_sale_date || null;
		const lastUploadedAt = syncResult[0]?.last_uploaded_at || null;
		const totalRows = Number(countsResult[0]?.total_rows ?? 0);
		const totalBills = Number(countsResult[0]?.total_bills ?? 0);
		const totalRevenue = Number(countsResult[0]?.total_revenue ?? 0);

		let dataAgeDays = null;
		if (latestSaleDate) {
			const today = new Date();
			today.setHours(0, 0, 0, 0);
			const saleDate = new Date(latestSaleDate);
			saleDate.setHours(0, 0, 0, 0);
			const diffTime = Math.abs(today.getTime() - saleDate.getTime());
			dataAgeDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
		}

		return NextResponse.json({
			success: true,
			data: {
				latestSaleDate,
				lastUploadedAt,
				dataAgeDays,
				totalRows,
				totalBills,
				totalRevenue,
				status: telemetry.overallStatus,
				secondsAgo: telemetry.maxSecondsAgo,
				isStale:
					telemetry.maxSecondsAgo === null || telemetry.maxSecondsAgo > 60,
				entityStatuses: telemetry.entityStatuses,
			},
		});
	} catch (error) {
		console.error("Failed to fetch data freshness:", error);
		return NextResponse.json(
			{ success: false, error: "Failed to fetch data freshness" },
			{ status: 500 },
		);
	}
}
