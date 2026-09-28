import { type NextRequest, NextResponse } from "next/server";
import { getAbcClassification } from "@/lib/repositories/inventory.repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: NextRequest) {
	try {
		const { searchParams } = new URL(request.url);

		const page = Math.max(1, Number(searchParams.get("page")) || 1);
		const pageSize = Math.max(1, Number(searchParams.get("pageSize")) || 25);
		const search = searchParams.get("search") || undefined;
		const store = searchParams.get("store") || undefined;
		const category = searchParams.get("category") || undefined;

		const result = await getAbcClassification({
			page,
			pageSize,
			search,
			store:
				store && store !== "ALL" && store !== "All Stores" ? store : undefined,
			category:
				category && category !== "All Categories" ? category : undefined,
		});

		return NextResponse.json({ success: true, data: result });
	} catch (err: any) {
		console.error("❌ Inventory ABC API Error:", err);
		return NextResponse.json(
			{
				success: false,
				error: err.message || "Failed to load ABC classification",
			},
			{ status: 500 },
		);
	}
}
