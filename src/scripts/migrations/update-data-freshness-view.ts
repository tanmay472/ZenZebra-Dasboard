import * as path from "node:path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

async function main() {
	if (!process.env.DATABASE_URL) {
		console.error("❌ DATABASE_URL is not set.");
		process.exit(1);
	}

	const { sql } = await import("../../lib/db");

	console.log("Updating data_freshness view to query sales_fact_v...");

	await sql`DROP VIEW IF EXISTS data_freshness CASCADE`;

	await sql`
		CREATE OR REPLACE VIEW data_freshness AS
		SELECT
			MAX(sfv.sale_date) AS latest_sale_date,
			CURRENT_DATE - MAX(sfv.sale_date) AS days_stale,
			COUNT(DISTINCT sfv.order_id) AS total_bills,
			COALESCE(SUM(sfv.net_amount), 0) AS total_revenue,
			(SELECT MAX(uploaded_at) FROM upload_batches) AS last_upload_at
		FROM sales_fact_v sfv
	`;

	console.log("✅ data_freshness view updated to query sales_fact_v!");
}

main().catch((err) => {
	console.error("❌ View update failed:", err.message || err);
	process.exit(1);
});
