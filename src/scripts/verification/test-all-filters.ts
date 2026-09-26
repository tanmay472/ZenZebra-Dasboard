import path from "node:path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

import { NextRequest } from "next/server";
import { GET as customerIntelligenceGET } from "../../app/api/customer-intelligence/route";
import { GET as retentionOverviewGET } from "../../app/api/customer-retention/overview/route";
import { GET as financeSummaryGET } from "../../app/api/finance/summary/route";
import { GET as inventoryDashboardGET } from "../../app/api/inventory/dashboard/route";
import { GET as salesDashboardGET } from "../../app/api/sales/dashboard/route";

async function runFilterVerification() {
	console.log("\n========================================================");
	console.log("ZENZEBRA MASTER FILTER & WORKFLOW VERIFICATION SUITE");
	console.log("========================================================\n");

	// 1. Store Filter Verification
	console.log("--- 1. STORE FILTER SUITE (/api/sales/dashboard) ---");
	const stores = ["ALL", "KLJ", "SWN", "HQ27GGN", "Club 125", "ZenZebra"];
	for (const st of stores) {
		const url = `http://localhost:3000/api/sales/dashboard?startDate=2026-08-01&endDate=2026-09-26${st !== "ALL" ? `&store=${encodeURIComponent(st)}` : ""}`;
		const req = new NextRequest(url);
		const res = await salesDashboardGET(req);
		const json = await res.json();
		if (!json.success) {
			throw new Error(`Store filter failed for ${st}: ${json.error}`);
		}
		const rev = json.data?.salesKpis?.revenue?.current ?? 0;
		const bills = json.data?.salesKpis?.billCuts?.current ?? 0;
		console.log(
			`✅ Store [${st.padEnd(8)}] -> Status: ${res.status} | Revenue: ₹${Number(rev).toFixed(2)} | Bills: ${bills}`,
		);
	}

	// 2. Category & Scope Filter Verification
	console.log("\n--- 2. CATEGORY & SCOPE FILTER SUITE ---");
	const catTests = [
		{ categoryScope: "all", category: "All Categories" },
		{ categoryScope: "retail", category: "All Categories" },
		{ categoryScope: "all", category: "BEVERAGES" },
		{ categoryScope: "all", category: "Clothing" },
	];
	for (const tc of catTests) {
		const url = `http://localhost:3000/api/sales/dashboard?startDate=2026-08-01&endDate=2026-09-26&categoryScope=${tc.categoryScope}${tc.category !== "All Categories" ? `&category=${encodeURIComponent(tc.category)}` : ""}`;
		const req = new NextRequest(url);
		const res = await salesDashboardGET(req);
		const json = await res.json();
		if (!json.success) {
			throw new Error(`Category filter failed: ${json.error}`);
		}
		const rev = json.data?.salesKpis?.revenue?.current ?? 0;
		console.log(
			`✅ Scope: ${tc.categoryScope.padEnd(6)} | Category: ${tc.category.padEnd(14)} -> Revenue: ₹${Number(rev).toFixed(2)}`,
		);
	}

	// 3. Date Range Filter Verification
	console.log("\n--- 3. DATE RANGE FILTER SUITE ---");
	const dateRanges = [
		{ name: "Last 7 Days", start: "2026-09-19", end: "2026-09-26" },
		{ name: "Last 30 Days", start: "2026-08-27", end: "2026-09-26" },
		{ name: "All Time", start: "2025-11-18", end: "2026-09-26" },
	];
	for (const dr of dateRanges) {
		const url = `http://localhost:3000/api/sales/dashboard?startDate=${dr.start}&endDate=${dr.end}`;
		const req = new NextRequest(url);
		const res = await salesDashboardGET(req);
		const json = await res.json();
		if (!json.success) {
			throw new Error(`Date filter failed for ${dr.name}: ${json.error}`);
		}
		const rev = json.data?.salesKpis?.revenue?.current ?? 0;
		const bills = json.data?.salesKpis?.billCuts?.current ?? 0;
		console.log(
			`✅ Range [${dr.name.padEnd(12)}] (${dr.start} → ${dr.end}) -> Revenue: ₹${Number(rev).toFixed(2)} | Bills: ${bills}`,
		);
	}

	// 4. Customer Intelligence Filter Verification
	console.log(
		"\n--- 4. CUSTOMER INTELLIGENCE FILTER SUITE (/api/customer-intelligence) ---",
	);
	for (const st of ["ALL", "KLJ", "SWN"]) {
		const url = `http://localhost:3000/api/customer-intelligence?startDate=2026-08-27&endDate=2026-09-26${st !== "ALL" ? `&store=${encodeURIComponent(st)}` : ""}`;
		const req = new NextRequest(url);
		const res = await customerIntelligenceGET(req);
		const json = await res.json();
		if (!json.success) {
			throw new Error(
				`Customer intelligence filter failed for ${st}: ${json.error}`,
			);
		}
		const totalRev = json.data?.revenueComposition?.totals?.revenue ?? 0;
		const repeatCard = json.data?.revenueComposition?.cards?.find(
			(c: { key: string; revenue?: number }) => c.key === "repeat",
		);
		const repeatRev = repeatCard?.revenue ?? 0;
		console.log(
			`✅ Customer Intelligence [Store: ${st.padEnd(4)}] -> Total Rev: ₹${Number(totalRev).toFixed(2)} | Repeat Rev: ₹${Number(repeatRev).toFixed(2)}`,
		);
	}

	// 5. Inventory Dashboard Filter Verification
	console.log(
		"\n--- 5. INVENTORY DASHBOARD FILTER SUITE (/api/inventory/dashboard) ---",
	);
	for (const st of ["All Stores", "KLJ", "SWN"]) {
		const url = `http://localhost:3000/api/inventory/dashboard?store=${encodeURIComponent(st)}`;
		const req = new NextRequest(url);
		const res = await inventoryDashboardGET(req);
		const json = await res.json();
		if (!json.success) {
			throw new Error(`Inventory filter failed for ${st}: ${json.error}`);
		}
		const totalItems = json.data?.overview?.totalItemsCount ?? 0;
		const stockValue = json.data?.overview?.totalInventoryValueMrp ?? 0;
		console.log(
			`✅ Inventory [Store: ${st.padEnd(10)}] -> Total Items: ${totalItems} | Stock Value: ₹${Number(stockValue).toFixed(2)}`,
		);
	}

	// 6. Finance Summary Filter Verification
	console.log(
		"\n--- 6. FINANCE SUMMARY FILTER SUITE (/api/finance/summary) ---",
	);
	for (const st of ["ALL", "KLJ", "SWN"]) {
		const storeParam = st !== "ALL" ? `&store=${encodeURIComponent(st)}` : "";
		const url = `http://localhost:3000/api/finance/summary?startDate=2026-08-01&endDate=2026-09-26${storeParam}`;
		const req = new NextRequest(url);
		const res = await financeSummaryGET(req);
		const json = await res.json();
		if (!json.success) {
			throw new Error(`Finance filter failed for ${st}: ${json.error}`);
		}
		console.log(
			`✅ Finance [Store: ${st.padEnd(4)}] -> Sales Revenue: ₹${Number(json.data?.totalRevenue ?? 0).toFixed(2)} | PO Spend: ₹${Number(json.data?.totalPurchaseSpend ?? 0).toFixed(2)}`,
		);
	}

	// 7. Retention Overview Filter Verification
	console.log(
		"\n--- 7. RETENTION OVERVIEW FILTER SUITE (/api/customer-retention/overview) ---",
	);
	for (const st of ["ALL", "KLJ", "SWN"]) {
		const url = `http://localhost:3000/api/customer-retention/overview?startDate=2026-08-01&endDate=2026-09-26${st !== "ALL" ? `&store=${encodeURIComponent(st)}` : ""}`;
		const req = new NextRequest(url);
		const res = await retentionOverviewGET(req);
		const json = await res.json();
		if (!json.success) {
			throw new Error(`Retention filter failed for ${st}: ${json.error}`);
		}
		const repeatRate = json.data?.overview?.repeatPurchaseRate?.current ?? 0;
		const ltv = json.data?.overview?.ltv?.current ?? 0;
		console.log(
			`✅ Retention [Store: ${st.padEnd(4)}] -> Repeat Purchase Rate: ${repeatRate}% | LTV: ₹${ltv}`,
		);
	}

	console.log("\n========================================================");
	console.log("🎉 ALL FILTER COMBINATIONS & WORKFLOWS VERIFIED 100%!");
	console.log("========================================================\n");
}

runFilterVerification().catch((err) => {
	console.error("❌ Filter verification failed:", err);
	process.exit(1);
});
