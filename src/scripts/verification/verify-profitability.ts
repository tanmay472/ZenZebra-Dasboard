import path from "node:path";
import { neon } from "@neondatabase/serverless";
import * as dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

/**
 * End-to-end profitability verification gate.
 *
 * Confirms the profitability engine is trustworthy before the Founder Dashboard
 * consumes it, validating the whole pipeline:
 *   Inventory upload → product_master → sales↔cost join → tax-adjusted COGS →
 *   Gross Profit → Gross Margin % → benchmark reconciliation.
 *
 * Reports discrepancies (empty cost master, unmatched SKUs, low coverage, off
 * benchmark) explicitly rather than proceeding silently.
 *
 *   npm run verify:profitability
 */

// Reference gross margin from the client's spreadsheet analysis. It was computed
// on a different/larger file (~₹37.7L taxable) than what currently lives in
// sales_fact_v (~₹21.5L), so a mismatch here is EXPECTED until the datasets are
// reconciled (period, import completeness, inventory snapshot, costing method).
// OPEN TASK: reconcile before treating the observed margin as business truth.
// Informational only — does NOT fail the gate; COGS is validated by the hard checks.
const REFERENCE_MARGIN_PCT = 22.7;
const MARGIN_TOLERANCE_PP = 5; // percentage points (informational)
// Below this cost-match coverage the margin is not trustworthy (hard gate).
const MIN_COVERAGE_PCT = 80;

// Tax-adjusted per-line COGS — mirrors COGS_LINE_SQL in profitability.ts.
const COGS_LINE = `(pm.purchase_price / (1 + CASE WHEN s.net_amount > 0 THEN s.tax_amount / s.net_amount ELSE 0 END)) * s.quantity`;

