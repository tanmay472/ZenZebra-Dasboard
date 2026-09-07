/**
 * The approved tool registry Claude (or any future model provider) may call.
 *
 * This is the single allow-list: a tool name not present here is rejected
 * before any backend function runs — the model can never trigger arbitrary
 * code, only one of these exact, pre-defined, read-only data queries.
 */
import {
	getCategoryPerformance,
	getCrmPipeline,
	getCustomerRetention,
	getDashboardSummary,
	getLowStockProducts,
	getLtvCac,
	getSalesByDate,
	getSalesByStore,
	getSalesSummary,
	getSalesTrend,
	getStoreInventory,
	getTodaySales,
	getTopCustomers,
	getTopProducts,
	type ToolResult,
} from "./data-tools";
import { generateReport } from "./reports";

export interface ToolDefinition {
	name: string;
	description: string;
	/** JSON Schema for the tool's input — provider-agnostic shape (Anthropic's
	 * `input_schema` and a hypothetical Gemini `parameters` field both accept
	 * plain JSON Schema, so this same object can be reused for either). */
	schema: {
		type: "object";
		properties: Record<string, { type: string; description: string }>;
		required?: string[];
	};
	run: (args: any) => Promise<ToolResult>;
}

export const TOOL_REGISTRY: ToolDefinition[] = [
	{
		name: "get_today_sales",
		description:
			"Get today's total revenue, gross collection, GST, order count, and average order value (AOV) across all stores. Use only for a narrow, single-metric question — for a broad 'today's sales' / 'how is business' question, use get_sales_summary instead.",
		schema: { type: "object", properties: {} },
		run: async () => getTodaySales(),
	},
	{
		name: "get_sales_summary",
		description:
			"Rich sales overview for one day: revenue, gross collection, GST, discount, units, orders, AOV, a same-store comparison against the previous day (with % changes), and a per-store breakdown with contribution %. This is the primary tool for broad questions like 'give me today's sales', 'how is business today', 'today's sales store-wise', or a comparison question. Defaults to today if no date given. If the date is still in progress, the comparison result includes a caveat you must surface, not hide.",
		schema: {
			type: "object",
			properties: {
				date: {
					type: "string",
					description: "Optional date, YYYY-MM-DD. Defaults to today.",
				},
				store: {
					type: "string",
					description:
						"Optional store name/code to scope to, e.g. 'KLJ'. Omit for all stores (and to get the per-store breakdown).",
				},
			},
		},
		run: async (args) => getSalesSummary(args),
	},
	{
		name: "get_sales_by_date",
		description:
			"Get total revenue, orders, and AOV for a specific date range (inclusive).",
		schema: {
			type: "object",
			properties: {
				startDate: { type: "string", description: "Start date, YYYY-MM-DD" },
				endDate: { type: "string", description: "End date, YYYY-MM-DD" },
			},
			required: ["startDate", "endDate"],
		},
		run: async (args) => getSalesByDate(args),
	},
	{
		name: "get_sales_by_store",
		description:
			"Get revenue, orders, and AOV broken down per store. Defaults to the last 30 days if no date range is given.",
		schema: {
			type: "object",
			properties: {
				startDate: {
					type: "string",
					description: "Optional start date, YYYY-MM-DD",
				},
				endDate: {
					type: "string",
					description: "Optional end date, YYYY-MM-DD",
				},
			},
		},
		run: async (args) => getSalesByStore(args),
	},
	{
		name: "get_sales_trend",
		description:
			"Get real per-period sales totals (gross, net, tax, orders, units, AOV) bucketed by day, week, or month over a date range — the dedicated tool for trend/direction questions like 'show me sales trend', 'is business trending up or down', or 'sales trend this week'. Returns real per-bucket data plus the overall direction (up/down/flat) and the strongest/weakest period — never a synthetic or interpolated series. If fewer than 2 periods have data, direction comes back 'insufficient_data'.",
		schema: {
			type: "object",
			properties: {
				startDate: { type: "string", description: "Start date, YYYY-MM-DD" },
				endDate: { type: "string", description: "End date, YYYY-MM-DD" },
				store: {
					type: "string",
					description:
						"Optional store name/code to scope to, e.g. 'KLJ'. Omit for all stores.",
				},
				granularity: {
					type: "string",
					description: "'day', 'week', or 'month' (default 'day')",
				},
			},
			required: ["startDate", "endDate"],
		},
		run: async (args) => getSalesTrend(args),
	},
	{
		name: "get_top_products",
		description:
			"Get the top-selling products by revenue. Defaults to the last 30 days if no date range is given.",
		schema: {
			type: "object",
			properties: {
				limit: {
					type: "number",
					description: "How many products to return (default 10, max 50)",
				},
				startDate: {
					type: "string",
					description: "Optional start date, YYYY-MM-DD",
				},
				endDate: {
					type: "string",
					description: "Optional end date, YYYY-MM-DD",
				},
			},
		},
		run: async (args) => getTopProducts(args),
	},
	{
		name: "get_low_stock_products",
		description:
			"Get products at or below a low-stock quantity threshold (default 5 units).",
		schema: {
			type: "object",
			properties: {
				threshold: {
					type: "number",
					description: "Stock quantity threshold (default 5)",
				},
				limit: {
					type: "number",
					description: "How many products to return (default 10, max 50)",
				},
			},
		},
		run: async (args) => getLowStockProducts(args),
	},
	{
		name: "get_store_inventory",
		description:
			"Get the full list of in-stock products currently held at one specific store, sorted by quantity on hand (not just low-stock items). Use this for 'what's in stock at X' / 'full inventory for X' questions. Store is matched by partial name/code, e.g. 'KLJ', 'SWN', 'ZenZebra'.",
		schema: {
			type: "object",
			properties: {
				store: {
					type: "string",
					description: "Store name or code, e.g. 'KLJ', 'SWN'",
				},
				limit: {
					type: "number",
					description: "How many products to return (default 50, max 100)",
				},
			},
			required: ["store"],
		},
		run: async (args) => getStoreInventory(args),
	},
	{
		name: "generate_report",
		description:
			"Generate a full, downloadable report (Excel and/or PDF) with the COMPLETE matching data set — never just a top-N. Use this whenever the user explicitly asks for a 'report', 'export', 'excel', 'pdf', or 'download' of inventory or sales data, instead of just answering in chat. reportType 'inventory' lists every in-stock item (optionally for one store); reportType 'sales' lists every sales line item for a date range (optionally for one store, default last 30 days).",
		schema: {
			type: "object",
			properties: {
				reportType: {
					type: "string",
					description: "'inventory' or 'sales'",
				},
				format: {
					type: "string",
					description:
						"'xlsx', 'pdf', or 'both' (default: both if unspecified)",
				},
				store: {
					type: "string",
					description:
						"Optional store name/code to scope to, e.g. 'KLJ'. Omit for all stores.",
				},
				startDate: {
					type: "string",
					description:
						"Sales report only, optional, YYYY-MM-DD. Defaults to 30 days ago.",
				},
				endDate: {
					type: "string",
					description:
						"Sales report only, optional, YYYY-MM-DD. Defaults to today.",
				},
			},
			required: ["reportType", "format"],
		},
		run: async (args) => {
			const result = await generateReport({
				reportType: args.reportType === "sales" ? "sales" : "inventory",
				format:
					args.format === "xlsx" || args.format === "pdf"
						? args.format
						: "both",
				store: typeof args.store === "string" ? args.store : undefined,
				startDate:
					typeof args.startDate === "string" ? args.startDate : undefined,
				endDate: typeof args.endDate === "string" ? args.endDate : undefined,
			});
			return {
				success: result.success,
				error: result.error,
				data: { rowCount: result.rowCount, reports: result.reports },
			};
		},
	},
	{
		name: "get_top_customers",
		description: "Get the highest lifetime-spend customers.",
		schema: {
			type: "object",
			properties: {
				limit: {
					type: "number",
					description: "How many customers to return (default 10, max 50)",
				},
			},
		},
		run: async (args) => getTopCustomers(args),
	},
	{
		name: "get_category_performance",
		description:
			"Get revenue, units, and orders broken down by product category (e.g. Beverages, Snack Corner, Live Menu). Defaults to the last 30 days if no date range is given.",
		schema: {
			type: "object",
			properties: {
				limit: {
					type: "number",
					description: "How many categories to return (default 15, max 50)",
				},
				startDate: {
					type: "string",
					description: "Optional start date, YYYY-MM-DD",
				},
				endDate: {
					type: "string",
					description: "Optional end date, YYYY-MM-DD",
				},
			},
		},
		run: async (args) => getCategoryPerformance(args),
	},
	{
		name: "get_crm_pipeline",
		description:
			"Get the real CRM pipeline: total pipeline value, lead count, average deal size, win rate, and a breakdown by stage — sourced from crm_leads. Use for 'how is CRM doing', 'what's our pipeline', 'how many leads' questions. If there are zero active leads, win rate and other rate-based fields come back null (not a fabricated 0%).",
		schema: { type: "object", properties: {} },
		run: async () => getCrmPipeline(),
	},
	{
		name: "get_ltv_cac",
		description:
			"Get customer lifetime value (LTV), customer acquisition cost (CAC), and LTV:CAC ratio for one store or all stores. IMPORTANT: LTV is a lifetime metric and does NOT vary with startDate/endDate — those only scope CAC/AOV. If asked to compare LTV across two different periods, say plainly that LTV is a lifetime figure and doesn't change per period, don't imply it was recalculated for each window. CAC and payback period come back null/unavailable when no marketing-spend data is configured for that store — never a fabricated number. Use for 'what is CAC', 'what is our LTV', 'LTV to CAC ratio' questions.",
		schema: {
			type: "object",
			properties: {
				store: {
					type: "string",
					description:
						"Optional store name/code, e.g. 'KLJ'. Omit for all stores.",
				},
				startDate: {
					type: "string",
					description:
						"Optional start date, YYYY-MM-DD. Defaults to 30 days ago.",
				},
				endDate: {
					type: "string",
					description: "Optional end date, YYYY-MM-DD. Defaults to today.",
				},
			},
		},
		run: async (args) => getLtvCac(args),
	},
	{
		name: "get_customer_retention",
		description:
			"Get customer retention metrics for one store or all stores: total customers, repeat purchase rate, retention rate, average orders per customer, with comparison to the prior equivalent period. Use for 'how is retention', 'repeat purchase rate', 'how many repeat customers' questions.",
		schema: {
			type: "object",
			properties: {
				store: {
					type: "string",
					description:
						"Optional store name/code, e.g. 'KLJ'. Omit for all stores.",
				},
				startDate: {
					type: "string",
					description:
						"Optional start date, YYYY-MM-DD. Defaults to 30 days ago.",
				},
				endDate: {
					type: "string",
					description: "Optional end date, YYYY-MM-DD. Defaults to today.",
				},
			},
		},
		run: async (args) => getCustomerRetention(args),
	},
	{
		name: "get_dashboard_summary",
		description:
			"Get a combined snapshot: today's sales, the best-performing store today, and how many products are low on stock.",
		schema: { type: "object", properties: {} },
		run: async () => getDashboardSummary(),
	},
];

export function getToolDefinition(name: string): ToolDefinition | undefined {
	return TOOL_REGISTRY.find((t) => t.name === name);
}

/**
 * Executes an approved tool by name with validated arguments. Returns a
 * ToolResult even for an unknown tool name (never throws), so the caller
 * always has something safe to feed back to the model.
 */
export async function runTool(
	name: string,
	args: unknown,
): Promise<ToolResult> {
	const tool = getToolDefinition(name);
	if (!tool) {
		return { success: false, error: `Unknown tool: ${name}` };
	}
	const safeArgs = args && typeof args === "object" ? args : {};
	try {
		return await tool.run(safeArgs);
	} catch {
		return { success: false, error: `Tool ${name} failed unexpectedly.` };
	}
}
