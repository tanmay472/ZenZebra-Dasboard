import { type NextRequest, NextResponse } from "next/server";
import { getFinanceSummary } from "@/lib/repositories/finance.repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: NextRequest) {
	try {
		const searchParams = req.nextUrl.searchParams;
		const store = searchParams.get("store");
		const category = searchParams.get("category");
		const brand = searchParams.get("brand");
		const startDate = searchParams.get("startDate");
		const endDate = searchParams.get("endDate");

		const filters = {
			store: store && store !== "All Stores" ? store : undefined,
			category:
				category && category !== "All Categories" ? category : undefined,
			brand: brand && brand !== "All Brands" ? brand : undefined,
			startDate: startDate || undefined,
			endDate: endDate || undefined,
		};

		const summary = await getFinanceSummary(filters);
		return NextResponse.json({ success: true, data: summary });
	} catch (err: any) {
		console.error("Failed to fetch finance summary:", err);
		return NextResponse.json(
			{
				success: false,
				error: err.message || "Failed to fetch finance summary",
			},
			{ status: 500 },
		);
	}
}
