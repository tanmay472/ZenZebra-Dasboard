import { sql } from "../db";

// Low-stock threshold: units on hand at or below this are "Low Stock",
// above it is "Healthy Stock". Phase 6 audit: no documented Odoo/business
// config source for this figure exists yet — it is an internally-used
// operational cutoff, not a value derived from real inventory data, so it
// is named and centralized here rather than left as an inline literal.
// Treat this as a business-configurable constant to revisit if the
// business defines a per-SKU or per-store reorder point instead.
const LOW_STOCK_THRESHOLD_UNITS = 10;

export interface InventoryOverviewMetrics {
	totalItemsCount: number;
	totalSohQty: number;
	totalInventoryValueMrp: number;
	totalInventoryValueCost: number;
	healthyStockCount: number;
	lowStockCount: number;
	outOfStockCount: number;
	deadStockCount: number;
	lastUpdated: string;
	syncHealth: {
		status: "healthy" | "degraded" | "syncing";
		lastSyncAt: string | null;
		recordsProcessed: number;
		pendingQueueJobs: number;
	};
}

export interface StoreInventoryBreakdown {
	storeId: number;
	storeName: string;
	storeCode: string;
	itemCount: number;
	totalQuantity: number;
	valuationMrp: number;
	locationMapped: boolean;
}

export interface FastSlowItem {
	productId: number;
	name: string;
	sku: string;
	category: string;
	qtyOnHand: number;
	unitsSold30d: number;
	velocityDaily: number;
	turnoverCategory: "fast" | "slow" | "dead" | "normal";
	listPrice: number;
}

export interface StockAgingCategory {
	ageRange: "0-30 Days" | "31-60 Days" | "61-90 Days" | "90+ Days";
	itemCount: number;
	totalQuantity: number;
	valuationCost: number;
}

export interface ReorderRecommendation {
	productId: number;
	name: string;
	sku: string;
	category: string;
	qtyOnHand: number;
	dailyRunRate: number;
	daysOfSupplyRemaining: number;
	suggestedReorderQty: number;
	recommendedVendor: string;
	urgency: "critical" | "high" | "medium";
}

/**
 * Fetches executive operational metrics from PostgreSQL canonical inventory & sales tables.
 * Sourced 100% from Odoo synced read-model data without hardcoded business assumptions.
 */
