import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the DB module so getCrmPipelineSummary()'s two sequential sql`...`
// calls (aggregate stats, then per-stage counts) resolve to controllable
// fixtures instead of hitting a real database.
let statsRows: any[] = [];
let stageRows: any[] = [];
let callIndex = 0;

vi.mock("@/lib/db", () => ({
	sql: Object.assign(
		vi.fn(async () => {
			callIndex += 1;
			return callIndex % 2 === 1 ? statsRows : stageRows;
		}),
		{},
	),
}));

const { getCrmPipelineSummary } = await import("./crm.repository");

describe("getCrmPipelineSummary — no-fabrication guarantees", () => {
	afterEach(() => {
		statsRows = [];
		stageRows = [];
		callIndex = 0;
		vi.clearAllMocks();
	});

	it("returns winRate: null (not a fabricated 0%) when there are zero real leads", async () => {
		statsRows = [
			{ totalPipelineValue: 0, totalLeads: 0, avgDealSize: 0, winRate: 0 },
		];
		stageRows = [];
		const summary = await getCrmPipelineSummary();
		expect(summary.totalLeads).toBe(0);
		expect(summary.winRate).toBeNull();
	});

	it("returns a real computed winRate when real leads exist", async () => {
		statsRows = [
			{
				totalPipelineValue: 50000,
				totalLeads: 4,
				avgDealSize: 12500,
				winRate: 25,
			},
		];
		stageRows = [{ stage: "Closed Won", count: 1, value: 50000 }];
		const summary = await getCrmPipelineSummary();
		expect(summary.totalLeads).toBe(4);
		expect(summary.winRate).toBe(25);
	});

	it("passes the requested store into both queries instead of ignoring it (Phase 6 fix: this previously always queried unfiltered crm_leads regardless of the selected store)", async () => {
		statsRows = [
			{
				totalPipelineValue: 10000,
				totalLeads: 1,
				avgDealSize: 10000,
				winRate: 100,
			},
		];
		stageRows = [{ stage: "Closed Won", count: 1, value: 10000 }];

		const { sql } = (await import("@/lib/db")) as unknown as {
			sql: { mock: { calls: unknown[][] } };
		};

		await getCrmPipelineSummary({ store: "Klj store" });

		expect(sql.mock.calls.length).toBe(2);
		for (const call of sql.mock.calls) {
			expect(call).toContain("Klj store");
		}
	});

	it("treats store: 'ALL' the same as no store filter (passes null, not the literal string 'ALL')", async () => {
		statsRows = [
			{ totalPipelineValue: 0, totalLeads: 0, avgDealSize: 0, winRate: 0 },
		];
		stageRows = [];

		const { sql } = (await import("@/lib/db")) as unknown as {
			sql: { mock: { calls: unknown[][] } };
		};

		await getCrmPipelineSummary({ store: "ALL" });

		for (const call of sql.mock.calls) {
			expect(call).not.toContain("ALL");
			expect(call).toContain(null);
		}
	});
});
