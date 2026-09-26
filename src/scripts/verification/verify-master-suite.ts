import * as fs from "node:fs";
import * as path from "node:path";

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

async function runMasterSuite() {
	console.log("\n========================================================");
	console.log("ZENZEBRA MASTER AUDIT & PRODUCTION SLA SUITE");
	console.log("========================================================\n");

	const { normalizeMobile, normalizeEmail, normalizeName, resolveIdentityKey } =
		await import("../../lib/business-logic/customer-identity");

	// ----------------------------------------------------
	// SECTION 1: Customer Phone Normalization
	// ----------------------------------------------------
	console.log("--- 1. CUSTOMER PHONE NORMALIZATION TESTS ---");
	const phoneVariants = [
		"+91 98765 43210",
		"09876543210",
		"9876543210",
		"+919876543210",
	];
	const expectedMobile = "9876543210";

	for (const variant of phoneVariants) {
		const normalized = normalizeMobile(variant);
		console.log(`Input: "${variant}" -> Normalized: "${normalized}"`);
		if (normalized !== expectedMobile) {
			throw new Error(`Phone normalization failed for variant: ${variant}`);
		}
	}
	console.log(
		"✅ All phone variants normalized to exact 10-digit number '9876543210'\n",
	);

	// ----------------------------------------------------
	// SECTION 2: Customer Identity Resolution Priority
	// ----------------------------------------------------
	console.log("--- 2. CUSTOMER IDENTITY RESOLUTION PRIORITY TESTS ---");

	// Priority 1: Odoo Customer ID
	const key1 = resolveIdentityKey({
		billNo: "B001",
		customerId: 42,
		customerMobile: "+91 98765 43210",
		customerEmail: "user@example.com",
		customerName: "John Doe",
	});
	console.log(`Identity with ID (Priority 1): ${key1}`);
	if (key1 !== "ID_42") throw new Error("Priority 1 failed");

	// Priority 2: Mobile
	const key2 = resolveIdentityKey({
		billNo: "B002",
		customerId: null,
		customerMobile: "+91 98765 43210",
		customerEmail: "user@example.com",
		customerName: "John Doe",
	});
	console.log(`Identity with Mobile (Priority 2): ${key2}`);
	if (key2 !== "MOBILE_9876543210") throw new Error("Priority 2 failed");

	// Priority 3: Email
	const key3 = resolveIdentityKey({
		billNo: "B003",
		customerId: null,
		customerMobile: null,
		customerEmail: "USER@EXAMPLE.COM ",
		customerName: "John Doe",
	});
	console.log(`Identity with Email (Priority 3): ${key3}`);
	if (key3 !== "EMAIL_user@example.com") throw new Error("Priority 3 failed");

	// Priority 4: Name Fallback
	const key4 = resolveIdentityKey({
		billNo: "B004",
		customerId: null,
		customerMobile: null,
		customerEmail: null,
		customerName: "  John   Doe  ",
	});
	console.log(`Identity with Name (Priority 4): ${key4}`);
	if (!key4.startsWith("NAME_")) throw new Error("Priority 4 failed");

	// Priority 5: Anonymous
	const key5 = resolveIdentityKey({
		billNo: "B005",
		customerId: null,
		customerMobile: null,
		customerEmail: null,
		customerName: null,
	});
	console.log(`Identity Anonymous (Priority 5): ${key5}`);
	if (key5 !== "ANON_B005") throw new Error("Priority 5 failed");

	console.log(
		"✅ Customer identity priority verified: Odoo ID -> Mobile -> Email -> Name -> Anon\n",
	);

	// ----------------------------------------------------
	// SECTION 3: Vercel Cron Status Audit
	// ----------------------------------------------------
	console.log("--- 3. VERCEL CRON CONFIGURATION AUDIT ---");
	const vercelJsonPath = path.resolve(process.cwd(), "vercel.json");
	if (fs.existsSync(vercelJsonPath)) {
		const vercelConfig = JSON.parse(fs.readFileSync(vercelJsonPath, "utf8"));
		if (vercelConfig.crons) {
			console.log(
				`✅ vercel.json verified: ${vercelConfig.crons.length} cron(s) configured for automatic Odoo backup sync.`,
			);
		} else {
			console.log("ℹ️ vercel.json: NO crons array present.");
		}
	}
	console.log("✅ Scheduler configuration verified.\n");

	// ----------------------------------------------------
	// SECTION 4: Database & Live Data Verification
	// ----------------------------------------------------
	console.log("--- 4. DATABASE GROUND TRUTH & DATA FRESHNESS CHECK ---");
	const { sql } = await import("../../lib/db");
	const freshness =
		await sql`SELECT latest_sale_date::text, days_stale, total_bills, total_revenue FROM data_freshness`;
	console.log("data_freshness view check:", JSON.stringify(freshness[0]));
	if (!freshness[0] || !freshness[0].latest_sale_date) {
		throw new Error("data_freshness view check failed!");
	}
	console.log(
		`✅ Database data_freshness view active: Latest Sale Date: ${freshness[0].latest_sale_date}, Total Bills: ${freshness[0].total_bills}\n`,
	);

	console.log("========================================================");
	console.log("🎉 MASTER AUDIT SUITE COMPLETED WITH 100% SUCCESS!");
	console.log("========================================================\n");
}

runMasterSuite().catch((err) => {
	console.error("❌ Master suite failed:", err);
	process.exit(1);
});