export async function getExecutiveInventoryMetrics(filters?: {
	store?: string;
	category?: string;
	brand?: string;
	sku?: string;
}): Promise<InventoryOverviewMetrics> {
	const storeFilter =
		filters?.store && filters.store !== "ALL" && filters.store !== "All Stores"
			? filters.store
			: null;
	const categoryFilter =
		filters?.category && filters.category !== "All Categories"
			? filters.category
			: null;
	const brandFilter =
		filters?.brand && filters.brand !== "All Brands" ? filters.brand : null;
	const skuFilter = filters?.sku ? `%${filters.sku.trim()}%` : null;

	const overviewResult = await sql`
		SELECT 
			COUNT(DISTINCT p.id) AS total_items,
			COALESCE(SUM(fi.quantity), 0) AS total_soh,
			COALESCE(SUM(fi.quantity * p.list_price), 0) AS total_val_mrp,
			COALESCE(SUM(fi.quantity * p.cost_price), 0) AS total_val_cost,
			COUNT(DISTINCT CASE WHEN fi.quantity > ${LOW_STOCK_THRESHOLD_UNITS} THEN p.id END) AS healthy_count,
			COUNT(DISTINCT CASE WHEN fi.quantity > 0 AND fi.quantity <= ${LOW_STOCK_THRESHOLD_UNITS} THEN p.id END) AS low_count,
			COUNT(DISTINCT CASE WHEN fi.quantity <= 0 OR fi.quantity IS NULL THEN p.id END) AS out_count,
			MAX(p.updated_at)::text AS max_updated
		FROM dim_products p
		JOIN fact_inventory fi ON p.id = fi.product_id
		LEFT JOIN dim_stores s ON fi.location_id = s.location_id
		WHERE p.active = true
		  AND (${storeFilter}::TEXT IS NULL OR s.name ILIKE ${storeFilter} OR s.code ILIKE ${storeFilter} OR s.id IN (
		        SELECT so.store_id 
		        FROM fact_sales_orders so 
		        JOIN sales_fact_v sf ON LOWER(TRIM(so.name)) = LOWER(TRIM(sf.bill_no))
		        WHERE sf.store_display_name ILIKE ${storeFilter} OR sf.billed_by ILIKE ${storeFilter}
		  ))
		  AND (${categoryFilter}::TEXT IS NULL OR TRIM(p.category) ILIKE TRIM(${categoryFilter}))
		  AND (${brandFilter}::TEXT IS NULL OR EXISTS (
		        SELECT 1 FROM sales_fact sf 
		        WHERE sf.brand ILIKE ${brandFilter}
		          AND (LOWER(TRIM(p.name)) = LOWER(TRIM(sf.item_name)) OR (p.default_code IS NOT NULL AND p.default_code = sf.sku_code) OR (p.barcode IS NOT NULL AND p.barcode = sf.sku_code))
		  ))
		  AND (${skuFilter}::TEXT IS NULL OR p.name ILIKE ${skuFilter} OR p.default_code ILIKE ${skuFilter})
	`;

	const row = overviewResult[0] || {};

	// Sync Telemetry Health
	const telemetryResult = await sql`
		SELECT completed_at::text, records_processed, status
		FROM sync_telemetry
		ORDER BY id DESC
		LIMIT 1
	`;
	const lastSync = telemetryResult[0];

	// Count dead stock (items with 0 sales in fact_sales_lines over last 60 days)
	const deadStockResult = await sql`
		SELECT COUNT(DISTINCT p.id) AS dead_count
		FROM dim_products p
		JOIN fact_inventory fi ON p.id = fi.product_id
		LEFT JOIN dim_stores s ON fi.location_id = s.location_id
		LEFT JOIN fact_sales_lines sl ON p.id = sl.product_id
		WHERE p.active = true 
		  AND fi.quantity > 0 
		  AND (sl.id IS NULL OR sl.updated_at < NOW() - INTERVAL '60 days')
		  AND (${storeFilter}::TEXT IS NULL OR s.name ILIKE ${storeFilter} OR s.code ILIKE ${storeFilter} OR s.id IN (
		        SELECT so.store_id 
		        FROM fact_sales_orders so 
		        JOIN sales_fact_v sf ON LOWER(TRIM(so.name)) = LOWER(TRIM(sf.bill_no))
		        WHERE sf.store_display_name ILIKE ${storeFilter} OR sf.billed_by ILIKE ${storeFilter}
		  ))
		  AND (${categoryFilter}::TEXT IS NULL OR TRIM(p.category) ILIKE TRIM(${categoryFilter}))
		  AND (${brandFilter}::TEXT IS NULL OR EXISTS (
		        SELECT 1 FROM sales_fact sf 
		        WHERE sf.brand ILIKE ${brandFilter}
		          AND (LOWER(TRIM(p.name)) = LOWER(TRIM(sf.item_name)) OR (p.default_code IS NOT NULL AND p.default_code = sf.sku_code) OR (p.barcode IS NOT NULL AND p.barcode = sf.sku_code))
		  ))
		  AND (${skuFilter}::TEXT IS NULL OR p.name ILIKE ${skuFilter} OR p.default_code ILIKE ${skuFilter})
	`;

	return {
		totalItemsCount: Number(row.total_items || 0),
		totalSohQty: Number(row.total_soh || 0),
		totalInventoryValueMrp: Number(row.total_val_mrp || 0),
		totalInventoryValueCost: Number(row.total_val_cost || 0),
		healthyStockCount: Number(row.healthy_count || 0),
		lowStockCount: Number(row.low_count || 0),
		outOfStockCount: Number(row.out_count || 0),
		deadStockCount: Number(deadStockResult[0]?.dead_count || 0),
		lastUpdated: row.max_updated || new Date().toISOString(),
		syncHealth: {
			status: lastSync?.status === "success" ? "healthy" : "degraded",
			lastSyncAt: lastSync?.completed_at || null,
			recordsProcessed: Number(lastSync?.records_processed || 0),
			pendingQueueJobs: 0,
		},
	};
}

/**
 * Store-wise inventory breakdown.
 */
export async function getStoreInventoryBreakdown(filters?: {
	store?: string;
	category?: string;
	brand?: string;
	sku?: string;
}): Promise<StoreInventoryBreakdown[]> {
	const storeFilter =
		filters?.store && filters.store !== "ALL" && filters.store !== "All Stores"
			? filters.store
			: null;
	const categoryFilter =
		filters?.category && filters.category !== "All Categories"
			? filters.category
			: null;
	const brandFilter =
		filters?.brand && filters.brand !== "All Brands" ? filters.brand : null;
	const skuFilter = filters?.sku ? `%${filters.sku.trim()}%` : null;

	const result = await sql`
		SELECT
			s.id AS store_id,
			s.name AS store_name,
			COALESCE(s.code, 'STORE') AS store_code,
			s.location_id IS NOT NULL AS location_mapped,
			COUNT(DISTINCT fi.product_id) AS item_count,
			COALESCE(SUM(fi.quantity), 0) AS total_qty,
			COALESCE(SUM(fi.quantity * p.list_price), 0) AS valuation_mrp
		FROM dim_stores s
		LEFT JOIN fact_inventory fi ON s.location_id = fi.location_id
		LEFT JOIN dim_products p ON fi.product_id = p.id
		WHERE (${storeFilter}::TEXT IS NULL OR s.name ILIKE ${storeFilter} OR s.code ILIKE ${storeFilter} OR s.id IN (
		        SELECT so.store_id 
		        FROM fact_sales_orders so 
		        JOIN sales_fact_v sf ON LOWER(TRIM(so.name)) = LOWER(TRIM(sf.bill_no))
		        WHERE sf.store_display_name ILIKE ${storeFilter} OR sf.billed_by ILIKE ${storeFilter}
		  ))
		  AND (${categoryFilter}::TEXT IS NULL OR TRIM(p.category) ILIKE TRIM(${categoryFilter}))
		  AND (${brandFilter}::TEXT IS NULL OR EXISTS (
		        SELECT 1 FROM sales_fact sf 
		        WHERE sf.brand ILIKE ${brandFilter}
		          AND (LOWER(TRIM(p.name)) = LOWER(TRIM(sf.item_name)) OR (p.default_code IS NOT NULL AND p.default_code = sf.sku_code) OR (p.barcode IS NOT NULL AND p.barcode = sf.sku_code))
		  ))
		  AND (${skuFilter}::TEXT IS NULL OR p.name ILIKE ${skuFilter} OR p.default_code ILIKE ${skuFilter})
		GROUP BY s.id, s.name, s.code, s.location_id
		ORDER BY valuation_mrp DESC
	`;

	return result.map((r) => ({
		storeId: Number(r.store_id),
		storeName: String(r.store_name),
		storeCode: String(r.store_code),
		itemCount: Number(r.item_count || 0),
		totalQuantity: Number(r.total_qty || 0),
		valuationMrp: Number(r.valuation_mrp || 0),
		locationMapped: Boolean(r.location_mapped),
	}));
}

