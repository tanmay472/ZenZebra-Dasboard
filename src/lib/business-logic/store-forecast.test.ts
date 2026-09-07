import { describe, expect, it } from "vitest";
import { computeForecastFromParts } from "./store-forecast";

describe("computeForecastFromParts (formula preserved by the batched-forecast performance optimization)", () => {
	it("computes run rate and expected closing from MTD revenue and working days", () => {
		const r = computeForecastFromParts(10, 10, 20, 50000, 90000, false);
		expect(r.runRate).toBe(5000);
		expect(r.expectedClosing).toBe(100000);
		expect(r.confidence).toBe("HIGH");
		expect(r.growthVsPrevMonth).toBeCloseTo(11.1, 1);
	});

	it("returns LOW confidence for fewer than 7 completed days", () => {
		const r = computeForecastFromParts(3, 17, 20, 9000, 50000, false);
		expect(r.confidence).toBe("LOW");
		expect(r.reason).toContain("first 3 operating days");
	});

	it("reports NEW STORE growth when the previous month closing is zero", () => {
		const r = computeForecastFromParts(5, 15, 20, 8000, 0, false);
		expect(r.growthVsPrevMonth).toBe("NEW STORE");
	});

	it("returns the insufficient-data shape on the first operating day / zero completed days", () => {
		const r = computeForecastFromParts(0, 20, 20, 0, 40000, true);
		expect(r.runRate).toBe(0);
		expect(r.expectedClosing).toBeNull();
		expect(r.confidence).toBe("LOW");
		expect(r.previousMonthClosing).toBe(40000);
	});
});
