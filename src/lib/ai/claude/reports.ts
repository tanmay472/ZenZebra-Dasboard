/**
 * Full (non-truncated) Excel/PDF report generation for the AI assistant's
 * `generate_report` tool. Pulls from the same canonical tables as every
 * other dashboard query (`fact_inventory`/`dim_stores` for inventory,
 * `sales_fact_v` for sales) — no separate/duplicated data path. Files are
 * written to disk (data/ai-reports/, gitignored) and referenced by a row in
 * `ai_generated_reports`, which the download route reads by id.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import * as XLSX from "xlsx";
import { sql } from "@/lib/db";

export interface ReportResult {
	success: boolean;
	error?: string;
	rowCount?: number;
	reports?: { id: string; filename: string; format: "xlsx" | "pdf" }[];
}

function reportsDir(): string {
	const dir = path.join(process.cwd(), "data", "ai-reports");
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function isValidDate(value: unknown): value is string {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

async function fetchInventoryRows(store?: string) {
	const storeFilter = store ? `%${store.trim()}%` : null;
	return sql`
		SELECT
			p.name AS product,
			COALESCE(p.default_code, 'SKU-' || p.id) AS sku,
			COALESCE(p.category, 'General') AS category,
			COALESCE(s.name, 'Unassigned') AS store,
			fi.quantity AS qty_on_hand,
			p.list_price,
			COALESCE(sl.units_sold_30d, 0) AS units_sold_30d
		FROM fact_inventory fi
		JOIN dim_products p ON fi.product_id = p.id
		LEFT JOIN dim_stores s ON fi.location_id = s.location_id
		LEFT JOIN (
			SELECT product_id, SUM(qty) AS units_sold_30d
			FROM fact_sales_lines
			WHERE updated_at >= NOW() - INTERVAL '30 days'
			GROUP BY product_id
		) sl ON sl.product_id = p.id
		WHERE p.active = true AND p.is_storable IS NOT FALSE AND fi.quantity <> 0
			AND (${storeFilter}::text IS NULL OR s.name ILIKE ${storeFilter} OR s.code ILIKE ${storeFilter})
		ORDER BY store, qty_on_hand DESC
	`;
}

async function fetchSalesRows(
	startDate: string,
	endDate: string,
	store?: string,
) {
	const storeFilter = store ? `%${store.trim()}%` : null;
	return sql`
		SELECT
			sale_date, bill_no, billed_by AS store, customer_name, customer_mobile,
			item_name, sku_code, quantity, net_amount, gross_amount, tax_amount
		FROM sales_fact_v
		WHERE sale_date >= ${startDate}::date AND sale_date <= ${endDate}::date
			AND (${storeFilter}::text IS NULL OR billed_by ILIKE ${storeFilter})
		ORDER BY sale_date DESC, bill_no
	`;
}

// The ONLY documented stock-status thresholds in this codebase
// (inventory.repository.ts's LOW_STOCK_THRESHOLD_UNITS = 10, and the
// separate qty<=0 "out of stock" check used by the inventory overview
// query). There is no approved threshold anywhere for finer tiers like
// "Very Low"/"Good"/"Excess" — inventing one here would be exactly the
// kind of unapproved classification this phase was told not to add, so
// stock status is limited to these 3 real, already-used tiers.
const LOW_STOCK_THRESHOLD_UNITS = 10;

function classifyStock(qty: number): "Out of Stock" | "Low" | "Healthy" {
	if (qty <= 0) return "Out of Stock";
	if (qty <= LOW_STOCK_THRESHOLD_UNITS) return "Low";
	return "Healthy";
}

function toInventorySheetRows(rows: any[]) {
	return rows.map((r) => {
		const qty = Number(r.qty_on_hand);
		return {
			Product: r.product,
			SKU: r.sku,
			Category: r.category,
			Store: r.store,
			"Qty On Hand": qty,
			"Stock Status": classifyStock(qty),
			"List Price (₹)": Number(r.list_price || 0),
			"Units Sold (30d)": Number(r.units_sold_30d),
		};
	});
}

/** Single-row aggregate — same canonical fields/definitions the dashboard
 * and chat tools use (SUM(gross_amount)/SUM(net_amount)/SUM(tax_amount)/
 * SUM(discount_amount), COUNT(DISTINCT bill_no), SUM(quantity), AOV =
 * net/orders). Computed from the exact row set the detail sheet lists —
 * not a second, independently-derived query path. */
function toSalesSummarySheetRows(rows: any[]) {
	const gross = rows.reduce((s, r) => s + Number(r.gross_amount || 0), 0);
	const net = rows.reduce((s, r) => s + Number(r.net_amount || 0), 0);
	const tax = rows.reduce((s, r) => s + Number(r.tax_amount || 0), 0);
	const units = rows.reduce((s, r) => s + Number(r.quantity || 0), 0);
	const orders = new Set(rows.map((r) => `${r.store}|${r.bill_no}`)).size;
	return [
		{
			"Gross Collection (₹)": Number(gross.toFixed(2)),
			"Net Revenue (₹)": Number(net.toFixed(2)),
			"GST/Tax (₹)": Number(tax.toFixed(2)),
			Orders: orders,
			"Units Sold": units,
			"AOV (₹)": orders > 0 ? Number((net / orders).toFixed(2)) : 0,
		},
	];
}

