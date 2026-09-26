import { type NextRequest, NextResponse } from "next/server";
import {
	createCrmLead,
	getCrmLeads,
	updateCrmLeadStage,
} from "@/lib/repositories/crm.repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: NextRequest) {
	try {
		const searchParams = req.nextUrl.searchParams;
		const stage = searchParams.get("stage") || undefined;
		const rawStore = searchParams.get("store");
		const store =
			rawStore && rawStore !== "All Stores" && rawStore !== "all"
				? rawStore
				: undefined;
		const search = searchParams.get("search") || undefined;

		const leads = await getCrmLeads({ stage, store, search });
		return NextResponse.json({ success: true, data: leads });
	} catch (err: any) {
		return NextResponse.json(
			{ success: false, error: err.message || "Failed to fetch leads" },
			{ status: 500 },
		);
	}
}

export async function POST(req: NextRequest) {
	try {
		const body = await req.json();
		const {
			name,
			partnerName,
			email,
			phone,
			stage,
			expectedRevenue,
			probability,
			store,
			salesperson,
			notes,
		} = body;

		if (!name) {
			return NextResponse.json(
				{ success: false, error: "Lead name is required" },
				{ status: 400 },
			);
		}

		const newLead = await createCrmLead({
			name,
			partnerName,
			email,
			phone,
			stage,
			expectedRevenue: Number(expectedRevenue || 0),
			probability: Number(probability || 20),
			store,
			salesperson,
			notes,
		});

		if (!newLead) {
			return NextResponse.json(
				{ success: false, error: "Failed to insert lead into database" },
				{ status: 500 },
			);
		}

		return NextResponse.json({ success: true, data: newLead });
	} catch (err: any) {
		return NextResponse.json(
			{ success: false, error: err.message || "Failed to create lead" },
			{ status: 500 },
		);
	}
}

export async function PATCH(req: NextRequest) {
	try {
		const body = await req.json();
		const { id, stage } = body;

		if (!id || !stage) {
			return NextResponse.json(
				{ success: false, error: "Both lead id and stage are required" },
				{ status: 400 },
			);
		}

		const success = await updateCrmLeadStage(Number(id), stage);
		if (!success) {
			return NextResponse.json(
				{ success: false, error: "Failed to update stage in DB" },
				{ status: 500 },
			);
		}

		return NextResponse.json({
			success: true,
			message: `Lead ${id} updated to ${stage}`,
		});
	} catch (err: any) {
		return NextResponse.json(
			{ success: false, error: err.message || "Failed to update lead" },
			{ status: 500 },
		);
	}
}
