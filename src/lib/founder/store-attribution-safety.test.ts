import { describe, expect, it } from "vitest";

/**
 * Phase 6A end-to-end regression: proves that unresolved (unknown) stores
 * are quarantined — never committed and never silently attributed to
 * Klj store / SmartworksNoida Noida — through all three Excel import
 * paths (sales, purchase, net-purchase), while known stores continue to
 * import exactly as before.
 *
 * Each import path's staged-validation function takes a `db` tagged
 * template. We fake it to serve: (1) staged raw rows from
 * staging_*_rows, then (2) store_alias_mapping, then (3) store_dimension
 * — the same three sequential queries the real functions issue. No real
 * database is touched.
 */

const REAL_ALIASES = [
	{
		source_name: "smartworksnoida noida",
		canonical_store: "SmartworksNoida Noida",
	},
	{ source_name: "klj", canonical_store: "Klj store" },
];

const REAL_DIMENSIONS = [
	{
		id: 1,
		store_name: "SmartworksNoida Noida",
		display_name: "Smart Works Noida",
	},
	{ id: 2, store_name: "Klj store", display_name: "KLJ" },
];

function fakeStagedDb(stagedRows: unknown[]) {
	let call = 0;
	return async () => {
		call += 1;
		if (call === 1) return stagedRows;
		if (call === 2) return REAL_ALIASES;
		return REAL_DIMENSIONS;
	};
}

describe("Phase 6A — Sales Excel import path (validateStagedFounderUpload)", () => {
	it("known store (klj) is imported normally", async () => {
		const { validateStagedFounderUpload } = await import("./import-service");
		const db = fakeStagedDb([
			{
				parsed: {
					bill_no: "B-1",
					sale_date: "01-01-2026",
					billed_by: "klj",
					item_name: "Widget",
					quantity: 1,
					net_amount: 100,
					gross_amount: 118,
					tax_amount: 18,
					mrp_amount: 118,
					discount_amount: 0,
				},
			},
		]);

		const result = await validateStagedFounderUpload(db as any, 1);
		expect(result.isValid).toBe(true);
		expect(result.validData).toHaveLength(1);
		expect(result.validData[0]?.billed_by).toBe("Klj store");
	});

	it("unknown store is quarantined, never committed, never becomes KLJ or SWN", async () => {
		const { validateStagedFounderUpload } = await import("./import-service");
		const db = fakeStagedDb([
			{
				parsed: {
					bill_no: "B-2",
					sale_date: "01-01-2026",
					billed_by: "New Gurgaon Store",
					item_name: "Widget",
					quantity: 1,
					net_amount: 100,
					gross_amount: 118,
					tax_amount: 18,
					mrp_amount: 118,
					discount_amount: 0,
				},
			},
		]);

		const result = await validateStagedFounderUpload(db as any, 2);
		expect(result.validData).toHaveLength(0);
		expect(result.isValid).toBe(false);
		expect(
			result.quarantineReasons?.some((r) => r.includes("Unknown store")),
		).toBe(true);
		// Explicitly prove it did NOT fall back to an existing store.
		expect(
			result.validData.some(
				(r) =>
					r.billed_by === "Klj store" ||
					r.billed_by === "SmartworksNoida Noida",
			),
		).toBe(false);
	});

	it("a mixed batch commits only the known-store row and quarantines the unknown-store row", async () => {
		const { validateStagedFounderUpload } = await import("./import-service");
		const db = fakeStagedDb([
			{
				parsed: {
					bill_no: "B-3",
					sale_date: "01-01-2026",
					billed_by: "smartworksnoida noida",
					item_name: "Widget A",
					quantity: 1,
					net_amount: 100,
					gross_amount: 118,
					tax_amount: 18,
					mrp_amount: 118,
					discount_amount: 0,
				},
			},
			{
				parsed: {
					bill_no: "B-4",
					sale_date: "01-01-2026",
					billed_by: "ABC Retail Pvt Ltd",
					item_name: "Widget B",
					quantity: 1,
					net_amount: 200,
					gross_amount: 236,
					tax_amount: 36,
					mrp_amount: 236,
					discount_amount: 0,
				},
			},
		]);

		const result = await validateStagedFounderUpload(db as any, 3);
		expect(result.validData).toHaveLength(1);
		expect(result.validData[0]?.billed_by).toBe("SmartworksNoida Noida");
		expect(result.errorCount).toBeGreaterThanOrEqual(1);
	});
});

describe("Phase 6A — Purchase Excel import path (validateStagedPurchaseUpload)", () => {
	it("known store (SmartworksNoida Noida) is imported normally", async () => {
		const { validateStagedPurchaseUpload } = await import(
			"./purchase-import-service"
		);
		const db = fakeStagedDb([
			{
				parsed: {
					bill_no: "P-1",
					purchase_date: "2026-01-01",
					billed_by: "SmartworksNoida Noida",
					item_name: "Ingredient",
					quantity: 5,
					net_purchase: 500,
					tax: 90,
					"gross pur": 590,
				},
			},
		]);

		const result = await validateStagedPurchaseUpload(db as any, 1);
		expect(result.success).toBe(true);
		expect(result._validatedRows).toHaveLength(1);
		expect(result._validatedRows?.[0]?.billed_by).toBe("SmartworksNoida Noida");
	});

	it("unknown store is quarantined, commit is refused, never becomes KLJ or SWN", async () => {
		const { validateStagedPurchaseUpload } = await import(
			"./purchase-import-service"
		);
		const db = fakeStagedDb([
			{
				parsed: {
					bill_no: "P-2",
					purchase_date: "2026-01-01",
					billed_by: "ABC Retail Pvt Ltd",
					item_name: "Ingredient",
					quantity: 5,
					net_purchase: 500,
					tax: 90,
					"gross pur": 590,
				},
			},
		]);

		const result = await validateStagedPurchaseUpload(db as any, 2);
		expect(result.success).toBe(false);
		expect(
			result.quarantineReasons?.some((r) => r.includes("Unknown store")),
		).toBe(true);
	});
});

describe("Phase 6A — Net-purchase Excel import path (validateStagedNetPurchaseUpload)", () => {
	it("known store (klj) is imported normally", async () => {
		const { validateStagedNetPurchaseUpload } = await import(
			"./net-purchase-import-service"
		);
		const db = fakeStagedDb([
			{
				parsed: {
					bill_no: "NP-1",
					purchase_date: "2026-01-01",
					billed_by: "klj",
					item_name: "Ingredient",
					quantity: 5,
					net_purchase: 500,
					tax: 90,
					"gross pur": 590,
				},
			},
		]);

		const result = await validateStagedNetPurchaseUpload(db as any, 1);
		expect(result.success).toBe(true);
		expect(result._validatedRows?.[0]?.billed_by).toBe("Klj store");
	});

	it("unknown store ('New Delhi Store 99') is quarantined, commit is refused, never becomes KLJ or SWN", async () => {
		const { validateStagedNetPurchaseUpload } = await import(
			"./net-purchase-import-service"
		);
		const db = fakeStagedDb([
			{
				parsed: {
					bill_no: "NP-2",
					purchase_date: "2026-01-01",
					billed_by: "New Delhi Store 99",
					item_name: "Ingredient",
					quantity: 5,
					net_purchase: 500,
					tax: 90,
					"gross pur": 590,
				},
			},
		]);

		const result = await validateStagedNetPurchaseUpload(db as any, 2);
		expect(result.success).toBe(false);
		expect(
			result.quarantineReasons?.some((r) => r.includes("Unknown store")),
		).toBe(true);
	});
});
