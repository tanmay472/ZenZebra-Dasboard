import { unstable_cache } from "next/cache";
import { type NextRequest, NextResponse } from "next/server";

import {
	cleanDashboardFilters,
	getComparisonPeriods,
	getDefaultPeriod,
} from "@/lib/business-logic/comparison";
import { getCustomerConcentration } from "@/lib/business-logic/customer-concentration";
import { getIdentityConfidence } from "@/lib/business-logic/customer-identity-confidence";
import { buildCustomerInsights } from "@/lib/business-logic/customer-insights";
import { shouldUseCustomerMv } from "@/lib/business-logic/customer-mv";
import {
	computeRevenueQualityScore,
	headlineMonth1Retention,
} from "@/lib/business-logic/customer-quality-score";
import { getRetentionCohort } from "@/lib/business-logic/customer-retention-cohort";
import { getRevenueComposition } from "@/lib/business-logic/customer-revenue-composition";
import { getValueDistribution } from "@/lib/business-logic/customer-value-distribution";
import { combine } from "@/lib/business-logic/reconciliation";
import { safeDiv } from "@/lib/business-logic/safe-math";
import { CUSTOMER_INTELLIGENCE_TAG } from "@/lib/cache-tags";
import { sql } from "@/lib/db";
import type { DashboardFilters } from "@/lib/founder/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

function getDefaultDateRange() {
	const defaults = getDefaultPeriod();
	return {
		startDate: defaults.current.startDate,
		endDate: defaults.current.endDate,
	};
}

/** Analytics tolerate short staleness; uploads invalidate via the tag. */
const CACHE_TTL_SECONDS = 300;

/**
 * Heavy compute for one filter set — memoised for 5 minutes and tagged so a new
 * upload invalidates it. Keyed by the serialized cleaned filters. Business logic
 * only; the live-SQL engines remain the source of truth (verified by the harness).
 */
async function computeCustomerIntelligence(filtersJson: string) {
	const filters = JSON.parse(filtersJson) as DashboardFilters;
	const periods = getComparisonPeriods(filters);

	// Lifetime engines may read the materialized layer only in the proven-parity
	// range (no cat/brand/sku filter, as-of-latest). Otherwise they scan live.
	const useMv = await shouldUseCustomerMv(sql, filters, periods.currentEnd);

	const [
		retentionCohort,
		revenueComposition,
		valueDistribution,
		identityConfidence,
		concentration,
	] = await Promise.all([
		getRetentionCohort(sql, periods, filters),
		getRevenueComposition(sql, periods, filters),
		getValueDistribution(sql, periods, filters, useMv),
		getIdentityConfidence(sql, periods, filters),
		getCustomerConcentration(sql, periods, filters, useMv),
	]);

	// Derived (pure) intelligence built from the query results above.
	const month1RetentionPct = headlineMonth1Retention(
		retentionCohort,
		periods.currentEnd,
	);
	const repeatCard = revenueComposition.cards.find((c) => c.key === "repeat");
	const newCard = revenueComposition.cards.find((c) => c.key === "new");
	const anonCard = revenueComposition.cards.find((c) => c.key === "anonymous");
	const lifetimeLtv = Math.round(
		safeDiv(
			valueDistribution.totals.revenue,
			valueDistribution.totals.customers,
		),
	);

	const qualityScore = computeRevenueQualityScore({
		repeatRevenuePct: repeatCard?.revenuePct ?? 0,
		newRevenuePct: newCard?.revenuePct ?? 0,
		anonymousRevenuePct: anonCard?.revenuePct ?? 0,
		month1RetentionPct,
		aov: revenueComposition.totals.aov,
		ltv: lifetimeLtv,
	});

	const insights = buildCustomerInsights({
		composition: revenueComposition,
		distribution: valueDistribution,
		concentration,
		month1RetentionPct,
	});

	const reconciliation = combine([
		revenueComposition.reconciliation,
		valueDistribution.reconciliation,
	]);

	return {
		filters,
		periods,
		comparisonLabel: periods.comparisonLabel,
		retentionCohort,
		revenueComposition,
		valueDistribution,
		identityConfidence,
		concentration,
		qualityScore,
		insights,
		reconciliation,
	};
}

const buildCustomerIntelligence = unstable_cache(
	computeCustomerIntelligence,
	[CUSTOMER_INTELLIGENCE_TAG],
	{ revalidate: CACHE_TTL_SECONDS, tags: [CUSTOMER_INTELLIGENCE_TAG] },
);

/**
 * Customer Intelligence API — dedicated endpoint (does not overload sales routes).
 * Returns retention cohort, revenue composition, value distribution, identity
 * confidence, concentration, quality score, insights, and reconciliation.
 * Orchestration only; all logic lives in the business layer.
 */
export async function GET(req: NextRequest) {
	try {
		const { searchParams } = req.nextUrl;
		const defaults = getDefaultDateRange();

		const filters = cleanDashboardFilters({
			startDate: searchParams.get("startDate") ?? defaults.startDate,
			endDate: searchParams.get("endDate") ?? defaults.endDate,
			store: searchParams.get("store") ?? undefined,
			category: searchParams.get("category") ?? undefined,
			brand: searchParams.get("brand") ?? undefined,
			sku: searchParams.get("sku") ?? undefined,
			categoryScope:
				(searchParams.get(
					"categoryScope",
				) as DashboardFilters["categoryScope"]) ?? "all",
			compareMode:
				(searchParams.get("compareMode") as DashboardFilters["compareMode"]) ??
				undefined,
			compareStartDate: searchParams.get("compareStartDate") ?? undefined,
			compareEndDate: searchParams.get("compareEndDate") ?? undefined,
		} satisfies DashboardFilters);

		let data: Awaited<ReturnType<typeof computeCustomerIntelligence>>;
		try {
			data = await buildCustomerIntelligence(JSON.stringify(filters));
		} catch (cacheErr: unknown) {
			const errMsg =
				cacheErr instanceof Error ? cacheErr.message : String(cacheErr);
			if (
				errMsg.includes("incrementalCache missing") ||
				errMsg.includes("Invariant")
			) {
				data = await computeCustomerIntelligence(JSON.stringify(filters));
			} else {
				throw cacheErr;
			}
		}

		return NextResponse.json({ success: true, data });
	} catch (error) {
		console.error("Failed to fetch customer intelligence data:", error);
		return NextResponse.json(
			{
				success: false,
				error:
					error instanceof Error
						? error.message
						: "Failed to fetch customer intelligence data",
			},
			{ status: 500 },
		);
	}
}