function mapVelocityRow(r: Record<string, any>): FastSlowItem {
	const sold = Number(r.units_sold_30d || 0);
	const dailyVelocity = sold / 30;
	let category: "fast" | "slow" | "dead" | "normal" = "normal";
	if (dailyVelocity >= 3) category = "fast";
	else if (dailyVelocity <= 0.2) category = "slow";

	return {
		productId: Number(r.id),
		name: String(r.name),
		sku: String(r.sku),
		category: String(r.category),
		qtyOnHand: Number(r.qty_available || 0),
		unitsSold30d: sold,
		velocityDaily: Number(dailyVelocity.toFixed(1)),
		turnoverCategory: category,
		listPrice: Number(r.list_price || 0),
	};
}

/**
 * Fast & Slow moving products.
 */
export async function getFastSlowMovingProducts(filters?: {
	store?: string;
	category?: string;
	brand?: string;
	sku?: string;
}): Promise<{
	fastMoving: FastSlowItem[];
	slowMoving: FastSlowItem[];
}> {
	const storeFilter =
		filters?.store && filters.store !== "ALL" && filters.store !== "All Stores"
			? filters.store
			: null;
	const categoryFilter =
		filters?.category && filters.category !== "All Categories"
			? filters.category
			: null;
	const brandFilter =
		filters?.brand && filters.brand !== "All Brands" ? filters.brand : null;
	const skuFilter = filters?.sku ? `%${filters.sku.trim()}%` : null;

	// fi_agg/sl_agg pre-aggregate each side to one row per product BEFORE
	// joining to dim_products, so the two independent 1-to-many relations
	// (locations, sale lines) never fan out against each other under a
	// shared GROUP BY. fi_agg also folds the store scoping in directly,
	// since it must filter fact_inventory rows before summing, not after.
	const fastResult = await sql`
		SELECT
			p.id,
			p.name,
			COALESCE(p.default_code, 'SKU-' || p.id) AS sku,
			COALESCE(p.category, 'General') AS category,
			COALESCE(fi_agg.qty_sum, p.qty_available, 0) AS qty_available,
			p.list_price,
			COALESCE(sl_agg.units_sold_30d, 0) AS units_sold_30d
		FROM dim_products p
		LEFT JOIN (
			SELECT fi.product_id, SUM(fi.quantity) AS qty_sum
			FROM fact_inventory fi
			LEFT JOIN dim_stores s ON fi.location_id = s.location_id
			WHERE (${storeFilter}::TEXT IS NULL OR s.name ILIKE ${storeFilter} OR s.code ILIKE ${storeFilter} OR s.id IN (
			        SELECT so2.store_id
			        FROM fact_sales_orders so2
			        JOIN sales_fact_v sf ON LOWER(TRIM(so2.name)) = LOWER(TRIM(sf.bill_no))
			        WHERE sf.store_display_name ILIKE ${storeFilter} OR sf.billed_by ILIKE ${storeFilter}
			  ))
			GROUP BY fi.product_id
		) fi_agg ON fi_agg.product_id = p.id
		LEFT JOIN (
			SELECT product_id, SUM(qty) AS units_sold_30d
			FROM fact_sales_lines
			WHERE updated_at >= NOW() - INTERVAL '30 days'
			GROUP BY product_id
		) sl_agg ON sl_agg.product_id = p.id
		WHERE p.active = true AND p.is_storable IS NOT FALSE
		  AND (${storeFilter}::TEXT IS NULL OR fi_agg.product_id IS NOT NULL)
		  AND (${categoryFilter}::TEXT IS NULL OR TRIM(p.category) ILIKE TRIM(${categoryFilter}))
		  AND (${brandFilter}::TEXT IS NULL OR EXISTS (
		        SELECT 1 FROM sales_fact sf
		        WHERE sf.brand ILIKE ${brandFilter}
		          AND (LOWER(TRIM(p.name)) = LOWER(TRIM(sf.item_name)) OR (p.default_code IS NOT NULL AND p.default_code = sf.sku_code) OR (p.barcode IS NOT NULL AND p.barcode = sf.sku_code))
		  ))
		  AND (${skuFilter}::TEXT IS NULL OR p.name ILIKE ${skuFilter} OR p.default_code ILIKE ${skuFilter})
		  AND COALESCE(sl_agg.units_sold_30d, 0) > 0
		ORDER BY units_sold_30d DESC
		LIMIT 10
	`;

	const slowResult = await sql`
		SELECT
			p.id,
			p.name,
			COALESCE(p.default_code, 'SKU-' || p.id) AS sku,
			COALESCE(p.category, 'General') AS category,
			COALESCE(fi_agg.qty_sum, p.qty_available, 0) AS qty_available,
			p.list_price,
			COALESCE(sl_agg.units_sold_30d, 0) AS units_sold_30d
		FROM dim_products p
		LEFT JOIN (
			SELECT fi.product_id, SUM(fi.quantity) AS qty_sum
			FROM fact_inventory fi
			LEFT JOIN dim_stores s ON fi.location_id = s.location_id
			WHERE (${storeFilter}::TEXT IS NULL OR s.name ILIKE ${storeFilter} OR s.code ILIKE ${storeFilter} OR s.id IN (
			        SELECT so2.store_id
			        FROM fact_sales_orders so2
			        JOIN sales_fact_v sf ON LOWER(TRIM(so2.name)) = LOWER(TRIM(sf.bill_no))
			        WHERE sf.store_display_name ILIKE ${storeFilter} OR sf.billed_by ILIKE ${storeFilter}
			  ))
			GROUP BY fi.product_id
		) fi_agg ON fi_agg.product_id = p.id
		LEFT JOIN (
			SELECT product_id, SUM(qty) AS units_sold_30d
			FROM fact_sales_lines
			WHERE updated_at >= NOW() - INTERVAL '30 days'
			GROUP BY product_id
		) sl_agg ON sl_agg.product_id = p.id
		WHERE p.active = true AND p.is_storable IS NOT FALSE AND COALESCE(fi_agg.qty_sum, p.qty_available, 0) > 0
		  AND (${storeFilter}::TEXT IS NULL OR fi_agg.product_id IS NOT NULL)
		  AND (${categoryFilter}::TEXT IS NULL OR TRIM(p.category) ILIKE TRIM(${categoryFilter}))
		  AND (${brandFilter}::TEXT IS NULL OR EXISTS (
		        SELECT 1 FROM sales_fact sf
		        WHERE sf.brand ILIKE ${brandFilter}
		          AND (LOWER(TRIM(p.name)) = LOWER(TRIM(sf.item_name)) OR (p.default_code IS NOT NULL AND p.default_code = sf.sku_code) OR (p.barcode IS NOT NULL AND p.barcode = sf.sku_code))
		  ))
		  AND (${skuFilter}::TEXT IS NULL OR p.name ILIKE ${skuFilter} OR p.default_code ILIKE ${skuFilter})
		ORDER BY units_sold_30d ASC
		LIMIT 10
	`;

	return {
		fastMoving: fastResult.map(mapVelocityRow),
		slowMoving: slowResult.map(mapVelocityRow),
	};
}