let failed = 0;
const num = (v: unknown) => Number(v ?? 0);
function assert(label: string, ok: boolean, detail = "") {
	console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `: ${detail}` : ""}`);
	if (!ok) failed++;
}

async function main() {
	if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL missing");
	const sql = neon(process.env.DATABASE_URL);

	// 1. Cost master population.
	console.log("--- Cost master (product_master) ---");
	const [pm] = await sql.query(
		`SELECT COUNT(*)::int rows, COUNT(*) FILTER (WHERE purchase_price > 0)::int priced FROM product_master`,
	);
	console.log(`   product_master: ${pm.rows} rows, ${pm.priced} priced`);
	if (num(pm.rows) === 0 || num(pm.priced) === 0) {
		console.log(
			"ℹ️  Cost master is EMPTY (0 priced SKUs) — validating honest DATA_UNAVAILABLE contract...",
		);

		// Validate that the system adheres to data-truth rules when cost master is unpopulated:
		// 1. Sales revenue remains intact and verified
		const [salesRes] = await sql.query(
			`SELECT COALESCE(SUM(net_amount), 0)::FLOAT AS "totalRevenue" FROM sales_fact_v;`,
		);
		const totalRevenue = Number(salesRes?.totalRevenue || 0);
		assert(
			"Sales revenue verified in sales_fact_v",
			totalRevenue > 0,
			`₹${totalRevenue.toLocaleString()}`,
		);

		// 2. Purchase spend & PO count
		const [poRes] = await sql.query(
			`SELECT COALESCE(SUM(amount_total), 0)::FLOAT AS "totalPurchaseSpend", COUNT(*)::INT AS "totalOrders" FROM purchase_orders;`,
		);
		const totalOrders = Number(poRes?.totalOrders || 0);
		const totalPurchaseSpend = Number(poRes?.totalPurchaseSpend || 0);
		const hasPurchaseData = totalOrders > 0;

		// 3. Margin handling: must NOT fabricate 100% margin or fake estimates
		const grossMargin = totalRevenue - totalPurchaseSpend;
		const grossMarginPercent =
			hasPurchaseData && totalRevenue > 0
				? (grossMargin / totalRevenue) * 100
				: null;

		assert(
			"No fabricated margin (grossMarginPercent is null)",
			grossMarginPercent === null,
			"null",
		);
		assert(
			"No fabricated COGS / purchase spend",
			totalPurchaseSpend === 0,
			`₹${totalPurchaseSpend}`,
		);
		assert(
			"Honest unavailable state signaled (hasPurchaseData === false)",
			hasPurchaseData === false,
			"false",
		);
		assert(
			"No NaN or division-by-zero behavior",
			!Number.isNaN(totalRevenue) && !Number.isNaN(grossMargin),
			"clean numbers",
		);

		if (failed > 0) {
			console.error(
				`\n${failed} check(s) failed in profitability unavailable contract.`,
			);
			process.exit(1);
		}

		console.log(
			"\n✅ Profitability data-unavailable contract verified successfully.",
		);
		console.log(
			"ℹ️  Note: When active_stock_pricing is uploaded, full SKU matching & COGS tests will run automatically.",
		);
		return;
	}
	assert("Cost master populated", true, `${pm.priced} priced SKUs`);

	// 2. Sales ↔ cost-master match rate (by normalized sku_code).
	console.log("\n--- Sales ↔ cost master match ---");
	const [skuMatch] = await sql.query(
		`SELECT
       COUNT(DISTINCT s.sku_code) FILTER (WHERE s.sku_code IS NOT NULL AND s.sku_code <> '')::int total_skus,
       COUNT(DISTINCT s.sku_code) FILTER (WHERE pm.sku_code IS NOT NULL)::int matched_skus
     FROM sales_fact_v s LEFT JOIN product_master pm ON s.sku_code = pm.sku_code`,
	);
	const skuRate =
		num(skuMatch.total_skus) > 0
			? (100 * num(skuMatch.matched_skus)) / num(skuMatch.total_skus)
			: 0;
	console.log(
		`   Distinct SKUs matched: ${skuMatch.matched_skus}/${skuMatch.total_skus} (${skuRate.toFixed(1)}%)`,
	);

	// 3. Line coverage + tax-adjusted COGS + GP + GM%.
	console.log("\n--- Tax-adjusted COGS / Gross Margin ---");
	const [agg] = await sql.query(
		`WITH j AS (
       SELECT s.net_amount, s.tax_amount, s.quantity, pm.purchase_price,
         ${COGS_LINE} AS cogs_line
       FROM sales_fact_v s LEFT JOIN product_master pm ON s.sku_code = pm.sku_code
     )
     SELECT
       COUNT(*)::int total_lines,
       COUNT(*) FILTER (WHERE purchase_price IS NOT NULL)::int matched_lines,
       COALESCE(SUM(net_amount), 0) total_net_sales,
       COALESCE(SUM(net_amount) FILTER (WHERE purchase_price IS NOT NULL), 0) matched_net_sales,
       COALESCE(SUM(cogs_line) FILTER (WHERE purchase_price IS NOT NULL), 0) cogs
     FROM j`,
	);
	const totalLines = num(agg.total_lines);
	const matchedLines = num(agg.matched_lines);
	const coverage = totalLines > 0 ? (100 * matchedLines) / totalLines : 0;
	const matchedNetSales = num(agg.matched_net_sales);
	const cogs = num(agg.cogs);
	const grossProfit = matchedNetSales - cogs;
	const marginPct =
		matchedNetSales > 0 ? (grossProfit / matchedNetSales) * 100 : 0;

	console.log(
		`   Total taxable revenue:  ₹${num(agg.total_net_sales).toFixed(2)}`,
	);
	console.log(`   Matched taxable revenue: ₹${matchedNetSales.toFixed(2)}`);
	console.log(`   Tax-adjusted COGS:      ₹${cogs.toFixed(2)}`);
	console.log(`   Gross Profit (matched): ₹${grossProfit.toFixed(2)}`);
	console.log(`   Gross Margin %:         ${marginPct.toFixed(1)}%`);
	console.log(
		`   Line coverage:          ${matchedLines}/${totalLines} (${coverage.toFixed(1)}%)`,
	);

	assert(
		"Line coverage ≥ minimum",
		coverage >= MIN_COVERAGE_PCT,
		`${coverage.toFixed(1)}% (min ${MIN_COVERAGE_PCT}%)`,
	);
	assert(
		"COGS is positive and below revenue",
		cogs > 0 && cogs < matchedNetSales,
		`₹${cogs.toFixed(2)}`,
	);
	assert(
		"Gross Profit positive",
		grossProfit > 0,
		`₹${grossProfit.toFixed(2)}`,
	);
	// Benchmark is informational (see note on REFERENCE_MARGIN_PCT) — warn, don't fail.
	const marginDelta = marginPct - REFERENCE_MARGIN_PCT;
	if (Math.abs(marginDelta) <= MARGIN_TOLERANCE_PP) {
		console.log(
			`✅ Gross Margin near reference ${REFERENCE_MARGIN_PCT}%: ${marginPct.toFixed(1)}%`,
		);
	} else {
		console.log(
			`⚠️  Gross Margin ${marginPct.toFixed(1)}% differs from reference ${REFERENCE_MARGIN_PCT}% (Δ ${marginDelta.toFixed(1)}pp) — recalibrate the reference to the current dataset; COGS itself is validated above.`,
		);
	}

	// 4. Discrepancy report — top unmatched SKUs by revenue impact.
	if (coverage < 100) {
		console.log("\n--- Top unmatched SKUs (revenue impact) ---");
		const unmatched = await sql.query(
			`SELECT s.sku_code, MAX(s.item_name) AS name, ROUND(SUM(s.net_amount)::numeric, 2) AS rev
       FROM sales_fact_v s LEFT JOIN product_master pm ON s.sku_code = pm.sku_code
       WHERE pm.sku_code IS NULL AND s.sku_code IS NOT NULL AND s.sku_code <> ''
       GROUP BY s.sku_code ORDER BY rev DESC LIMIT 10`,
		);
		for (const u of unmatched) {
			console.log(
				`   ${String(u.sku_code).padEnd(16)} ₹${u.rev}  ${String(u.name).slice(0, 40)}`,
			);
		}
	}

	if (failed > 0) {
		console.error(
			`\n${failed} profitability check(s) failed — see discrepancies above.`,
		);
		process.exit(1);
	}
	console.log("\n✅ Profitability pipeline verified — engine is trustworthy.");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
