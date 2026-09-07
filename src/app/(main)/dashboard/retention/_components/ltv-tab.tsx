"use client";

import {
	ChevronLeft,
	ChevronRight,
	Coins,
	Download,
	Percent,
	Search,
	Trophy,
	Users,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
	Bar,
	BarChart,
	CartesianGrid,
	Tooltip as ChartTooltip,
	Legend,
	Line,
	LineChart,
	ResponsiveContainer,
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
import { MetricCard } from "@/components/ui/metric-card";
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
import { useLTV } from "@/hooks/useLTV";
import { exportToPDF } from "@/lib/export-utils";
import { formatCurrency } from "@/lib/utils";

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

export function LtvTab({ hasData }: { hasData: boolean }) {
	const [searchQuery, setSearchQuery] = useState("");
	const [customerTypeFilter, setCustomerTypeFilter] =
		useState<CustomerTypeFilter>("all");
	const [aovStabilityFilter, setAovStabilityFilter] =
		useState<AovStabilityFilter>("all");

	const { data, isLoading } = useLTV(hasData);

	const distribution = data?.distribution || [];
	const topCustomers = data?.topCustomers || [];
	const overview = data?.overview;
	const trend = data?.trend || [];

	// Blended LTV, AOV, CAC metrics
	const summaryStats = useMemo(() => {
		if (!overview) {
			return {
				avgLtv: 0,
				avgAov: 0,
				cac: 0,
				ratio: "0:1",
				hasSpendData: false,
			};
		}
		const hasSpendData = Boolean(overview.hasMarketingSpendData);
		const avgLtv = Math.round(overview.ltv?.current || 0);
		const cac = Math.round(overview.cac?.current || 0);
		const totalRevenue = overview.meta?.totalRevenue || 0;
		const totalOrders =
			overview.meta?.totalOrders ||
			topCustomers.reduce(
				(acc: number, c: LtvCustomer) => acc + (c.orders ?? 0),
				0,
			) ||
			1;
		const avgAov =
			totalRevenue > 0
				? Math.round(totalRevenue / totalOrders)
				: Math.round(avgLtv / (overview.avgOrdersPerCustomer?.current || 1));

		const ratioNum = hasSpendData
			? overview.ltvCacRatio?.current ||
				(cac > 0 ? Math.round((avgLtv / cac) * 10) / 10 : 0)
			: null;
		const ratio = ratioNum === null ? "N/A" : `${ratioNum}:1`;

		return { avgLtv, avgAov, cac, ratio, hasSpendData };
	}, [overview, topCustomers]);

	// Interactive Filters for Customer Table
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

	const filteredCustomers = useMemo<LtvCustomer[]>(() => {
		return topCustomers.filter((c: LtvCustomer) => {
			// Search Query
			const query = searchQuery.toLowerCase();
			const matchesSearch =
				!searchQuery ||
				c.customerName?.toLowerCase().includes(query) ||
				String(c.customerMobile ?? "").includes(query);

			// Customer Type Filter
			let matchesType = true;
			if (customerTypeFilter === "new") {
				matchesType = c.customerType === "New";
			} else if (customerTypeFilter === "existing") {
				matchesType = c.customerType === "Existing";
			}

			// AOV Stability Filter
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

	// Pagination & Page Size states
	const [currentPage, setCurrentPage] = useState(1);
	const [pageSize, setPageSize] = useState(15);

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

	// Reset page on filter changes
	useEffect(() => {
		setCurrentPage(1);
	}, []);

	// Export handler
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

	if (isLoading || !data) {
		return (
			<div className="grid gap-6 grid-cols-1 md:grid-cols-4 mt-2">
				<Skeleton className="h-[120px] rounded-2xl" />
				<Skeleton className="h-[120px] rounded-2xl" />
				<Skeleton className="h-[120px] rounded-2xl" />
				<Skeleton className="h-[120px] rounded-2xl" />
				<Skeleton className="h-[300px] md:col-span-4 rounded-2xl" />
			</div>
		);
	}

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
		<div className="flex flex-col gap-6">
			{/* Top KPI Cards Row */}
			<div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
				<MetricCard
					title="Avg LTV"
					value={formatCurrency(summaryStats.avgLtv, { noDecimals: true })}
					comparisonLabel="Avg spend per customer"
					icon={Trophy}
				/>
				<MetricCard
					title="Avg AOV"
					value={formatCurrency(summaryStats.avgAov, { noDecimals: true })}
					comparisonLabel="Avg order ticket size"
					icon={Coins}
				/>
				<MetricCard
					title="CAC"
					value={
						summaryStats.hasSpendData
							? formatCurrency(summaryStats.cac, { noDecimals: true })
							: "N/A"
					}
					comparisonLabel={
						summaryStats.hasSpendData
							? "Acquisition marketing cost"
							: "No marketing spend data recorded"
					}
					icon={Users}
				/>
				<MetricCard
					title="LTV:CAC"
					value={summaryStats.ratio}
					comparisonLabel="Ad spend efficiency"
					icon={Percent}
				/>
			</div>

			{/* Month-wise Trend Line Chart */}
			<div className="grid gap-6 grid-cols-1 lg:grid-cols-3 items-stretch">
				<Card className="lg:col-span-2">
					<CardHeader>
						<CardTitle className="text-lg">LTV / AOV / CAC Trend</CardTitle>
						<CardDescription>
							Month-wise trend of core customer values and ad spend efficiencies
						</CardDescription>
					</CardHeader>
					<CardContent className="h-[280px] pb-4">
						{trend.length === 0 ? (
							<div className="h-full flex items-center justify-center text-xs text-muted-foreground">
								No monthly trend data available.
							</div>
						) : (
							<ResponsiveContainer width="100%" height="100%">
								<LineChart
									data={trend}
									margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
								>
									<CartesianGrid strokeDasharray="3 3" opacity={0.15} />
									<XAxis
										dataKey="monthLabel"
										tickLine={false}
										style={{ fontSize: 11 }}
									/>
									<YAxis tickLine={false} style={{ fontSize: 11 }} />
									<ChartTooltip
										formatter={(val) => [formatCurrency(Number(val)), "Value"]}
									/>
									<Legend
										verticalAlign="top"
										height={36}
										style={{ fontSize: 11 }}
									/>
									<Line
										type="monotone"
										name="LTV"
										dataKey="ltv"
										stroke="var(--chart-1)"
										strokeWidth={2}
										dot={{ r: 3 }}
									/>
									<Line
										type="monotone"
										name="AOV"
										dataKey="aov"
										stroke="var(--chart-3)"
										strokeWidth={2}
										strokeDasharray="6 3"
										dot={{ r: 3 }}
									/>
									<Line
										type="monotone"
										name="CAC"
										dataKey="cac"
										stroke="var(--chart-4)"
										strokeWidth={2}
										strokeDasharray="2 2"
										dot={{ r: 3 }}
									/>
								</LineChart>
							</ResponsiveContainer>
						)}
					</CardContent>
				</Card>

				{/* LTV Tier Distribution Histogram */}
				<Card className="lg:col-span-1">
					<CardHeader>
						<CardTitle className="text-lg">Customer Value Tiers</CardTitle>
						<CardDescription>
							Customer count distribution by LTV tiers
						</CardDescription>
					</CardHeader>
					<CardContent className="h-[280px] pb-4">
						{distribution.length === 0 ? (
							<div className="h-full flex items-center justify-center text-xs text-muted-foreground">
								No customer distribution available.
							</div>
						) : (
							<ResponsiveContainer width="100%" height="100%">
								<BarChart
									data={distribution}
									margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
								>
									<CartesianGrid strokeDasharray="3 3" opacity={0.15} />
									<XAxis
										dataKey="range"
										tickLine={false}
										style={{ fontSize: 11 }}
									/>
									<YAxis tickLine={false} style={{ fontSize: 11 }} />
									<ChartTooltip
										formatter={(val) => [`${val} customers`, "Count"]}
									/>
									<Bar
										dataKey="count"
										fill="var(--chart-1)"
										radius={[4, 4, 0, 0]}
										maxBarSize={40}
									/>
								</BarChart>
							</ResponsiveContainer>
						)}
					</CardContent>
				</Card>

				{/* Detailed Top Customer Table */}
				<Card className="lg:col-span-3 overflow-hidden">
					<CardHeader className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between pb-4 border-b border-border/40">
						<div className="flex flex-col gap-1">
							<CardTitle className="text-lg">
								Customer AOV & LTV Table
							</CardTitle>
							<CardDescription>
								Individual customer spending habits, lifetime value, and AOV
								stability tracking.
							</CardDescription>
						</div>

						{/* Interactive Table Filters */}
						<div className="flex flex-wrap items-center gap-3 w-full lg:w-auto">
							{/* Customer Type Dropdown */}
							<div className="flex items-center gap-2">
								<span className="text-[10px] uppercase font-bold text-muted-foreground">
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
								<span className="text-[10px] uppercase font-bold text-muted-foreground">
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
								className="h-9 px-3 bg-zinc-950 border-[0.5px] border-zinc-800 text-xs text-zinc-100 hover:bg-zinc-900 rounded-lg flex items-center gap-1.5 shrink-0"
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
									<TableRow className="border-b bg-muted/20">
										<TableHead className="font-semibold text-xs py-3 pl-4">
											Rank
										</TableHead>
										<TableHead className="font-semibold text-xs py-3">
											Customer Mobile
										</TableHead>
										<TableHead className="font-semibold text-xs py-3">
											Customer Name
										</TableHead>
										<TableHead className="font-semibold text-xs py-3 text-center">
											Type
										</TableHead>
										<TableHead className="font-semibold text-xs py-3 text-right">
											Orders
										</TableHead>
										<TableHead className="font-semibold text-xs py-3 text-right">
											Revenue
										</TableHead>
										<TableHead className="font-semibold text-xs py-3 text-right">
											AOV
										</TableHead>
										<TableHead className="font-semibold text-xs py-3 text-right">
											LTV
										</TableHead>
										<TableHead className="font-semibold text-xs py-3 text-center">
											AOV Trend
										</TableHead>
										<TableHead className="font-semibold text-xs py-3 text-right pr-4">
											Last Purchase
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{paginatedCustomers.length === 0 ? (
										<TableRow>
											<TableCell
												colSpan={10}
												className="h-32 text-center text-muted-foreground text-xs"
											>
												No matching customers found.
											</TableCell>
										</TableRow>
									) : (
										paginatedCustomers.map(
											(cust: LtvCustomer, index: number) => {
												const actualIndex =
													(currentPage - 1) * pageSize + index;
												return (
													<TableRow
														key={getCustomerRowKey(cust)}
														className="border-b hover:bg-muted/5 animate-fade-in"
													>
														<TableCell className="font-mono text-xs py-3 pl-4 text-muted-foreground">
															#{actualIndex + 1}
														</TableCell>
														<TableCell className="font-mono text-xs py-3">
															{String(cust.customerMobile ?? "")}
														</TableCell>
														<TableCell className="font-semibold text-xs py-3">
															{String(cust.customerName ?? "Valued Customer")}
														</TableCell>
														<TableCell className="py-3 text-center">
															{getTypeBadge(cust.customerType ?? "Existing")}
														</TableCell>
														<TableCell className="font-mono text-xs py-3 text-right tabular-nums">
															{(cust.orders ?? 0).toLocaleString()}
														</TableCell>
														<TableCell className="font-mono text-xs py-3 text-right tabular-nums text-foreground/80">
															{formatCurrency(cust.revenue ?? 0, {
																noDecimals: true,
															})}
														</TableCell>
														<TableCell className="font-mono text-xs py-3 text-right tabular-nums text-foreground/80">
															{formatCurrency(cust.aov ?? 0, {
																noDecimals: true,
															})}
														</TableCell>
														<TableCell className="font-bold font-mono text-xs py-3 text-right tabular-nums text-foreground">
															{formatCurrency(cust.ltv ?? 0, {
																noDecimals: true,
															})}
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
											},
										)
									)}
								</TableBody>
							</Table>
						</div>

						{/* Table Pagination Controls */}
						<div className="flex items-center justify-between px-6 py-4 border-t border-zinc-900 bg-zinc-950/20">
							<div className="flex items-center gap-2 text-xs text-zinc-500 font-mono">
								<span>Rows per page:</span>
								<Select
									value={String(pageSize)}
									onValueChange={(val) => {
										setPageSize(Number(val));
										setCurrentPage(1);
									}}
								>
									<SelectTrigger className="w-[70px] h-8 bg-zinc-950 border-zinc-800 text-xs rounded-lg text-zinc-200 focus:ring-0 focus:ring-offset-0">
										<SelectValue />
									</SelectTrigger>
									<SelectContent className="bg-zinc-950 border-zinc-800 text-zinc-200">
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
									-{Math.min(filteredCustomers.length, currentPage * pageSize)}{" "}
									of {filteredCustomers.length}
								</span>
							</div>

							<div className="flex items-center gap-2">
								<Button
									variant="outline"
									size="sm"
									onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
									disabled={currentPage === 1}
									className="h-8 w-8 p-0 bg-zinc-950 border-zinc-800 rounded-lg text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
								>
									<ChevronLeft className="size-4" />
								</Button>
								<span className="text-xs text-zinc-400 font-mono">
									Page {currentPage} of {totalPages}
								</span>
								<Button
									variant="outline"
									size="sm"
									onClick={() =>
										setCurrentPage((p) => Math.min(totalPages, p + 1))
									}
									disabled={currentPage === totalPages}
									className="h-8 w-8 p-0 bg-zinc-950 border-zinc-800 rounded-lg text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
								>
									<ChevronRight className="size-4" />
								</Button>
							</div>
						</div>
					</CardContent>
				</Card>
			</div>
		</div>
	);
}
