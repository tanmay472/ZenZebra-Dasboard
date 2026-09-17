import { describe, expect, it } from "vitest";
import { formatStoreName } from "./global-filter-bar";

describe("formatStoreName generic formatting certification (Phase 10A)", () => {
	it("preserves uppercase acronyms and codes without space shattering", () => {
		expect(formatStoreName("HQ27GGN")).toBe("HQ27GGN");
		expect(formatStoreName("KLJ")).toBe("KLJ");
		expect(formatStoreName("SWN")).toBe("SWN");
	});

	it("cleanly formats camelCase names into spaced words", () => {
		expect(formatStoreName("ZenZebra")).toBe("Zen Zebra");
		expect(formatStoreName("SuperStore")).toBe("Super Store");
	});

	it("handles legacy string formats correctly", () => {
		expect(formatStoreName("Klj store")).toBe("KLJ");
		expect(formatStoreName("SmartworksNoida Noida")).toBe("Smart Works Noida");
		expect(formatStoreName("Head office")).toBe("Head office");
	});

	it("preserves already-spaced and unknown store strings", () => {
		expect(formatStoreName("Unknown Store")).toBe("Unknown Store");
		expect(formatStoreName("All Stores")).toBe("All Stores");
	});

	it("handles future stores dynamically", () => {
		expect(formatStoreName("CyberHub_DLF")).toBe("Cyber Hub DLF");
		expect(formatStoreName("GURGAON-SECTOR29")).toBe("GURGAON SECTOR29");
	});

	it("safely handles empty or null input", () => {
		expect(formatStoreName("")).toBe("");
		expect(formatStoreName(null as any)).toBe("");
		expect(formatStoreName(undefined as any)).toBe("");
	});
});
