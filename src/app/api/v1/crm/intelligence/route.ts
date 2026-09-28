import type { NextRequest } from "next/server";
import { getCrmIntelligence } from "@/features/crm/services/crm.service";
import { createApiErrorResponse, createApiResponse } from "@/lib/api/response";
import { logger } from "@/lib/observability/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(_req: NextRequest) {
	const { requestId, startTime } = logger.startRequest(
		"GET",
		"/api/v1/crm/intelligence",
	);

	try {
		const data = await getCrmIntelligence();

		logger.logApiPerformance({
			requestId,
			method: "GET",
			path: "/api/v1/crm/intelligence",
			durationMs: performance.now() - startTime,
			status: 200,
		});

		return createApiResponse(data, { requestId, startTime });
	} catch (err: any) {
		logger.logApiPerformance({
			requestId,
			method: "GET",
			path: "/api/v1/crm/intelligence",
			durationMs: performance.now() - startTime,
			status: 500,
			error: err.message,
		});

		return createApiErrorResponse(
			err.message || "Failed to fetch CRM intelligence",
			{
				requestId,
				startTime,
			},
		);
	}
}
