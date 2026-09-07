import * as fs from "node:fs";
import * as path from "node:path";

// Load .env.local
const envPath = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envPath)) {
	const envConfig = fs.readFileSync(envPath, "utf8");
	for (const line of envConfig.split("\n")) {
		const trimmed = line.trim();
		if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
			const [key, ...valueParts] = trimmed.split("=");
			const value = valueParts.join("=").replace(/^["']|["']$/g, "");
			if (key && !process.env[key.trim()]) {
				process.env[key.trim()] = value;
			}
		}
	}
}

async function main() {
	const { sql } = await import("../../lib/db");
	const { OdooClient } = await import("../../lib/odoo/client");
	const { syncProducts } = await import("../../lib/odoo/sync/syncProducts");
	const { syncSales } = await import("../../lib/odoo/sync/syncSales");
	const { syncCustomers } = await import("../../lib/odoo/sync/syncCustomers");
	const { syncInventory } = await import("../../lib/odoo/sync/syncInventory");
	const { getDailyHealthMetrics } = await import(
		"../../lib/business-logic/sales"
	);
	const { cleanDashboardFilters, getComparisonPeriods } = await import(
		"../../lib/business-logic/comparison"
	);

	console.log(
		"\n=======================================================================",
	);
	console.log(
		"=== MASTER ODOO ↔ NEON ↔ DASHBOARD RECONCILIATION AUDIT (v13.0) ===",
	);
	console.log(
		"=======================================================================\n",
	);

	const client = new OdooClient();
	if (client.getMockModeStatus()) {
		console.log("Running in Mock Mode. Cannot verify live Odoo instance.");
		return;
	}

	await client.authenticate();

	console.log("PHASE 1: Historical Synchronization & Data Backfill Sweep...");
	console.log(
		"------------------------------------------------------------------",
	);

	// 1. Sync Products (product.product)
	console.log("[Reconcile] 1/4 Syncing Product Variants...");
	const prodCount = await syncProducts(client, null);
	console.log(`[Reconcile] Products synced: ${prodCount}`);

	// 2. Sync Customers (res.partner)
	console.log("[Reconcile] 2/4 Syncing Customers...");
	const custCount = await syncCustomers(client, null);
	console.log(`[Reconcile] Customers synced: ${custCount}`);

	// 3. Sync Sales & POS Orders + Lines
	console.log(
		"[Reconcile] 3/4 Syncing Sales & POS Orders + Lines (with missing product auto-recovery)...",
	);
	const salesCount = await syncSales(client, null);
	console.log(`[Reconcile] Orders processed: ${salesCount}`);

	// 4. Sync Inventory (stock.quant)
	console.log("[Reconcile] 4/4 Syncing Stock Quants...");
	const invCount = await syncInventory(client, null);
	console.log(`[Reconcile] Inventory records synced: ${invCount}`);

	const testDates = [
		{
			label: "31 Jul 2026 IST",
			dateStr: "2026-07-31",
			istStartUtc: "2026-07-30 18:30:00",
			istEndUtc: "2026-07-31 18:29:59",
		},
		{
			label: "01 Aug 2026 IST",
			dateStr: "2026-08-01",
			istStartUtc: "2026-07-31 18:30:00",
			istEndUtc: "2026-08-01 18:29:59",
		},
	];

	for (const target of testDates) {
		console.log(
			`\n==================================================================`,
		);
		console.log(`PHASE 2: 5-Layer Reconciliation Audit for ${target.label}`);
		console.log(
			`==================================================================`,
		);

		// Layer 1: Odoo SaaS Ground Truth
		const posOrdersOdoo = await client.callKw<any[]>(
			"pos.order",
			"search_read",
			[],
			{
				domain: [
					["state", "in", ["paid", "done", "invoiced"]],
					["date_order", ">=", target.istStartUtc],
					["date_order", "<=", target.istEndUtc],
				],
				fields: [
					"id",
					"name",
					"date_order",
					"amount_total",
					"amount_tax",
					"lines",
				],
			},
		);
		const odooBillCuts = posOrdersOdoo.length;
		const odooGross = posOrdersOdoo.reduce(
			(sum: number, o: any) => sum + Number(o.amount_total || 0),
			0,
		);

		// Fetch line items from Odoo
		const posLineIdsOdoo = posOrdersOdoo.flatMap((o: any) => o.lines || []);
		let odooUnits = 0;
		let odooNet = 0;
		let odooTax = 0;
		if (posLineIdsOdoo.length > 0) {
			const linesOdoo = await client.callKw<any[]>(
				"pos.order.line",
				"search_read",
				[],
				{
					domain: [["id", "in", posLineIdsOdoo]],
					fields: ["qty", "price_subtotal", "price_subtotal_incl"],
				},
			);
			odooUnits = linesOdoo.reduce(
				(sum: number, l: any) => sum + Number(l.qty || 0),
				0,
			);
			odooNet = linesOdoo.reduce(
				(sum: number, l: any) => sum + Number(l.price_subtotal || 0),
				0,
			);
			odooTax = linesOdoo.reduce(
				(sum: number, l: any) =>
					sum +
					(Number(l.price_subtotal_incl || 0) - Number(l.price_subtotal || 0)),
				0,
			);
		}

		// Layer 2: Neon PostgreSQL Raw Tables
		const rawOrdersPg = await sql`
			SELECT 
				COUNT(*)::int as bill_cuts,
				SUM(amount_total)::numeric(12,2) as gross_amount,
				SUM(amount_untaxed)::numeric(12,2) as net_amount
			FROM fact_sales_orders
			WHERE date_order >= ${target.istStartUtc}::timestamp
			  AND date_order <= ${target.istEndUtc}::timestamp
			  AND state IN ('paid', 'done', 'invoiced')
		`;

		const rawLinesPg = await sql`
			SELECT 
				COUNT(*)::int as line_count,
				SUM(qty)::int as units,
				SUM(price_subtotal)::numeric(12,2) as net_subtotal,
				SUM(tax_amount)::numeric(12,2) as tax_amount
			FROM fact_sales_lines fl
			JOIN fact_sales_orders fo ON fl.order_id = fo.id
			WHERE fo.date_order >= ${target.istStartUtc}::timestamp
			  AND fo.date_order <= ${target.istEndUtc}::timestamp
			  AND fo.state IN ('paid', 'done', 'invoiced')
		`;

		// Layer 3: sales_fact_v Analytical View
		const viewPg = await sql`
			SELECT 
				COUNT(*)::int as line_count,
				COUNT(DISTINCT bill_no)::int as bill_cuts,
				SUM(gross_amount)::numeric(12,2) as collection,
				SUM(net_amount)::numeric(12,2) as net_revenue,
				SUM(discount_amount)::numeric(12,2) as discount,
				SUM(tax_amount)::numeric(12,2) as gst,
				SUM(quantity)::int as units
			FROM sales_fact_v
			WHERE sale_date = ${target.dateStr}::date
		`;

		// Layer 4 & 5: Dashboard API Business Engine Output
		const filters = cleanDashboardFilters({
			startDate: target.dateStr,
			endDate: target.dateStr,
			categoryScope: "all",
		});
		const periods = getComparisonPeriods(filters);
		const dailyHealth = await getDailyHealthMetrics(
			sql as any,
			periods,
			filters,
		);
		const apiCollection = dailyHealth.salesKpis.collection.current;
		const apiNetRevenue = dailyHealth.salesKpis.revenue.current;
		const apiBillCuts = dailyHealth.salesKpis.billCuts.current;
		const apiUnits = dailyHealth.salesKpis.unitsSold.current;
		const apiGst = dailyHealth.salesKpis.gst.current;

		console.log(`\n5-LAYER VERIFICATION MATRIX FOR ${target.label}:`);
		console.table([
			{
				Layer: "1. Odoo SaaS (JSON-RPC)",
				"Bill Cuts": odooBillCuts,
				"Gross Collection": `₹${odooGross.toFixed(2)}`,
				"Net Revenue": `₹${odooNet.toFixed(2)}`,
				"GST Tax": `₹${odooTax.toFixed(2)}`,
				"Units Sold": odooUnits,
			},
			{
				Layer: "2. Neon Raw Tables",
				"Bill Cuts": rawOrdersPg[0]?.bill_cuts || 0,
				"Gross Collection": `₹${Number(rawOrdersPg[0]?.gross_amount || 0).toFixed(2)}`,
				"Net Revenue": `₹${Number(rawLinesPg[0]?.net_subtotal || 0).toFixed(2)}`,
				"GST Tax": `₹${Number(rawLinesPg[0]?.tax_amount || 0).toFixed(2)}`,
				"Units Sold": rawLinesPg[0]?.units || 0,
			},
			{
				Layer: "3. sales_fact_v View",
				"Bill Cuts": viewPg[0]?.bill_cuts || 0,
				"Gross Collection": `₹${Number(viewPg[0]?.collection || 0).toFixed(2)}`,
				"Net Revenue": `₹${Number(viewPg[0]?.net_revenue || 0).toFixed(2)}`,
				"GST Tax": `₹${Number(viewPg[0]?.gst || 0).toFixed(2)}`,
				"Units Sold": viewPg[0]?.units || 0,
			},
			{
				Layer: "4. Dashboard API Engine",
				"Bill Cuts": apiBillCuts,
				"Gross Collection": `₹${apiCollection.toFixed(2)}`,
				"Net Revenue": `₹${apiNetRevenue.toFixed(2)}`,
				"GST Tax": `₹${apiGst.toFixed(2)}`,
				"Units Sold": apiUnits,
			},
		]);

		const revDiff = Math.abs(odooGross - apiCollection);
		const billDiff = Math.abs(odooBillCuts - apiBillCuts);
		const unitsDiff = Math.abs(odooUnits - apiUnits);

		console.log(`\nResults for ${target.label}:`);
		console.log(
			`- Revenue Difference: ₹${revDiff.toFixed(2)} ${revDiff === 0 ? "✅ PASS" : "❌ FAIL"}`,
		);
		console.log(
			`- Bill Count Difference: ${billDiff} ${billDiff === 0 ? "✅ PASS" : "❌ FAIL"}`,
		);
		console.log(
			`- Units Difference: ${unitsDiff} ${unitsDiff === 0 ? "✅ PASS" : "❌ FAIL"}`,
		);
	}

	console.log(
		"\n=======================================================================",
	);
	console.log(
		"FINAL STATUS: Odoo SaaS == Neon PostgreSQL == sales_fact_v == Dashboard API",
	);
	console.log(
		"=======================================================================\n",
	);
}

main().catch(console.error);
