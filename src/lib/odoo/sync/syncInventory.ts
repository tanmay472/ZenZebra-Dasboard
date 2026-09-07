import {
	type OdooInventory,
	upsertInventory,
} from "../../repositories/odoo.repository";
import { getKnownLocationIds } from "../../repositories/odoo-dimensions.repository";
import { formatDateTimeForOdoo, type OdooClient } from "../client";
import { syncLocationDimension } from "./syncDimensions";

/**
 * Synchronizes current stock levels (stock.quant) from Odoo.
 *
 * Incremental via write_date >= lastSyncTime, same pattern as syncSales —
 * this used to do a full stock.quant table scan on EVERY poll cycle
 * (no lastSyncTime filter at all), which for a catalog of a few thousand
 * SKUs took minutes per cycle and, since inventory is HIGH priority and
 * queued ahead of sales_orders, pushed every new sale's DB arrival back by
 * however long that full scan took — the measured root cause of new orders
 * landing in Neon several minutes after being placed in Odoo, not a
 * webhook/cache issue.
 */
export async function syncInventory(
	client: OdooClient,
	lastSyncTime: string | null,
): Promise<number> {
	console.log("[syncInventory] Starting stock levels sync...");

	const fields = [
		"product_id",
		"location_id",
		"quantity",
		"reserved_quantity",
		"write_date",
	];

	// Filter to check only internal stock locations (e.g. usage = 'internal')
	// To be safe and compatible with all Odoo setups, we query all stock.quant,
	// but restrict to internal locations if we know the domain. For a general POC,
	// checking location_id.usage = 'internal' is standard in Odoo.
	const domain: any[] = [["location_id.usage", "=", "internal"]];

	// Same 10-minute safety lookback as syncSales — covers clock skew and any
	// write that lands just before the last recorded watermark.
	const LOOKBACK_MS = 10 * 60 * 1000;
	const effectiveLastSync = lastSyncTime
		? new Date(
				Math.max(0, new Date(lastSyncTime).getTime() - LOOKBACK_MS),
			).toISOString()
		: null;
	if (effectiveLastSync) {
		domain.push(["write_date", ">=", formatDateTimeForOdoo(effectiveLastSync)]);
	}

	let offset = 0;
	const limit = 100;
	let totalUpserted = 0;
	let totalSkippedUnresolved = 0;
	let totalSkippedMissingProduct = 0;
	let totalSkippedDuplicateKey = 0;
	const missingProductIdsSeen = new Set<number>();
	let hasMore = true;

	// fact_inventory.location_id now has a FK to dim_locations (Phase 3) — an
	// unresolved location would otherwise fail the whole batch insert
	// (upsertInventory does one bulk UNNEST statement, not per-row). Resolve
	// against the known set first; on a miss, try ONE dimension refresh per
	// sync run (self-heal for a genuinely new Odoo location) rather than
	// refetching every batch, then fail safe (skip + log) for anything still
	// unresolved instead of guessing or crashing.
	let knownLocationIds = await getKnownLocationIds();
	let attemptedRefresh = false;

	while (hasMore) {
		console.log(
			`[syncInventory] Fetching batch (offset: ${offset}, limit: ${limit})...`,
		);

		let records: any[] = [];
		try {
			records = await client.fetchBatch(
				"stock.quant",
				fields,
				domain,
				"id asc",
				limit,
				offset,
			);
		} catch (err: any) {
			console.warn(
				"[syncInventory] Failed to query stock.quant with location filters. Retrying without the location-usage filter...",
				err.message,
			);
			// Fallback: drop only the usage='internal' clause (in case standard
			// SaaS permissions restrict location field access) — keep the
			// write_date incremental filter so a permission-triggered retry
			// doesn't silently fall back to a full-table scan.
			const fallbackDomain = effectiveLastSync
				? [["write_date", ">=", formatDateTimeForOdoo(effectiveLastSync)]]
				: [];
			records = await client.fetchBatch(
				"stock.quant",
				fields,
				fallbackDomain,
				"id asc",
				limit,
				offset,
			);
		}

		if (records.length === 0) {
			hasMore = false;
			break;
		}

		console.log(`[syncInventory] Processing ${records.length} records...`);
		const mapped = records
			.map((rec: any) => {
				const productId = Array.isArray(rec.product_id)
					? Number(rec.product_id[0])
					: null;
				const locationId = Array.isArray(rec.location_id)
					? Number(rec.location_id[0])
					: null;
				const locationName = Array.isArray(rec.location_id)
					? String(rec.location_id[1])
					: undefined;

				if (!productId || !locationId) return null;

				return {
					productId,
					locationId,
					locationName,
					quantity: Number(rec.quantity || 0),
					reservedQuantity: Number(rec.reserved_quantity || 0),
				};
			})
			.filter((rec) => rec !== null) as OdooInventory[];

		let unresolved = mapped.filter(
			(rec) => !knownLocationIds.has(rec.locationId),
		);
		if (unresolved.length > 0 && !attemptedRefresh) {
			attemptedRefresh = true;
			console.warn(
				`[syncInventory] ${unresolved.length} record(s) reference location(s) not yet in dim_locations — refreshing location dimension once: ${[...new Set(unresolved.map((r) => r.locationId))].join(", ")}`,
			);
			try {
				await syncLocationDimension(client);
				knownLocationIds = await getKnownLocationIds();
				unresolved = mapped.filter(
					(rec) => !knownLocationIds.has(rec.locationId),
				);
			} catch (refreshErr: any) {
				console.warn(
					"[syncInventory] Location dimension refresh failed (non-fatal):",
					refreshErr.message,
				);
			}
		}

		const inventoryToUpsert = mapped.filter((rec) =>
			knownLocationIds.has(rec.locationId),
		);
		if (unresolved.length > 0) {
			totalSkippedUnresolved += unresolved.length;
			console.error(
				`[syncInventory] Skipping ${unresolved.length} record(s) with unresolved location_id (fail-safe, not fabricated): ${[...new Set(unresolved.map((r) => r.locationId))].join(", ")}`,
			);
		}

		const upsertResult = await upsertInventory(inventoryToUpsert);
		totalUpserted += upsertResult.inserted;
		totalSkippedMissingProduct += upsertResult.skippedMissingProduct;
		totalSkippedDuplicateKey += upsertResult.skippedDuplicateKey;
		for (const id of upsertResult.missingProductIds)
			missingProductIdsSeen.add(id);
		if (upsertResult.skippedMissingProduct > 0) {
			console.warn(
				`[syncInventory] Skipped ${upsertResult.skippedMissingProduct} record(s) — product not yet in dim_products (fail-safe, not fabricated). Sample product IDs: ${upsertResult.missingProductIds.slice(0, 20).join(", ")}`,
			);
		}

		if (records.length < limit) {
			hasMore = false;
		} else {
			offset += limit;
		}
	}

	console.log(
		`[syncInventory] Completed. Upserted: ${totalUpserted}. Skipped (unresolved location): ${totalSkippedUnresolved}. Skipped (product not yet synced): ${totalSkippedMissingProduct} (${missingProductIdsSeen.size} distinct products). Skipped (duplicate key in batch): ${totalSkippedDuplicateKey}.`,
	);
	return totalUpserted;
}
