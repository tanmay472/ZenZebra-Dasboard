import type { NeonQueryFunction } from "@neondatabase/serverless";
import {
	parseExcelBuffer,
	parseRawRows,
	parseResultToValidation,
} from "@/lib/parser/excel-parser";
import { createStoreNormalizer } from "@/lib/parser/store-normalizer";
import type { ParsedSalesRow, ValidationResult } from "./types";

type FounderSql = NeonQueryFunction<false, false>;
type UploadType = "full_replace" | "incremental";

const INSERT_CHUNK_SIZE = 1000;

function chunkRows(rows: ParsedSalesRow[]) {
	const chunks: ParsedSalesRow[][] = [];
	for (let index = 0; index < rows.length; index += INSERT_CHUNK_SIZE) {
		chunks.push(rows.slice(index, index + INSERT_CHUNK_SIZE));
	}
	return chunks;
}

export async function validateFounderUploadFile(
	db: FounderSql,
	file: File,
): Promise<ValidationResult> {
	const buffer = Buffer.from(await file.arrayBuffer());

	try {
		const parseResult = parseExcelBuffer(buffer);
		const validationResult = parseResultToValidation(parseResult);

		const normalizer = await createStoreNormalizer(db);

		const normalizationReport: Record<
			string,
			{
				displayName: string;
				rawSourcesCount: Record<string, number>;
				totalRows: number;
			}
		> = {};

		// Unknown-store rows are quarantined, never silently attributed to an
		// existing store (Phase 6A data-integrity fix). See store-normalizer.ts.
		const mappedRows: ParsedSalesRow[] = [];
		const unresolvedReasons: string[] = [];

		for (const row of validationResult.validData) {
			const rawBilled = row.billed_by;
			const mapping = normalizer.normalize(rawBilled);

			if (!mapping.resolved) {
				unresolvedReasons.push(
					`Row (bill: ${row.bill_no || "unknown"}): Unknown store '${mapping.rawValue || "(empty)"}'. Store mapping is required before import.`,
				);
				continue;
			}

			if (!normalizationReport[mapping.canonicalStore]) {
				normalizationReport[mapping.canonicalStore] = {
					displayName: mapping.displayName,
					rawSourcesCount: {},
					totalRows: 0,
				};
			}

			const storeReport = normalizationReport[mapping.canonicalStore]!;
			storeReport.rawSourcesCount[rawBilled] =
				(storeReport.rawSourcesCount[rawBilled] || 0) + 1;
			storeReport.totalRows += 1;

			mappedRows.push({
				...row,
				source_billed_by: rawBilled,
				billed_by: mapping.canonicalStore,
				store_id: mapping.storeId,
			});
		}

		return {
			...validationResult,
			isValid: validationResult.isValid && mappedRows.length > 0,
			validData: mappedRows,
			validRows: mappedRows.length,
			errorCount: validationResult.errorCount + unresolvedReasons.length,
			errors: [
				...validationResult.errors,
				...unresolvedReasons.map((reason, index) => ({
					rowNumber: validationResult.validData.length + index,
					errors: [reason],
				})),
			],
			quarantineReasons: [
				...(validationResult.quarantineReasons ?? []),
				...unresolvedReasons,
			],
			normalizationReport,
		};
	} catch (error) {
		return {
			isValid: false,
			totalRows: 0,
			validRows: 0,
			errorCount: 1,
			errors: [
				{
					rowNumber: 0,
					errors: [
						error instanceof Error
							? error.message
							: "Failed to parse Excel file",
					],
				},
			],
			validData: [],
			dateRange: { start: null, end: null },
		};
	}
}

