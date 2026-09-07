import type { NeonQueryFunction } from "@neondatabase/serverless";
import {
	type ComparisonPeriods,
	growthPct,
} from "@/lib/business-logic/comparison";
import { FOOD_CATEGORIES } from "@/lib/business-logic/filter-sql";
import type { DashboardFilters } from "@/lib/founder/types";

type FounderSql = NeonQueryFunction<false, false>;

function n(v: unknown) {
	return Number.isFinite(Number(v ?? 0)) ? Number(v ?? 0) : 0;
}

function retailFilter(f: DashboardFilters) {
	return f.categoryScope === "retail" ? [...FOOD_CATEGORIES] : null;
}

export async function getRetentionOverview(
	db: FounderSql,
	periods: ComparisonPeriods,
	filters: DashboardFilters,
) {
	const food = retailFilter(filters);
	const store = filters.store ?? null;

	const baseCustomersQuery = `
    SELECT COUNT(DISTINCT customer_mobile)::integer AS total_customers
    FROM sales_fact_v
    WHERE sale_date BETWEEN $1::date AND $2::date
      AND customer_mobile IS NOT NULL AND customer_mobile <> ''
      AND ($3::text IS NULL OR billed_by = $3)
      AND ($4::text[] IS NULL OR category <> ALL($4::text[]))
  `;

	// Metric-naming note (Phase 6 audit): "repeat" here means customers
	// with >1 distinct order strictly within the selected period.
	// customer-intelligence.ts computes a differently defined "repeat
	// customers" — (total customers) − (customers whose lifetime-first
	// purchase falls in this period). Both are legitimate but distinct;
	// they surface under distinct UI labels ("Repeat Purchase Rate" here
	// vs. "Repeat Customers" on sales/customer-intelligence views) and
	// must never be silently swapped for one another.
	const repeatCustomersQuery = `
    SELECT COUNT(*)::integer AS repeat_customers FROM (
      SELECT customer_mobile
      FROM sales_fact_v
      WHERE sale_date BETWEEN $1::date AND $2::date
        AND customer_mobile IS NOT NULL AND customer_mobile <> ''
        AND ($3::text IS NULL OR billed_by = $3)
        AND ($4::text[] IS NULL OR category <> ALL($4::text[]))
      GROUP BY customer_mobile
      HAVING COUNT(DISTINCT order_id) > 1
    ) x
  `;

	const revenueQuery = `
    SELECT COALESCE(SUM(net_amount), 0)::numeric AS revenue,
      COUNT(DISTINCT order_id)::integer AS orders
    FROM sales_fact_v
    WHERE sale_date BETWEEN $1::date AND $2::date
      AND ($3::text IS NULL OR billed_by = $3)
      AND ($4::text[] IS NULL OR category <> ALL($4::text[]))
  `;

	const [
		currCustomersResult,
		prevCustomersResult,
		currRepeatResult,
		prevRepeatResult,
		currRevenueResult,
		prevRevenueResult,
	] = await Promise.all([
		(db as any).query(baseCustomersQuery, [
			periods.currentStart,
			periods.currentEnd,
			store,
			food,
		]),
		(db as any).query(baseCustomersQuery, [
			periods.previousStart,
			periods.previousEnd,
			store,
			food,
		]),
		(db as any).query(repeatCustomersQuery, [
			periods.currentStart,
			periods.currentEnd,
			store,
			food,
		]),
		(db as any).query(repeatCustomersQuery, [
			periods.previousStart,
			periods.previousEnd,
			store,
			food,
		]),
		(db as any).query(revenueQuery, [
			periods.currentStart,
			periods.currentEnd,
			store,
			food,
		]),
		(db as any).query(revenueQuery, [
			periods.previousStart,
			periods.previousEnd,
			store,
			food,
		]),
	]);

	const currCustomers = n(currCustomersResult[0]?.total_customers);
	const prevCustomers = n(prevCustomersResult[0]?.total_customers);
	const currRepeat = n(currRepeatResult[0]?.repeat_customers);
	const prevRepeat = n(prevRepeatResult[0]?.repeat_customers);
	const currRevenue = n(currRevenueResult[0]?.revenue);
	const currOrders = n(currRevenueResult[0]?.orders);
	const prevOrders = n(prevRevenueResult[0]?.orders);

	const currRepeatRate =
		currCustomers > 0 ? (currRepeat / currCustomers) * 100 : 0;
	const prevRepeatRate =
		prevCustomers > 0 ? (prevRepeat / prevCustomers) * 100 : 0;

	// This is a period-window revenue-per-customer proxy, NOT true lifetime
	// value — it resets with the selected date range. The genuine
	// all-history LTV lives in customer.repository.ts's getLtvValue() /
	// ltv.service.ts's getLtvReportData(). Phase 6 audit: the retention
	// overview page previously labeled this "Customer Lifetime Value",
	// which conflated the two — the UI label is now "Revenue per Customer
	// (Period)" to keep this field honest.
	const currLtv = currCustomers > 0 ? currRevenue / currCustomers : 0;
	const prevLtv =
		prevCustomers > 0 ? n(prevRevenueResult[0]?.revenue) / prevCustomers : 0;

	// CAC Calculations (Simulated Marketing Spend scaled by days)
	const start = new Date(periods.currentStart);
	const end = new Date(periods.currentEnd);
	const days = Math.max(
		1,
		Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1,
	);

	const targetStore = store || "All Stores";
	// dim_marketing_spend has no real business data source yet on this DB — the
	// code already treats "no matching row" as monthlySpend=0 (see below), so a
	// missing table degrades to that same, already-designed-for state instead of
	// crashing the endpoint.
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

	// Get New Customers (First purchase date falls in the range)
	const newCustomersQuery = `
    SELECT COUNT(DISTINCT customer_mobile)::integer AS count
    FROM customer_metrics
    WHERE first_purchase_date BETWEEN $1::date AND $2::date
      AND customer_mobile IN (
        SELECT DISTINCT customer_mobile FROM sales_fact_v
        WHERE ($3::text IS NULL OR billed_by = $3)
          AND ($4::text[] IS NULL OR category <> ALL($4::text[]))
      )
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

	const currCac = currentSpend / currNew;
	const prevCac = prevSpend / prevNew;

	const ltvCacRatio = currCac > 0 ? currLtv / currCac : 0;
	const prevLtvCacRatio = prevCac > 0 ? prevLtv / prevCac : 0;

	const currAov = currOrders > 0 ? currRevenue / currOrders : 0;
	const prevAov =
		prevOrders > 0 ? n(prevRevenueResult[0]?.revenue) / prevOrders : 0;
	const currOrdersPerCustomer =
		currCustomers > 0 ? currOrders / currCustomers : 0;
	const prevOrdersPerCustomer =
		prevCustomers > 0 ? prevOrders / prevCustomers : 0;

	return {
		retentionRate: {
			current: Math.round(currRepeatRate * 10) / 10,
			previous: Math.round(prevRepeatRate * 10) / 10,
			growth: growthPct(currRepeatRate, prevRepeatRate),
		},
		repeatPurchaseRate: {
			current: Math.round(currRepeatRate * 10) / 10,
			previous: Math.round(prevRepeatRate * 10) / 10,
			growth: growthPct(currRepeatRate, prevRepeatRate),
		},
		ltv: {
			current: Math.round(currLtv),
			previous: Math.round(prevLtv),
			growth: growthPct(currLtv, prevLtv),
		},
		cac: hasMarketingSpendData
			? {
					current: Math.round(currCac),
					previous: Math.round(prevCac),
					growth: growthPct(currCac, prevCac),
				}
			: { current: null, previous: null, growth: null },
		hasMarketingSpendData,
		ltvCacRatio: hasMarketingSpendData
			? {
					current: Math.round(ltvCacRatio * 10) / 10,
					previous: Math.round(prevLtvCacRatio * 10) / 10,
					growth: growthPct(ltvCacRatio, prevLtvCacRatio),
				}
			: { current: null, previous: null, growth: null },
		avgAov: {
			current: Math.round(currAov),
			previous: Math.round(prevAov),
			growth: growthPct(currAov, prevAov),
		},
		avgOrdersPerCustomer: {
			current: Math.round(currOrdersPerCustomer * 100) / 100,
			previous: Math.round(prevOrdersPerCustomer * 100) / 100,
			growth: growthPct(currOrdersPerCustomer, prevOrdersPerCustomer),
		},
		meta: {
			marketingSpend: currentSpend,
			newCustomers: currNew,
			totalRevenue: currRevenue,
			totalOrders: currOrders,
		},
	};
}

export async function getRetentionTrend(
	db: FounderSql,
	periods: ComparisonPeriods,
	filters: DashboardFilters,
) {
	const food = retailFilter(filters);
	const store = filters.store ?? null;

	const trendQuery = `
    SELECT
      gs.d::text AS date,
      COUNT(DISTINCT sf.customer_mobile) FILTER (WHERE cm.first_purchase_date = gs.d)::integer AS new_customers,
      COUNT(DISTINCT sf.customer_mobile) FILTER (WHERE cm.first_purchase_date < gs.d)::integer AS returning_customers,
      COALESCE(SUM(sf.net_amount) FILTER (WHERE cm.first_purchase_date = gs.d), 0)::numeric AS new_revenue,
      COALESCE(SUM(sf.net_amount) FILTER (WHERE cm.first_purchase_date < gs.d), 0)::numeric AS returning_revenue
    FROM (
      SELECT generate_series($1::date, $2::date, interval '1 day')::date AS d
    ) gs
    LEFT JOIN sales_fact_v sf ON sf.sale_date = gs.d
      AND ($3::text IS NULL OR sf.billed_by = $3)
      AND ($4::text[] IS NULL OR sf.category <> ALL($4::text[]))
    LEFT JOIN customer_metrics cm ON sf.customer_mobile = cm.customer_mobile
    GROUP BY gs.d
    ORDER BY gs.d ASC
  `;

	const result = await (db as any).query(trendQuery, [
		periods.currentStart,
		periods.currentEnd,
		store,
		food,
	]);

	return result.map((row: any) => ({
		date: row.date,
		newCustomers: n(row.new_customers),
		returningCustomers: n(row.returning_customers),
		newRevenue: Math.round(n(row.new_revenue)),
		returningRevenue: Math.round(n(row.returning_revenue)),
		totalRevenue: Math.round(n(row.new_revenue) + n(row.returning_revenue)),
	}));
}

export async function getAiInsights(
	db: FounderSql,
	periods: ComparisonPeriods,
	filters: DashboardFilters,
) {
	const overview = await getRetentionOverview(db, periods, filters);
	// Null (not a fabricated 61%) when totalRevenue is 0 — there is no
	// meaningful "returning customer revenue share" to report in that case.
	const returningRevShare =
		overview.meta.totalRevenue > 0
			? Math.round(
					((overview.meta.totalRevenue -
						overview.meta.newCustomers *
							(overview.ltv.current /
								(overview.avgOrdersPerCustomer.current || 1))) /
						overview.meta.totalRevenue) *
						100,
				)
			: null;

	const changePct = overview.repeatPurchaseRate.growth ?? 0;
	const rateStr =
		changePct >= 0
			? `improved ${changePct}%`
			: `declined ${Math.abs(changePct)}%`;

	const insights = [
		`Retention ${rateStr} vs last month`,
		overview.hasMarketingSpendData
			? `LTV:CAC currently ${overview.ltvCacRatio.current}x - ${(overview.ltvCacRatio.current ?? 0) >= 3 ? "Healthy growth benchmark exceeded" : "Consider acquisition optimizations"}`
			: "LTV:CAC unavailable — no marketing spend data recorded",
	];

	// A prior version always appended a static, fabricated cohort insight
	// ("Customers acquired in March show highest repeat purchases") — removed
	// rather than replaced with another guess; no cohort-comparison query
	// backs a genuine version of this sentence here.
	if (returningRevShare !== null) {
		insights.push(
			`Returning customers contribute ${Math.min(100, Math.max(0, returningRevShare))}% revenue`,
		);
	}

	return insights;
}

export async function getCustomerSegments(
	db: FounderSql,
	periods: ComparisonPeriods,
	filters: DashboardFilters,
) {
	const food = retailFilter(filters);
	const store = filters.store ?? null;

	const stdDevQuery = `
		SELECT COALESCE(STDDEV_SAMP(bill_amount), 0)::numeric AS aov_stddev
		FROM (
			SELECT order_id, SUM(net_amount) AS bill_amount
			FROM sales_fact_v
			WHERE customer_mobile IS NOT NULL AND customer_mobile <> ''
				AND ($1::text IS NULL OR billed_by = $1)
				AND ($2::text[] IS NULL OR category <> ALL($2::text[]))
			GROUP BY order_id
		) x
	`;

	const newCustQuery = `
		WITH new_cust AS (
			SELECT customer_mobile
			FROM customer_metrics
			WHERE first_purchase_date BETWEEN $1::date AND $2::date
		)
		SELECT
			COUNT(DISTINCT sf.customer_mobile)::integer AS customers_count,
			COALESCE(SUM(sf.net_amount), 0)::numeric AS revenue,
			COUNT(DISTINCT sf.order_id)::integer AS orders_count
		FROM sales_fact_v sf
		JOIN new_cust nc ON sf.customer_mobile = nc.customer_mobile
		WHERE sf.sale_date BETWEEN $1::date AND $2::date
			AND ($3::text IS NULL OR sf.billed_by = $3)
			AND ($4::text[] IS NULL OR sf.category <> ALL($4::text[]))
	`;

	const retCustQuery = `
		WITH ret_cust AS (
			SELECT customer_mobile
			FROM customer_metrics
			WHERE first_purchase_date < $1::date
		)
		SELECT
			COUNT(DISTINCT sf.customer_mobile)::integer AS customers_count,
			COALESCE(SUM(sf.net_amount), 0)::numeric AS revenue,
			COUNT(DISTINCT sf.order_id)::integer AS orders_count
		FROM sales_fact_v sf
		JOIN ret_cust rc ON sf.customer_mobile = rc.customer_mobile
		WHERE sf.sale_date BETWEEN $1::date AND $2::date
			AND ($3::text IS NULL OR sf.billed_by = $3)
			AND ($4::text[] IS NULL OR sf.category <> ALL($4::text[]))
	`;

	const [stdDevRes, newRes, retRes] = await Promise.all([
		(db as any).query(stdDevQuery, [store, food]),
		(db as any).query(newCustQuery, [
			periods.currentStart,
			periods.currentEnd,
			store,
			food,
		]),
		(db as any).query(retCustQuery, [
			periods.currentStart,
			periods.currentEnd,
			store,
			food,
		]),
	]);

	const stdDev = n(stdDevRes[0]?.aov_stddev);
	const newCount = n(newRes[0]?.customers_count);
	const newRevenue = n(newRes[0]?.revenue);
	const newOrders = n(newRes[0]?.orders_count);

	const retCount = n(retRes[0]?.customers_count);
	const retRevenue = n(retRes[0]?.revenue);
	const retOrders = n(retRes[0]?.orders_count);

	const newAov = newOrders > 0 ? newRevenue / newOrders : 0;
	const retAov = retOrders > 0 ? retRevenue / retOrders : 0;

	const start = new Date(periods.currentStart);
	const end = new Date(periods.currentEnd);
	const days = Math.max(
		1,
		Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1,
	);
	const targetStore = store || "All Stores";
	// dim_marketing_spend has no real business data source yet on this DB — the
	// code already treats "no matching row" as monthlySpend=0 (see below), so a
	// missing table degrades to that same, already-designed-for state instead of
	// crashing the endpoint.
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
	const spend = Math.round((monthlySpend / 30) * days);
	const cac = hasMarketingSpendData ? spend / Math.max(1, newCount) : null;

	return {
		newCustomers: {
			count: newCount,
			revenue: Math.round(newRevenue),
			aov: Math.round(newAov),
			cac: cac === null ? null : Math.round(cac),
			hasMarketingSpendData,
			orders: newOrders,
		},
		returningCustomers: {
			count: retCount,
			revenue: Math.round(retRevenue),
			aov: Math.round(retAov),
			orders: retOrders,
			revenueShare: Math.round(
				(retRevenue / Math.max(1, newRevenue + retRevenue)) * 100,
			),
		},
		aovStability: {
			volatility: Math.round(stdDev),
			status:
				stdDev < 150
					? "Low Volatility (Stable Spending)"
					: "High Volatility (Variable Spending)",
		},
	};
}

export async function getCustomerHealth(
	db: FounderSql,
	periods: ComparisonPeriods,
	filters: DashboardFilters,
) {
	const food = retailFilter(filters);
	const store = filters.store ?? null;

	const healthQuery = `
		WITH customer_stats AS (
			SELECT
				customer_mobile,
				MAX(sale_date) AS last_purchase_date,
				MIN(sale_date) AS first_purchase_date,
				COUNT(DISTINCT order_id) AS total_orders,
				SUM(net_amount) AS total_revenue,
				PERCENT_RANK() OVER (ORDER BY SUM(net_amount) DESC) AS spend_percentile
			FROM sales_fact_v
			WHERE customer_mobile IS NOT NULL AND customer_mobile <> ''
				AND ($2::text IS NULL OR billed_by = $2)
				AND ($3::text[] IS NULL OR category <> ALL($3::text[]))
			GROUP BY customer_mobile
		),
		customer_segments AS (
			SELECT
				customer_mobile,
				total_orders,
				($1::date - last_purchase_date)::integer AS recency,
				($1::date - first_purchase_date)::integer AS age,
				spend_percentile,
				(
					CASE
						WHEN ($1::date - last_purchase_date) <= 30 THEN 40
						WHEN ($1::date - last_purchase_date) <= 60 THEN 20
						ELSE 0
					END +
					CASE
						WHEN total_orders >= 10 THEN 30
						WHEN total_orders >= 5 THEN 20
						ELSE 10
					END +
					CASE
						WHEN spend_percentile <= 0.20 THEN 30
						WHEN spend_percentile <= 0.70 THEN 20
						ELSE 10
					END
				) AS health_score
			FROM customer_stats
		)
		SELECT
			COUNT(*) FILTER (WHERE spend_percentile <= 0.20)::integer AS vip_count,
			COUNT(*) FILTER (WHERE total_orders >= 5 AND recency <= 30 AND NOT (spend_percentile <= 0.20))::integer AS loyal_count,
			COUNT(*) FILTER (WHERE age <= 30 AND NOT (spend_percentile <= 0.20) AND NOT (total_orders >= 5 AND recency <= 30))::integer AS new_count,
			COUNT(*) FILTER (WHERE recency BETWEEN 45 AND 90 AND NOT (spend_percentile <= 0.20) AND NOT (total_orders >= 5 AND recency <= 30) AND NOT (age <= 30))::integer AS at_risk_count,
			COUNT(*) FILTER (WHERE recency > 90 AND NOT (spend_percentile <= 0.20) AND NOT (total_orders >= 5 AND recency <= 30) AND NOT (age <= 30) AND NOT (recency BETWEEN 45 AND 90))::integer AS lost_count,
			AVG(health_score)::numeric AS avg_health_score,
			COUNT(*)::integer AS total_customers
		FROM customer_segments
	`;

	const res = await (db as any).query(healthQuery, [
		periods.currentEnd,
		store,
		food,
	]);
	const row = res[0] || {};

	const vip = n(row.vip_count);
	const loyal = n(row.loyal_count);
	const newCust = n(row.new_count);
	const atRisk = n(row.at_risk_count);
	const lost = n(row.lost_count);
	const total = n(row.total_customers);
	const healthScore = Math.round(n(row.avg_health_score));

	// Healthy count includes VIP, Loyal, and New (which represent customers in good health)
	const healthy = vip + loyal + newCust;

	return {
		vip,
		loyal,
		newCustomers: newCust,
		atRisk,
		lost,
		healthy,
		total,
		healthScore,
		status:
			healthScore >= 75
				? "Healthy"
				: healthScore >= 50
					? "Stable"
					: "Critical Risk",
	};
}

export async function getCustomerHealthList(
	db: FounderSql,
	periods: ComparisonPeriods,
	filters: DashboardFilters,
) {
	const food = retailFilter(filters);
	const store = filters.store ?? null;

	const listQuery = `
		WITH customer_stats AS (
			SELECT
				customer_mobile,
				COALESCE(MAX(customer_name), 'Valued Customer') AS customer_name,
				MAX(sale_date) AS last_purchase_date,
				MIN(sale_date) AS first_purchase_date,
				COUNT(DISTINCT order_id) AS total_orders,
				SUM(net_amount) AS total_revenue,
				PERCENT_RANK() OVER (ORDER BY SUM(net_amount) DESC) AS spend_percentile
			FROM sales_fact_v
			WHERE customer_mobile IS NOT NULL AND customer_mobile <> ''
				AND ($2::text IS NULL OR billed_by = $2)
				AND ($3::text[] IS NULL OR category <> ALL($3::text[]))
			GROUP BY customer_mobile
		)
		SELECT
			customer_mobile AS "customerMobile",
			customer_name AS "customerName",
			total_orders AS "orders",
			total_revenue AS "revenue",
			($1::date - last_purchase_date)::integer AS "recencyDays",
			($1::date - first_purchase_date)::integer AS "ageDays",
			spend_percentile AS "spendPercentile",
			CASE
				WHEN ($1::date - last_purchase_date) <= 30 THEN 40
				WHEN ($1::date - last_purchase_date) <= 60 THEN 20
				ELSE 0
			END AS "recencyPoints",
			CASE
				WHEN total_orders >= 10 THEN 30
				WHEN total_orders >= 5 THEN 20
				ELSE 10
			END AS "frequencyPoints",
			CASE
				WHEN spend_percentile <= 0.20 THEN 30
				WHEN spend_percentile <= 0.70 THEN 20
				ELSE 10
			END AS "monetaryPoints"
		FROM customer_stats
		ORDER BY total_revenue DESC
		LIMIT 200
	`;

	const rows = await (db as any).query(listQuery, [
		periods.currentEnd,
		store,
		food,
	]);

	return rows.map((row: any) => {
		const recencyDays = n(row.recencyDays);
		const ageDays = n(row.ageDays);
		const orders = n(row.orders);
		const spendPercentile = n(row.spendPercentile);

		const healthScore =
			n(row.recencyPoints) + n(row.frequencyPoints) + n(row.monetaryPoints);

		// Segment Precedence
		let segment = "Regular";
		if (spendPercentile <= 0.2) {
			segment = "VIP";
		} else if (orders >= 5 && recencyDays <= 30) {
			segment = "Loyal";
		} else if (ageDays <= 30) {
			segment = "New";
		} else if (recencyDays >= 45 && recencyDays <= 90) {
			segment = "At Risk";
		} else if (recencyDays > 90) {
			segment = "Lost";
		}

		// Human readable last purchase text
		let lastPurchase = `${recencyDays} Days`;
		if (recencyDays === 0) lastPurchase = "0 Days";
		else if (recencyDays === 1) lastPurchase = "1 Day";

		return {
			customerMobile: row.customerMobile,
			customerName: row.customerName,
			orders,
			revenue: Math.round(n(row.revenue)),
			aov: orders > 0 ? Math.round(n(row.revenue) / orders) : 0,
			healthScore,
			segment,
			lastPurchaseDays: recencyDays,
			lastPurchase,
		};
	});
}

/**
 * Real monthly AOV trend across the selected date range (data-truth
 * remediation, FINDING-201) — replaces a UI-side function that fabricated a
 * fixed 6-month Jan-Jun series with a hardcoded multiplier curve. Grouped by
 * calendar month within the filtered range, using the same
 * SUM(net_amount)/COUNT(DISTINCT order_id) AOV definition used everywhere
 * else in this codebase.
 */
export async function getMonthlyAovTrend(
	db: FounderSql,
	periods: ComparisonPeriods,
	filters: DashboardFilters,
): Promise<
	Array<{ month: string; aov: number; revenue: number; orders: number }>
> {
	const food = retailFilter(filters);
	const store = filters.store ?? null;

	const rows = await (db as any).query(
		`SELECT
      to_char(date_trunc('month', sale_date), 'YYYY-MM') AS month,
      SUM(net_amount)::numeric AS revenue,
      COUNT(DISTINCT order_id)::integer AS orders
    FROM sales_fact_v
    WHERE sale_date >= $1::date AND sale_date <= $2::date
      AND ($3::text IS NULL OR billed_by = $3)
      AND ($4::text[] IS NULL OR category <> ALL($4::text[]))
    GROUP BY date_trunc('month', sale_date)
    ORDER BY date_trunc('month', sale_date) ASC`,
		[periods.currentStart, periods.currentEnd, store, food],
	);

	return rows.map((row: any) => {
		const revenue = n(row.revenue);
		const orders = n(row.orders);
		return {
			month: row.month,
			revenue: Math.round(revenue),
			orders,
			aov: orders > 0 ? Math.round(revenue / orders) : 0,
		};
	});
}
