import * as XLSX from "xlsx";

/**
 * Utility to export an array of JSON objects to an Excel file.
 * @param data Array of objects to export
 * @param filename Name of the file (without extension)
 * @param sheetName Name of the sheet inside the workbook
 */
export function exportToExcel(
	data: Array<any>,
	filename: string,
	sheetName: string,
) {
	try {
		// Clone data to avoid mutating original objects
		const cleanedData = data.map((item) => {
			const cleaned: Record<string, any> = {};
			for (const [key, value] of Object.entries(item)) {
				// Exclude internal metadata or helper fields
				if (key === "footnote" || key.startsWith("_")) continue;
				cleaned[key] = value;
			}
			return cleaned;
		});

		const worksheet = XLSX.utils.json_to_sheet(cleanedData);
		const workbook = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
		XLSX.writeFile(workbook, `${filename}.xlsx`);
	} catch (error) {
		console.error("Failed to export Excel file", error);
	}
}

/** Store token used in export filenames and the Summary sheet. */
export function storeExportToken(store: string | null | undefined): string {
	if (!store || store === "ALL" || store === "All Stores") return "All_Stores";
	return store.trim().replace(/[^a-zA-Z0-9]/g, "_");
}

/** Compact YYYY-MM (or YYYY-MM-DD_to_YYYY-MM-DD) token for filenames. */
export function timePeriodExportToken(
	startDate: string,
	endDate: string,
): string {
	const startMonth = startDate.slice(0, 7);
	const endMonth = endDate.slice(0, 7);
	return startMonth === endMonth ? startMonth : `${startDate}_to_${endDate}`;
}

interface ExportColumn<T> {
	header: string;
	accessor: (row: T, rank: number) => string | number | null;
}

/**
 * Builds a two-sheet workbook (Summary + Data) for a dashboard export:
 * Sheet 1 documents the export context, Sheet 2 holds every matching row
 * sorted by the given metric, highest to lowest.
 */
export function exportDashboardWorkbook<T>({
	dashboardName,
	store,
	startDate,
	endDate,
	rows,
	columns,
	sortBy,
	dataSheetName = "Data",
}: {
	dashboardName: string;
	store: string | null | undefined;
	startDate: string;
	endDate: string;
	rows: T[];
	columns: ExportColumn<T>[];
	sortBy: (row: T) => number;
	dataSheetName?: string;
}) {
	try {
		const storeToken = storeExportToken(store);
		const sortedRows = [...rows].sort((a, b) => sortBy(b) - sortBy(a));

		const summaryRows = [
			{ Field: "Dashboard Name", Value: dashboardName.replace(/_/g, " ") },
			{ Field: "Store", Value: storeToken },
			{ Field: "Time Period", Value: `${startDate} to ${endDate}` },
			{ Field: "Generated At", Value: new Date().toLocaleString() },
			{ Field: "Total Records", Value: sortedRows.length },
		];

		const dataRows = sortedRows.map((row, index) => {
			const record: Record<string, string | number | null> = {};
			for (const column of columns) {
				record[column.header] = column.accessor(row, index + 1);
			}
			return record;
		});

		const summarySheet = XLSX.utils.json_to_sheet(summaryRows);
		summarySheet["!cols"] = [{ wch: 22 }, { wch: 40 }];
		const dataSheet = XLSX.utils.json_to_sheet(dataRows);

		const workbook = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(workbook, summarySheet, "Summary");
		XLSX.utils.book_append_sheet(workbook, dataSheet, dataSheetName);

		const periodToken = timePeriodExportToken(startDate, endDate);
		const filename = `${dashboardName}_${storeToken}_${periodToken}.xlsx`;
		XLSX.writeFile(workbook, filename);
		return filename;
	} catch (error) {
		console.error("Failed to export Excel workbook", error);
		return null;
	}
}
