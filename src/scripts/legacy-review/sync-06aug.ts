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

	console.log(
		"\n=======================================================================",
	);
	console.log("=== FULL ODOO SYNC — 06 AUGUST 2026 ===");
	console.log(
		"=======================================================================\n",
	);

	const client = new OdooClient();
	if (client.getMockModeStatus()) {
		console.error(
			"❌ Client is in Mock Mode. Set Odoo credentials in .env.local to run a live sync.",
		);
		process.exit(1);
	}

	await client.authenticate();
	console.log("✅ Authenticated to Odoo SaaS\n");

	// -----------------------------------------------------------------------
	// PHASE 1: Full Sync (lastSync = null → pulls ALL records)
	// -----------------------------------------------------------------------
	console.log("PHASE 1: Full Data Sync from Odoo → Neon PostgreSQL");
	console.log(
		"------------------------------------------------------------------",
	);

	console.log("[1/4] Syncing Product Variants (product.product)...");
	const prodCount = await syncProducts(client, null);
	console.log(`     ✅ Products upserted: ${prodCount}\n`);

	console.log("[2/4] Syncing Customers (res.partner)...");
	const custCount = await syncCustomers(client, null);
	console.log(`     ✅ Customers upserted: ${custCount}\n`);

	console.log(
		"[3/4] Syncing Sales & POS Orders + Lines (sale.order + pos.order)...",
	);
	const salesCount = await syncSales(client, null);
	console.log(`     ✅ Orders processed: ${salesCount}\n`);

	console.log("[4/4] Syncing Inventory Levels (stock.quant)...");
	const invCount = await syncInventory(client, null);
	console.log(`     ✅ Stock quants upserted: ${invCount}\n`);

	// -----------------------------------------------------------------------
	// PHASE 2: Quick Verification — 06 Aug 2026 IST counts
	// -----------------------------------------------------------------------
	console.log(
		"=======================================================================",
	);
	console.log("PHASE 2: 3-Layer Verification for 06 Aug 2026 IST");
	console.log(
		"=======================================================================",
	);

	const istStart = "2026-08-05 18:30:00"; // 06-Aug-2026 00:00 IST = 05-Aug UTC+5:30
	const istEnd = "2026-08-06 18:29:59"; // 06-Aug-2026 23:59 IST

	// Layer 1: Odoo SaaS (ground truth)
	console.log(
		"\n[Layer 1] Querying Odoo SaaS POS orders for 06-Aug-2026 IST...",
	);
	const posOrdersOdoo = await client.callKw<any[]>(
		"pos.order",
		"search_read",
		[],
		{
			domain: [
				["state", "in", ["paid", "done", "invoiced"]],
				["date_order", ">=", istStart],
				["date_order", "<=", istEnd],
			],
			fields: ["id", "name", "date_order", "amount_total", "lines"],
		},
	);
	const odooGross = posOrdersOdoo.reduce(
		(sum: number, o: any) => sum + Number(o.amount_total || 0),
		0,
	);
	console.log(
		`     Odoo → Bill Cuts: ${posOrdersOdoo.length}, Gross: ₹${odooGross.toFixed(2)}`,
	);

	// Layer 2: Neon Raw Tables
	console.log(
		"[Layer 2] Querying Neon fact_sales_orders for 06-Aug-2026 IST...",
	);
	const rawPg = await sql`
		SELECT
			COUNT(*)::int            AS bill_cuts,
			SUM(amount_total)::numeric(12,2) AS gross_amount,
			SUM(amount_untaxed)::numeric(12,2) AS net_amount
		FROM fact_sales_orders
		WHERE date_order >= ${istStart}::timestamp
		  AND date_order <= ${istEnd}::timestamp
		  AND state IN ('paid', 'done', 'invoiced')
	`;
	const pgGross = Number(rawPg[0]?.gross_amount || 0);
	console.log(
		`     Neon → Bill Cuts: ${rawPg[0]?.bill_cuts || 0}, Gross: ₹${pgGross.toFixed(2)}`,
	);

	// Layer 3: Analytical View
	console.log("[Layer 3] Querying sales_fact_v view for 2026-08-06...");
	const viewPg = await sql`
		SELECT
			COUNT(DISTINCT bill_no)::int             AS bill_cuts,
			SUM(gross_amount)::numeric(12,2)         AS collection,
			SUM(net_amount)::numeric(12,2)           AS net_revenue,
			SUM(quantity)::int                       AS units
		FROM sales_fact_v
		WHERE sale_date = '2026-08-06'::date
	`;
	const viewGross = Number(viewPg[0]?.collection || 0);
	console.log(
		`     View → Bill Cuts: ${viewPg[0]?.bill_cuts || 0}, Gross: ₹${viewGross.toFixed(2)}, Units: ${viewPg[0]?.units || 0}`,
	);

	// -----------------------------------------------------------------------
	// PHASE 3: Reconciliation Summary
	// -----------------------------------------------------------------------
	console.log(
		"\n=======================================================================",
	);
	console.log("RECONCILIATION SUMMARY — 06 Aug 2026");
	console.log(
		"=======================================================================",
	);
	console.table([
		{
			Layer: "1. Odoo SaaS (Ground Truth)",
			"Bill Cuts": posOrdersOdoo.length,
			"Gross Collection": `₹${odooGross.toFixed(2)}`,
		},
		{
			Layer: "2. Neon Raw Tables",
			"Bill Cuts": rawPg[0]?.bill_cuts || 0,
			"Gross Collection": `₹${pgGross.toFixed(2)}`,
		},
		{
			Layer: "3. sales_fact_v View",
			"Bill Cuts": viewPg[0]?.bill_cuts || 0,
			"Gross Collection": `₹${viewGross.toFixed(2)}`,
		},
	]);

	const grossDiff = Math.abs(odooGross - viewGross);
	const billDiff = Math.abs(posOrdersOdoo.length - (viewPg[0]?.bill_cuts || 0));

	console.log(
		`\nRevenue parity: ₹${grossDiff.toFixed(2)} diff ${grossDiff < 1 ? "✅ PASS" : "❌ FAIL — investigate"}`,
	);
	console.log(
		`Bill count parity: ${billDiff} diff ${billDiff === 0 ? "✅ PASS" : "❌ FAIL — investigate"}`,
	);

	console.log(
		"\n=======================================================================",
	);
	console.log("Full Odoo sync for 06-Aug-2026 COMPLETE.");
	console.log(
		"=======================================================================\n",
	);
}

main().catch(console.error);
