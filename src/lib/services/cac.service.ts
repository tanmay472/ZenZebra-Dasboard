import type { NeonQueryFunction } from "@neondatabase/serverless";
import {
	type ComparisonPeriods,
	growthPct,
} from "@/lib/business-logic/comparison";
import { FOOD_CATEGORIES } from "@/lib/business-logic/filter-sql";
import type { DashboardFilters } from "@/lib/founder/types";
import { customerRepository } from "@/lib/repositories/customer.repository";

type FounderSql = NeonQueryFunction<false, false>;

function n(v: unknown) {
	return Number.isFinite(Number(v ?? 0)) ? Number(v ?? 0) : 0;
}

function retailFilter(f: DashboardFilters) {
	return f.categoryScope === "retail" ? [...FOOD_CATEGORIES] : null;
}

export async function getCacMetrics(
	db: FounderSql,
	periods: ComparisonPeriods,
	filters: DashboardFilters,
) {
	const food = retailFilter(filters);
	const store = filters.store ?? null;

	const start = new Date(periods.currentStart);
	const end = new Date(periods.currentEnd);
	const days = Math.max(
		1,
		Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1,
	);

	// dim_marketing_spend has no real business data source configured yet —
	// this used to hardcode ₹200,000 / ₹150,000 / ₹50,000 by store name,
	// fabricating CAC/LTV:CAC/payback figures from numbers with no source.
	// "No spend data" must render as unavailable, not an invented spend.
	const targetStore = store || "All Stores";
	let spendRows: Record<string, unknown>[] = [];
	try {
		spendRows = await db`
			SELECT monthly_spend
			FROM dim_marketing_spend
			WHERE store_display_name ILIKE ${`%${targetStore}%`}
			LIMIT 1
		`;
	} catch {
		spendRows = [];
	}
	const hasMarketingSpendData = spendRows.length > 0;
	const monthlySpend = hasMarketingSpendData
		? Number(spendRows[0].monthly_spend)
		: 0;

	const currentSpend = Math.round((monthlySpend / 30) * days);

	const prevStart = new Date(periods.previousStart);
	const prevEnd = new Date(periods.previousEnd);
	const prevDays = Math.max(
		1,
		Math.ceil(
			(prevEnd.getTime() - prevStart.getTime()) / (1000 * 60 * 60 * 24),
		) + 1,
	);
	const prevSpend = Math.round((monthlySpend / 30) * prevDays);

	const newCustomersQuery = `
    SELECT 
      COUNT(DISTINCT sf.customer_mobile)::integer AS count,
      COALESCE(SUM(sf.net_amount), 0)::numeric AS revenue,
      COUNT(DISTINCT sf.order_id)::integer AS orders
    FROM sales_fact_v sf
    JOIN customer_metrics cm ON sf.customer_mobile = cm.customer_mobile
    WHERE cm.first_purchase_date BETWEEN $1::date AND $2::date
      AND ($3::text IS NULL OR sf.billed_by = $3)
      AND ($4::text[] IS NULL OR sf.category <> ALL($4::text[]))
  `;

	const [currNewRes, prevNewRes] = await Promise.all([
		(db as any).query(newCustomersQuery, [
			periods.currentStart,
			periods.currentEnd,
			store,
			food,
		]),
		(db as any).query(newCustomersQuery, [
			periods.previousStart,
			periods.previousEnd,
			store,
			food,
		]),
	]);

	const currNew = Math.max(1, n(currNewRes[0]?.count));
	const prevNew = Math.max(1, n(prevNewRes[0]?.count));

	const currRevenue = n(currNewRes[0]?.revenue);
	const prevRevenue = n(prevNewRes[0]?.revenue);
	const currOrders = n(currNewRes[0]?.orders);

	const currLtv = currNew > 0 ? currRevenue / currNew : 0;
	const prevLtv = prevNew > 0 ? prevRevenue / prevNew : 0;

	const currCac = hasMarketingSpendData ? currentSpend / currNew : null;
	const prevCac = hasMarketingSpendData ? prevSpend / prevNew : null;

	const ltvCacRatio =
		currCac !== null && currCac > 0 ? currLtv / currCac : null;
	const prevLtvCacRatio =
		prevCac !== null && prevCac > 0 ? prevLtv / prevCac : null;

	// No fabricated fallback — zero orders means AOV is genuinely unavailable
	// for this period, not a plausible-sounding ₹150 (a prior version used
	// that literal; Phase 6 audit confirmed it was never a real observed
	// value for this business).
	const aov = currOrders > 0 ? currRevenue / currOrders : 0;
	// Payback requires a real monthly-margin-per-customer figure. No
	// canonical margin assumption exists anywhere in this codebase or its
	// docs for CAC payback specifically (the previous formula used an
	// unexplained 26% margin * 1.5x purchase-frequency multiplier with no
	// documented source — Phase 6 audit found no business justification
	// for either number). Presenting a payback period built on unsupported
	// assumptions would be more misleading than showing it as unavailable.
	const paybackMonths: number | null = null;

	return {
		hasMarketingSpendData,
		totalSpend: hasMarketingSpendData
			? {
					current: currentSpend,
					previous: prevSpend,
					growth: growthPct(currentSpend, prevSpend),
				}
			: { current: null, previous: null, growth: null },
		newCustomers: {
			current: currNew,
			previous: prevNew,
			growth: growthPct(currNew, prevNew),
		},
		cac: hasMarketingSpendData
			? {
					current: Math.round(currCac as number),
					previous: Math.round(prevCac as number),
					growth: growthPct(currCac as number, prevCac as number),
				}
			: { current: null, previous: null, growth: null },
		ltvCacRatio:
			ltvCacRatio !== null
				? {
						current: Math.round(ltvCacRatio * 10) / 10,
						previous: Math.round((prevLtvCacRatio ?? 0) * 10) / 10,
						growth: growthPct(ltvCacRatio, prevLtvCacRatio ?? 0),
					}
				: { current: null, previous: null, growth: null },
		paybackPeriod: {
			current:
				paybackMonths === null ? null : Math.round(paybackMonths * 10) / 10,
		},
	};
}