export async function commitFounderUploadFile(
	db: FounderSql,
	file: File,
	uploadType: UploadType = "full_replace",
) {
	const validation = await validateFounderUploadFile(db, file);

	if (!validation.isValid || validation.validData.length === 0) {
		return {
			success: false,
			validation,
			error: "No valid rows found. Cannot commit upload.",
		};
	}

	const batchIdResult = await db`
    SELECT nextval(pg_get_serial_sequence('upload_batches', 'id'))::integer AS id
  `;
	const batchId = Number(batchIdResult[0]?.id);

	if (!Number.isFinite(batchId)) {
		throw new Error("Unable to allocate upload batch id.");
	}

	const validRows = validation.validData;
	const chunks = chunkRows(validRows);
	const latestSaleDate = validation.latestSaleDate ?? validation.dateRange.end;

	// Calculate metadata for tracking
	const storesFound = Array.from(
		new Set(validRows.map((r) => r.billed_by).filter(Boolean)),
	);
	const categoriesFound = Array.from(
		new Set(validRows.map((r) => r.category).filter(Boolean)),
	);
	const netSales = validRows.reduce((sum, r) => sum + (r.net_amount || 0), 0);

	await db.transaction?.((tx) => {
		const queries = [
			tx`
        INSERT INTO upload_batches (
          id,
          filename,
          status,
          row_count,
          error_count,
          valid_row_count,
          quarantined_row_count,
          date_range_start,
          date_range_end,
          upload_type,
          latest_sale_date,
          row_count_raw,
          row_count_stored,
          rows_quarantined,
          stores_found,
          categories_found,
          net_sales
        )
        VALUES (
          ${batchId},
          ${file.name},
          'success',
          ${validation.totalRows},
          ${validation.errorCount},
          ${validation.validRows},
          ${validation.errorCount},
          ${validation.dateRange.start},
          ${validation.dateRange.end},
          ${uploadType},
          ${latestSaleDate},
          ${validation.totalRows},
          ${validation.validRows},
          ${validation.errorCount},
          ${storesFound}::text[],
          ${categoriesFound}::text[],
          ${netSales}::numeric
        )
      `,
		];

		// Batch insert into staging_upload_rows in chunks of 1000
		const stagingChunks = [];
		for (let index = 0; index < validRows.length; index += 1000) {
			stagingChunks.push(
				validRows.slice(index, index + 1000).map((row, i) => ({
					row_number: index + i + 1,
					parsed: JSON.stringify(row),
					status: "valid",
				})),
			);
		}

		for (const chunk of stagingChunks) {
			queries.push(tx`
				INSERT INTO staging_upload_rows (batch_id, row_number, parsed, status, error_reason)
				SELECT * FROM UNNEST (
					${chunk.map(() => batchId)}::integer[],
					${chunk.map((r) => r.row_number)}::integer[],
					${chunk.map((r) => r.parsed)}::jsonb[],
					${chunk.map((r) => r.status)}::text[],
					${chunk.map(() => null)}::text[]
				)
			`);
		}

		if (uploadType === "full_replace") {
			const timestamp = Date.now();
			queries.push(
				tx.query(
					`CREATE TABLE sales_fact_backup_${timestamp} (LIKE sales_fact INCLUDING ALL)`,
				),
			);
			queries.push(
				tx.query(
					`INSERT INTO sales_fact_backup_${timestamp} SELECT * FROM sales_fact`,
				),
			);
			// Transaction-safe DELETE instead of truncate to avoid breaking UI during processing
			queries.push(tx`DELETE FROM sales_fact`);
		}

		for (const chunk of chunks) {
			queries.push(tx`
        INSERT INTO sales_fact (
          upload_id,
          sale_date,
          bill_no,
          billed_by,
          product_key,
          category,
          brand,
          sku_code,
          item_name,
          quantity,
          mrp_amount,
          discount_amount,
          gross_amount,
          tax_amount,
          net_amount,
          payment_method,
          customer_mobile,
          customer_name,
          source_billed_by,
          store_id
        )
        SELECT * FROM UNNEST (
          ${chunk.map(() => batchId)}::integer[],
          ${chunk.map((row) => row.sale_date)}::date[],
          ${chunk.map((row) => row.bill_no)}::text[],
          ${chunk.map((row) => row.billed_by)}::text[],
          ${chunk.map((row) => row.product_key)}::text[],
          ${chunk.map((row) => row.category)}::text[],
          ${chunk.map((row) => row.brand)}::text[],
          ${chunk.map((row) => row.sku_code)}::text[],
          ${chunk.map((row) => row.item_name)}::text[],
          ${chunk.map((row) => row.quantity)}::integer[],
          ${chunk.map((row) => row.mrp_amount)}::numeric[],
          ${chunk.map((row) => row.discount_amount)}::numeric[],
          ${chunk.map((row) => row.gross_amount)}::numeric[],
          ${chunk.map((row) => row.tax_amount)}::numeric[],
          ${chunk.map((row) => row.net_amount)}::numeric[],
          ${chunk.map((row) => row.payment_method)}::text[],
          ${chunk.map((row) => row.customer_mobile)}::text[],
          ${chunk.map((row) => row.customer_name)}::text[],
          ${chunk.map((row) => row.source_billed_by || row.billed_by)}::text[],
          ${chunk.map((row) => row.store_id || null)}::integer[]
        )
        ON CONFLICT (sale_date, bill_no, billed_by, product_key) DO UPDATE SET
          upload_id = EXCLUDED.upload_id,
          category = EXCLUDED.category,
          brand = EXCLUDED.brand,
          sku_code = EXCLUDED.sku_code,
          item_name = EXCLUDED.item_name,
          quantity = EXCLUDED.quantity,
          mrp_amount = EXCLUDED.mrp_amount,
          discount_amount = EXCLUDED.discount_amount,
          gross_amount = EXCLUDED.gross_amount,
          tax_amount = EXCLUDED.tax_amount,
          net_amount = EXCLUDED.net_amount,
          payment_method = EXCLUDED.payment_method,
          customer_mobile = EXCLUDED.customer_mobile,
          customer_name = EXCLUDED.customer_name,
          source_billed_by = EXCLUDED.source_billed_by,
          store_id = EXCLUDED.store_id
      `);
		}

		queries.push(tx`
      DELETE FROM staging_upload_rows
      WHERE batch_id = ${batchId}
    `);

		return queries;
	});

	return {
		success: true,
		batchId,
		rowsInserted: validation.validRows,
		validation,
	};
}