/** Per-store breakdown with contribution % — stores are whatever appears
 * in the queried rows, never a fixed/hardcoded list, so a new store shows
 * up automatically. */
function toStorePerformanceSheetRows(rows: any[]) {
	const totalGross = rows.reduce((s, r) => s + Number(r.gross_amount || 0), 0);
	const byStore = new Map<
		string,
		{ gross: number; net: number; orderKeys: Set<string> }
	>();
	for (const r of rows) {
		const store = String(r.store || "Unknown");
		if (!byStore.has(store)) {
			byStore.set(store, { gross: 0, net: 0, orderKeys: new Set() });
		}
		const s = byStore.get(store)!;
		s.gross += Number(r.gross_amount || 0);
		s.net += Number(r.net_amount || 0);
		s.orderKeys.add(String(r.bill_no));
	}
	return Array.from(byStore.entries())
		.map(([store, s]) => ({
			Store: store,
			"Gross Collection (₹)": Number(s.gross.toFixed(2)),
			"Net Revenue (₹)": Number(s.net.toFixed(2)),
			Orders: s.orderKeys.size,
			"Contribution %":
				totalGross > 0 ? Number(((s.gross / totalGross) * 100).toFixed(1)) : 0,
		}))
		.sort((a, b) => b["Gross Collection (₹)"] - a["Gross Collection (₹)"]);
}

/** Neon returns DATE columns as JS Date objects (UTC midnight) — writing
 * those straight into a sheet cell makes XLSX store a raw date-serial
 * number with no format, unreadable to a human opener. Render as a plain
 * YYYY-MM-DD string instead. */
function formatSheetDate(value: unknown): string {
	if (value instanceof Date) return value.toISOString().slice(0, 10);
	return String(value ?? "");
}

function toSalesSheetRows(rows: any[]) {
	return rows.map((r) => ({
		Date: formatSheetDate(r.sale_date),
		"Bill No": r.bill_no,
		Store: r.store,
		Customer: r.customer_name || "",
		Mobile: r.customer_mobile || "",
		Item: r.item_name,
		SKU: r.sku_code || "",
		Qty: Number(r.quantity),
		"Net Amount (₹)": Number(r.net_amount),
		"Gross Amount (₹)": Number(r.gross_amount),
		"GST (₹)": Number(r.tax_amount),
	}));
}

/**
 * One detail sheet per real store found in the queried rows — never a
 * fixed count. Whatever `billed_by` values exist in the result set become
 * sheets; a new store shows up automatically with zero code change.
 */
function toPerStoreSheets(
	rows: any[],
): { name: string; rows: Record<string, unknown>[] }[] {
	const byStore = new Map<string, any[]>();
	for (const r of rows) {
		const store = String(r.store || "Unknown");
		if (!byStore.has(store)) byStore.set(store, []);
		byStore.get(store)!.push(r);
	}
	const usedNames = new Set<string>();
	return Array.from(byStore.entries()).map(([store, storeRows]) => {
		let name = store.replace(/[[\]:*?/\\]/g, "").slice(0, 31);
		while (usedNames.has(name)) {
			name = `${name.slice(0, 28)}_${usedNames.size}`;
		}
		usedNames.add(name);
		return { name, rows: toSalesSheetRows(storeRows) };
	});
}

function writeXlsx(
	data: Record<string, unknown>[],
	sheetName: string,
	absPath: string,
) {
	writeXlsxSheets([{ name: sheetName, rows: data }], absPath);
}

/**
 * Writes a multi-sheet workbook. Each sheet's rows are already the exact
 * shape to display — no fabricated/sample rows are added here, only
 * aggregates computed from the same queried row set the detail sheet uses.
 */
function writeXlsxSheets(
	sheets: { name: string; rows: Record<string, unknown>[] }[],
	absPath: string,
) {
	const wb = XLSX.utils.book_new();
	for (const sheet of sheets) {
		const ws = XLSX.utils.json_to_sheet(sheet.rows);
		// Sheet names are capped at 31 chars and can't contain []:*?/\
		const safeName = sheet.name.replace(/[[\]:*?/\\]/g, "").slice(0, 31);
		XLSX.utils.book_append_sheet(wb, ws, safeName);
	}
	// XLSX.writeFile() auto-detects the environment to decide how to save,
	// and that detection breaks under Next.js's bundled server runtime
	// (Turbopack/webpack) — it can't tell it's really Node and throws
	// "cannot save file". Writing the buffer ourselves sidesteps it.
	const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
	fs.writeFileSync(absPath, buffer);
}