export async function getCacReportData(
	db: FounderSql,
	startDate: string,
	endDate: string,
	storeName: string | null,
) {
	const start = new Date(startDate);
	const end = new Date(endDate);
	const days = Math.max(
		1,
		Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1,
	);

	// dim_marketing_spend has no real business data source configured yet —
	// this used to hardcode ₹200,000 / ₹150,000 / ₹50,000 by store name,
	// fabricating CAC/payback figures from numbers with no source. "No
	// spend data" must render as unavailable, not an invented spend.
	const getSpendForStore = async (
		store: string | null,
		daysCount: number,
	): Promise<{ spend: number; hasData: boolean }> => {
		const targetStore = store || "All Stores";
		let spendRows: Record<string, unknown>[] = [];
		try {
			spendRows = await db`
				SELECT monthly_spend
				FROM dim_marketing_spend
				WHERE store_display_name ILIKE ${`%${targetStore}%`}
				LIMIT 1
			`;
		} catch {
			spendRows = [];
		}
		if (spendRows.length === 0) return { spend: 0, hasData: false };
		const monthlySpend = Number(spendRows[0].monthly_spend);
		return {
			spend: Math.round((monthlySpend / 30) * daysCount),
			hasData: true,
		};
	};

	const { spend: currentSpend, hasData: hasMarketingSpendData } =
		await getSpendForStore(storeName, days);
	const newCustomersCount = await customerRepository.getNewCustomersCount(
		startDate,
		endDate,
		storeName,
	);
	const newCustomers = Math.max(1, newCustomersCount);
	const cac = hasMarketingSpendData ? currentSpend / newCustomers : null;

	const aovMetrics = await customerRepository.getAovMetrics(
		startDate,
		endDate,
		storeName,
	);
	const aov = aovMetrics.bills > 0 ? aovMetrics.revenue / aovMetrics.bills : 0;

	// Payback requires a real monthly-margin-per-customer figure, which
	// requires a documented margin assumption. No such assumption exists
	// anywhere in this codebase/docs (the previous formula's 26% margin *
	// 1.5x frequency multiplier had no traceable source — Phase 6 audit).
	// Unavailable is honest; a fabricated-but-plausible number is not.
	const paybackMonths: number | null = null;

	// Store rows are discovered dynamically from the same canonical source
	// every other store breakdown in this app uses (billed_by on
	// sales_fact_v) — a new store appears here automatically, with zero
	// code change. This replaces a prior hardcoded 3-entry list
	// (Smart Works Noida / Klj store / Overall) that made HQ27GGN and
	// ZenZebra permanently invisible to this table.
	const storeRows = (await db`
		SELECT DISTINCT billed_by FROM sales_fact_v
		WHERE billed_by IS NOT NULL AND billed_by <> ''
		ORDER BY billed_by
	`) as { billed_by: string }[];
	const storeOptions: { name: string; key: string | null }[] = [
		...storeRows.map((r) => ({ name: r.billed_by, key: r.billed_by })),
		{ name: "Overall", key: null },
	];

	const paybackTable = await Promise.all(
		storeOptions.map(async (opt) => {
			const { spend: sSpend, hasData: sHasData } = await getSpendForStore(
				opt.key,
				days,
			);
			const sNewCount = await customerRepository.getNewCustomersCount(
				startDate,
				endDate,
				opt.key,
			);
			const sNew = Math.max(1, sNewCount);
			const sCac = sHasData ? sSpend / sNew : null;
			const sAovMetrics = await customerRepository.getAovMetrics(
				startDate,
				endDate,
				opt.key,
			);
			const sAov =
				sAovMetrics.bills > 0 ? sAovMetrics.revenue / sAovMetrics.bills : 0;

			return {
				storeName: opt.name,
				hasMarketingSpendData: sHasData,
				spend: sHasData ? sSpend : null,
				newCustomers: sNewCount,
				cac: sCac === null ? null : Math.round(sCac),
				aov: Math.round(sAov),
				// margin/payback removed — see paybackMonths comment above;
				// no documented assumption exists to compute either honestly.
				margin: null as number | null,
				payback: null as number | null,
			};
		}),
	);

	return {
		hasMarketingSpendData,
		spend: hasMarketingSpendData ? currentSpend : null,
		newCustomers: newCustomersCount,
		cac: cac === null ? null : Math.round(cac),
		aov: Math.round(aov),
		paybackMonths,
		paybackTable,
	};
}