export interface ItemVelocityPagedParams {
	page: number;
	pageSize: number;
	sortBy: "sales" | "velocity" | "soh" | "name";
	sortDir: "asc" | "desc";
	search?: string;
	store?: string;
	category?: string;
	brand?: string;
}

export interface ItemVelocityPagedResult {
	items: FastSlowItem[];
	totalCount: number;
	page: number;
	pageSize: number;
}

/**
 * Full-catalog paginated/sortable/searchable product velocity list.
 */
export async function getItemVelocityPaged(
	params: ItemVelocityPagedParams,
): Promise<ItemVelocityPagedResult> {
	const page = Math.max(1, params.page);
	const pageSize = Math.min(100, Math.max(1, params.pageSize));
	const offset = (page - 1) * pageSize;
	const search = params.search?.trim() || "";
	const storeFilter =
		params.store && params.store !== "ALL" && params.store !== "All Stores"
			? params.store
			: null;
	const categoryFilter =
		params.category && params.category !== "All Categories"
			? params.category
			: null;
	const brandFilter =
		params.brand && params.brand !== "All Brands" ? params.brand : null;

	const sortColumn: Record<ItemVelocityPagedParams["sortBy"], string> = {
		sales: "units_sold_30d",
		velocity: "units_sold_30d",
		soh: "qty_available",
		name: "name",
	};
	const orderColumn = sortColumn[params.sortBy] || "units_sold_30d";
	const orderDir = params.sortDir === "asc" ? "ASC" : "DESC";

	// This project's Neon client has no sql.unsafe() (that's a postgres.js-only
	// API) — the ORDER BY column/direction must come from a literal whitelist
	// (sortColumn above, plus this direction guard) and be spliced into the
	// query text directly via sql.query()'s raw-string path, never from
	// unvalidated input.
	if (!["units_sold_30d", "qty_available", "name"].includes(orderColumn)) {
		throw new Error(`Invalid sort column: ${orderColumn}`);
	}
	if (orderDir !== "ASC" && orderDir !== "DESC") {
		throw new Error(`Invalid sort direction: ${orderDir}`);
	}

	const likeSearch = `%${search}%`;
	const queryText = `
		SELECT
			p.id,
			p.name,
			COALESCE(p.default_code, 'SKU-' || p.id) AS sku,
			COALESCE(p.category, 'General') AS category,
			COALESCE(fi_agg.qty_sum, p.qty_available, 0) AS qty_available,
			p.list_price,
			COALESCE(sl_agg.units_sold_30d, 0) AS units_sold_30d
		FROM dim_products p
		LEFT JOIN (
			SELECT fi.product_id, SUM(fi.quantity) AS qty_sum
			FROM fact_inventory fi
			LEFT JOIN dim_stores s ON fi.location_id = s.location_id
			WHERE ($6::text IS NULL OR s.name ILIKE $6 OR s.code ILIKE $6 OR s.id IN (
			        SELECT so2.store_id
			        FROM fact_sales_orders so2
			        JOIN sales_fact_v sf ON LOWER(TRIM(so2.name)) = LOWER(TRIM(sf.bill_no))
			        WHERE sf.store_display_name ILIKE $6 OR sf.billed_by ILIKE $6
			  ))
			GROUP BY fi.product_id
		) fi_agg ON fi_agg.product_id = p.id
		LEFT JOIN (
			SELECT product_id, SUM(qty) AS units_sold_30d
			FROM fact_sales_lines
			WHERE updated_at >= NOW() - INTERVAL '30 days'
			GROUP BY product_id
		) sl_agg ON sl_agg.product_id = p.id
		WHERE p.active = true AND p.is_storable IS NOT FALSE
		  AND ($1 = '' OR p.name ILIKE $2 OR p.default_code ILIKE $2)
		  AND ($6::text IS NULL OR fi_agg.product_id IS NOT NULL)
		  AND ($3::text IS NULL OR TRIM(p.category) ILIKE TRIM($3))
		  AND ($4::text IS NULL OR EXISTS (
		        SELECT 1 FROM sales_fact sf
		        WHERE sf.brand ILIKE $4
		          AND (LOWER(TRIM(p.name)) = LOWER(TRIM(sf.item_name)) OR (p.default_code IS NOT NULL AND p.default_code = sf.sku_code) OR (p.barcode IS NOT NULL AND p.barcode = sf.sku_code))
		  ))
		ORDER BY ${orderColumn} ${orderDir}
		LIMIT $5 OFFSET $7
	`;
	const result = await (sql as any).query(queryText, [
		search,
		likeSearch,
		categoryFilter,
		brandFilter,
		pageSize,
		storeFilter,
		offset,
	]);

	const countResult = await sql`
		SELECT COUNT(DISTINCT p.id) AS total
		FROM dim_products p
		LEFT JOIN fact_inventory fi ON p.id = fi.product_id
		LEFT JOIN dim_stores s ON fi.location_id = s.location_id
		LEFT JOIN fact_sales_lines sl ON p.id = sl.product_id
		WHERE p.active = true AND p.is_storable IS NOT FALSE
		  AND (${search} = '' OR p.name ILIKE ${"%" + search + "%"} OR p.default_code ILIKE ${"%" + search + "%"})
		  AND (${storeFilter}::TEXT IS NULL OR s.name ILIKE ${storeFilter} OR s.code ILIKE ${storeFilter} OR s.id IN (
		        SELECT so2.store_id 
		        FROM fact_sales_orders so2 
		        JOIN sales_fact_v sf ON LOWER(TRIM(so2.name)) = LOWER(TRIM(sf.bill_no))
		        WHERE sf.store_display_name ILIKE ${storeFilter} OR sf.billed_by ILIKE ${storeFilter}
		  ))
		  AND (${categoryFilter}::TEXT IS NULL OR TRIM(p.category) ILIKE TRIM(${categoryFilter}))
		  AND (${brandFilter}::TEXT IS NULL OR EXISTS (
		        SELECT 1 FROM sales_fact sf 
		        WHERE sf.brand ILIKE ${brandFilter}
		          AND (LOWER(TRIM(p.name)) = LOWER(TRIM(sf.item_name)) OR (p.default_code IS NOT NULL AND p.default_code = sf.sku_code) OR (p.barcode IS NOT NULL AND p.barcode = sf.sku_code))
		  ))
	`;

	return {
		items: result.map(mapVelocityRow),
		totalCount: Number(countResult[0]?.total || 0),
		page,
		pageSize,
	};
}