function writePdf(
	data: Record<string, unknown>[],
	title: string,
	absPath: string,
) {
	const doc = new jsPDF({ orientation: "landscape" });
	const headers = Object.keys(data[0] || {});
	const body = data.map((row) => headers.map((h) => String(row[h] ?? "")));

	doc.setFontSize(14);
	doc.text(title, 10, 12);
	doc.setFontSize(9);
	doc.text(
		`Generated ${new Date().toISOString().slice(0, 10)} — ${data.length} rows`,
		10,
		18,
	);

	autoTable(doc, {
		head: [headers],
		body,
		startY: 24,
		theme: "striped",
		styles: { fontSize: 6, cellPadding: 1 },
		headStyles: { fillColor: [40, 40, 40], textColor: [255, 255, 255] },
		margin: { left: 8, right: 8 },
	});

	fs.writeFileSync(absPath, Buffer.from(doc.output("arraybuffer")));
}

async function saveReport(
	sheetData: Record<string, unknown>[],
	title: string,
	baseName: string,
	format: "xlsx" | "pdf",
	extraXlsxSheets?: { name: string; rows: Record<string, unknown>[] }[],
	detailSheetName?: string,
): Promise<{ id: string; filename: string; format: "xlsx" | "pdf" }> {
	const id = randomUUID();
	const filename = `${baseName}.${format}`;
	const absPath = path.join(reportsDir(), `${id}.${format}`);
	const mimeType =
		format === "xlsx"
			? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
			: "application/pdf";

	if (format === "xlsx") {
		if (extraXlsxSheets && extraXlsxSheets.length > 0) {
			writeXlsxSheets(
				[
					...extraXlsxSheets,
					{ name: detailSheetName ?? title.slice(0, 31), rows: sheetData },
				],
				absPath,
			);
		} else {
			writeXlsx(sheetData, title.slice(0, 31), absPath);
		}
	} else {
		writePdf(sheetData, title, absPath);
	}

	await sql`
		INSERT INTO ai_generated_reports (id, filename, mime_type, file_path, row_count)
		VALUES (${id}, ${filename}, ${mimeType}, ${absPath}, ${sheetData.length})
	`;

	return { id, filename, format };
}

export interface GenerateReportArgs {
	reportType: "inventory" | "sales";
	format: "xlsx" | "pdf" | "both";
	store?: string;
	startDate?: string;
	endDate?: string;
}

/**
 * Generates the requested report(s), writes them to disk, records metadata,
 * and returns download references. Never truncates to a top-N — the full
 * matching row set is always exported.
 */
export async function generateReport(
	args: GenerateReportArgs,
): Promise<ReportResult> {
	const formats: ("xlsx" | "pdf")[] =
		args.format === "both" ? ["xlsx", "pdf"] : [args.format];

	try {
		if (args.reportType === "inventory") {
			const rows = await fetchInventoryRows(args.store);
			if (rows.length === 0) {
				return {
					success: false,
					error: "No inventory data found for that store.",
				};
			}
			const sheetData = toInventorySheetRows(rows);
			const scope = args.store ? args.store.trim() : "AllStores";
			const title = `Full Inventory Report — ${scope}`;
			const baseName = `Inventory_${scope.replace(/\s+/g, "")}_Full`;
			const reports = await Promise.all(
				formats.map((f) => saveReport(sheetData, title, baseName, f)),
			);
			return { success: true, rowCount: rows.length, reports };
		}

		const endDate = isValidDate(args.endDate)
			? args.endDate
			: new Date().toISOString().split("T")[0];
		const startDate = isValidDate(args.startDate)
			? args.startDate
			: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
					.toISOString()
					.split("T")[0];

		const rows = await fetchSalesRows(startDate, endDate, args.store);
		if (rows.length === 0) {
			return {
				success: false,
				error: "No sales data found for that range/store.",
			};
		}
		const sheetData = toSalesSheetRows(rows);
		const scope = args.store ? args.store.trim() : "AllStores";
		const title = `Full Sales Report — ${scope} (${startDate} to ${endDate})`;
		const baseName = `Sales_${scope.replace(/\s+/g, "")}_${startDate}_to_${endDate}`;
		// Excel gets Summary + Store Performance + Sales Detail, all derived
		// from this same queried row set — no separate/fabricated aggregate
		// query. When the report isn't already scoped to one store, add one
		// additional detail sheet per real store found in the data — never a
		// fixed count (3 stores today, 4 tomorrow, both work with zero code
		// change). PDF keeps a single detail table.
		const summarySheetRows = toSalesSummarySheetRows(rows);
		const storePerfSheetRows = toStorePerformanceSheetRows(rows);
		const extraXlsxSheets = [
			{ name: "Sales Summary", rows: summarySheetRows },
			{ name: "Store Performance", rows: storePerfSheetRows },
			...(args.store ? [] : toPerStoreSheets(rows)),
		];
		const reports = await Promise.all(
			formats.map((f) =>
				saveReport(
					sheetData,
					title,
					baseName,
					f,
					f === "xlsx" ? extraXlsxSheets : undefined,
					"Sales Detail",
				),
			),
		);
		return { success: true, rowCount: rows.length, reports };
	} catch (err: any) {
		console.error(
			"[generateReport] failed:",
			err?.stack || err?.message || err,
		);
		return { success: false, error: "Failed to generate the report." };
	}
}
