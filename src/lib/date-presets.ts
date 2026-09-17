export const DATE_PRESETS = [
	{ value: "today", label: "Today" },
	{ value: "yesterday", label: "Yesterday" },
	{ value: "last7", label: "Last 7 Days" },
	{ value: "last30", label: "Last 30 Days" },
	{ value: "thisMonth", label: "This Month" },
	{ value: "lastMonth", label: "Last Month" },
	{ value: "thisQuarter", label: "This Quarter" },
	{ value: "lastQuarter", label: "Last Quarter" },
	{ value: "thisYear", label: "This Year" },
	{ value: "allTime", label: "All Time" },
	{ value: "custom", label: "Custom Date Range" },
] as const;

export type DatePresetValue = (typeof DATE_PRESETS)[number]["value"];

/**
 * Formats a Date to YYYY-MM-DD in the Asia/Kolkata (IST) timezone.
 */
export function toKolkataISODate(date: Date = new Date()): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(
		date,
	);
}

function toISODate(date: Date) {
	return toKolkataISODate(date);
}

/**
 * Returns a reference Date representing current Indian Standard Time (IST).
 */
function getKolkataNow(): Date {
	const str = toKolkataISODate(new Date());
	const [y, m, d] = str.split("-").map(Number);
	return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

/** Client-side date math for the quick-range presets. "custom" returns null (caller keeps existing dates). */
export function getPresetRange(
	preset: string,
): { startDate: string; endDate: string } | null {
	const today = getKolkataNow();

	if (preset === "today") {
		return { startDate: toISODate(today), endDate: toISODate(today) };
	}
	if (preset === "yesterday") {
		const yesterday = new Date(today);
		yesterday.setUTCDate(yesterday.getUTCDate() - 1);
		return { startDate: toISODate(yesterday), endDate: toISODate(yesterday) };
	}
	if (preset === "last7") {
		const start = new Date(today);
		start.setUTCDate(start.getUTCDate() - 6);
		return { startDate: toISODate(start), endDate: toISODate(today) };
	}
	if (preset === "last30") {
		const start = new Date(today);
		start.setUTCDate(start.getUTCDate() - 29);
		return { startDate: toISODate(start), endDate: toISODate(today) };
	}
	if (preset === "thisMonth") {
		const start = new Date(today);
		start.setUTCDate(1);
		return { startDate: toISODate(start), endDate: toISODate(today) };
	}
	if (preset === "lastMonth") {
		const start = new Date(
			Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1),
		);
		const end = new Date(
			Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0),
		);
		return { startDate: toISODate(start), endDate: toISODate(end) };
	}
	if (preset === "thisQuarter") {
		const quarterStartMonth = Math.floor(today.getUTCMonth() / 3) * 3;
		const start = new Date(
			Date.UTC(today.getUTCFullYear(), quarterStartMonth, 1),
		);
		return { startDate: toISODate(start), endDate: toISODate(today) };
	}
	if (preset === "lastQuarter") {
		const quarterStartMonth = Math.floor(today.getUTCMonth() / 3) * 3;
		const start = new Date(
			Date.UTC(today.getUTCFullYear(), quarterStartMonth - 3, 1),
		);
		const end = new Date(
			Date.UTC(today.getUTCFullYear(), quarterStartMonth, 0),
		);
		return { startDate: toISODate(start), endDate: toISODate(end) };
	}
	if (preset === "thisYear") {
		const start = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
		return { startDate: toISODate(start), endDate: toISODate(today) };
	}

	// "custom" (or unknown) — caller keeps whatever dates are already set.
	return null;
}
