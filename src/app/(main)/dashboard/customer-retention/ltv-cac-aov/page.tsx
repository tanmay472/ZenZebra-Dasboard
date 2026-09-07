import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { sql } from "@/lib/db";
import { getCacReportData } from "@/lib/services/cac.service";
import { getLtvReportData } from "@/lib/services/ltv.service";
import { formatCurrency } from "@/lib/utils";
import { LtvCharts } from "./_components/ltv-charts";
import { StoreFilter } from "./_components/store-filter";

interface PageProps {
	searchParams: Promise<{
		store?: string;
		startDate?: string;
		endDate?: string;
	}>;
}

export default async function LtvCacAovPage({ searchParams }: PageProps) {
	const params = await searchParams;
	const store = params.store || "ALL";
	const storeParam = store === "ALL" ? null : store;

	// Date range defaults
	const startDate = params.startDate || "2025-11-18";
	const endDate = params.endDate || "2026-06-24";

	// Fetch report data sequentially on the server
	const ltvData = await getLtvReportData(storeParam);
	const cacData = await getCacReportData(sql, startDate, endDate, storeParam);

	// Store list is data-driven (same query the sales dashboard's filter bar
	// uses) so a new store added in Odoo appears here automatically once it
	// has synced data — this used to be a hardcoded 2-store dropdown.
	const storeRows = await sql`
		SELECT DISTINCT billed_by FROM sales_fact_v
		WHERE billed_by IS NOT NULL AND billed_by <> ''
		ORDER BY billed_by
	`;
	const availableStores = storeRows.map((r) => String(r.billed_by));

	const ltv = ltvData.ltv;
	const hasMarketingSpendData = cacData.hasMarketingSpendData;
	const cac = cacData.cac; // number | null when no marketing spend data exists
	const aov = cacData.aov;

	// LTV:CAC Ratio
	const ltvCacRatio = cac !== null && cac > 0 ? ltv / cac : 0;
	const formattedRatio = hasMarketingSpendData
		? `${ltvCacRatio.toFixed(1)}x`
		: "N/A";

	// Classification for ratio
	let ratioBadge = {
		label: "Average",
		className: "bg-zinc-800/50 text-zinc-400 border-zinc-700/50",
	};
	if (ltvCacRatio < 1.0) {
		ratioBadge = {
			label: "Dangerous",
			className: "bg-red-500/10 text-red-500 border-red-500/20",
		};
	} else if (ltvCacRatio >= 3.0 && ltvCacRatio < 5.0) {
		ratioBadge = {
			label: "Healthy",
			className: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
		};
	} else if (ltvCacRatio >= 5.0) {
		ratioBadge = {
			label: "Excellent",
			className:
				"bg-emerald-500/10 text-emerald-500 border-emerald-500/20 font-bold",
		};
	}

	// Net value per customer (LTV - CAC)
	const netValue = cac !== null ? ltv - cac : null;

	// AOV expansion percentage
	const aovExpansion = ltvData.aovExpansionPct;

	// Format cohorts data for Recharts
	const monthsList = [
		"Jan",
		"Feb",
		"Mar",
		"Apr",
		"May",
		"Jun",
		"Jul",
		"Aug",
		"Sep",
		"Oct",
		"Nov",
		"Dec",
	];
	const cohortLines: string[] = [];
	const cohortChartData = [
		{ name: "Month 0" },
		{ name: "Month 3" },
		{ name: "Month 6" },
	];

	ltvData.cohortLtv.forEach((c) => {
		const dateObj = new Date(c.cohort_month_raw);
		const cohortLabel = `${monthsList[dateObj.getUTCMonth()]} ${dateObj.getUTCFullYear()}`;
		cohortLines.push(cohortLabel);

		// Add properties dynamically to each month point
		(cohortChartData[0] as any)[cohortLabel] = Math.round(Number(c.ltv_m0));
		(cohortChartData[1] as any)[cohortLabel] = Math.round(Number(c.ltv_m3));
		(cohortChartData[2] as any)[cohortLabel] = Math.round(Number(c.ltv_m6));
	});

	// Format AOV order groups for Bar Chart
	const orderGroups = ["1st", "2nd", "3rd", "4th+"];
	const aovChartData = orderGroups.map((group) => {
		const found = ltvData.aovByOrder.find((r) => r.order_group === group);
		return {
			name: group,
			aov: found ? Math.round(Number(found.aov)) : 0,
		};
	});

	const _formattedDate = format(new Date(), "MMMM yyyy");

	return (
		<div className="flex flex-col gap-8 p-6 md:p-10 bg-black min-h-screen text-zinc-100 font-sans">
			{/* Title Section */}
			<div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
				<div className="flex flex-col gap-1">
					<h1 className="text-2xl font-semibold tracking-tight text-white font-mono">
						LTV, CAC & AOV Analysis
					</h1>
					<p className="text-zinc-500 text-xs">
						Calculated metrics based on data bounds (Nov 2025 – Jun 2026)
					</p>
				</div>
				<StoreFilter currentStore={store} availableStores={availableStores} />
			</div>

			<Separator className="bg-zinc-900 h-[0.5px]" />

			{/* Hero Card: LTV:CAC Ratio */}
			<Card className="border-[0.5px] border-zinc-800 bg-zinc-950 rounded-[12px] p-6 shadow-none flex flex-col gap-4">
				<div className="flex items-center justify-between">
					<div className="flex flex-col gap-0.5">
						<h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 font-mono">
							LTV:CAC Ratio
						</h2>
						<p className="text-[10px] text-zinc-600">
							Ratio of Lifetime Value relative to Customer Acquisition Cost
						</p>
					</div>
					<Badge
						className={`rounded-[4px] border ${ratioBadge.className} text-[10px] uppercase font-mono px-1.5 py-0.5`}
					>
						{ratioBadge.label}
					</Badge>
				</div>
				<div className="flex items-baseline gap-2">
					<span className="text-6xl font-bold font-mono tracking-tight text-white">
						{formattedRatio}
					</span>
				</div>
				<p className="text-xs text-zinc-400 leading-relaxed max-w-2xl">
					A ratio of{" "}
					<span className="font-mono text-white">{formattedRatio}</span> means
					every rupee spent on marketing generates{" "}
					<span className="font-mono text-white">
						₹{ltvCacRatio.toFixed(1)}
					</span>{" "}
					in lifetime customer revenue. A standard healthy target is{" "}
					<span className="font-mono text-white">3.0x</span> or greater.
				</p>
			</Card>

			{/* Row 1 Metric Cards */}
			<div className="grid gap-6 grid-cols-1 md:grid-cols-3">
				<Card className="border-[0.5px] border-zinc-800 bg-zinc-950 rounded-[12px] p-5 shadow-none flex flex-col gap-2">
					<span className="text-xs text-zinc-500 font-mono uppercase tracking-wider">
						Customer LTV
					</span>
					<span className="text-3xl font-semibold text-white font-mono">
						{formatCurrency(Math.round(ltv), { noDecimals: true })}
					</span>
					<span className="text-[10px] text-zinc-600">
						Average lifetime revenue per customer
					</span>
				</Card>

				<Card className="border-[0.5px] border-zinc-800 bg-zinc-950 rounded-[12px] p-5 shadow-none flex flex-col gap-2">
					<span className="text-xs text-zinc-500 font-mono uppercase tracking-wider">
						Acquisition Cost (CAC)
					</span>
					<span className="text-3xl font-semibold text-white font-mono">
						{cac === null
							? "N/A"
							: formatCurrency(Math.round(cac), { noDecimals: true })}
					</span>
					<span className="text-[10px] text-zinc-600">
						{cac === null
							? "No marketing spend data recorded"
							: "Spend per new customer acquired in period"}
					</span>
				</Card>

				<Card className="border-[0.5px] border-zinc-800 bg-zinc-950 rounded-[12px] p-5 shadow-none flex flex-col gap-2">
					<span className="text-xs text-zinc-500 font-mono uppercase tracking-wider">
						Average AOV
					</span>
					<span className="text-3xl font-semibold text-white font-mono">
						{formatCurrency(Math.round(aov), { noDecimals: true })}
					</span>
					<span className="text-[10px] text-zinc-600">
						Total revenue divided by total bill cuts
					</span>
				</Card>
			</div>

			{/* Row 2 Metric Cards */}
			<div className="grid gap-6 grid-cols-1 md:grid-cols-3">
				<Card className="border-[0.5px] border-zinc-800 bg-zinc-950 rounded-[12px] p-5 shadow-none flex flex-col gap-2">
					<span className="text-xs text-zinc-500 font-mono uppercase tracking-wider">
						Net Value per Customer
					</span>
					<span className="text-3xl font-semibold text-white font-mono">
						{netValue === null
							? "N/A"
							: formatCurrency(Math.round(netValue), { noDecimals: true })}
					</span>
					<span className="text-[10px] text-zinc-600">
						Lifetime value net of acquisition cost (LTV - CAC)
					</span>
				</Card>

				<Card className="border-[0.5px] border-zinc-800 bg-zinc-950 rounded-[12px] p-5 shadow-none flex flex-col gap-2">
					<span className="text-xs text-zinc-500 font-mono uppercase tracking-wider">
						CAC Payback Period
					</span>
					<span className="text-3xl font-semibold text-white font-mono">
						{cacData.paybackMonths === null ? (
							"N/A"
						) : (
							<>
								{cacData.paybackMonths}{" "}
								<span className="text-xs text-zinc-500 font-sans">Months</span>
							</>
						)}
					</span>
					<span className="text-[10px] text-zinc-600">
						{cacData.paybackMonths === null
							? "Unavailable — no documented margin assumption to compute this from"
							: "Months required to recoup customer acquisition cost"}
					</span>
				</Card>

				<Card className="border-[0.5px] border-zinc-800 bg-zinc-950 rounded-[12px] p-5 shadow-none flex flex-col gap-2">
					<span className="text-xs text-zinc-500 font-mono uppercase tracking-wider">
						AOV Expansion
					</span>
					<span className="text-3xl font-semibold text-white font-mono">
						{aovExpansion >= 0 ? "+" : ""}
						{aovExpansion.toFixed(1)}%
					</span>
					<span className="text-[10px] text-zinc-600">
						Growth from first order to latest order AOV
					</span>
				</Card>
			</div>

			{/* Charts Section */}
			<LtvCharts
				cohortChartData={cohortChartData}
				cohortsList={cohortLines}
				aovChartData={aovChartData}
			/>

			{/* CAC Payback Table Section */}
			<Card className="border-[0.5px] border-zinc-800 bg-zinc-950 rounded-[12px] p-6 shadow-none flex flex-col gap-4">
				<div>
					<h3 className="text-sm font-medium text-zinc-100 font-mono">
						Payback Matrix & Store Breakdown
					</h3>
					<p className="text-xs text-zinc-500 mt-1">
						Payback computes how long it takes to fully recover CAC using a
						standard 26% gross margin and 1.5 order/month frequency model.
					</p>
				</div>
				<div className="overflow-x-auto">
					<Table>
						<TableHeader className="border-b-[0.5px] border-zinc-800">
							<TableRow className="border-b-[0.5px] border-zinc-800 hover:bg-zinc-900/50">
								<TableHead className="text-zinc-500 text-xs font-mono h-10">
									Store
								</TableHead>
								<TableHead className="text-zinc-500 text-xs font-mono text-right h-10">
									CAC
								</TableHead>
								<TableHead className="text-zinc-500 text-xs font-mono text-right h-10">
									Average AOV
								</TableHead>
								<TableHead className="text-zinc-500 text-xs font-mono text-right h-10">
									Monthly Margin
								</TableHead>
								<TableHead className="text-zinc-500 text-xs font-mono text-right h-10">
									Payback Period
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{cacData.paybackTable.map((row) => (
								<TableRow
									key={row.storeName}
									className="border-b-[0.5px] border-zinc-900 hover:bg-zinc-900/40"
								>
									<TableCell className="text-xs font-medium text-zinc-300 py-3">
										{row.storeName}
									</TableCell>
									<TableCell className="text-xs text-right font-mono py-3 text-zinc-300">
										{row.cac === null
											? "N/A"
											: formatCurrency(row.cac, { noDecimals: true })}
									</TableCell>
									<TableCell className="text-xs text-right font-mono py-3 text-zinc-300">
										{formatCurrency(row.aov, { noDecimals: true })}
									</TableCell>
									<TableCell className="text-xs text-right font-mono py-3 text-zinc-300">
										{row.margin === null
											? "N/A"
											: formatCurrency(row.margin, { noDecimals: true })}
									</TableCell>
									<TableCell className="text-xs text-right font-mono py-3 font-semibold text-white">
										{row.payback === null ? "N/A" : `${row.payback} Months`}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			</Card>
		</div>
	);
}
