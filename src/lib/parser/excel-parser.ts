import * as XLSX from "xlsx";

import { normalizeProductCode } from "./product-code";

export interface ColumnMatch {
	field: string;
	matchedColumn: string;
	confidence: number;
}

export interface ParsedRow {
	bill_no: string;
	sale_date: string;
	billed_by: string;
	product_key: string;
	sku_code: string | null;
	item_name: string;
	brand: string | null;
	category: string | null;
	quantity: number;
	mrp_amount: number;
	discount_amount: number;
	gross_amount: number;
	tax_amount: number;
	net_amount: number;
	customer_mobile: string | null;
	customer_name: string | null;
	payment_method: string | null;
}

export interface ParseResult {
	rows: ParsedRow[];
	quarantined: number;
	quarantine_reasons: string[];
	latest_sale_date: string;
	raw_row_count: number;
}

// Dynamic mapping configuration with confidence scores
export const COLUMN_MAP: Record<
	string,
	Array<{ alias: string; confidence: number }>
> = {
	bill_no: [
		{ alias: "number", confidence: 1.0 },
		{ alias: "bill_no", confidence: 1.0 },
		{ alias: "bill_number", confidence: 1.0 },
		{ alias: "invoice", confidence: 0.95 },
		{ alias: "bill_num", confidence: 0.85 },
	],
	sale_date: [
		{ alias: "dateOnly", confidence: 1.0 },
		{ alias: "sale_date", confidence: 1.0 },
		{ alias: "date", confidence: 0.85 },
		{ alias: "bill_date", confidence: 0.95 },
	],
	item_name: [
		{ alias: "name", confidence: 1.0 },
		{ alias: "item_name", confidence: 1.0 },
		{ alias: "product", confidence: 0.95 },
		{ alias: "productName", confidence: 1.0 },
		{ alias: "item", confidence: 0.9 },
	],
	quantity: [
		{ alias: "quantity", confidence: 1.0 },
		{ alias: "qty", confidence: 0.95 },
	],
	net_amount: [
		{ alias: "taxableAmount", confidence: 1.0 },
		{ alias: "net_amount", confidence: 1.0 },
		{ alias: "taxable_amount", confidence: 1.0 },
		{ alias: "netSales", confidence: 0.7 },
		{ alias: "net_sales", confidence: 0.7 },
	],
	gross_amount: [
		{ alias: "totalAmount", confidence: 1.0 },
		{ alias: "gross_amount", confidence: 1.0 },
		{ alias: "total_amount", confidence: 1.0 },
		{ alias: "gross", confidence: 0.9 },
	],
	billed_by: [
		{ alias: "billed_by", confidence: 1.0 },
		{ alias: "store", confidence: 0.95 },
		{ alias: "billedBy", confidence: 1.0 },
		{ alias: "branch", confidence: 0.9 },
	],
	sku_code: [
		{ alias: "code", confidence: 1.0 },
		{ alias: "sku_code", confidence: 1.0 },
		{ alias: "sku", confidence: 0.5 },
		{ alias: "barcode", confidence: 0.95 },
		{ alias: "item_code", confidence: 0.9 },
		{ alias: "product_id", confidence: 0.9 },
	],
	brand: [{ alias: "brand", confidence: 1.0 }],
	category: [
		{ alias: "category", confidence: 1.0 },
		{ alias: "dept", confidence: 0.9 },
		{ alias: "department", confidence: 0.9 },
	],
	tax_amount: [
		{ alias: "totalTax", confidence: 1.0 },
		{ alias: "tax_amount", confidence: 1.0 },
		{ alias: "tax_val", confidence: 0.95 },
		{ alias: "tax", confidence: 0.9 },
	],
	mrp_amount: [
		{ alias: "currentMrp", confidence: 1.0 },
		{ alias: "mrp", confidence: 1.0 },
		{ alias: "mrp_amount", confidence: 1.0 },
	],
	customer_mobile: [
		{ alias: "customerMobile", confidence: 1.0 },
		{ alias: "mobile", confidence: 0.95 },
		{ alias: "phone", confidence: 0.9 },
		{ alias: "customer_mobile", confidence: 1.0 },
	],
	customer_name: [
		{ alias: "customerName", confidence: 1.0 },
		{ alias: "customer_name", confidence: 1.0 },
		{ alias: "customer", confidence: 0.9 },
	],
	payment_method: [
		{ alias: "paymentMethod", confidence: 1.0 },
		{ alias: "payment_method", confidence: 1.0 },
		{ alias: "payment", confidence: 0.9 },
		{ alias: "pay_mode", confidence: 0.9 },
	],
};

