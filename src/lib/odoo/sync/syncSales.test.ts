import { describe, expect, it } from "vitest";
import { deriveOrderLineSigns } from "./syncSales";

describe("deriveOrderLineSigns (order-level sign reconciliation)", () => {
	it("keeps a normal sale line positive (no refund, no discount)", () => {
		const r = deriveOrderLineSigns(
			[{ rawSubtotal: 100, rawSubtotalIncl: 118 }],
			118,
		);
		expect(r[0].priceSubtotal).toBe(100);
		expect(r[0].taxAmount).toBe(18);
	});

	it("forces a single-line refund negative when Odoo's raw fields come back positive", () => {
		// e.g. pos_600 (SWN - 000172 REFUND): header amount_total=-119,
		// single line raw price_subtotal=price_subtotal_incl=119 (wrongly
		// positive for a refund).
		const r = deriveOrderLineSigns(
			[{ rawSubtotal: 119, rawSubtotalIncl: 119 }],
			-119,
		);
		expect(r[0].priceSubtotal).toBe(-119);
		expect(r[0].taxAmount).toBe(0);
	});

	it("keeps a discount-only order's lines exactly as Odoo returns them (regression: pos_5898, ZenZebra - 000203, 2026-09-05)", () => {
		// A fully-discounted order: 3 real items + 2 discount lines for the
		// same amount, header amount_total=0. Odoo's raw signs are already
		// correct here (discount lines already negative); no flip needed.
		const r = deriveOrderLineSigns(
			[
				{ rawSubtotal: 33.34, rawSubtotalIncl: 35 },
				{ rawSubtotal: 119.04, rawSubtotalIncl: 125 },
				{ rawSubtotal: 28.58, rawSubtotalIncl: 40 },
				{ rawSubtotal: -28.58, rawSubtotalIncl: -40 },
				{ rawSubtotal: -152.38, rawSubtotalIncl: -160 },
			],
			0,
		);
		expect(r.map((x) => x.priceSubtotal)).toEqual([
			33.34, 119.04, 28.58, -28.58, -152.38,
		]);
		const total = r.reduce((s, x) => s + x.priceSubtotal + x.taxAmount, 0);
		expect(total).toBeCloseTo(0, 2);
	});

	it("flips BOTH a refunded product line and its refunded discount line (regression: pos_3564, KLJ - 000002 REFUND, 2026-08-18)", () => {
		// Odoo returns product line raw=+249 incl and discount line raw=-24.9
		// incl, both qty=-1. Header amount_total=-224.1. The only
		// combination that reconciles is flipping BOTH lines.
		const r = deriveOrderLineSigns(
			[
				{ rawSubtotal: 211.02, rawSubtotalIncl: 249 },
				{ rawSubtotal: -21.1, rawSubtotalIncl: -24.9 },
			],
			-224.1,
		);
		expect(r[0].priceSubtotal).toBeCloseTo(-211.02, 2);
		expect(r[0].taxAmount).toBeCloseTo(-37.98, 2);
		expect(r[1].priceSubtotal).toBeCloseTo(21.1, 2);
		expect(r[1].taxAmount).toBeCloseTo(3.8, 2);
		const total = r.reduce((s, x) => s + x.priceSubtotal + x.taxAmount, 0);
		expect(total).toBeCloseTo(-224.1, 2);
	});

	it("flips only ONE of two refunded product lines when that's what reconciles (regression: pos_1587, SWN - 000485 REFUND, 2026-07-31)", () => {
		// Two separately-refunded products, no discount. Odoo returns one
		// line already correctly negative (-60 incl) and the other wrongly
		// positive (110 incl). Header amount_total=-170. Only flipping the
		// wrongly-positive line reconciles — flipping both, or neither,
		// does not.
		const r = deriveOrderLineSigns(
			[
				{ rawSubtotal: 110, rawSubtotalIncl: 110 },
				{ rawSubtotal: -50.84, rawSubtotalIncl: -60 },
			],
			-170,
		);
		expect(r[0].priceSubtotal).toBe(-110);
		expect(r[0].taxAmount).toBe(0);
		expect(r[1].priceSubtotal).toBe(-50.84);
		expect(r[1].taxAmount).toBeCloseTo(-9.16, 2);
	});

	it("zero-value edge case does not throw or flip unexpectedly", () => {
		const r = deriveOrderLineSigns([{ rawSubtotal: 0, rawSubtotalIncl: 0 }], 0);
		expect(r[0].priceSubtotal).toBe(0);
		expect(r[0].taxAmount).toBe(0);
	});

	it("falls back to Odoo's raw values (no search) for a pathologically large order rather than an expensive/unbounded search", () => {
		const lines = Array.from({ length: 25 }, () => ({
			rawSubtotal: 10,
			rawSubtotalIncl: 12,
		}));
		const r = deriveOrderLineSigns(lines, 300);
		expect(r[0].priceSubtotal).toBe(10);
		expect(r[0].taxAmount).toBe(2);
	});
});
