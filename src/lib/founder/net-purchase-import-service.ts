import type { NeonQueryFunction } from "@neondatabase/serverless";
import {
	type ParsedNetPurchaseRow,
	parseNetPurchaseExcelBuffer,
	parseNetPurchaseRawRows,
} from "@/lib/parser/net-purchase-parser";
import { createStoreNormalizer } from "@/lib/parser/store-normalizer";

type FounderSql = NeonQueryFunction<false, false>;
type UploadType = "full_replace" | "incremental";

const INSERT_CHUNK_SIZE = 1000;

export interface NetPurchaseImportResult {
	success: boolean;
	error?: string;
	batchId?: number;
	rowsInserted?: number;
	quarantined?: number;
	quarantineReasons?: string[];
	dateRange?: { start: string | null; end: string | null };
	netPurchase?: number;
	normalizationReport?: Record<
		string,
		{
			displayName: string;
			rawSourcesCount: Record<string, number>;
			totalRows: number;
		}
	>;
	_validatedRows?: ParsedNetPurchaseRow[];
}

function chunkRows(rows: ParsedNetPurchaseRow[]) {
	const chunks: ParsedNetPurchaseRow[][] = [];
	for (let index = 0; index < rows.length; index += INSERT_CHUNK_SIZE) {
		chunks.push(rows.slice(index, index + INSERT_CHUNK_SIZE));
	}
	return chunks;
}

// ── File-based upload (single POST with the full file) ───────────────────

/**
 * Parse + normalize a net purchase workbook and commit into `net_purchase_fact`.
 *
 * Store normalization reuses the shared store normalizer (same as sales/purchase)
 * so store aliases collapse correctly.
 */
export async function commitNetPurchaseUploadFile(
	db: FounderSql,
	file: File,
	uploadType: UploadType = "full_replace",
): Promise<NetPurchaseImportResult> {
	const buffer = Buffer.from(await file.arrayBuffer());

	let parsed: ReturnType<typeof parseNetPurchaseExcelBuffer>;
	try {
		parsed = parseNetPurchaseExcelBuffer(buffer);
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to parse net purchase file",
		};
	}

	if (parsed.rows.length === 0) {
		return {
			success: false,
			error: "No valid net purchase rows found. Cannot commit upload.",
			quarantined: parsed.quarantined,
			quarantineReasons: parsed.quarantine_reasons,
		};
	}

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
	const mappedRows: ParsedNetPurchaseRow[] = [];
	const unresolvedReasons: string[] = [];

	for (const row of parsed.rows) {
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
		const reportItem = normalizationReport[mapping.canonicalStore];
		if (reportItem) {
			reportItem.rawSourcesCount[rawBilled] =
				(reportItem.rawSourcesCount[rawBilled] || 0) + 1;
			reportItem.totalRows += 1;
		}
		mappedRows.push({
			...row,
			source_billed_by: rawBilled,
			billed_by: mapping.canonicalStore,
			store_id: mapping.storeId,
		});
	}

	const totalQuarantined = parsed.quarantined + unresolvedReasons.length;
	const quarantineReasons = [
		...parsed.quarantine_reasons,
		...unresolvedReasons,
	];

	if (mappedRows.length === 0) {
		return {
			success: false,
			error: "No valid net purchase rows found. Cannot commit upload.",
			quarantined: totalQuarantined,
			quarantineReasons,
		};
	}

	const dates = mappedRows.map((r) => r.purchase_date).sort();
	const dateRange = { start: dates[0] ?? null, end: dates.at(-1) ?? null };
	const netPurchase = mappedRows.reduce(
		(sum, r) => sum + (r.net_purchase_amount || 0),
		0,
	);

	const batchIdResult = await db`
    SELECT nextval(pg_get_serial_sequence('net_purchase_batches', 'id'))::integer AS id
  `;
	const batchId = Number(batchIdResult[0]?.id);
	if (!Number.isFinite(batchId)) {
		throw new Error("Unable to allocate net purchase batch id.");
	}

	const chunks = chunkRows(mappedRows);

	await db.transaction?.((tx) => {
		const queries = [
			tx`
        INSERT INTO net_purchase_batches (
          id, filename, status, row_count, valid_row_count, quarantined_row_count,
          date_range_start, date_range_end, upload_type, net_purchase
        ) VALUES (
          ${batchId}, ${file.name}, 'success', ${parsed.raw_row_count},
          ${mappedRows.length}, ${totalQuarantined},
          ${dateRange.start}, ${dateRange.end}, ${uploadType}, ${netPurchase}::numeric
        )
      `,
		];

		if (uploadType === "full_replace") {
			queries.push(tx`DELETE FROM net_purchase_fact`);
		}

		for (const chunk of chunks) {
			queries.push(tx`
        INSERT INTO net_purchase_fact (
          upload_id, purchase_date, bill_no, billed_by, product_key, sku_code,
          item_name, brand, category, quantity, gross_purchase_amount, tax_amount,
          net_purchase_amount, supplier_name, source_billed_by, store_id
        )
        SELECT * FROM UNNEST (
          ${chunk.map(() => batchId)}::integer[],
          ${chunk.map((r) => r.purchase_date)}::date[],
          ${chunk.map((r) => r.bill_no)}::text[],
          ${chunk.map((r) => r.billed_by)}::text[],
          ${chunk.map((r) => r.product_key)}::text[],
          ${chunk.map((r) => r.sku_code)}::text[],
          ${chunk.map((r) => r.item_name)}::text[],
          ${chunk.map((r) => r.brand)}::text[],
          ${chunk.map((r) => r.category)}::text[],
          ${chunk.map((r) => r.quantity)}::integer[],
          ${chunk.map((r) => r.gross_purchase_amount)}::numeric[],
          ${chunk.map((r) => r.tax_amount)}::numeric[],
          ${chunk.map((r) => r.net_purchase_amount)}::numeric[],
          ${chunk.map((r) => r.supplier_name)}::text[],
          ${chunk.map((r) => r.source_billed_by || r.billed_by)}::text[],
          ${chunk.map((r) => r.store_id || null)}::integer[]
        )
        ON CONFLICT (purchase_date, COALESCE(bill_no, ''), COALESCE(billed_by, ''), product_key)
        DO UPDATE SET
          upload_id = EXCLUDED.upload_id,
          sku_code = EXCLUDED.sku_code,
          item_name = EXCLUDED.item_name,
          brand = EXCLUDED.brand,
          category = EXCLUDED.category,
          quantity = EXCLUDED.quantity,
          gross_purchase_amount = EXCLUDED.gross_purchase_amount,
          tax_amount = EXCLUDED.tax_amount,
          net_purchase_amount = EXCLUDED.net_purchase_amount,
          supplier_name = EXCLUDED.supplier_name,
          source_billed_by = EXCLUDED.source_billed_by,
          store_id = EXCLUDED.store_id
      `);
		}

		return queries;
	});

	return {
		success: true,
		batchId,
		rowsInserted: mappedRows.length,
		quarantined: totalQuarantined,
		quarantineReasons,
		dateRange,
		netPurchase,
		normalizationReport,
	};
}

