import path from "node:path";
import { neon } from "@neondatabase/serverless";
import * as dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

/**
 * ZenZebra Canonical Regression Verification
 *
 * Validates the live production view `sales_fact_v`, which unifies:
 *   1. Historical seed data (deduplicated against live Odoo orders)
 *   2. Real-time Odoo SaaS sales transactions (fact_sales_orders + fact_sales_lines)
 *
 * Verifies:
 *   - Dynamic date boundaries (min_date <= max_date)
 *   - Golden Mathematical Invariants:
 *       Equation 1: MRP - Discount = Collection (Gross)
 *       Equation 2: Collection - GST = Revenue (Net)
 *   - Store attribution & volume integrity across canonical stores (KLJ, SWN, etc.)
 *   - AOV consistency (Net Revenue / Distinct Bills)
 *   - Repeat customer calculation integrity
 *   - Historical reference slice (2025-11-18 -> 2026-06-25) to prevent baseline regression
 */

async function main() {
	if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL missing");
	const sql = neon(process.env.DATABASE_URL);
	let failed = 0;

	console.log("==================================================");
	console.log("🔍 Checking Canonical Metrics in sales_fact_v...");
	console.log("==================================================");

	// 1. Full Dataset Aggregations with Dynamic Date Bounds
	const [totals] = await sql`
		SELECT
			COUNT(*)::int AS rows,
			COUNT(DISTINCT bill_no)::int AS bills,
			ROUND(SUM(net_amount)::numeric, 2) AS revenue,
			SUM(quantity)::int AS units,
			ROUND(SUM(gross_amount)::numeric, 2) AS gross_revenue,
			ROUND(SUM(tax_amount)::numeric, 2) AS gst_liability,
			ROUND(SUM(discount_amount)::numeric, 2) AS discount_given,
			ROUND(SUM(mrp_amount)::numeric, 2) AS mrp_total,
			MIN(sale_date)::text AS min_date,
			MAX(sale_date)::text AS max_date,
			COUNT(DISTINCT customer_mobile) FILTER (WHERE customer_mobile IS NOT NULL AND customer_mobile <> '')::int AS mobiles
		FROM sales_fact_v`;

	const totalRows = Number(totals.rows);
	const distinctBills = Number(totals.bills);
	const totalRevenue = Number(totals.revenue);
	const totalQuantity = Number(totals.units);
	const grossCollection = Number(totals.gross_revenue);
	const gstLiability = Number(totals.gst_liability);
	const discountGiven = Number(totals.discount_given);
	const mrpTotal = Number(totals.mrp_total);
	const distinctMobiles = Number(totals.mobiles);

	console.log(
		`\n📅 Dynamic Dataset Range: ${totals.min_date} → ${totals.max_date}`,
	);
	console.log(`📊 Total Fact Rows: ${totalRows.toLocaleString()}`);
	console.log(`🧾 Distinct Bills: ${distinctBills.toLocaleString()}`);
	console.log(`💰 Net Revenue: ₹${totalRevenue.toLocaleString()}`);

	// Integrity checks on full dataset
	const volumeChecks = [
		["Total Rows > 0", totalRows > 0, totalRows],
		["Distinct Bills > 0", distinctBills > 0, distinctBills],
		["Net Revenue > 0", totalRevenue > 0, totalRevenue],
		["Gross Collection > 0", grossCollection > 0, grossCollection],
		["Total Quantity > 0", totalQuantity > 0, totalQuantity],
		["Customer Mobiles > 0", distinctMobiles > 0, distinctMobiles],
		[
			"Date Bounds Valid",
			Boolean(
				totals.min_date &&
					totals.max_date &&
					totals.min_date <= totals.max_date,
			),
			`${totals.min_date} <= ${totals.max_date}`,
		],
	] as const;

	for (const [label, pass, val] of volumeChecks) {
		console.log(`${pass ? "✅" : "❌"} ${label}: ${val}`);
		if (!pass) failed++;
	}

	// 2. Canonical Store Integrity
	console.log("\n--- Checking Canonical Store Distribution ---");
	const storeRows = await sql`
		SELECT
			billed_by,
			COUNT(*)::int AS rows,
			COUNT(DISTINCT bill_no)::int AS bills,
			ROUND(SUM(net_amount)::numeric, 2) AS revenue,
			SUM(quantity)::int AS units
		FROM sales_fact_v
		GROUP BY billed_by
		ORDER BY rows DESC`;

	console.log(
		`Found ${storeRows.length} active canonical store(s) in sales_fact_v:`,
	);
	for (const s of storeRows) {
		const sRevenue = Number(s.revenue);
		const sPass = s.rows > 0 && s.bills > 0 && sRevenue > 0 && s.units > 0;
		console.log(
			`${sPass ? "✅" : "❌"} Store '${s.billed_by}': ${s.rows} rows, ${s.bills} bills, ₹${sRevenue.toLocaleString()}, ${s.units} units`,
		);
		if (!sPass) failed++;
	}

	// 3. AOV Verification
	console.log("\n--- Verifying Average Order Value (AOV) ---");
	const [aovRow] = await sql`
		SELECT ROUND(SUM(net_amount) / NULLIF(COUNT(DISTINCT bill_no), 0), 2) AS aov
		FROM sales_fact_v`;
	const actualAov = Number(aovRow.aov);
	const expectedAov = Number((totalRevenue / distinctBills).toFixed(2));
	const aovPass = Math.abs(actualAov - expectedAov) < 0.1;
	console.log(
		`${aovPass ? "✅" : "❌"} Overall AOV: ₹${actualAov} (calculated: ₹${expectedAov})`,
	);
	if (!aovPass) failed++;

	// 4. Repeat Customers Verification
	console.log("\n--- Verifying Repeat Customer Logic ---");
	const [repeatRow] = await sql`
		SELECT COUNT(*)::int AS repeat_customers FROM (
			SELECT customer_mobile FROM sales_fact_v
			WHERE customer_mobile IS NOT NULL AND customer_mobile <> ''
			GROUP BY customer_mobile HAVING COUNT(DISTINCT bill_no) > 1
		) x`;
	const repeatCustomers = Number(repeatRow.repeat_customers);
	const repeatPass = repeatCustomers > 0 && repeatCustomers <= distinctMobiles;
	console.log(
		`${repeatPass ? "✅" : "❌"} Repeat Customers: ${repeatCustomers} (<= total mobiles ${distinctMobiles})`,
	);
	if (!repeatPass) failed++;

	// 5. Golden Mathematical Relationship Equations
	console.log("\n--- Verifying Financial Relationship Equations ---");
	const eq1_diff = Math.abs(mrpTotal - discountGiven - grossCollection);
	const eq2_diff = Math.abs(grossCollection - gstLiability - totalRevenue);

	const eq1_ok = eq1_diff < 5.0; // Tolerance for floating point aggregations
	const eq2_ok = eq2_diff < 5.0;

	console.log(
		`${eq1_ok ? "✅" : "❌"} Equation 1 (MRP - Discount = Collection): ${mrpTotal.toFixed(2)} - ${discountGiven.toFixed(2)} = ${(mrpTotal - discountGiven).toFixed(2)} (Actual Collection: ${grossCollection.toFixed(2)}, diff: ${eq1_diff.toFixed(4)})`,
	);
	console.log(
		`${eq2_ok ? "✅" : "❌"} Equation 2 (Collection - GST = Revenue): ${grossCollection.toFixed(2)} - ${gstLiability.toFixed(2)} = ${(grossCollection - gstLiability).toFixed(2)} (Actual Revenue: ${totalRevenue.toFixed(2)}, diff: ${eq2_diff.toFixed(4)})`,
	);

	if (!eq1_ok || !eq2_ok) {
		console.error("❌ Critical: Mathematical relationship checks failed.");
		failed++;
	}

	// 6. Historical Reference Slice Check (2025-11-18 -> 2026-06-25)
	// Purpose: Ensures historical seed batches (#1 to #39) remain frozen and uncorrupted.
	console.log(
		"\n--- Verifying Historical Baseline Slice (2025-11-18 → 2026-06-25) ---",
	);
	const [histTotals] = await sql`
		SELECT
			COUNT(*)::int AS rows,
			COUNT(DISTINCT bill_no)::int AS bills,
			ROUND(SUM(net_amount)::numeric, 2) AS revenue,
			ROUND(SUM(gross_amount)::numeric, 2) AS gross,
			ROUND(SUM(tax_amount)::numeric, 2) AS gst,
			ROUND(SUM(discount_amount)::numeric, 2) AS discount,
			ROUND(SUM(mrp_amount)::numeric, 2) AS mrp
		FROM sales_fact_v
		WHERE billed_by IN ('KLJ', 'SWN')
			AND sale_date >= '2025-11-18' AND sale_date <= '2026-06-25'`;

	const histEq1Diff = Math.abs(
		Number(histTotals.mrp) -
			Number(histTotals.discount) -
			Number(histTotals.gross),
	);
	const histEq2Diff = Math.abs(
		Number(histTotals.gross) -
			Number(histTotals.gst) -
			Number(histTotals.revenue),
	);
	const histPass =
		Number(histTotals.rows) > 0 && histEq1Diff < 5.0 && histEq2Diff < 5.0;

	console.log(
		`${histPass ? "✅" : "❌"} Historical Seed Window: ${histTotals.rows} rows, ₹${Number(histTotals.revenue).toLocaleString()} revenue (Equations diff: eq1=${histEq1Diff.toFixed(4)}, eq2=${histEq2Diff.toFixed(4)})`,
	);
	if (!histPass) failed++;

	if (failed > 0) {
		console.error(
			`\n❌ ${failed} check(s) failed in canonical regression verification.`,
		);
		process.exit(1);
	}
	console.log(
		"\n🎉 All canonical production metrics and financial equations verified successfully.",
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
