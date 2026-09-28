import { type NextRequest, NextResponse } from "next/server";
import {
	getItemVelocityPaged,
	type ItemVelocityPagedParams,
} from "@/lib/repositories/inventory.repository";

const ALLOWED_SORT_BY = new Set(["sales", "velocity", "soh", "name"]);
const ALLOWED_SORT_DIR = new Set(["asc", "desc"]);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: NextRequest) {
	try {
		const { searchParams } = new URL(request.url);

		const page = Math.max(1, Number(searchParams.get("page")) || 1);
		const pageSize = Math.max(1, Number(searchParams.get("pageSize")) || 25);

		const sortByRaw = searchParams.get("sortBy") || "sales";
		const sortBy = (
			ALLOWED_SORT_BY.has(sortByRaw) ? sortByRaw : "sales"
		) as ItemVelocityPagedParams["sortBy"];

		const sortDirRaw = searchParams.get("sortDir") || "desc";
		const sortDir = (
			ALLOWED_SORT_DIR.has(sortDirRaw) ? sortDirRaw : "desc"
		) as ItemVelocityPagedParams["sortDir"];

		const search = searchParams.get("search") || undefined;
		const store = searchParams.get("store") || undefined;
		const category = searchParams.get("category") || undefined;
		const brand = searchParams.get("brand") || undefined;

		const result = await getItemVelocityPaged({
			page,
			pageSize,
			sortBy,
			sortDir,
			search,
			store:
				store && store !== "ALL" && store !== "All Stores" ? store : undefined,
			category:
				category && category !== "All Categories" ? category : undefined,
			brand: brand && brand !== "All Brands" ? brand : undefined,
		});

		return NextResponse.json({ success: true, data: result });
	} catch (err: any) {
		console.error("❌ Inventory Velocity API Error:", err);
		return NextResponse.json(
			{
				success: false,
				error: err.message || "Failed to load inventory velocity list",
			},
			{ status: 500 },
		);
	}
}