export async function startFounderUploadBatch(
	db: FounderSql,
	filename: string,
): Promise<number> {
	const batchIdResult = await db`
		SELECT nextval(pg_get_serial_sequence('upload_batches', 'id'))::integer AS id
	`;
	const batchId = Number(batchIdResult[0]?.id);
	if (!Number.isFinite(batchId)) {
		throw new Error("Unable to allocate upload batch id.");
	}

	await db`
		INSERT INTO upload_batches (id, filename, status, row_count, error_count, valid_row_count, quarantined_row_count, date_range_start, date_range_end, upload_type, latest_sale_date, row_count_raw, row_count_stored, rows_quarantined, stores_found, categories_found, net_sales)
		VALUES (${batchId}, ${filename}, 'processing', 0, 0, 0, 0, null, null, 'incremental', null, 0, 0, 0, ARRAY[]::text[], ARRAY[]::text[], 0)
	`;
	return batchId;
}

export async function stageFounderUploadChunk(
	db: FounderSql,
	batchId: number,
	chunkIndex: number,
	rawRows: any[],
): Promise<void> {
	if (rawRows.length === 0) return;

	const startIndex = chunkIndex * rawRows.length;
	const chunk = rawRows.map((row, i) => ({
		row_number: startIndex + i + 1,
		parsed: JSON.stringify(row),
		status: "valid",
	}));

	await db`
		INSERT INTO staging_upload_rows (batch_id, row_number, parsed, status, error_reason)
		SELECT * FROM UNNEST (
			${chunk.map(() => batchId)}::integer[],
			${chunk.map((r) => r.row_number)}::integer[],
			${chunk.map((r) => r.parsed)}::jsonb[],
			${chunk.map((r) => r.status)}::text[],
			${chunk.map(() => null)}::text[]
		)
	`;
}