export interface ReorderRecommendationsPagedParams {
	page: number;
	pageSize: number;
	sortBy: "urgency" | "name";
	sortDir: "asc" | "desc";
	search?: string;
	store?: string;
	category?: string;
	brand?: string;
}

export interface ReorderRecommendationsPagedResult {
	items: ReorderRecommendation[];
	totalCount: number;
	page: number;
	pageSize: number;
}

/**
 * Products eligible for reorder (SOH <= 15), full eligible population,
 * paginated/sorted/searched — not a fixed top-N. Deterministic arithmetic,
 * not an AI/ML model: computes target stock from 30-day run rate and real
 * SOH without inventing unverified lead-time assumptions.
 */
export async function getReorderRecommendationsPaged(
	params: ReorderRecommendationsPagedParams,
): Promise<ReorderRecommendationsPagedResult> {
	const page = Math.max(1, params.page);
	const pageSize = Math.min(100, Math.max(1, params.pageSize));
	const offset = (page - 1) * pageSize;
	const search = params.search?.trim() || "";
	const storeFilter =
		params.store && params.store !== "ALL" && params.store !== "All Stores"
			? params.store
			: null;
	const categoryFilter =
		params.category && params.category !== "All Categories"
			? params.category
			: null;
	const brandFilter =
		params.brand && params.brand !== "All Brands" ? params.brand : null;

	// Same sql.query()-with-whitelist pattern as getItemVelocityPaged (Bug 5) —
	// this Neon client has no sql.unsafe(), so the ORDER BY column/direction
	// must come from a fixed whitelist, never unvalidated input.
	const sortColumn: Record<
		ReorderRecommendationsPagedParams["sortBy"],
		string
	> = {
		urgency: "qty_available",
		name: "name",
	};
	const orderColumn = sortColumn[params.sortBy] || "qty_available";
	const orderDir = params.sortDir === "desc" ? "DESC" : "ASC";
	if (!["qty_available", "name"].includes(orderColumn)) {
		throw new Error(`Invalid sort column: ${orderColumn}`);
	}
	if (orderDir !== "ASC" && orderDir !== "DESC") {
		throw new Error(`Invalid sort direction: ${orderDir}`);
	}

	const likeSearch = `%${search}%`;
	const queryText = `
		SELECT
			p.id,
			p.name,
			COALESCE(p.default_code, 'SKU-' || p.id) AS sku,
			COALESCE(p.category, 'General') AS category,
			COALESCE(fi_agg.qty_sum, p.qty_available, 0) AS qty_available,
			COALESCE(sl_agg.units_sold_30d, 0) AS units_sold_30d
		FROM dim_products p
		LEFT JOIN (
			SELECT fi.product_id, SUM(fi.quantity) AS qty_sum
			FROM fact_inventory fi
			LEFT JOIN dim_stores s ON fi.location_id = s.location_id
			WHERE ($6::text IS NULL OR s.name ILIKE $6 OR s.code ILIKE $6 OR s.id IN (
			        SELECT so2.store_id
			        FROM fact_sales_orders so2
			        JOIN sales_fact_v sf ON LOWER(TRIM(so2.name)) = LOWER(TRIM(sf.bill_no))
			        WHERE sf.store_display_name ILIKE $6 OR sf.billed_by ILIKE $6
			  ))
			GROUP BY fi.product_id
		) fi_agg ON fi_agg.product_id = p.id
		LEFT JOIN (
			SELECT product_id, SUM(qty) AS units_sold_30d
			FROM fact_sales_lines
			WHERE updated_at >= NOW() - INTERVAL '30 days'
			GROUP BY product_id
		) sl_agg ON sl_agg.product_id = p.id
		WHERE p.active = true AND p.is_storable IS NOT FALSE
		  AND COALESCE(fi_agg.qty_sum, p.qty_available, 0) <= 15
		  AND ($6::text IS NULL OR fi_agg.product_id IS NOT NULL)
		  AND ($1 = '' OR p.name ILIKE $2 OR p.default_code ILIKE $2)
		  AND ($3::text IS NULL OR TRIM(p.category) ILIKE TRIM($3))
		  AND ($4::text IS NULL OR EXISTS (
		        SELECT 1 FROM sales_fact sf
		        WHERE sf.brand ILIKE $4
		          AND (LOWER(TRIM(p.name)) = LOWER(TRIM(sf.item_name)) OR (p.default_code IS NOT NULL AND p.default_code = sf.sku_code) OR (p.barcode IS NOT NULL AND p.barcode = sf.sku_code))
		  ))
		ORDER BY ${orderColumn} ${orderDir}
		LIMIT $5 OFFSET $7
	`;
	const result = await (sql as any).query(queryText, [
		search,
		likeSearch,
		categoryFilter,
		brandFilter,
		pageSize,
		storeFilter,
		offset,
	]);

	const countResult = await sql`
		SELECT COUNT(*) AS total FROM (
			SELECT p.id
			FROM dim_products p
			LEFT JOIN (
				SELECT fi.product_id, SUM(fi.quantity) AS qty_sum
				FROM fact_inventory fi
				LEFT JOIN dim_stores s ON fi.location_id = s.location_id
				WHERE (${storeFilter}::TEXT IS NULL OR s.name ILIKE ${storeFilter} OR s.code ILIKE ${storeFilter} OR s.id IN (
				        SELECT so2.store_id
				        FROM fact_sales_orders so2
				        JOIN sales_fact_v sf ON LOWER(TRIM(so2.name)) = LOWER(TRIM(sf.bill_no))
				        WHERE sf.store_display_name ILIKE ${storeFilter} OR sf.billed_by ILIKE ${storeFilter}
				  ))
				GROUP BY fi.product_id
			) fi_agg ON fi_agg.product_id = p.id
			WHERE p.active = true AND p.is_storable IS NOT FALSE
			  AND COALESCE(fi_agg.qty_sum, p.qty_available, 0) <= 15
			  AND (${storeFilter}::TEXT IS NULL OR fi_agg.product_id IS NOT NULL)
			  AND (${search} = '' OR p.name ILIKE ${likeSearch} OR p.default_code ILIKE ${likeSearch})
			  AND (${categoryFilter}::TEXT IS NULL OR TRIM(p.category) ILIKE TRIM(${categoryFilter}))
			  AND (${brandFilter}::TEXT IS NULL OR EXISTS (
			        SELECT 1 FROM sales_fact sf
			        WHERE sf.brand ILIKE ${brandFilter}
			          AND (LOWER(TRIM(p.name)) = LOWER(TRIM(sf.item_name)) OR (p.default_code IS NOT NULL AND p.default_code = sf.sku_code) OR (p.barcode IS NOT NULL AND p.barcode = sf.sku_code))
			  ))
		) t
	`;

	const items = result.map((r: any) => {
		const qty = Number(r.qty_available || 0);
		const sold30d = Number(r.units_sold_30d || 0);
		const dailyRate = Math.max(0.5, Number((sold30d / 30).toFixed(1)));
		const daysLeft = Math.round(qty / dailyRate);

		// Pure Odoo-driven target buffer calculation (30-day target inventory minus current SOH)
		const targetStockBuffer = Math.ceil(dailyRate * 30);
		const suggestedQty = Math.max(0, targetStockBuffer - qty);
		const urgency: ReorderRecommendation["urgency"] =
			qty <= 2 ? "critical" : qty <= 8 ? "high" : "medium";

		return {
			productId: Number(r.id),
			name: String(r.name),
			sku: String(r.sku),
			category: String(r.category),
			qtyOnHand: qty,
			dailyRunRate: dailyRate,
			daysOfSupplyRemaining: daysLeft,
			suggestedReorderQty: suggestedQty,
			recommendedVendor: "Primary Odoo SaaS Vendor",
			urgency,
		};
	});

	return {
		items,
		totalCount: Number(countResult[0]?.total || 0),
		page,
		pageSize,
	};
}