// ── Chunked upload (start → stage → validate → commit) ──────────────────

export async function startNetPurchaseUploadBatch(
	db: FounderSql,
	filename: string,
): Promise<number> {
	const batchIdResult = await db`
		SELECT nextval(pg_get_serial_sequence('net_purchase_batches', 'id'))::integer AS id
	`;
	const batchId = Number(batchIdResult[0]?.id);
	if (!Number.isFinite(batchId)) {
		throw new Error("Unable to allocate net purchase batch id.");
	}

	await db`
		INSERT INTO net_purchase_batches (id, filename, status, row_count, valid_row_count, quarantined_row_count, date_range_start, date_range_end, upload_type, net_purchase)
		VALUES (${batchId}, ${filename}, 'processing', 0, 0, 0, null, null, 'incremental', 0)
	`;
	return batchId;
}

export async function stageNetPurchaseUploadChunk(
	db: FounderSql,
	batchId: number,
	chunkIndex: number,
	rawRows: Record<string, unknown>[],
): Promise<void> {
	if (rawRows.length === 0) return;

	const startIndex = chunkIndex * rawRows.length;
	const chunk = rawRows.map((row, i) => ({
		row_number: startIndex + i + 1,
		parsed: JSON.stringify(row),
		status: "valid",
	}));

	await db`
		INSERT INTO staging_net_purchase_rows (batch_id, row_number, parsed, status, error_reason)
		SELECT * FROM UNNEST (
			${chunk.map(() => batchId)}::integer[],
			${chunk.map((r) => r.row_number)}::integer[],
			${chunk.map((r) => r.parsed)}::jsonb[],
			${chunk.map((r) => r.status)}::text[],
			${chunk.map(() => null)}::text[]
		)
	`;
}