export async function validateStagedFounderUpload(
	db: FounderSql,
	batchId: number,
): Promise<ValidationResult> {
	try {
		const stagedRows = await db`
			SELECT parsed FROM staging_upload_rows
			WHERE batch_id = ${batchId}
			ORDER BY row_number ASC
		`;

		const rawRows = stagedRows.map((r) => r.parsed as Record<string, unknown>);

		const parseResult = parseRawRows(rawRows);
		const validationResult = parseResultToValidation(parseResult);

		const normalizer = await createStoreNormalizer(db);

		const normalizationReport: Record<
			string,
			{
				displayName: string;
				rawSourcesCount: Record<string, number>;
				totalRows: number;
			}
		> = {};

		// Unknown-store rows are quarantined, never silently attributed to an
		// existing store (Phase 6A data-integrity fix). See store-normalizer.ts.
		const mappedRows: ParsedSalesRow[] = [];
		const unresolvedReasons: string[] = [];

		for (const row of validationResult.validData) {
			const rawBilled = row.billed_by;
			const mapping = normalizer.normalize(rawBilled);

			if (!mapping.resolved) {
				unresolvedReasons.push(
					`Row (bill: ${row.bill_no || "unknown"}): Unknown store '${mapping.rawValue || "(empty)"}'. Store mapping is required before import.`,
				);
				continue;
			}

			if (!normalizationReport[mapping.canonicalStore]) {
				normalizationReport[mapping.canonicalStore] = {
					displayName: mapping.displayName,
					rawSourcesCount: {},
					totalRows: 0,
				};
			}

			const storeReport = normalizationReport[mapping.canonicalStore]!;
			storeReport.rawSourcesCount[rawBilled] =
				(storeReport.rawSourcesCount[rawBilled] || 0) + 1;
			storeReport.totalRows += 1;

			mappedRows.push({
				...row,
				source_billed_by: rawBilled,
				billed_by: mapping.canonicalStore,
				store_id: mapping.storeId,
			});
		}

		return {
			...validationResult,
			isValid: validationResult.isValid && mappedRows.length > 0,
			validData: mappedRows,
			validRows: mappedRows.length,
			errorCount: validationResult.errorCount + unresolvedReasons.length,
			errors: [
				...validationResult.errors,
				...unresolvedReasons.map((reason, index) => ({
					rowNumber: validationResult.validData.length + index,
					errors: [reason],
				})),
			],
			quarantineReasons: [
				...(validationResult.quarantineReasons ?? []),
				...unresolvedReasons,
			],
			normalizationReport,
		};
	} catch (error) {
		return {
			isValid: false,
			totalRows: 0,
			validRows: 0,
			errorCount: 1,
			errors: [
				{
					rowNumber: 0,
					errors: [
						error instanceof Error
							? error.message
							: "Failed to parse staged Excel file",
					],
				},
			],
			validData: [],
			dateRange: { start: null, end: null },
		};
	}
}

