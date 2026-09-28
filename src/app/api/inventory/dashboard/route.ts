import { type NextRequest, NextResponse } from "next/server";
import {
	getExecutiveInventoryMetrics,
	getFastSlowMovingProducts,
	getStockAgingDistribution,
	getStoreInventoryBreakdown,
} from "@/lib/repositories/inventory.repository";

const responseCache = new Map<string, { timestamp: number; payload: any }>();

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: NextRequest) {
	const startTime = Date.now();

	try {
		const searchParams = req.nextUrl.searchParams;
		const store = searchParams.get("store");
		const category = searchParams.get("category");
		const brand = searchParams.get("brand");
		const sku = searchParams.get("sku");

		const filters = {
			store: store && store !== "All Stores" ? store : undefined,
			category:
				category && category !== "All Categories" ? category : undefined,
			brand: brand && brand !== "All Brands" ? brand : undefined,
			sku: sku || undefined,
		};

		const cacheKey = JSON.stringify(filters);
		const cached = responseCache.get(cacheKey);
		const now = Date.now();
		if (cached && now - cached.timestamp < 15000) {
			return NextResponse.json(cached.payload, {
				headers: {
					"X-Dashboard-Cache": "HIT",
					"X-Response-Time-Ms": (now - startTime).toString(),
				},
			});
		}

		const [overview, storeBreakdown, fastSlow, stockAging] = await Promise.all([
			getExecutiveInventoryMetrics(filters),
			getStoreInventoryBreakdown(filters),
			getFastSlowMovingProducts(filters),
			getStockAgingDistribution(filters),
		]);

		const queryLatencyMs = Date.now() - startTime;
		const payload = {
			success: true,
			data: {
				overview,
				storeBreakdown,
				fastMoving: fastSlow.fastMoving,
				slowMoving: fastSlow.slowMoving,
				stockAging,
				performance: {
					queryLatencyMs,
					dataFreshness: "2-5s (Odoo SaaS Live Sync)",
				},
			},
		};

		responseCache.set(cacheKey, { timestamp: now, payload });

		return NextResponse.json(payload, {
			headers: {
				"X-Dashboard-Cache": "MISS",
				"X-Response-Time-Ms": queryLatencyMs.toString(),
			},
		});
	} catch (err: any) {
		console.error("❌ Inventory Dashboard API Error:", err);
		return NextResponse.json(
			{
				success: false,
				error: err.message || "Failed to load inventory dashboard metrics",
			},
			{ status: 500 },
		);
	}
}
