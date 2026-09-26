import type { NextRequest } from "next/server";
import { getCommercialIntelligence } from "@/features/commercial/services/commercial.service";
import { getCrmIntelligence } from "@/features/crm/services/crm.service";
import { createApiErrorResponse, createApiResponse } from "@/lib/api/response";
import { generateFounderActions } from "@/lib/intelligence/action-center";
import { calculateBusinessHealth } from "@/lib/intelligence/health";
import { logger } from "@/lib/observability/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(_req: NextRequest) {
	const { requestId, startTime } = logger.startRequest(
		"GET",
		"/api/v1/founder/overview",
	);

	try {
		const [commercial, crm] = await Promise.all([
			getCommercialIntelligence(),
			getCrmIntelligence(),
		]);

		// repeatPurchaseRate, decliningStoresCount, and pendingProposalsCount
		// have no data source currently wired into this endpoint — omitted
		// rather than fabricated. Both consumers already treat a missing
		// field as "no signal" (undefined-checked), not as zero.
		const businessHealth = calculateBusinessHealth({
			// forecast.growthTrendPercent is `number | null` (null = not enough
			// historical data) — convert to undefined so calculateBusinessHealth's
			// `!== undefined` check correctly excludes it rather than treating
			// `null` as a defined value.
			revenueGrowthPercent: commercial.forecast.growthTrendPercent ?? undefined,
			// crm.summary.winRate is `number | null` (null = no real CRM leads
			// yet) — convert to undefined for the same reason as above.
			closedWonRate: crm.summary.winRate ?? undefined,
		});

		const hotLeads = crm.leads.filter((l: any) => l.leadBadge === "Hot").length;
		const actions = generateFounderActions({
			hotLeadsCount: hotLeads,
		});

		const payload = {
			businessHealth,
			executive: commercial.executive,
			commercial: {
				stores: commercial.stores,
				brands: commercial.brands,
			},
			crm: {
				summary: crm.summary,
				topOpportunities: crm.leads.slice(0, 5),
			},
			recommendations: commercial.recommendations,
			actions,
		};

		logger.logApiPerformance({
			requestId,
			method: "GET",
			path: "/api/v1/founder/overview",
			durationMs: performance.now() - startTime,
			status: 200,
		});

		return createApiResponse(payload, { requestId, startTime });
	} catch (err: any) {
		logger.logApiPerformance({
			requestId,
			method: "GET",
			path: "/api/v1/founder/overview",
			durationMs: performance.now() - startTime,
			status: 500,
			error: err.message,
		});

		return createApiErrorResponse(
			err.message || "Failed to fetch founder overview",
			{
				requestId,
				startTime,
			},
		);
	}
}