export async function commitStagedFounderUpload(
	db: FounderSql,
	batchId: number,
	uploadType: UploadType = "full_replace",
) {
	const validation = await validateStagedFounderUpload(db, batchId);

	if (!validation.isValid || validation.validData.length === 0) {
		return {
			success: false,
			validation,
			error: "No valid rows found. Cannot commit upload.",
		};
	}

	const validRows = validation.validData;
	const chunks = chunkRows(validRows);
	const latestSaleDate = validation.latestSaleDate ?? validation.dateRange.end;

	const storesFound = Array.from(
		new Set(validRows.map((r) => r.billed_by).filter(Boolean)),
	);
	const categoriesFound = Array.from(
		new Set(validRows.map((r) => r.category).filter(Boolean)),
	);
	const netSales = validRows.reduce((sum, r) => sum + (r.net_amount || 0), 0);

	await db.transaction?.((tx) => {
		const queries = [
			tx`
				UPDATE upload_batches
				SET
					status = 'success',
					row_count = ${validation.totalRows},
					error_count = ${validation.errorCount},
					valid_row_count = ${validation.validRows},
					quarantined_row_count = ${validation.errorCount},
					date_range_start = ${validation.dateRange.start},
					date_range_end = ${validation.dateRange.end},
					upload_type = ${uploadType},
					latest_sale_date = ${latestSaleDate},
					row_count_raw = ${validation.totalRows},
					row_count_stored = ${validation.validRows},
					rows_quarantined = ${validation.errorCount},
					stores_found = ${storesFound}::text[],
					categories_found = ${categoriesFound}::text[],
					net_sales = ${netSales}::numeric
				WHERE id = ${batchId}
			`,
		];

		if (uploadType === "full_replace") {
			const timestamp = Date.now();
			queries.push(
				tx([
					`CREATE TABLE sales_fact_backup_${timestamp} (LIKE sales_fact INCLUDING ALL)`,
				] as any),
			);
			queries.push(
				tx([
					`INSERT INTO sales_fact_backup_${timestamp} SELECT * FROM sales_fact`,
				] as any),
			);
			queries.push(tx`DELETE FROM sales_fact`);
		}

		for (const chunk of chunks) {
			queries.push(tx`
				INSERT INTO sales_fact (
					upload_id,
					sale_date,
					bill_no,
					billed_by,
					product_key,
					category,
					brand,
					sku_code,
					item_name,
					quantity,
					mrp_amount,
					discount_amount,
					gross_amount,
					tax_amount,
					net_amount,
					payment_method,
					customer_mobile,
					customer_name,
					source_billed_by,
					store_id
				)
				SELECT * FROM UNNEST (
					${chunk.map(() => batchId)}::integer[],
					${chunk.map((row) => row.sale_date)}::date[],
					${chunk.map((row) => row.bill_no)}::text[],
					${chunk.map((row) => row.billed_by)}::text[],
					${chunk.map((row) => row.product_key)}::text[],
					${chunk.map((row) => row.category)}::text[],
					${chunk.map((row) => row.brand)}::text[],
					${chunk.map((row) => row.sku_code)}::text[],
					${chunk.map((row) => row.item_name)}::text[],
					${chunk.map((row) => row.quantity)}::integer[],
					${chunk.map((row) => row.mrp_amount)}::numeric[],
					${chunk.map((row) => row.discount_amount)}::numeric[],
					${chunk.map((row) => row.gross_amount)}::numeric[],
					${chunk.map((row) => row.tax_amount)}::numeric[],
					${chunk.map((row) => row.net_amount)}::numeric[],
					${chunk.map((row) => row.payment_method)}::text[],
					${chunk.map((row) => row.customer_mobile)}::text[],
					${chunk.map((row) => row.customer_name)}::text[],
					${chunk.map((row) => row.source_billed_by || row.billed_by)}::text[],
					${chunk.map((row) => row.store_id || null)}::integer[]
				)
				ON CONFLICT (sale_date, bill_no, billed_by, product_key) DO UPDATE SET
					upload_id = EXCLUDED.upload_id,
					category = EXCLUDED.category,
					brand = EXCLUDED.brand,
					sku_code = EXCLUDED.sku_code,
					item_name = EXCLUDED.item_name,
					quantity = EXCLUDED.quantity,
					mrp_amount = EXCLUDED.mrp_amount,
					discount_amount = EXCLUDED.discount_amount,
					gross_amount = EXCLUDED.gross_amount,
					tax_amount = EXCLUDED.tax_amount,
					net_amount = EXCLUDED.net_amount,
					payment_method = EXCLUDED.payment_method,
					customer_mobile = EXCLUDED.customer_mobile,
					customer_name = EXCLUDED.customer_name,
					source_billed_by = EXCLUDED.source_billed_by,
					store_id = EXCLUDED.store_id
			`);
		}

		queries.push(tx`
			DELETE FROM staging_upload_rows
			WHERE batch_id = ${batchId}
		`);

		return queries;
	});

	return {
		success: true,
		batchId,
		rowsInserted: validation.validRows,
		validation,
	};
}
