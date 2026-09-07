import type { NeonQueryFunction } from "@neondatabase/serverless";
import type { DashboardFilters } from "@/lib/founder/types";
import { type ComparisonPeriods, growthPct } from "./comparison";
import { FOOD_CATEGORIES } from "./filter-sql";
import { METRICS } from "./metrics";

type FounderSql = NeonQueryFunction<false, false>;
function n(v: unknown) {
	return Number.isFinite(Number(v ?? 0)) ? Number(v ?? 0) : 0;
}
function retailFilter(f: DashboardFilters) {
	return f.categoryScope === "retail" ? [...FOOD_CATEGORIES] : null;
}

export async function getCustomerIntelligence(
	db: FounderSql,
	periods: ComparisonPeriods,
	filters: DashboardFilters,
	topN = 10,
) {
	const food = retailFilter(filters);

	// Customer classification (new vs existing) must be based on the customer's
	// COMPLETE lifetime purchase history, never rescoped by the selected period
	// or by store/category/brand — otherwise a longtime customer making their
	// first purchase in a filtered slice (e.g. a category they hadn't bought
	// before) would incorrectly look "new". This mirrors the already-correct
	// pattern in customerRepository.getNewCustomersCount: filters narrow WHICH
	// customers are in view, never WHAT their first purchase date was.
	const aggregatedCustomerQuery = `
		WITH customer_first_purchase AS (
			SELECT customer_mobile, MIN(sale_date) AS first_purchase_date
			FROM sales_fact_v
			WHERE customer_mobile IS NOT NULL AND customer_mobile <> ''
			GROUP BY customer_mobile
		),
		cust_summary AS (
			SELECT
				customer_mobile,
				MAX(customer_name) AS customer_name,
				${METRICS.bills} AS bill_count,
				${METRICS.revenue} AS revenue
			FROM sales_fact_v
			WHERE sale_date BETWEEN $1::date AND $2::date
				AND customer_mobile IS NOT NULL
				AND customer_mobile <> ''
				AND ($3::text IS NULL OR billed_by = $3)
				AND ($4::text IS NULL OR category = $4)
				AND ($5::text IS NULL OR brand = $5)
				AND ($6::text[] IS NULL OR category <> ALL($6::text[]))
				AND ($7::text IS NULL OR (sku_code ILIKE '%' || $7 || '%' OR item_name ILIKE '%' || $7 || '%'))
			GROUP BY customer_mobile
		)
		SELECT
			COUNT(*)::integer AS total_customers,
			COUNT(*) FILTER (
				WHERE cfp.first_purchase_date BETWEEN $1::date AND $2::date
			)::integer AS new_customers
		FROM cust_summary cs
		JOIN customer_first_purchase cfp ON cs.customer_mobile = cfp.customer_mobile
	`;

	const topCustomersQuery = `
		SELECT 
			customer_mobile, 
			MAX(customer_name) AS customer_name, 
			${METRICS.bills} AS bill_count, 
			${METRICS.revenue} AS revenue
		FROM sales_fact_v 
		WHERE sale_date BETWEEN $1::date AND $2::date
			AND customer_mobile IS NOT NULL 
			AND customer_mobile <> ''
			AND ($3::text IS NULL OR billed_by = $3)
			AND ($4::text[] IS NULL OR category <> ALL($4::text[]))
			AND ($6::text IS NULL OR (sku_code ILIKE '%' || $6 || '%' OR item_name ILIKE '%' || $6 || '%'))
		GROUP BY customer_mobile
		ORDER BY revenue DESC
		LIMIT $5::int
	`;

	const [current, previous, topCustomers] = await Promise.all([
		(db as any).query(aggregatedCustomerQuery, [
			periods.currentStart,
			periods.currentEnd,
			filters.store ?? null,
			filters.category ?? null,
			filters.brand ?? null,
			food ?? null,
			filters.sku ?? null,
		]),
		(db as any).query(aggregatedCustomerQuery, [
			periods.previousStart,
			periods.previousEnd,
			filters.store ?? null,
			filters.category ?? null,
			filters.brand ?? null,
			food ?? null,
			filters.sku ?? null,
		]),
		(db as any).query(topCustomersQuery, [
			periods.currentStart,
			periods.currentEnd,
			filters.store ?? null,
			food ?? null,
			topN,
			filters.sku ?? null,
		]),
	]);

	const totalCustomers = n(current[0]?.total_customers);
	const previousCustomers = n(previous[0]?.total_customers);
	const newCustomers = n(current[0]?.new_customers);
	// Metric-naming note (Phase 6 audit): this "repeat customers" is
	// (total customers in period) − (customers whose first-ever purchase
	// falls in this period). retention.service.ts computes a differently
	// defined "Repeat Customers"/"Repeat Purchase Rate" — customers with
	// >1 order within the period. Both are legitimate but distinct
	// definitions; they are shown under distinct UI labels ("Repeat
	// Customers" here vs. "Repeat Purchase Rate" on retention pages) and
	// must never be silently swapped for one another.
	const repeatCustomers = Math.max(totalCustomers - newCustomers, 0);

	return {
		totalCustomers,
		previousCustomers,
		customersGrowthPct: growthPct(totalCustomers, previousCustomers),
		repeatCustomers,
		newCustomers,
		repeatCustomersNote:
			"New = lifetime first purchase falls in this period. Existing = purchased before this period. Based on customers who provided a phone number.",
		topCustomers: topCustomers.map((row: any) => ({
			customerMobile: String(row.customer_mobile),
			customerName: row.customer_name ? String(row.customer_name) : null,
			billCount: n(row.bill_count),
			revenue: n(row.revenue),
		})),
	};
}