export async function validateStagedNetPurchaseUpload(
	db: FounderSql,
	batchId: number,
): Promise<NetPurchaseImportResult> {
	try {
		const stagedRows = await db`
			SELECT parsed FROM staging_net_purchase_rows
			WHERE batch_id = ${batchId}
			ORDER BY row_number ASC
		`;

		const rawRows = stagedRows.map((r) => r.parsed as Record<string, unknown>);
		const parsed = parseNetPurchaseRawRows(rawRows);

		if (parsed.rows.length === 0) {
			return {
				success: false,
				error: "No valid net purchase rows found. Cannot commit upload.",
				quarantined: parsed.quarantined,
				quarantineReasons: parsed.quarantine_reasons,
			};
		}

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
		const mappedRows: ParsedNetPurchaseRow[] = [];
		const unresolvedReasons: string[] = [];

		for (const row of parsed.rows) {
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
			const reportItem = normalizationReport[mapping.canonicalStore];
			if (reportItem) {
				reportItem.rawSourcesCount[rawBilled] =
					(reportItem.rawSourcesCount[rawBilled] || 0) + 1;
				reportItem.totalRows += 1;
			}
			mappedRows.push({
				...row,
				source_billed_by: rawBilled,
				billed_by: mapping.canonicalStore,
				store_id: mapping.storeId,
			});
		}

		const totalQuarantined = parsed.quarantined + unresolvedReasons.length;
		const quarantineReasons = [
			...parsed.quarantine_reasons,
			...unresolvedReasons,
		];

		if (mappedRows.length === 0) {
			return {
				success: false,
				error: "No valid net purchase rows found. Cannot commit upload.",
				quarantined: totalQuarantined,
				quarantineReasons,
			};
		}

		const dates = mappedRows.map((r) => r.purchase_date).sort();
		const dateRange = { start: dates[0] ?? null, end: dates.at(-1) ?? null };
		const netPurchase = mappedRows.reduce(
			(sum, r) => sum + (r.net_purchase_amount || 0),
			0,
		);

		return {
			success: true,
			batchId,
			rowsInserted: mappedRows.length,
			quarantined: totalQuarantined,
			quarantineReasons,
			dateRange,
			netPurchase,
			normalizationReport,
			_validatedRows: mappedRows,
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to parse net purchase staged rows",
		};
	}
}

export async function commitStagedNetPurchaseUpload(
	db: FounderSql,
	batchId: number,
	uploadType: UploadType = "full_replace",
) {
	const validation = await validateStagedNetPurchaseUpload(db, batchId);

	if (
		!validation.success ||
		!validation._validatedRows ||
		validation.rowsInserted === 0
	) {
		return {
			success: false,
			error: validation.error || "No valid rows found. Cannot commit upload.",
			validation,
		};
	}

	const mappedRows = validation._validatedRows;
	const chunks = chunkRows(mappedRows);
	const dateRange = validation.dateRange ?? { start: null, end: null };
	const netPurchase = validation.netPurchase ?? 0;
	const rowsInserted = validation.rowsInserted ?? 0;
	const quarantined = validation.quarantined ?? 0;

	await db.transaction?.((tx) => {
		const queries = [
			tx`
				UPDATE net_purchase_batches
				SET
					status = 'success',
					row_count = ${rowsInserted + quarantined},
					valid_row_count = ${rowsInserted},
					quarantined_row_count = ${quarantined},
					date_range_start = ${dateRange.start},
					date_range_end = ${dateRange.end},
					upload_type = ${uploadType},
					net_purchase = ${netPurchase}::numeric
				WHERE id = ${batchId}
			`,
		];

		if (uploadType === "full_replace") {
			queries.push(tx`DELETE FROM net_purchase_fact`);
		}

		for (const chunk of chunks) {
			queries.push(tx`
				INSERT INTO net_purchase_fact (
					upload_id, purchase_date, bill_no, billed_by, product_key, sku_code,
					item_name, brand, category, quantity, gross_purchase_amount, tax_amount,
					net_purchase_amount, supplier_name, source_billed_by, store_id
				)
				SELECT * FROM UNNEST (
					${chunk.map(() => batchId)}::integer[],
					${chunk.map((r) => r.purchase_date)}::date[],
					${chunk.map((r) => r.bill_no)}::text[],
					${chunk.map((r) => r.billed_by)}::text[],
					${chunk.map((r) => r.product_key)}::text[],
					${chunk.map((r) => r.sku_code)}::text[],
					${chunk.map((r) => r.item_name)}::text[],
					${chunk.map((r) => r.brand)}::text[],
					${chunk.map((r) => r.category)}::text[],
					${chunk.map((r) => r.quantity)}::integer[],
					${chunk.map((r) => r.gross_purchase_amount)}::numeric[],
					${chunk.map((r) => r.tax_amount)}::numeric[],
					${chunk.map((r) => r.net_purchase_amount)}::numeric[],
					${chunk.map((r) => r.supplier_name)}::text[],
					${chunk.map((r) => r.source_billed_by || r.billed_by)}::text[],
					${chunk.map((r) => r.store_id || null)}::integer[]
				)
				ON CONFLICT (purchase_date, COALESCE(bill_no, ''), COALESCE(billed_by, ''), product_key)
				DO UPDATE SET
					upload_id = EXCLUDED.upload_id,
					sku_code = EXCLUDED.sku_code,
					item_name = EXCLUDED.item_name,
					brand = EXCLUDED.brand,
					category = EXCLUDED.category,
					quantity = EXCLUDED.quantity,
					gross_purchase_amount = EXCLUDED.gross_purchase_amount,
					tax_amount = EXCLUDED.tax_amount,
					net_purchase_amount = EXCLUDED.net_purchase_amount,
					supplier_name = EXCLUDED.supplier_name,
					source_billed_by = EXCLUDED.source_billed_by,
					store_id = EXCLUDED.store_id
			`);
		}

		queries.push(tx`
			DELETE FROM staging_net_purchase_rows
			WHERE batch_id = ${batchId}
		`);

		return queries;
	});

	return {
		success: true,
		batchId,
		rowsInserted: validation.rowsInserted,
		validation,
	};
}