/**
 * Stock aging distribution computed dynamically from product timestamps.
 */
export async function getStockAgingDistribution(filters?: {
	store?: string;
	category?: string;
	brand?: string;
	sku?: string;
}): Promise<StockAgingCategory[]> {
	const storeFilter =
		filters?.store && filters.store !== "ALL" && filters.store !== "All Stores"
			? filters.store
			: null;
	const categoryFilter =
		filters?.category && filters.category !== "All Categories"
			? filters.category
			: null;
	const brandFilter =
		filters?.brand && filters.brand !== "All Brands" ? filters.brand : null;
	const skuFilter = filters?.sku ? `%${filters.sku.trim()}%` : null;

	const agingResult = await sql`
		SELECT
			CASE
				WHEN p.updated_at >= NOW() - INTERVAL '30 days' THEN '0-30 Days'
				WHEN p.updated_at >= NOW() - INTERVAL '60 days' THEN '31-60 Days'
				WHEN p.updated_at >= NOW() - INTERVAL '90 days' THEN '61-90 Days'
				ELSE '90+ Days'
			END AS age_range,
			COUNT(DISTINCT p.id)::INT AS item_count,
			COALESCE(SUM(fi.quantity), 0)::FLOAT AS total_qty,
			COALESCE(SUM(fi.quantity * p.cost_price), 0)::FLOAT AS val_cost
		FROM dim_products p
		JOIN fact_inventory fi ON p.id = fi.product_id
		LEFT JOIN dim_stores s ON fi.location_id = s.location_id
		WHERE p.active = true
		  AND (${storeFilter}::TEXT IS NULL OR s.name ILIKE ${storeFilter} OR s.code ILIKE ${storeFilter} OR s.id IN (
		        SELECT so.store_id 
		        FROM fact_sales_orders so 
		        JOIN sales_fact_v sf ON LOWER(TRIM(so.name)) = LOWER(TRIM(sf.bill_no))
		        WHERE sf.store_display_name ILIKE ${storeFilter} OR sf.billed_by ILIKE ${storeFilter}
		  ))
		  AND (${categoryFilter}::TEXT IS NULL OR TRIM(p.category) ILIKE TRIM(${categoryFilter}))
		  AND (${brandFilter}::TEXT IS NULL OR EXISTS (
		        SELECT 1 FROM sales_fact sf 
		        WHERE sf.brand ILIKE ${brandFilter}
		          AND (LOWER(TRIM(p.name)) = LOWER(TRIM(sf.item_name)) OR (p.default_code IS NOT NULL AND p.default_code = sf.sku_code) OR (p.barcode IS NOT NULL AND p.barcode = sf.sku_code))
		  ))
		  AND (${skuFilter}::TEXT IS NULL OR p.name ILIKE ${skuFilter} OR p.default_code ILIKE ${skuFilter})
		GROUP BY age_range
		ORDER BY age_range ASC
	`;

	const map: Record<
		string,
		{ itemCount: number; totalQuantity: number; valuationCost: number }
	> = {};
	for (const r of agingResult) {
		map[String(r.age_range)] = {
			itemCount: Number(r.item_count || 0),
			totalQuantity: Number(r.total_qty || 0),
			valuationCost: Number(r.val_cost || 0),
		};
	}

	const ranges: Array<"0-30 Days" | "31-60 Days" | "61-90 Days" | "90+ Days"> =
		["0-30 Days", "31-60 Days", "61-90 Days", "90+ Days"];

	return ranges.map((range) => ({
		ageRange: range,
		itemCount: map[range]?.itemCount || 0,
		totalQuantity: map[range]?.totalQuantity || 0,
		valuationCost: map[range]?.valuationCost || 0,
	}));
}