const REQUIRED_FIELDS = [
	"bill_no",
	"sale_date",
	"item_name",
	"quantity",
	"gross_amount",
	"net_amount",
	"billed_by",
];

function normalizeMobile(value: unknown): string | null {
	if (value == null || value === "") return null;
	const normalized = String(value).replace(/\.0$/, "").trim();
	return normalized || null;
}

/**
 * Canonical SKU/code normalization — delegates to the shared normalizer so sales,
 * inventory (cost master), and profitability joins all key on an identical code
 * (incl. scientific-notation barcodes).
 */
function normalizeSkuCode(value: unknown): string | null {
	return normalizeProductCode(value);
}

function parseSaleDate(dateRaw: string): string | null {
	const parts = dateRaw.split("-");
	if (parts.length !== 3) return null;

	const [dd, mm, yyyy] = parts;
	if (!dd || !mm || !yyyy) return null;

	const iso = `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
	const parsed = new Date(`${iso}T00:00:00.000Z`);
	if (Number.isNaN(parsed.getTime())) return null;
	return iso;
}

function normalizeHeader(h: string): string {
	return h.toLowerCase().replace(/[\s_-]/g, "");
}

export function resolveColumnMappings(firstRow: Record<string, unknown>): {
	mappings: Record<string, ColumnMatch>;
	isValid: boolean;
	errors: string[];
} {
	const resolved: Record<string, ColumnMatch> = {};
	const rowHeaders = Object.keys(firstRow);
	const errors: string[] = [];
	let isValid = true;

	for (const [field, aliases] of Object.entries(COLUMN_MAP)) {
		let bestMatch: ColumnMatch | null = null;

		for (const item of aliases) {
			const normAlias = normalizeHeader(item.alias);
			const matchedHeader = rowHeaders.find(
				(h) => normalizeHeader(h) === normAlias,
			);

			if (matchedHeader) {
				if (!bestMatch || item.confidence > bestMatch.confidence) {
					bestMatch = {
						field,
						matchedColumn: matchedHeader,
						confidence: item.confidence,
					};
				}
			}
		}

		if (bestMatch) {
			resolved[field] = bestMatch;
		} else if (REQUIRED_FIELDS.includes(field)) {
			isValid = false;
			errors.push(
				`Required field '${field}' could not be matched to any column in the Excel sheet.`,
			);
		}
	}

	// Verify confidence thresholds for required fields
	for (const field of REQUIRED_FIELDS) {
		const match = resolved[field];
		if (match && match.confidence < 0.9) {
			isValid = false;
			errors.push(
				`Required field '${field}' matched column '${match.matchedColumn}' but the mapping confidence was only ${(match.confidence * 100).toFixed(0)}% (minimum threshold is 90%).`,
			);
		}
	}

	return { mappings: resolved, isValid, errors };
}

export function parseExcelBuffer(buffer: Buffer): ParseResult {
	const workbook = XLSX.read(buffer, { type: "buffer" });
	const worksheet = workbook.Sheets.main;

	if (!worksheet) {
		throw new Error("Sheet 'main' not found. Expected one sheet named 'main'.");
	}

	const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, {
		raw: true,
		defval: null,
	});

	return parseRawRows(rawRows);
}

export function parseRawRows(rawRows: Record<string, unknown>[]): ParseResult {
	if (rawRows.length === 0) {
		return {
			rows: [],
			quarantined: 0,
			quarantine_reasons: [],
			latest_sale_date: "",
			raw_row_count: 0,
		};
	}

	const firstRow = rawRows[0]!;
	const mappingResult = resolveColumnMappings(firstRow);
	if (!mappingResult.isValid) {
		throw new Error(
			`Excel column mapping validation failed:\n- ${mappingResult.errors.join("\n- ")}`,
		);
	}

	const resolved = mappingResult.mappings;
	const rows: ParsedRow[] = [];
	const quarantine_reasons: string[] = [];
	let quarantined = 0;
	const dates: string[] = [];

	for (const raw of rawRows) {
		const billNo = String(raw[resolved.bill_no.matchedColumn] ?? "").trim();
		const dateRaw = String(raw[resolved.sale_date.matchedColumn] ?? "").trim();
		const itemName = String(raw[resolved.item_name.matchedColumn] ?? "").trim();
		const quantity = Number(raw[resolved.quantity.matchedColumn]);
		const billedBy = String(raw[resolved.billed_by.matchedColumn] ?? "").trim();
		const grossAmount = Number(raw[resolved.gross_amount.matchedColumn]);

		// Net Amount with fallbacks
		let netAmount = NaN;
		if (resolved.net_amount) {
			netAmount = Number(raw[resolved.net_amount.matchedColumn]);
		}

		// Resolve tax rate from an explicit tax_rate column only — GST/tax
		// slabs vary by product (0/5/12/18/28%, exempt), so a missing rate
		// must never be assumed as a fixed percentage. A row with no
		// explicit net_amount and no discoverable tax_rate is left as
		// NaN below, which the validation block already quarantines
		// ("invalid net_amount") instead of silently fabricating a split.
		let taxRate: number | null = null;
		const taxRateHeader = rowHeadersContainTaxRate(Object.keys(raw));
		if (taxRateHeader) {
			const parsedRate = Number(raw[taxRateHeader]);
			if (!Number.isNaN(parsedRate) && parsedRate > 0) {
				taxRate = parsedRate > 1 ? parsedRate / 100 : parsedRate;
			}
		}

		if (Number.isNaN(netAmount) && taxRate !== null) {
			netAmount = grossAmount / (1 + taxRate);
		}

		// Tax Amount with fallbacks
		let taxAmount = NaN;
		if (resolved.tax_amount) {
			taxAmount = Number(raw[resolved.tax_amount.matchedColumn]);
		}
		if (Number.isNaN(taxAmount)) {
			taxAmount = grossAmount - netAmount;
		}

		// MRP Amount with fallbacks (no guessing MRP from sale price)
		let mrpAmount = NaN;
		if (resolved.mrp_amount) {
			const val = Number(raw[resolved.mrp_amount.matchedColumn]);
			if (!Number.isNaN(val)) {
				const matchedName = resolved.mrp_amount.matchedColumn.toLowerCase();
				const isTotal =
					matchedName.includes("amount") || matchedName.includes("total");
				mrpAmount = isTotal ? val : val * quantity;
			}
		}

		if (Number.isNaN(mrpAmount)) {
			// Fallback: mrp_amount = gross_amount + discount_amount
			let discountHeader: string | null = null;
			if (resolved.discount_amount) {
				discountHeader = resolved.discount_amount.matchedColumn;
			} else {
				discountHeader = findHeaderLikeDiscount(Object.keys(raw));
			}

			if (discountHeader) {
				const discVal = Number(raw[discountHeader]);
				if (!Number.isNaN(discVal)) {
					mrpAmount = grossAmount + discVal;
				}
			}
		}

		if (Number.isNaN(mrpAmount) || mrpAmount < grossAmount - 0.01) {
			mrpAmount = grossAmount; // Fallback: no discount
		}

		const discountAmount = mrpAmount - grossAmount;

		// Optional Fields
		const skuCode = resolved.sku_code
			? normalizeSkuCode(raw[resolved.sku_code.matchedColumn])
			: null;
		const brand = resolved.brand
			? String(raw[resolved.brand.matchedColumn] ?? "").trim() || null
			: null;
		const category = resolved.category
			? String(raw[resolved.category.matchedColumn] ?? "").trim() || null
			: null;
		const customerMobile = resolved.customer_mobile
			? normalizeMobile(raw[resolved.customer_mobile.matchedColumn])
			: null;
		const customerName = resolved.customer_name
			? String(raw[resolved.customer_name.matchedColumn] ?? "").trim() || null
			: null;
		const paymentMethod = resolved.payment_method
			? String(raw[resolved.payment_method.matchedColumn] ?? "").trim() || null
			: null;

		// Product identity priority: skuCode ?? itemName (never empty/null)
		const productKey = skuCode || itemName;

		const errors: string[] = [];
		if (!billNo) errors.push("missing bill_no");
		if (!dateRaw) errors.push("missing dateOnly");
		if (!itemName) errors.push("missing item_name");
		if (Number.isNaN(quantity)) errors.push("invalid quantity");
		if (Number.isNaN(netAmount)) errors.push("invalid net_amount");
		if (Number.isNaN(grossAmount)) errors.push("invalid gross_amount");
		if (Number.isNaN(taxAmount)) errors.push("invalid tax_amount");
		if (Number.isNaN(mrpAmount)) errors.push("invalid mrp_amount");

		if (mrpAmount < grossAmount - 0.01)
			errors.push(`mrp_amount (${mrpAmount}) < gross_amount (${grossAmount})`);
		if (grossAmount < netAmount - 0.01)
			errors.push(`gross_amount (${grossAmount}) < net_amount (${netAmount})`);
		if (Math.abs(grossAmount - netAmount - taxAmount) > 0.01)
			errors.push(
				`gross_amount - net_amount (${grossAmount - netAmount}) != tax_amount (${taxAmount})`,
			);
		if (Math.abs(mrpAmount - grossAmount - discountAmount) > 0.01)
			errors.push(
				`mrp_amount - gross_amount (${mrpAmount - grossAmount}) != discount_amount (${discountAmount})`,
			);

		if (errors.length > 0) {
			quarantined++;
			quarantine_reasons.push(
				`Row (bill: ${billNo || "unknown"}): ${errors.join(", ")}`,
			);
			continue;
		}

		const saleDate = parseSaleDate(dateRaw);
		if (!saleDate) {
			quarantined++;
			quarantine_reasons.push(
				`Row (bill: ${billNo}): invalid date format '${dateRaw}' — expected DD-MM-YYYY`,
			);
			continue;
		}

		dates.push(saleDate);
		rows.push({
			bill_no: billNo,
			sale_date: saleDate,
			billed_by: billedBy,
			product_key: productKey,
			sku_code: skuCode,
			item_name: itemName,
			brand,
			category,
			quantity,
			mrp_amount: mrpAmount,
			discount_amount: discountAmount,
			gross_amount: grossAmount,
			tax_amount: taxAmount,
			net_amount: netAmount,
			customer_mobile: customerMobile,
			customer_name: customerName,
			payment_method: paymentMethod,
		});
	}

	const latestSaleDate = [...dates].sort().at(-1) ?? "";

	return {
		rows,
		quarantined,
		quarantine_reasons,
		latest_sale_date: latestSaleDate,
		raw_row_count: rawRows.length,
	};
}

function rowHeadersContainTaxRate(headers: string[]): string | null {
	const aliases = ["taxrate", "gstrate", "taxpercent", "taxpct", "gstpct"];
	return headers.find((h) => aliases.includes(normalizeHeader(h))) ?? null;
}

function findHeaderLikeDiscount(headers: string[]): string | null {
	const aliases = ["discountamount", "discount", "totaldiscount"];
	return headers.find((h) => aliases.includes(normalizeHeader(h))) ?? null;
}

export function parseResultToValidation(parseResult: ParseResult) {
	const dates = parseResult.rows.map((row) => row.sale_date).sort();
	return {
		isValid: parseResult.rows.length > 0,
		totalRows: parseResult.raw_row_count,
		validRows: parseResult.rows.length,
		errorCount: parseResult.quarantined,
		errors: parseResult.quarantine_reasons.map((reason, index) => ({
			rowNumber: index + 1,
			errors: [reason],
		})),
		validData: parseResult.rows,
		dateRange: {
			start: dates[0] ?? null,
			end: dates.at(-1) ?? null,
		},
		latestSaleDate: parseResult.latest_sale_date,
		quarantineReasons: parseResult.quarantine_reasons,
	};
}
