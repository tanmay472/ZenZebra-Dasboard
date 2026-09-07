import { afterEach, describe, expect, it, vi } from "vitest";

// customerRepository is a named export object imported by cac.service.ts —
// mock it so getCacReportData()'s per-store loop (getNewCustomersCount /
// getAovMetrics) resolves to controllable fixtures instead of hitting a
// real database. The `db` tagged-template client is passed in as a plain
// function argument by the caller, so it's stubbed directly per-test below
// with no module mock needed.
vi.mock("@/lib/repositories/customer.repository", () => ({
	customerRepository: {
		getNewCustomersCount: vi.fn(async () => 5),
		getAovMetrics: vi.fn(async () => ({ revenue: 5000, bills: 10 })),
	},
}));

const { getCacReportData } = await import("./cac.service");
const { customerRepository } = (await import(
	"@/lib/repositories/customer.repository"
)) as unknown as {
	customerRepository: {
		getNewCustomersCount: ReturnType<typeof vi.fn>;
		getAovMetrics: ReturnType<typeof vi.fn>;
	};
};

/**
 * Builds a fake Neon tagged-template `db` function. Distinguishes the
 * store-discovery query (SELECT DISTINCT billed_by ...) from the
 * marketing-spend lookup (SELECT monthly_spend ...) by sniffing the
 * template's literal text, since both are called as `db\`...\`` in
 * cac.service.ts.
 */
function makeFakeDb(opts: {
	storeRows: { billed_by: string }[];
	spendRows: Record<string, unknown>[];
}) {
	return vi.fn(async (strings: TemplateStringsArray) => {
		const text = strings.join("");
		if (text.includes("SELECT DISTINCT billed_by")) return opts.storeRows;
		if (text.includes("monthly_spend")) return opts.spendRows;
		return [];
	});
}

describe("getCacReportData — store scalability and no-fabrication guarantees", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("discovers store rows dynamically from sales_fact_v instead of a hardcoded 3-store list", async () => {
		const db = makeFakeDb({
			storeRows: [
				{ billed_by: "HQ27GGN" },
				{ billed_by: "Klj store" },
				{ billed_by: "SmartworksNoida Noida" },
				{ billed_by: "ZenZebra" },
			],
			spendRows: [],
		});

		const result = await getCacReportData(
			db as any,
			"2026-01-01",
			"2026-01-31",
			null,
		);

		const storeNames = result.paybackTable.map((row) => row.storeName);
		// All four real stores must appear (including ones a hardcoded list
		// would have omitted), plus the synthetic "Overall" row.
		expect(storeNames).toEqual([
			"HQ27GGN",
			"Klj store",
			"SmartworksNoida Noida",
			"ZenZebra",
			"Overall",
		]);
	});

	it("never returns the old hardcoded 'Smart Works Noida' / 'Klj store' / 'Overall' fixed 3-row table", async () => {
		const db = makeFakeDb({
			storeRows: [{ billed_by: "HQ27GGN" }],
			spendRows: [],
		});

		const result = await getCacReportData(
			db as any,
			"2026-01-01",
			"2026-01-31",
			null,
		);

		expect(result.paybackTable).toHaveLength(2); // HQ27GGN + Overall
		expect(result.paybackTable.map((r) => r.storeName)).not.toContain(
			"Smart Works Noida",
		);
	});

	it("returns paybackMonths: null and per-store margin/payback: null instead of a fabricated 0.26 * 1.5 formula", async () => {
		const db = makeFakeDb({
			storeRows: [{ billed_by: "Klj store" }],
			spendRows: [],
		});

		const result = await getCacReportData(
			db as any,
			"2026-01-01",
			"2026-01-31",
			null,
		);

		expect(result.paybackMonths).toBeNull();
		for (const row of result.paybackTable) {
			expect(row.margin).toBeNull();
			expect(row.payback).toBeNull();
		}
	});

	it("marks hasMarketingSpendData: false and spend: null when no dim_marketing_spend row exists, rather than fabricating a spend figure", async () => {
		const db = makeFakeDb({ storeRows: [], spendRows: [] });

		const result = await getCacReportData(
			db as any,
			"2026-01-01",
			"2026-01-31",
			"Klj store",
		);

		expect(result.hasMarketingSpendData).toBe(false);
		expect(result.spend).toBeNull();
		expect(result.cac).toBeNull();
	});

	it("computes a real CAC when marketing-spend data does exist", async () => {
		customerRepository.getNewCustomersCount.mockResolvedValueOnce(10);
		const db = makeFakeDb({
			storeRows: [],
			spendRows: [{ monthly_spend: 30000 }],
		});

		const result = await getCacReportData(
			db as any,
			"2026-01-01",
			"2026-01-31",
			"Klj store",
		);

		expect(result.hasMarketingSpendData).toBe(true);
		expect(result.spend).not.toBeNull();
		expect(result.cac).not.toBeNull();
	});
});