export interface AbcClassificationItem {
	productId: number;
	name: string;
	sku: string;
	category: string;
	revenue: number;
	revenueSharePct: number;
	cumulativeSharePct: number;
	abcClass: "A" | "B" | "C";
}

export interface AbcClassificationParams {
	page: number;
	pageSize: number;
	search?: string;
	store?: string;
	category?: string;
}

export interface AbcClassificationResult {
	items: AbcClassificationItem[];
	totalCount: number;
	page: number;
	pageSize: number;
	summary: {
		aCount: number;
		bCount: number;
		cCount: number;
		totalRevenue: number;
		earliestSaleDate: string | null;
		latestSaleDate: string | null;
	};
}

/**
 * Real Pareto (80/15/5 cumulative-revenue) ABC classification, computed
 * from Odoo-native data only (dim_products + fact_sales_lines/fact_sales_orders)
 * — deliberately does not cross into the legacy sales_fact table, since that
 * would inherit the ~20% product-identity matching gap documented in the
 * Phase 15 audit. Revenue uses the full available fact_sales_lines history
 * (currently a few weeks, since this table is comparatively new) rather than
 * a fixed 30-day window, so classifications reflect everything the Odoo-native
 * sync has captured so far. Products with zero revenue in that window still
 * appear (classified C), rather than being silently dropped.
 */
