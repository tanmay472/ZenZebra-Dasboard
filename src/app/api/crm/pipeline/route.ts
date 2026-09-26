import { type NextRequest, NextResponse } from "next/server";
import {
	getCrmLeads,
	getCrmPipelineSummary,
} from "@/lib/repositories/crm.repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: NextRequest) {
	try {
		const searchParams = req.nextUrl.searchParams;
		const store = searchParams.get("store") || undefined;
		const search = searchParams.get("search") || undefined;

		const [summary, leads] = await Promise.all([
			getCrmPipelineSummary({ store }),
			getCrmLeads({ store, search }),
		]);

		return NextResponse.json({
			success: true,
			data: {
				summary,
				leads,
			},
		});
	} catch (err: any) {
		console.error("Failed to fetch CRM pipeline data:", err);
		return NextResponse.json(
			{
				success: false,
				error: err.message || "Failed to fetch CRM pipeline data",
			},
			{ status: 500 },
		);
	}
}
