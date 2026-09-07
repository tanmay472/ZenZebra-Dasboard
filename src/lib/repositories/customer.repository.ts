import { CUSTOMER_IDENTITY_KEY_SQL } from "@/lib/business-logic/customer-identity";
import { sql } from "@/lib/db";

export interface CohortLtvRow {
	cohort_month_raw: string;
	cohort_size: number;
	ltv_m0: number;
	ltv_m3: number;
	ltv_m6: number;
}

export interface AovOrderRow {
	order_group: string;
	aov: number;
}

export const customerRepository = {
	// This is the canonical, all-history "Customer Lifetime Value": average
	// total lifetime net revenue per identified customer, with no date-range
	// restriction. retention.service.ts's getRetentionOverview() computes a
	// differently-scoped "revenue per customer" that resets with the
	// selected date range — that is a period proxy, not lifetime value, and
	// is labeled "Revenue per Customer (Period)" in the UI specifically to
	// avoid being confused with this figure (Phase 6 audit). Cloud AI's
	// LTV tool must read from this function, not the period proxy.
	async getLtvValue(store: string | null): Promise<number> {
		const query = `
      WITH customer_rev AS (
        SELECT (${CUSTOMER_IDENTITY_KEY_SQL}) AS customer_key, SUM(net_amount) AS total_revenue
        FROM sales_fact_v
        WHERE (${CUSTOMER_IDENTITY_KEY_SQL}) NOT LIKE 'ANON_%'
          AND ($1::text IS NULL OR billed_by = $1)
        GROUP BY (${CUSTOMER_IDENTITY_KEY_SQL})
      )
      SELECT COALESCE(AVG(total_revenue), 0)::numeric AS ltv
      FROM customer_rev
    `;
		const rows = await sql.query(query, [store]);
		const row = rows[0] as Record<string, unknown> | undefined;
		return Number(row?.ltv ?? 0);
	},

	async getNewCustomersCount(
		startDate: string,
		endDate: string,
		store: string | null,
	): Promise<number> {
		const query = `
      WITH customer_first_purchase AS (
        SELECT (${CUSTOMER_IDENTITY_KEY_SQL}) AS customer_key, MIN(sale_date) AS first_purchase_date
        FROM sales_fact_v
        WHERE (${CUSTOMER_IDENTITY_KEY_SQL}) NOT LIKE 'ANON_%'
        GROUP BY (${CUSTOMER_IDENTITY_KEY_SQL})
      )
      SELECT COUNT(DISTINCT cfp.customer_key)::integer AS new_customers
      FROM customer_first_purchase cfp
      WHERE cfp.first_purchase_date BETWEEN $1::date AND $2::date
        AND ($3::text IS NULL OR cfp.customer_key IN (
          SELECT DISTINCT (${CUSTOMER_IDENTITY_KEY_SQL}) FROM sales_fact_v WHERE billed_by = $3
        ))
    `;
		const rows = await sql.query(query, [startDate, endDate, store]);
		const row = rows[0] as Record<string, unknown> | undefined;
		return Number(row?.new_customers ?? 0);
	},

	async getAovMetrics(
		startDate: string,
		endDate: string,
		store: string | null,
	): Promise<{ revenue: number; bills: number }> {
		const query = `
      SELECT 
        COALESCE(SUM(net_amount), 0)::numeric AS total_revenue,
        COUNT(DISTINCT order_id)::integer AS total_bills
      FROM sales_fact_v
      WHERE ($1::text IS NULL OR billed_by = $1)
        AND (sale_date BETWEEN $2::date AND $3::date)
    `;
		const rows = await sql.query(query, [store, startDate, endDate]);
		const row = rows[0] as Record<string, unknown> | undefined;
		return {
			revenue: Number(row?.total_revenue ?? 0),
			bills: Number(row?.total_bills ?? 0),
		};
	},

	async getAovExpansion(
		store: string | null,
	): Promise<{ firstOrderAov: number; latestOrderAov: number }> {
		const query = `
      WITH customer_bills AS (
        SELECT 
          (${CUSTOMER_IDENTITY_KEY_SQL}) AS customer_key,
          net_amount,
          ROW_NUMBER() OVER(PARTITION BY (${CUSTOMER_IDENTITY_KEY_SQL}) ORDER BY sale_date ASC, order_id ASC) as rn_asc,
          ROW_NUMBER() OVER(PARTITION BY (${CUSTOMER_IDENTITY_KEY_SQL}) ORDER BY sale_date DESC, order_id DESC) as rn_desc
        FROM sales_fact_v
        WHERE (${CUSTOMER_IDENTITY_KEY_SQL}) NOT LIKE 'ANON_%'
          AND ($1::text IS NULL OR billed_by = $1)
      ),
      first_orders AS (
        SELECT net_amount FROM customer_bills WHERE rn_asc = 1
      ),
      latest_orders AS (
        SELECT net_amount FROM customer_bills WHERE rn_desc = 1
      )
      SELECT 
        COALESCE(AVG(f.net_amount), 0)::numeric AS first_order_aov,
        COALESCE(AVG(l.net_amount), 0)::numeric AS latest_order_aov
      FROM first_orders f
      CROSS JOIN latest_orders l
    `;
		const rows = await sql.query(query, [store]);
		const row = rows[0] as Record<string, unknown> | undefined;
		return {
			firstOrderAov: Number(row?.first_order_aov ?? 0),
			latestOrderAov: Number(row?.latest_order_aov ?? 0),
		};
	},

	async getCohortLtvGrowth(store: string | null): Promise<CohortLtvRow[]> {
		const query = `
      WITH customer_first_purchase AS (
        SELECT 
          (${CUSTOMER_IDENTITY_KEY_SQL}) AS customer_key,
          MIN(sale_date) AS first_purchase_date
        FROM sales_fact_v
        WHERE (${CUSTOMER_IDENTITY_KEY_SQL}) NOT LIKE 'ANON_%'
          AND ($1::text IS NULL OR billed_by = $1)
        GROUP BY (${CUSTOMER_IDENTITY_KEY_SQL})
      ),
      cohort_customers AS (
        SELECT 
          customer_key,
          first_purchase_date,
          DATE_TRUNC('month', first_purchase_date)::date AS cohort_month
        FROM customer_first_purchase
      ),
      cohort_sizes AS (
        SELECT 
          cohort_month,
          COUNT(DISTINCT customer_key) AS cohort_size
        FROM cohort_customers
        GROUP BY cohort_month
      ),
      customer_sales AS (
        SELECT 
          (${CUSTOMER_IDENTITY_KEY_SQL}) AS customer_key,
          cc.cohort_month,
          cc.first_purchase_date,
          sf.net_amount,
          sf.sale_date,
          ((EXTRACT(year FROM sf.sale_date) - EXTRACT(year FROM cc.first_purchase_date)) * 12 +
           (EXTRACT(month FROM sf.sale_date) - EXTRACT(month FROM cc.first_purchase_date)))::integer AS months_since_first
        FROM sales_fact_v sf
        JOIN cohort_customers cc ON (${CUSTOMER_IDENTITY_KEY_SQL}) = cc.customer_key
        WHERE ($1::text IS NULL OR sf.billed_by = $1)
      ),
      cohort_months_revenue AS (
        SELECT 
          cohort_month,
          customer_key,
          SUM(CASE WHEN months_since_first <= 0 THEN net_amount ELSE 0 END) AS rev_m0,
          SUM(CASE WHEN months_since_first <= 3 THEN net_amount ELSE 0 END) AS rev_m3,
          SUM(CASE WHEN months_since_first <= 6 THEN net_amount ELSE 0 END) AS rev_m6
        FROM customer_sales
        GROUP BY cohort_month, customer_key
      )
      SELECT 
        cmr.cohort_month::text AS cohort_month_raw,
        cs.cohort_size::integer,
        COALESCE(SUM(cmr.rev_m0) / NULLIF(cs.cohort_size, 0), 0)::numeric AS ltv_m0,
        COALESCE(SUM(cmr.rev_m3) / NULLIF(cs.cohort_size, 0), 0)::numeric AS ltv_m3,
        COALESCE(SUM(cmr.rev_m6) / NULLIF(cs.cohort_size, 0), 0)::numeric AS ltv_m6
      FROM cohort_months_revenue cmr
      JOIN cohort_sizes cs ON cmr.cohort_month = cs.cohort_month
      GROUP BY cmr.cohort_month, cs.cohort_size
      ORDER BY cmr.cohort_month ASC
    `;
		const rows = await sql.query(query, [store]);
		return rows as unknown as CohortLtvRow[];
	},

	async getAovByOrderNumber(store: string | null): Promise<AovOrderRow[]> {
		const query = `
      WITH customer_ordered_bills AS (
        SELECT 
          (${CUSTOMER_IDENTITY_KEY_SQL}) AS customer_key,
          net_amount,
          ROW_NUMBER() OVER(PARTITION BY (${CUSTOMER_IDENTITY_KEY_SQL}) ORDER BY sale_date ASC, order_id ASC) as order_num
        FROM sales_fact_v
        WHERE (${CUSTOMER_IDENTITY_KEY_SQL}) NOT LIKE 'ANON_%'
          AND ($1::text IS NULL OR billed_by = $1)
      ),
      grouped_orders AS (
        SELECT 
          CASE 
            WHEN order_num = 1 THEN '1st'
            WHEN order_num = 2 THEN '2nd'
            WHEN order_num = 3 THEN '3rd'
            ELSE '4th+'
          END AS order_group,
          net_amount
        FROM customer_ordered_bills
      )
      SELECT 
        order_group,
        COALESCE(AVG(net_amount), 0)::numeric AS aov
      FROM grouped_orders
      GROUP BY order_group
    `;
		const rows = await sql.query(query, [store]);
		return rows as unknown as AovOrderRow[];
	},
};
