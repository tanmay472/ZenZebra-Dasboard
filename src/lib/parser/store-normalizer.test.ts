import { describe, expect, it } from "vitest";
import { createStoreNormalizer } from "./store-normalizer";

/**
 * Phase 6A regression suite — data-integrity fix for silent store
 * attribution. The fixture data below mirrors the ACTUAL live
 * store_dimension / store_alias_mapping content verified during the
 * Phase 6A audit (2 real store_dimension rows: SmartworksNoida Noida and
 * Klj store; 13 active store_alias_mapping rows including the
 * head-office/employee-name aliases that already exist for real).
 *
 * ZenZebra and HQ27GGN do NOT exist in store_dimension today — they are
 * Odoo-only stores that never flow through the Excel import path this
 * normalizer serves. Tests 8/9 below verify the honest current behavior
 * (unresolved, never misattributed) rather than inventing a mapping that
 * doesn't exist in the real database.
 */
function fakeSql(aliasRows: unknown[], dimensionRows: unknown[]) {
	let call = 0;
	return async () => {
		call += 1;
		return call === 1 ? aliasRows : dimensionRows;
	};
}

const REAL_ALIASES = [
	{
		source_name: "smartworksnoida noida",
		canonical_store: "SmartworksNoida Noida",
	},
	{ source_name: "surjeet kumar", canonical_store: "SmartworksNoida Noida" },
	{ source_name: "master admin", canonical_store: "SmartworksNoida Noida" },
	{
		source_name: "smartworksggn ggn",
		canonical_store: "SmartworksNoida Noida",
	},
	{ source_name: "awfisggn ggn", canonical_store: "SmartworksNoida Noida" },
	{ source_name: "sanjam saluja", canonical_store: "SmartworksNoida Noida" },
	{ source_name: "deepanshu zz", canonical_store: "SmartworksNoida Noida" },
	{ source_name: "sonu kumar", canonical_store: "SmartworksNoida Noida" },
	{ source_name: "klj store", canonical_store: "Klj store" },
	{
		source_name: "smart_works_noida",
		canonical_store: "SmartworksNoida Noida",
	},
	{ source_name: "klj", canonical_store: "Klj store" },
	{ source_name: "head office", canonical_store: "SmartworksNoida Noida" },
	{ source_name: "head_office", canonical_store: "SmartworksNoida Noida" },
];

const REAL_DIMENSIONS = [
	{
		id: 1,
		store_name: "SmartworksNoida Noida",
		display_name: "Smart Works Noida",
	},
	{ id: 2, store_name: "Klj store", display_name: "KLJ" },
];

async function realNormalizer() {
	return createStoreNormalizer(fakeSql(REAL_ALIASES, REAL_DIMENSIONS) as any);
}

describe("store-normalizer — Phase 6A: unknown store must never become an existing store", () => {
	it("1. completely unknown store 'New Delhi Store 99' is unresolved", async () => {
		const normalizer = await realNormalizer();
		const result = normalizer.normalize("New Delhi Store 99");
		expect(result.resolved).toBe(false);
	});

	it("2. random store 'ABC Retail Pvt Ltd' is unresolved", async () => {
		const normalizer = await realNormalizer();
		const result = normalizer.normalize("ABC Retail Pvt Ltd");
		expect(result.resolved).toBe(false);
	});

	it("3. new future store 'New Gurgaon Store' is unresolved", async () => {
		const normalizer = await realNormalizer();
		const result = normalizer.normalize("New Gurgaon Store");
		expect(result.resolved).toBe(false);
	});

	it("4. empty store value is unresolved", async () => {
		const normalizer = await realNormalizer();
		const result = normalizer.normalize("");
		expect(result.resolved).toBe(false);
	});

	it("5. whitespace-only store value is unresolved", async () => {
		const normalizer = await realNormalizer();
		const result = normalizer.normalize("   ");
		expect(result.resolved).toBe(false);
	});

	it("6. known KLJ alias resolves to Klj store", async () => {
		const normalizer = await realNormalizer();
		const result = normalizer.normalize("klj");
		expect(result.resolved).toBe(true);
		if (result.resolved) {
			expect(result.canonicalStore).toBe("Klj store");
		}
	});

	it("7. known SWN alias resolves to SmartworksNoida Noida", async () => {
		const normalizer = await realNormalizer();
		const result = normalizer.normalize("smart_works_noida");
		expect(result.resolved).toBe(true);
		if (result.resolved) {
			expect(result.canonicalStore).toBe("SmartworksNoida Noida");
		}
	});

	it("8. 'ZenZebra' is unresolved against real store_dimension (Odoo-only store, not an Excel-path store — must never fall back to KLJ or SWN)", async () => {
		const normalizer = await realNormalizer();
		const result = normalizer.normalize("ZenZebra");
		expect(result.resolved).toBe(false);
	});

	it("9. 'HQ27GGN' is unresolved against real store_dimension (Odoo-only store, not an Excel-path store — must never fall back to KLJ or SWN)", async () => {
		const normalizer = await realNormalizer();
		const result = normalizer.normalize("HQ27GGN");
		expect(result.resolved).toBe(false);
	});

	it("9b. a hypothetical explicitly-mapped store (once given its own store_dimension + alias row) resolves correctly, proving the mechanism itself is not KLJ/SWN-only", async () => {
		const normalizer = await createStoreNormalizer(
			fakeSql(
				[{ source_name: "hq27ggn", canonical_store: "HQ27GGN" }],
				[{ id: 3, store_name: "HQ27GGN", display_name: "HQ27GGN" }],
			) as any,
		);
		const result = normalizer.normalize("HQ27GGN");
		expect(result.resolved).toBe(true);
		if (result.resolved) {
			expect(result.canonicalStore).toBe("HQ27GGN");
			expect(result.storeId).toBe(3);
		}
	});

	it("10. case/whitespace variation of a known alias still resolves to the same canonical store", async () => {
		const normalizer = await realNormalizer();
		const result = normalizer.normalize("  KLJ  ");
		expect(result.resolved).toBe(true);
		if (result.resolved) {
			expect(result.canonicalStore).toBe("Klj store");
		}
	});

	it("employee/head-office aliases (Surjeet Kumar, Master Admin, AwfisGgn Ggn) resolve via explicit registered aliases, not guessing", async () => {
		const normalizer = await realNormalizer();
		for (const raw of [
			"Surjeet Kumar",
			"Master Admin",
			"AwfisGgn Ggn",
			"Head Office",
		]) {
			const result = normalizer.normalize(raw);
			expect(result.resolved).toBe(true);
			if (result.resolved) {
				expect(result.canonicalStore).toBe("SmartworksNoida Noida");
			}
		}
	});

	it("never resolves any unknown input to Klj store via substring guessing (e.g. a name that merely contains 'klj')", async () => {
		const normalizer = await realNormalizer();
		const result = normalizer.normalize("klj-adjacent-warehouse-99");
		// Not a registered alias and not an exact dimension name — must be
		// unresolved, NOT guessed into Klj store via substring match.
		expect(result.resolved).toBe(false);
	});

	it("UNKNOWN never equals KLJ or SWN across a batch of unrelated raw values", async () => {
		const normalizer = await realNormalizer();
		const unknownInputs = [
			"New Delhi Store 99",
			"ABC Retail Pvt Ltd",
			"New Gurgaon Store",
			"",
			"   ",
			"Random Warehouse",
			"Test Store XYZ",
		];
		for (const raw of unknownInputs) {
			const result = normalizer.normalize(raw);
			expect(result.resolved).toBe(false);
		}
	});
});