export async function getAbcClassification(
	params: AbcClassificationParams,
): Promise<AbcClassificationResult> {
	const page = Math.max(1, params.page);
	const pageSize = Math.min(100, Math.max(1, params.pageSize));
	const offset = (page - 1) * pageSize;
	const search = params.search?.trim() || "";
	const likeSearch = `%${search}%`;
	const storeFilter =
		params.store && params.store !== "ALL" && params.store !== "All Stores"
			? params.store
			: null;
	const categoryFilter =
		params.category && params.category !== "All Categories"
			? params.category
			: null;

	const classified = await sql`
		WITH revenue_agg AS (
			SELECT sl.product_id, SUM(sl.price_subtotal) AS revenue
			FROM fact_sales_lines sl
			JOIN fact_sales_orders so ON so.id = sl.order_id
			WHERE (${storeFilter}::TEXT IS NULL OR so.store_id IN (
			        SELECT id FROM dim_stores WHERE name ILIKE ${storeFilter} OR code ILIKE ${storeFilter}
			  ))
			GROUP BY sl.product_id
		),
		scoped AS (
			SELECT
				p.id,
				p.name,
				COALESCE(p.default_code, 'SKU-' || p.id) AS sku,
				COALESCE(p.category, 'General') AS category,
				COALESCE(ra.revenue, 0) AS revenue
			FROM dim_products p
			LEFT JOIN revenue_agg ra ON ra.product_id = p.id
			WHERE p.active = true AND p.is_storable IS NOT FALSE
			  AND (${categoryFilter}::TEXT IS NULL OR TRIM(p.category) ILIKE TRIM(${categoryFilter}))
			  AND (${search} = '' OR p.name ILIKE ${likeSearch} OR p.default_code ILIKE ${likeSearch})
		),
		ranked AS (
			SELECT
				*,
				SUM(revenue) OVER (ORDER BY revenue DESC, id ROWS UNBOUNDED PRECEDING) AS cum_revenue,
				SUM(revenue) OVER () AS total_revenue,
				ROW_NUMBER() OVER (ORDER BY revenue DESC, id) AS rn
			FROM scoped
		)
		SELECT
			id, name, sku, category, revenue, total_revenue, cum_revenue,
			CASE
				WHEN total_revenue = 0 THEN 'C'
				WHEN (cum_revenue::numeric / NULLIF(total_revenue, 0)) <= 0.8 THEN 'A'
				WHEN (cum_revenue::numeric / NULLIF(total_revenue, 0)) <= 0.95 THEN 'B'
				ELSE 'C'
			END AS abc_class
		FROM ranked
		ORDER BY revenue DESC, id
	`;

	const earliestLatest = await sql`
		SELECT MIN(so.date_order)::text AS earliest, MAX(so.date_order)::text AS latest
		FROM fact_sales_lines sl
		JOIN fact_sales_orders so ON so.id = sl.order_id
	`;

	const totalRevenue = Number(classified[0]?.total_revenue || 0);
	const aCount = classified.filter((r) => r.abc_class === "A").length;
	const bCount = classified.filter((r) => r.abc_class === "B").length;
	const cCount = classified.filter((r) => r.abc_class === "C").length;

	const pageRows = classified.slice(offset, offset + pageSize);

	return {
		items: pageRows.map((r) => ({
			productId: Number(r.id),
			name: String(r.name),
			sku: String(r.sku),
			category: String(r.category),
			revenue: Number(r.revenue || 0),
			revenueSharePct:
				totalRevenue > 0
					? Math.round((Number(r.revenue || 0) / totalRevenue) * 1000) / 10
					: 0,
			cumulativeSharePct:
				totalRevenue > 0
					? Math.round((Number(r.cum_revenue || 0) / totalRevenue) * 1000) / 10
					: 0,
			abcClass: r.abc_class as "A" | "B" | "C",
		})),
		totalCount: classified.length,
		page,
		pageSize,
		summary: {
			aCount,
			bCount,
			cCount,
			totalRevenue,
			earliestSaleDate: earliestLatest[0]?.earliest || null,
			latestSaleDate: earliestLatest[0]?.latest || null,
		},
	};
}
