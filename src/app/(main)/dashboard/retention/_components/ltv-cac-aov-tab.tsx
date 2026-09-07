"use client";

import { ChevronLeft, ChevronRight, Download, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
	Bar,
	BarChart,
	CartesianGrid,
	Line,
	LineChart,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { exportToPDF } from "@/lib/export-utils";
import { formatCurrency } from "@/lib/utils";
import { useFilterStore } from "@/stores/founder/filter-store";

type CustomerTypeFilter = "all" | "new" | "existing";
type AovStabilityFilter = "all" | "stable" | "increasing" | "decreasing";
type LtvCustomer = {
	customerName?: string;
	customerMobile?: string | number;
	customerType?: string;
	aovStability?: string;
	orders?: number;
	revenue?: number;
	aov?: number;
	ltv?: number;
	lastPurchaseDays?: number;
};

export function LtvCacAovTab() {
	const { store, startDate, endDate } = useFilterStore();
	const [data, setData] = useState<any>(null);
	const [loading, setLoading] = useState(true);

	// Table filters & pagination states
	const [searchQuery, setSearchQuery] = useState("");
	const [customerTypeFilter, setCustomerTypeFilter] =
		useState<CustomerTypeFilter>("all");
	const [aovStabilityFilter, setAovStabilityFilter] =
		useState<AovStabilityFilter>("all");
	const [currentPage, setCurrentPage] = useState(1);
	const [pageSize, setPageSize] = useState(15);

	useEffect(() => {
		const fetchData = async () => {
			setLoading(true);
			try {
				const queryParams = new URLSearchParams({
					store: store || "ALL",
					startDate: startDate || "",
					endDate: endDate || "",
				});
				const res = await fetch(
					`/api/customer-retention/ltv-cac-aov?${queryParams.toString()}`,
				);
				const json = await res.json();
				if (json.success) {
					setData(json.data);
				}
			} catch (err) {
				console.error("Failed to load LTV/CAC/AOV metrics", err);
			} finally {
				setLoading(false);
			}
		};
		fetchData();
	}, [store, startDate, endDate]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset trigger, deps aren't read in the effect body
	useEffect(() => {
		setCurrentPage(1);
	}, [searchQuery, customerTypeFilter, aovStabilityFilter]);

	const topCustomers = data?.topCustomers || [];

	// Table row unique key
	const getCustomerRowKey = (cust: LtvCustomer) =>
		[
			cust.customerMobile ?? "unknown",
			cust.customerName ?? "unknown",
			cust.orders ?? "",
			cust.revenue ?? "",
			cust.aov ?? "",
			cust.ltv ?? "",
			cust.lastPurchaseDays ?? "",
		].join("|");

	// Filtering Logic
	const filteredCustomers = useMemo<LtvCustomer[]>(() => {
		return topCustomers.filter((c: LtvCustomer) => {
			const query = searchQuery.toLowerCase();
			const matchesSearch =
				!searchQuery ||
				c.customerName?.toLowerCase().includes(query) ||
				String(c.customerMobile ?? "").includes(query);

			let matchesType = true;
			if (customerTypeFilter === "new") {
				matchesType = c.customerType === "New";
			} else if (customerTypeFilter === "existing") {
				matchesType = c.customerType === "Existing";
			}

			let matchesStability = true;
			if (aovStabilityFilter === "stable") {
				matchesStability = c.aovStability === "Stable";
			} else if (aovStabilityFilter === "increasing") {
				matchesStability = c.aovStability === "Increasing";
			} else if (aovStabilityFilter === "decreasing") {
				matchesStability = c.aovStability === "Decreasing";
			}

			return matchesSearch && matchesType && matchesStability;
		});
	}, [searchQuery, customerTypeFilter, aovStabilityFilter, topCustomers]);

	// Pagination Logic
	const paginatedCustomers = useMemo(() => {
		return filteredCustomers.slice(
			(currentPage - 1) * pageSize,
			currentPage * pageSize,
		);
	}, [filteredCustomers, currentPage, pageSize]);

	const totalPages = Math.max(
		1,
		Math.ceil(filteredCustomers.length / pageSize),
	);

	if (loading || !data) {
		return (
			<div className="grid gap-6 grid-cols-1 md:grid-cols-3 mt-2">
				<Skeleton className="h-[120px] rounded-xl" />
				<Skeleton className="h-[120px] rounded-xl" />
				<Skeleton className="h-[120px] rounded-xl" />
				<Skeleton className="h-[120px] rounded-xl" />
				<Skeleton className="h-[120px] rounded-xl" />
				<Skeleton className="h-[120px] rounded-xl" />
				<Skeleton className="h-[300px] md:col-span-3 rounded-xl" />
			</div>
		);
	}

	const { ltvData, cacData } = data;
	const ltv = ltvData.ltv;
	const hasSpendData = Boolean(cacData.hasMarketingSpendData);
	const cac = cacData.cac; // number | null when no marketing spend data exists
	const aov = cacData.aov;
	const netValue = cac !== null ? ltv - cac : null;
	const payback = cacData.paybackMonths;
	const aovExpansion = ltvData.aovExpansionPct;

	// LTV:CAC Ratio
	const ratio = cac !== null && cac > 0 ? ltv / cac : 0;

	// Cohort LineChart data transformation
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
	const cohortNames: string[] = [];
	const cohortChartData = [
		{ name: "Month 0" },
		{ name: "Month 3" },
		{ name: "Month 6" },
	];

	ltvData.cohortLtv.forEach((c: any) => {
		const dateObj = new Date(c.cohort_month_raw);
		const label = `${monthsList[dateObj.getUTCMonth()]} cohort`;
		cohortNames.push(label);

		(cohortChartData[0] as any)[label] = Math.round(Number(c.ltv_m0));
		(cohortChartData[1] as any)[label] = Math.round(Number(c.ltv_m3));
		(cohortChartData[2] as any)[label] = Math.round(Number(c.ltv_m6));
	});

	// AOV Expansion BarChart data
	const orderGroups = ["1st order", "2nd order", "3rd order", "4th+ order"];
	const aovBarData = orderGroups.map((group) => {
		const key = group.replace(" order", "");
		const found = ltvData.aovByOrder.find((r: any) => r.order_group === key);
		return {
			name: group,
			aov: found ? Math.round(Number(found.aov)) : 0,
		};
	});

	// Payback Breakdown metrics
	const avgMonthlyMargin = Math.round(aov * 0.26 * 1.5);

	// PDF Export
	const handleExport = () => {
		const exportData = filteredCustomers.map((c, idx) => ({
			Rank: `#${idx + 1}`,
			Mobile: String(c.customerMobile || "—"),
			Name: c.customerName || "Valued Customer",
			Type: c.customerType || "Existing",
			Orders: c.orders ?? 0,
			Revenue: `Rs. ${c.revenue ?? 0}`,
			AOV: `Rs. ${c.aov ?? 0}`,
			LTV: `Rs. ${c.ltv ?? 0}`,
			Trend: c.aovStability || "Stable",
			LastPurchase:
				(c.lastPurchaseDays ?? 0) === 0
					? "Today"
					: `${c.lastPurchaseDays} Days ago`,
		}));
		exportToPDF(exportData, "customer-ltv-aov-analysis");
		toast.success("PDF export downloaded successfully!");
	};

	const getStabilityBadge = (status?: string) => {
		if (status === "Increasing") {
			return (
				<Badge className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10 border-none font-medium text-[10px] rounded-sm">
					Increasing
				</Badge>
			);
		}
		if (status === "Decreasing") {
			return (
				<Badge className="bg-rose-500/10 text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 border-none font-medium text-[10px] rounded-sm">
					Decreasing
				</Badge>
			);
		}
		return (
			<Badge className="bg-blue-500/10 text-blue-600 dark:text-blue-400 hover:bg-blue-500/10 border-none font-medium text-[10px] rounded-sm">
				Stable
			</Badge>
		);
	};

	const getTypeBadge = (type?: string) => {
		if (type === "New") {
			return (
				<Badge className="bg-purple-500/10 text-purple-600 dark:text-purple-400 hover:bg-purple-500/10 border-none font-medium text-[10px] rounded-sm">
					New
				</Badge>
			);
		}
		return (
			<Badge className="bg-gray-500/10 text-gray-600 dark:text-gray-400 hover:bg-gray-500/10 border-none font-medium text-[10px] rounded-sm">
				Existing
			</Badge>
		);
	};

	return (
		<div className="flex flex-col gap-4 text-foreground font-sans">
			{/* Dense bento grid: KPI tiles + ratio hero + charts + breakdown, packed masonry-style */}
			<div className="columns-1 sm:columns-2 lg:columns-3 xl:columns-4 gap-4 [&>*]:mb-4 [&>*]:break-inside-avoid">
				{/* Customer LTV */}
				<Card className="border-[0.5px] border-border bg-card rounded-[12px] p-5 shadow-none flex flex-col gap-1">
					<span className="text-xs text-muted-foreground font-mono">
						Customer LTV
					</span>
					<span className="text-3xl font-semibold text-foreground font-mono mt-1">
						{formatCurrency(Math.round(ltv), { noDecimals: true })}
					</span>
				</Card>

				{/* CAC */}
				<Card className="border-[0.5px] border-border bg-card rounded-[12px] p-5 shadow-none flex flex-col gap-1">
					<span className="text-xs text-muted-foreground font-mono">CAC</span>
					<span className="text-3xl font-semibold text-foreground font-mono mt-1">
						{hasSpendData
							? formatCurrency(Math.round(cac as number), { noDecimals: true })
							: "N/A"}
					</span>
				</Card>

				{/* Average AOV */}
				<Card className="border-[0.5px] border-border bg-card rounded-[12px] p-5 shadow-none flex flex-col gap-1">
					<span className="text-xs text-muted-foreground font-mono">
						Average AOV
					</span>
					<span className="text-3xl font-semibold text-foreground font-mono mt-1">
						{formatCurrency(Math.round(aov), { noDecimals: true })}
					</span>
				</Card>

				{/* Net value / customer */}
				<Card className="border-[0.5px] border-border bg-card rounded-[12px] p-5 shadow-none flex flex-col gap-1">
					<span className="text-xs text-muted-foreground font-mono">
						Net value / customer
					</span>
					<span className="text-3xl font-semibold text-foreground font-mono mt-1">
						{netValue === null
							? "N/A"
							: formatCurrency(Math.round(netValue), { noDecimals: true })}
					</span>
				</Card>

				{/* CAC payback */}
				<Card className="border-[0.5px] border-border bg-card rounded-[12px] p-5 shadow-none flex flex-col gap-1">
					<span className="text-xs text-muted-foreground font-mono">
						CAC payback
					</span>
					<span className="text-3xl font-semibold text-foreground font-mono mt-1">
						{payback === null ? "N/A" : `${payback} mo`}
					</span>
				</Card>

				{/* AOV expansion */}
				<Card className="border-[0.5px] border-border bg-card rounded-[12px] p-5 shadow-none flex flex-col gap-1">
					<span className="text-xs text-muted-foreground font-mono">
						AOV expansion
					</span>
					<span className="text-3xl font-semibold text-foreground font-mono mt-1">
						{aovExpansion >= 0 ? "+" : ""}
						{Math.round(aovExpansion)}%
					</span>
				</Card>

				{/* LTV : CAC Ratio Green Banner Card */}
				<Card className="border border-emerald-950 bg-emerald-950/20 p-6 rounded-[12px] shadow-none flex flex-col gap-3">
					<span className="text-xs font-semibold text-emerald-500 font-mono">
						LTV : CAC ratio
					</span>
					<span className="text-5xl font-bold font-mono tracking-tight text-emerald-500">
						{hasSpendData ? `${ratio.toFixed(1)}x` : "N/A"}
					</span>
					<div className="flex flex-col gap-1">
						<span className="text-xs font-semibold text-emerald-500 uppercase tracking-wider font-mono">
							{hasSpendData
								? ratio >= 3.0
									? "Healthy"
									: "Below Target"
								: "No spend data"}
						</span>
						<span className="text-[10px] text-emerald-600 font-mono">
							Benchmark: 3-5x
						</span>
					</div>
				</Card>

				{/* Cohort LTV Growth Line Chart */}
				<Card className="border-[0.5px] border-border bg-card p-6 rounded-[12px] shadow-none flex flex-col gap-4">
					<div>
						<h3 className="text-sm font-medium text-foreground font-mono">
							Cohort LTV growth
						</h3>
					</div>
					<div className="h-[240px] w-full mt-2">
						<ResponsiveContainer width="100%" height="100%">
							<LineChart
								data={cohortChartData}
								margin={{ top: 10, right: 10, left: -20, bottom: 5 }}
							>
								<CartesianGrid
									strokeDasharray="3 3"
									stroke="var(--border)"
									vertical={false}
								/>
								<XAxis
									dataKey="name"
									stroke="var(--muted-foreground)"
									fontSize={11}
									tickLine={false}
									axisLine={false}
								/>
								<YAxis
									stroke="var(--muted-foreground)"
									fontSize={11}
									tickLine={false}
									axisLine={false}
								/>
								<Tooltip
									contentStyle={{
										backgroundColor: "var(--popover)",
										borderColor: "var(--border)",
										borderRadius: "8px",
										color: "var(--popover-foreground)",
										fontSize: "11px",
									}}
									formatter={(v) => [`₹${v}`, "LTV"]}
								/>
								{cohortNames.slice(0, 2).map((cohort, index) => (
									<Line
										key={cohort}
										type="monotone"
										dataKey={cohort}
										stroke={index === 0 ? "var(--chart-1)" : "var(--chart-4)"}
										strokeWidth={2}
										strokeDasharray={index === 0 ? undefined : "6 3"}
										dot={{
											r: 5,
											strokeWidth: 0,
											fill: index === 0 ? "var(--chart-1)" : "var(--chart-4)",
										}}
										activeDot={{ r: 7 }}
									/>
								))}
							</LineChart>
						</ResponsiveContainer>
					</div>
					{/* Custom Legend Below Chart */}
					<div className="flex items-center gap-4 text-xs font-mono text-muted-foreground mt-2">
						{cohortNames.slice(0, 2).map((cohort, index) => (
							<div key={cohort} className="flex items-center gap-1.5">
								<span
									className="size-2 rounded-full"
									style={{
										backgroundColor:
											index === 0 ? "var(--chart-1)" : "var(--chart-4)",
									}}
								/>
								<span>{cohort}</span>
							</div>
						))}
					</div>
				</Card>

				{/* AOV Expansion Bar Chart */}
				<Card className="border-[0.5px] border-border bg-card p-6 rounded-[12px] shadow-none flex flex-col gap-4">
					<div>
						<h3 className="text-sm font-medium text-foreground font-mono">
							AOV expansion over time
						</h3>
					</div>
					<div className="h-[240px] w-full mt-2">
						<ResponsiveContainer width="100%" height="100%">
							<BarChart
								data={aovBarData}
								margin={{ top: 10, right: 10, left: -20, bottom: 5 }}
							>
								<CartesianGrid
									strokeDasharray="3 3"
									stroke="var(--border)"
									vertical={false}
								/>
								<XAxis
									dataKey="name"
									stroke="var(--muted-foreground)"
									fontSize={11}
									tickLine={false}
									axisLine={false}
								/>
								<YAxis
									stroke="var(--muted-foreground)"
									fontSize={11}
									tickLine={false}
									axisLine={false}
								/>
								<Tooltip
									contentStyle={{
										backgroundColor: "var(--popover)",
										borderColor: "var(--border)",
										borderRadius: "8px",
										color: "var(--popover-foreground)",
										fontSize: "11px",
									}}
									formatter={(v) => [`₹${v}`, "AOV"]}
								/>
								<Bar
									dataKey="aov"
									fill="var(--chart-1)"
									radius={[4, 4, 0, 0]}
									barSize={40}
								/>
							</BarChart>
						</ResponsiveContainer>
					</div>
				</Card>

				{/* CAC Payback Breakdown */}
				<Card className="border-[0.5px] border-border bg-card p-6 rounded-[12px] shadow-none flex flex-col gap-4">
					<div>
						<h3 className="text-sm font-medium text-foreground font-mono">
							CAC payback breakdown
						</h3>
					</div>
					<div className="border border-border rounded-lg overflow-hidden divide-y divide-border">
						<div className="flex justify-between items-center p-4 bg-muted/20 text-xs font-mono">
							<span className="text-muted-foreground">CAC</span>
							<span className="text-foreground font-semibold">
								{hasSpendData
									? formatCurrency(Math.round(cac as number), {
											noDecimals: true,
										})
									: "N/A"}
							</span>
						</div>
						<div className="flex justify-between items-center p-4 bg-muted/20 text-xs font-mono">
							<span className="text-muted-foreground">
								Avg monthly margin / customer
							</span>
							<span className="text-foreground font-semibold">
								{formatCurrency(avgMonthlyMargin, { noDecimals: true })}
							</span>
						</div>
						<div className="flex justify-between items-center p-4 bg-muted/20 text-xs font-mono">
							<span className="text-foreground font-semibold">
								Payback period
							</span>
							<span className="text-foreground font-bold">
								{payback === null ? "N/A" : `${payback} months`}
							</span>
						</div>
					</div>
				</Card>
			</div>

			{/* Detailed Top Customer Table */}
			<Card className="overflow-hidden border-[0.5px] border-border bg-card rounded-[12px] shadow-none flex flex-col">
				<CardHeader className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between pb-4 border-b border-border bg-card">
					<div className="flex flex-col gap-1">
						<CardTitle className="text-lg text-foreground font-mono">
							Customer AOV & LTV Table
						</CardTitle>
						<CardDescription className="text-muted-foreground text-xs">
							Individual customer spending habits, lifetime value, and AOV
							stability tracking.
						</CardDescription>
					</div>

					{/* Interactive Table Filters */}
					<div className="flex flex-wrap items-center gap-3 w-full lg:w-auto">
						{/* Customer Type Dropdown */}
						<div className="flex items-center gap-2">
							<span className="text-[10px] uppercase font-bold text-muted-foreground font-mono">
								Customer Type:
							</span>
							<Select
								value={customerTypeFilter}
								onValueChange={(val) =>
									setCustomerTypeFilter(val as CustomerTypeFilter)
								}
							>
								<SelectTrigger className="w-[140px] h-9 text-xs">
									<SelectValue placeholder="All Customers" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="all">All Customers</SelectItem>
									<SelectItem value="new">New Customers</SelectItem>
									<SelectItem value="existing">Existing Customers</SelectItem>
								</SelectContent>
							</Select>
						</div>

						{/* AOV Stability Dropdown */}
						<div className="flex items-center gap-2">
							<span className="text-[10px] uppercase font-bold text-muted-foreground font-mono">
								AOV View:
							</span>
							<Select
								value={aovStabilityFilter}
								onValueChange={(val) =>
									setAovStabilityFilter(val as AovStabilityFilter)
								}
							>
								<SelectTrigger className="w-[140px] h-9 text-xs">
									<SelectValue placeholder="All Stability" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="all">All</SelectItem>
									<SelectItem value="stable">Stable</SelectItem>
									<SelectItem value="increasing">Increasing</SelectItem>
									<SelectItem value="decreasing">Decreasing</SelectItem>
								</SelectContent>
							</Select>
						</div>

						{/* Search input */}
						<div className="relative w-full sm:w-[200px]">
							<Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
							<Input
								placeholder="Search name or mobile..."
								className="pl-9 h-9 text-xs w-full"
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
							/>
						</div>

						{/* Export PDF Button */}
						<Button
							variant="outline"
							size="sm"
							onClick={handleExport}
							className="h-9 px-3 text-xs flex items-center gap-1.5 shrink-0"
						>
							<Download className="size-4" />
							Export PDF
						</Button>
					</div>
				</CardHeader>
				<CardContent className="p-0">
					<div className="overflow-x-auto w-full">
						<Table className="min-w-[800px] border-collapse">
							<TableHeader>
								<TableRow className="border-b border-border hover:bg-transparent">
									<TableHead className="font-semibold text-xs py-3 pl-4 text-muted-foreground">
										Rank
									</TableHead>
									<TableHead className="font-semibold text-xs py-3 text-muted-foreground">
										Customer Mobile
									</TableHead>
									<TableHead className="font-semibold text-xs py-3 text-muted-foreground">
										Customer Name
									</TableHead>
									<TableHead className="font-semibold text-xs py-3 text-center text-muted-foreground">
										Type
									</TableHead>
									<TableHead className="font-semibold text-xs py-3 text-right text-muted-foreground">
										Orders
									</TableHead>
									<TableHead className="font-semibold text-xs py-3 text-right text-muted-foreground">
										Revenue
									</TableHead>
									<TableHead className="font-semibold text-xs py-3 text-right text-muted-foreground">
										AOV
									</TableHead>
									<TableHead className="font-semibold text-xs py-3 text-right text-muted-foreground">
										LTV
									</TableHead>
									<TableHead className="font-semibold text-xs py-3 text-center text-muted-foreground">
										AOV Trend
									</TableHead>
									<TableHead className="font-semibold text-xs py-3 text-right pr-4 text-muted-foreground">
										Last Purchase
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{paginatedCustomers.length === 0 ? (
									<TableRow className="border-b border-border hover:bg-transparent">
										<TableCell
											colSpan={10}
											className="h-32 text-center text-muted-foreground text-xs font-mono"
										>
											No matching customers found.
										</TableCell>
									</TableRow>
								) : (
									paginatedCustomers.map((cust: LtvCustomer, index: number) => {
										const actualIndex = (currentPage - 1) * pageSize + index;
										return (
											<TableRow
												key={getCustomerRowKey(cust)}
												className="border-b border-border hover:bg-muted/40"
											>
												<TableCell className="font-mono text-xs py-3 pl-4 text-muted-foreground">
													#{actualIndex + 1}
												</TableCell>
												<TableCell className="font-mono text-xs py-3 text-foreground/80">
													{String(cust.customerMobile ?? "")}
												</TableCell>
												<TableCell className="font-semibold text-xs py-3 text-foreground">
													{String(cust.customerName ?? "Valued Customer")}
												</TableCell>
												<TableCell className="py-3 text-center">
													{getTypeBadge(cust.customerType ?? "Existing")}
												</TableCell>
												<TableCell className="font-mono text-xs py-3 text-right tabular-nums text-foreground/80">
													{(cust.orders ?? 0).toLocaleString()}
												</TableCell>
												<TableCell className="font-mono text-xs py-3 text-right tabular-nums text-foreground/80">
													{formatCurrency(cust.revenue ?? 0, {
														noDecimals: true,
													})}
												</TableCell>
												<TableCell className="font-mono text-xs py-3 text-right tabular-nums text-foreground/80">
													{formatCurrency(cust.aov ?? 0, { noDecimals: true })}
												</TableCell>
												<TableCell className="font-bold font-mono text-xs py-3 text-right tabular-nums text-foreground">
													{formatCurrency(cust.ltv ?? 0, { noDecimals: true })}
												</TableCell>
												<TableCell className="py-3 text-center">
													{getStabilityBadge(cust.aovStability ?? "Stable")}
												</TableCell>
												<TableCell className="font-mono text-xs py-3 text-right tabular-nums pr-4 text-muted-foreground">
													{(cust.lastPurchaseDays ?? 0) === 0
														? "Today"
														: (cust.lastPurchaseDays ?? 0) === 1
															? "Yesterday"
															: `${cust.lastPurchaseDays ?? 0} Days ago`}
												</TableCell>
											</TableRow>
										);
									})
								)}
							</TableBody>
						</Table>
					</div>

					{/* Table Pagination Controls */}
					<div className="flex items-center justify-between px-6 py-4 border-t border-border bg-card">
						<div className="flex items-center gap-2 text-xs text-muted-foreground font-mono">
							<span>Rows per page:</span>
							<Select
								value={String(pageSize)}
								onValueChange={(val) => {
									setPageSize(Number(val));
									setCurrentPage(1);
								}}
							>
								<SelectTrigger className="w-[70px] h-8 text-xs rounded-lg focus:ring-0 focus:ring-offset-0">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="10">10</SelectItem>
									<SelectItem value="15">15</SelectItem>
									<SelectItem value="20">20</SelectItem>
								</SelectContent>
							</Select>
							<span className="ml-4">
								Showing{" "}
								{Math.min(
									filteredCustomers.length,
									(currentPage - 1) * pageSize + 1,
								)}
								-{Math.min(filteredCustomers.length, currentPage * pageSize)} of{" "}
								{filteredCustomers.length}
							</span>
						</div>

						<div className="flex items-center gap-2">
							<Button
								variant="outline"
								size="sm"
								onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
								disabled={currentPage === 1}
								className="h-8 w-8 p-0 rounded-lg text-muted-foreground hover:text-foreground disabled:opacity-50"
							>
								<ChevronLeft className="size-4" />
							</Button>
							<span className="text-xs text-muted-foreground font-mono">
								Page {currentPage} of {totalPages}
							</span>
							<Button
								variant="outline"
								size="sm"
								onClick={() =>
									setCurrentPage((p) => Math.min(totalPages, p + 1))
								}
								disabled={currentPage === totalPages}
								className="h-8 w-8 p-0 rounded-lg text-muted-foreground hover:text-foreground disabled:opacity-50"
							>
								<ChevronRight className="size-4" />
							</Button>
						</div>
					</div>
				</CardContent>
			</Card>
		</div>
	);
}
