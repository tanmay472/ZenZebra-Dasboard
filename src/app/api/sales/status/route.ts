import { NextResponse } from "next/server";

import { sql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

function emptyStatus() {
	return {
		hasData: false,
		isSeeded: false,
		totalRows: 0,
		minDate: null,
		maxDate: null,
		dateRange: null,
		totalRevenue: 0,
		latestBatch: null,
		availableStores: [],
		availableCategories: [],
		availableBrands: [],
		syncStatus: {
			webhookStatus: "NOT VERIFIED",
			pollingStatus: "NOT VERIFIED",
			primaryMode: "NOT VERIFIED",
			organicWebhookCount: 0,
			lastOrganicWebhookAt: null,
			workerLastSeenSecondsAgo: null,
			workerHostname: null,
		},
	};
}

export async function GET() {
	try {
		const [
			statsResult,
			latestBatchResult,
			storesResult,
			categoriesResult,
			brandsResult,
			freshnessResult,
			categoryBrandMapResult,
			webhookStatsResult,
			workerHeartbeatResult,
		] = await Promise.all([
			sql`
        SELECT COUNT(*) AS total_rows, MIN(sale_date)::text AS min_date, MAX(sale_date)::text AS max_date,
          COALESCE(SUM(net_amount), 0) AS total_revenue
        FROM sales_fact_v
      `,
			sql`
        SELECT
          id,
          filename,
          status,
          row_count AS "rowCount",
          error_count AS "errorCount",
          valid_row_count AS "validRowCount",
          quarantined_row_count AS "quarantinedRowCount",
          date_range_start::text AS "dateRangeStart",
          date_range_end::text AS "dateRangeEnd",
          uploaded_at AS "uploadedAt"
        FROM upload_batches
        ORDER BY uploaded_at DESC
        LIMIT 1
      `,
			sql`SELECT DISTINCT billed_by FROM sales_fact_v ORDER BY billed_by`,
			// Legacy Excel rows and Odoo-synced rows record category/brand text
			// independently, so the same logical value can arrive with different
			// casing/whitespace (e.g. "BEVERAGES" vs "Beverages") — DISTINCT ON
			// a normalized key collapses those to one canonical option per real
			// category, instead of surfacing every raw formatting variant.
			sql`
        SELECT DISTINCT ON (LOWER(TRIM(category))) category
        FROM sales_fact_v
        WHERE category IS NOT NULL AND category <> ''
        ORDER BY LOWER(TRIM(category)), category
      `,
			sql`
        SELECT DISTINCT ON (LOWER(TRIM(brand))) brand
        FROM sales_fact_v
        WHERE brand IS NOT NULL AND brand <> ''
        ORDER BY LOWER(TRIM(brand)), brand
      `,
			sql`SELECT latest_sale_date::text, days_stale, total_bills, total_revenue, last_upload_at::text FROM data_freshness`,
			sql`SELECT DISTINCT category, brand FROM sales_fact_v WHERE category IS NOT NULL AND category <> '' AND brand IS NOT NULL AND brand <> '' ORDER BY category, brand`,
			sql`
				SELECT
					COUNT(*) FILTER (WHERE event_id NOT LIKE 'test_%' AND event_id NOT LIKE 'verify_%' AND received_at > NOW() - INTERVAL '24 hours')::int AS organic_recent_count,
					MAX(received_at) FILTER (WHERE event_id NOT LIKE 'test_%' AND event_id NOT LIKE 'verify_%')::text AS last_organic_received_at,
					COUNT(*) FILTER (WHERE status = 'failed' OR status = 'dead_letter')::int AS webhook_error_count
				FROM webhook_events
			`.catch(() => [
				{
					organic_recent_count: 0,
					last_organic_received_at: null,
					webhook_error_count: 0,
				},
			]),
			sql`
				SELECT worker_id, hostname, state, updated_at::text,
					EXTRACT(EPOCH FROM (NOW() - updated_at))::int AS seconds_ago
				FROM worker_heartbeat
				WHERE worker_id = 'main'
				LIMIT 1
			`.catch(() => []),
		]);

		const stats = statsResult[0] ?? {};
		const totalRows = Number(stats.total_rows ?? 0);

		const webhookStats = webhookStatsResult?.[0] ?? {
			organic_recent_count: 0,
			last_organic_received_at: null,
			webhook_error_count: 0,
		};
		const workerRow = workerHeartbeatResult?.[0];
		const organicWebhookCount = Number(webhookStats.organic_recent_count ?? 0);
		const hasOrganicWebhooks = organicWebhookCount > 0;
		const workerSecondsAgo =
			workerRow?.seconds_ago !== undefined && workerRow?.seconds_ago !== null
				? Number(workerRow.seconds_ago)
				: null;
		const isWorkerAlive = workerSecondsAgo !== null && workerSecondsAgo < 120;
		const isWorkerDelayed =
			workerSecondsAgo !== null &&
			workerSecondsAgo >= 120 &&
			workerSecondsAgo < 600;

		let primaryMode:
			| "WEBHOOK ACTIVE"
			| "POLLING ACTIVE"
			| "DELAYED"
			| "ERROR"
			| "NOT VERIFIED" = "NOT VERIFIED";
		if (hasOrganicWebhooks) {
			primaryMode = "WEBHOOK ACTIVE";
		} else if (isWorkerAlive) {
			const workerState = workerRow?.state as any;
			if (
				workerState &&
				(Number(workerState.consecutiveErrors ?? 0) > 3 ||
					Number(workerState.deadLetterCount ?? 0) > 10)
			) {
				primaryMode = "ERROR";
			} else {
				primaryMode = "POLLING ACTIVE";
			}
		} else if (isWorkerDelayed) {
			primaryMode = "DELAYED";
		} else {
			primaryMode = "NOT VERIFIED";
		}

		const syncStatus = {
			webhookStatus: hasOrganicWebhooks ? "WEBHOOK ACTIVE" : "NOT VERIFIED",
			pollingStatus: isWorkerAlive
				? "POLLING ACTIVE"
				: isWorkerDelayed
					? "DELAYED"
					: "INACTIVE",
			primaryMode,
			organicWebhookCount,
			lastOrganicWebhookAt: webhookStats.last_organic_received_at ?? null,
			workerLastSeenSecondsAgo: workerSecondsAgo,
			workerHostname: workerRow?.hostname ? String(workerRow.hostname) : null,
		};

		// Normalize the same way as the categoriesResult/brandsResult queries
		// above: group by a case/whitespace-insensitive key so "BEVERAGES" and
		// "Beverages" rows merge into one entry, keyed by whichever raw variant
		// sorts first alphabetically (matching the DISTINCT ON canonical pick),
		// with brand values deduped the same way within each category.
		const canonicalLabel = new Map<string, string>();
		const categoryBrandSets = new Map<string, Map<string, string>>();
		for (const row of categoryBrandMapResult || []) {
			const rawCat = String(row.category ?? "");
			const rawBrand = String(row.brand ?? "");
			const catKey = rawCat.trim().toLowerCase();
			const brandKey = rawBrand.trim().toLowerCase();
			if (!catKey || !brandKey) continue;

			const existingCatLabel = canonicalLabel.get(catKey);
			if (!existingCatLabel || rawCat < existingCatLabel) {
				canonicalLabel.set(catKey, rawCat);
			}

			if (!categoryBrandSets.has(catKey))
				categoryBrandSets.set(catKey, new Map());
			const brandsForCat = categoryBrandSets.get(catKey)!;
			const existingBrandLabel = brandsForCat.get(brandKey);
			if (!existingBrandLabel || rawBrand < existingBrandLabel) {
				brandsForCat.set(brandKey, rawBrand);
			}
		}
		const categoryBrandMap: Record<string, string[]> = {};
		for (const [catKey, brandsForCat] of categoryBrandSets) {
			const label = canonicalLabel.get(catKey)!;
			categoryBrandMap[label] = Array.from(brandsForCat.values()).sort();
		}

		return NextResponse.json({
			success: true,
			data: {
				hasData: totalRows > 0,
				isSeeded: totalRows > 0,
				totalRows,
				minDate: stats.min_date ?? null,
				maxDate: stats.max_date ?? null,
				dateRange: {
					start: stats.min_date ?? null,
					end: stats.max_date ?? null,
				},
				totalRevenue: Number(stats.total_revenue ?? 0),
				latestBatch: latestBatchResult[0] ?? null,
				availableStores: storesResult
					.map((row) => row.billed_by)
					.filter(Boolean),
				availableCategories: categoriesResult
					.map((row) => row.category)
					.filter(Boolean),
				availableBrands: brandsResult.map((row) => row.brand).filter(Boolean),
				categoryBrandMap,
				dataFreshness: freshnessResult[0]
					? {
							latestSaleDate: freshnessResult[0].latest_sale_date ?? null,
							daysStale:
								freshnessResult[0].days_stale != null
									? Number(freshnessResult[0].days_stale)
									: null,
							totalBills: Number(freshnessResult[0].total_bills ?? 0),
							totalRevenue: Number(freshnessResult[0].total_revenue ?? 0),
							lastUploadAt: freshnessResult[0].last_upload_at ?? null,
						}
					: undefined,
				syncStatus,
			},
		});
	} catch (error: any) {
		console.warn(
			"Failed to fetch founder status (returning fallback status):",
			error?.message || error,
		);
		return NextResponse.json({
			success: true,
			data: emptyStatus(),
		});
	}
}
