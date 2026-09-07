"use client";

import {
	CheckCircle,
	ChevronLeft,
	ChevronRight,
	Download,
	Search,
	Sparkles,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
	CartesianGrid,
	Cell,
	Line,
	LineChart,
	Pie,
	PieChart,
	Tooltip as RechartsTooltip,
	ResponsiveContainer,
	XAxis,
	YAxis,
} from "recharts";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
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
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useHealth } from "@/hooks/useHealth";
import { exportToPDF } from "@/lib/export-utils";

type CustomerTypeFilter = "all" | "new" | "existing";

type CustomerHealthEntry = {
	customerName?: string;
	customerMobile?: string | number;
	orders?: number;
	revenue?: number;
	aov?: number;
	healthScore?: number;
	segment?: string;
	customerType?: string;
	lastPurchaseDays?: number;
	ageDays?: number;
	spendPercentile?: number;
};

function calculateHealthScore(customer: CustomerHealthEntry) {
	const recencyPoints =
		(customer.lastPurchaseDays ?? 0 <= 30)
			? 40
			: (customer.lastPurchaseDays ?? 0 <= 60)
				? 25
				: (customer.lastPurchaseDays ?? 0 <= 90)
					? 10
					: 0;
	const frequencyPoints =
		(customer.orders ?? 0) >= 10
			? 30
			: (customer.orders ?? 0) >= 5
				? 20
				: (customer.orders ?? 0) >= 2
					? 10
					: 5;
	const monetaryPoints =
		(customer.spendPercentile ?? 0) <= 0.2
			? 30
			: (customer.spendPercentile ?? 0) <= 0.7
				? 20
				: 10;

	return recencyPoints + frequencyPoints + monetaryPoints;
}

function classifyCustomerType(customer: CustomerHealthEntry) {
	if ((customer.ageDays ?? 0) <= 30 || (customer.orders ?? 0) <= 1) {
		return "New";
	}
	return "Existing";
}

function classifySegment(customer: CustomerHealthEntry) {
	const healthScore = calculateHealthScore(customer);
	const isTopLtv = (customer.spendPercentile ?? 0) <= 0.2;
	const recencyDays = customer.lastPurchaseDays ?? 0;
	const ageDays = customer.ageDays ?? 0;
	const orders = customer.orders ?? 0;

	if (healthScore > 80 && isTopLtv) return "VIP";
	if (healthScore > 70 && orders >= 5) return "Loyal";
	if (ageDays <= 30) return "New";
	if (recencyDays > 45 && recencyDays < 90) return "At Risk";
	if (recencyDays >= 90) return "Lost";
	return "Regular";
}

type MonthlyAovPoint = {
	month: string;
	aov: number;
	revenue: number;
	orders: number;
};

/**
 * Data-truth remediation, FINDING-201: this used to fabricate a fixed
 * 6-month Jan-Jun series with a hardcoded multiplier curve. Now derives the
 * "Increasing/Decreasing/Stable" badge from the real monthly AOV series
 * (getMonthlyAovTrend, sourced from sales_fact_v) instead of synthesizing
 * data — no series is invented; an empty/short real series just yields
 * "Stable" and an empty or partial chart.
 */
function summarizeAovTrend(series: MonthlyAovPoint[]) {
	let status: "Stable" | "Increasing" | "Decreasing" = "Stable";
	if (series.length >= 2) {
		const first = series[0].aov;
		const last = series[series.length - 1].aov;
		if (first > 0) {
			if (last > first * 1.08) status = "Increasing";
			else if (last < first * 0.92) status = "Decreasing";
		}
	}
	return { status, series };
}

export function SegmentsHealthTab({ hasData }: { hasData: boolean }) {
	const { data: healthData, isLoading } = useHealth(hasData);
	const customerList = healthData?.customerList ?? [];

	const [searchQuery, setSearchQuery] = useState("");
	const [selectedCustomerType, setSelectedCustomerType] =
		useState<CustomerTypeFilter>("all");

	const getCustomerRowKey = (cust: CustomerHealthEntry) =>
		[
			cust.customerMobile ?? "unknown",
			cust.customerName ?? "unknown",
			cust.healthScore ?? "",
			cust.segment ?? "",
			cust.lastPurchaseDays ?? "",
		].join("|");

	const filteredCustomers = useMemo(() => {
		const query = searchQuery.toLowerCase();
		return customerList.filter((customer: CustomerHealthEntry) => {
			const matchesSearch =
				!query ||
				(customer.customerName ?? "").toLowerCase().includes(query) ||
				String(customer.customerMobile ?? "").includes(query);

			const customerType = classifyCustomerType(customer);
			const matchesType =
				selectedCustomerType === "all" ||
				customerType.toLowerCase() === selectedCustomerType;

			return matchesSearch && matchesType;
		});
	}, [customerList, searchQuery, selectedCustomerType]);

	const enrichedCustomers = useMemo(() => {
		return filteredCustomers.map((customer: CustomerHealthEntry) => ({
			...customer,
			healthScore: calculateHealthScore(customer),
			segment: classifySegment(customer),
			customerType: classifyCustomerType(customer),
		}));
	}, [filteredCustomers]);

	const segmentCounts = useMemo(() => {
		const counts = { Champions: 0, Loyal: 0, "At Risk": 0, Lost: 0 };
		enrichedCustomers.forEach((customer: CustomerHealthEntry) => {
			const segment = customer.segment ?? "Regular";
			if (segment === "VIP") {
				counts.Champions += 1;
			} else if (
				segment === "Loyal" ||
				segment === "New" ||
				segment === "Regular"
			) {
				counts.Loyal += 1;
			} else if (segment === "At Risk" || segment === "At risk") {
				counts["At Risk"] += 1;
			} else if (segment === "Lost") {
				counts.Lost += 1;
			}
		});
		return counts;
	}, [enrichedCustomers]);

	const newVsReturningCounts = useMemo(() => {
		const counts = { New: 0, Returning: 0 };
		enrichedCustomers.forEach((customer: CustomerHealthEntry) => {
			const type = customer.customerType ?? "Existing";
			if (type === "New") {
				counts.New += 1;
			} else {
				counts.Returning += 1;
			}
		});
		return counts;
	}, [enrichedCustomers]);

	const averageHealthScore = useMemo(() => {
		if (!enrichedCustomers.length) return 0;
		return Math.round(
			enrichedCustomers.reduce(
				(total: number, customer: CustomerHealthEntry) =>
					total + (customer.healthScore ?? 0),
				0,
			) / enrichedCustomers.length,
		);
	}, [enrichedCustomers]);

	const gaugeColors = useMemo(() => {
		if (averageHealthScore >= 75) {
			return {
				text: "text-emerald-500",
				bg: "bg-emerald-500/10 border-emerald-500/20",
				label: "Healthy",
			};
		}
		if (averageHealthScore >= 40) {
			return {
				text: "text-amber-500",
				bg: "bg-amber-500/10 border-amber-500/20",
				label: "Average",
			};
		}
		return {
			text: "text-rose-500",
			bg: "bg-rose-500/10 border-rose-500/20",
			label: "Critical",
		};
	}, [averageHealthScore]);

	const aovTrend = useMemo(
		() => summarizeAovTrend(healthData?.monthlyAovTrend ?? []),
		[healthData?.monthlyAovTrend],
	);
	const total = Math.max(1, enrichedCustomers.length || healthData?.total || 1);

	// Pagination state
	const [currentPage, setCurrentPage] = useState(1);
	const [pageSize, setPageSize] = useState(15);

	const paginatedCustomers = useMemo(() => {
		return enrichedCustomers.slice(
			(currentPage - 1) * pageSize,
			currentPage * pageSize,
		);
	}, [enrichedCustomers, currentPage, pageSize]);

	const totalPages = Math.max(
		1,
		Math.ceil(enrichedCustomers.length / pageSize),
	);

	// Export handler
	const handleExport = () => {
		const exportData = enrichedCustomers.map((c: CustomerHealthEntry) => ({
			Customer: c.customerName || "Valued Customer",
			Mobile: String(c.customerMobile || "—"),
			Type: c.customerType || "Existing",
			HealthScore: `${c.healthScore ?? 0} (${(c.healthScore ?? 0) >= 75 ? "Good" : (c.healthScore ?? 0) >= 40 ? "Average" : "Bad"})`,
			Segment: c.segment || "Regular",
			LastPurchase:
				(c.lastPurchaseDays ?? 0) === 0
					? "Today"
					: `${c.lastPurchaseDays} Days`,
		}));
		exportToPDF(exportData, "customer-segments-health");
		toast.success("PDF export downloaded successfully!");
	};

	// Chart data formatting — must be declared BEFORE any early returns (Rules of Hooks)
	const rfmChartData = useMemo(() => {
		return [
			{
				name: "Champions",
				value: segmentCounts.Champions,
				color: "var(--chart-1)",
			},
			{ name: "Loyal", value: segmentCounts.Loyal, color: "var(--chart-2)" },
			{
				name: "At risk",
				value: segmentCounts["At Risk"],
				color: "var(--chart-3)",
			},
			{ name: "Lost", value: segmentCounts.Lost, color: "var(--chart-5)" },
		].filter((d) => d.value > 0);
	}, [segmentCounts]);

	const typeChartData = useMemo(() => {
		return [
			{ name: "New", value: newVsReturningCounts.New, color: "var(--chart-1)" },
			{
				name: "Returning",
				value: newVsReturningCounts.Returning,
				color: "var(--chart-4)",
			},
		].filter((d) => d.value > 0);
	}, [newVsReturningCounts]);

	if (isLoading || !healthData) {
		return (
			<div className="grid gap-6 grid-cols-1 md:grid-cols-4 mt-2">
				<Skeleton className="h-[120px] rounded-2xl" />
				<Skeleton className="h-[120px] rounded-2xl" />
				<Skeleton className="h-[120px] rounded-2xl" />
				<Skeleton className="h-[120px] rounded-2xl" />
				<Skeleton className="h-[400px] md:col-span-4 rounded-2xl" />
			</div>
		);
	}

	const getHealthBadge = (health: number) => {
		if (health >= 75) {
			return (
				<span className="text-emerald-500 font-mono font-semibold">
					{health} (Good)
				</span>
			);
		}
		if (health >= 40) {
			return (
				<span className="text-amber-500 font-mono font-semibold">
					{health} (Average)
				</span>
			);
		}
		return (
			<span className="text-rose-500 font-mono font-semibold">
				{health} (Bad)
			</span>
		);
	};

	const getSegmentBadge = (segment: string) => {
		switch (segment) {
			case "VIP":
				return (
					<Badge className="bg-amber-500/20 text-amber-500 hover:bg-amber-500/20 border-amber-500/30 text-[10px] rounded-full">
						VIP
					</Badge>
				);
			case "Loyal":
				return (
					<Badge className="bg-blue-500/20 text-blue-500 hover:bg-blue-500/20 border-blue-500/30 text-[10px] rounded-full">
						Loyal
					</Badge>
				);
			case "New":
				return (
					<Badge className="bg-purple-500/20 text-purple-500 hover:bg-purple-500/20 border-purple-500/30 text-[10px] rounded-full">
						New
					</Badge>
				);
			case "At Risk":
				return (
					<Badge className="bg-orange-500/20 text-orange-500 hover:bg-orange-500/20 border-orange-500/30 text-[10px] rounded-full">
						At Risk
					</Badge>
				);
			case "Lost":
				return (
					<Badge className="bg-red-500/20 text-red-500 hover:bg-red-500/20 border-red-500/30 text-[10px] rounded-full">
						Lost
					</Badge>
				);
			default:
				return (
					<Badge className="bg-gray-500/20 text-gray-500 hover:bg-gray-500/20 border-gray-500/30 text-[10px] rounded-full">
						Regular
					</Badge>
				);
		}
	};

	const handleAction = (action: string, mobile: string) => {
		toast.info(`${action} queued for ${mobile}`, {
			description: "This action isn't wired to a live provider yet.",
		});
	};

	return (
		<div className="flex flex-col gap-6 text-foreground font-sans">
			{/* Header Section */}
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<h2 className="text-xl font-semibold tracking-tight text-foreground font-mono">
						Health & Segments
					</h2>
					<p className="text-xs text-muted-foreground">
						Customer type filters recalculate health score, segment mix, and AOV
						stability together.
					</p>
				</div>
				<Select
					value={selectedCustomerType}
					onValueChange={(value) => {
						setSelectedCustomerType(value as CustomerTypeFilter);
						setCurrentPage(1);
					}}
				>
					<SelectTrigger className="w-[190px] h-9 text-xs rounded-lg focus:ring-0">
						<SelectValue placeholder="All Customers" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">All Customers</SelectItem>
						<SelectItem value="new">New Customers</SelectItem>
						<SelectItem value="existing">Existing Customers</SelectItem>
					</SelectContent>
				</Select>
			</div>

			{/* Main Grid: Left (Health & Donut Charts) vs Right (AOV Trend) */}
			<div className="grid gap-6 grid-cols-1 xl:grid-cols-[1.1fr_0.9fr]">
				<div className="flex flex-col gap-6">
					{/* Customer health index Card */}
					<Card className="border-[0.5px] border-border bg-card p-6 rounded-[12px] shadow-none flex flex-col gap-4">
						<div className="flex items-center justify-between">
							<div className="flex flex-col gap-0.5">
								<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground font-mono">
									Customer health index
								</h3>
								<div className="flex items-baseline gap-1 mt-1">
									<span className="text-5xl font-bold font-mono tracking-tight text-foreground">
										{averageHealthScore}
									</span>
									<span className="text-muted-foreground text-sm font-mono">
										/ 100
									</span>
								</div>
							</div>
							<Badge
								className={`rounded-[4px] border ${gaugeColors.bg} ${gaugeColors.text} text-[10px] uppercase font-mono px-1.5 py-0.5`}
							>
								{gaugeColors.label}
							</Badge>
						</div>
						<Progress
							value={averageHealthScore}
							className="h-2 w-full bg-muted"
						/>
						<p className="text-[10px] text-muted-foreground font-mono">
							Weighted: retention 40, frequency 25, AOV growth 20, churn risk 15
						</p>
					</Card>

					{/* Donut Charts Card */}
					<Card className="border-[0.5px] border-border bg-card p-6 rounded-[12px] shadow-none flex flex-col gap-4">
						<div className="grid grid-cols-1 md:grid-cols-2 gap-8 divide-y md:divide-y-0 md:divide-x divide-border">
							{/* RFM Segments */}
							<div className="flex flex-col items-center">
								<h4 className="text-xs font-medium text-foreground/80 font-mono self-start mb-6">
									RFM segments
								</h4>
								<div className="relative size-40 flex items-center justify-center">
									<ResponsiveContainer width="100%" height="100%">
										<PieChart>
											<Pie
												data={rfmChartData}
												cx="50%"
												cy="50%"
												innerRadius={45}
												outerRadius={60}
												paddingAngle={3}
												dataKey="value"
											>
												{rfmChartData.map((entry, index) => (
													// biome-ignore lint/suspicious/noArrayIndexKey: stable chart segments
													<Cell key={`cell-${index}`} fill={entry.color} />
												))}
											</Pie>
										</PieChart>
									</ResponsiveContainer>
									<div className="absolute flex flex-col items-center justify-center">
										<span className="text-sm font-semibold text-foreground font-mono">
											{total.toLocaleString()}
										</span>
										<span className="text-[9px] text-muted-foreground font-mono uppercase tracking-wider">
											Total
										</span>
									</div>
								</div>

								{/* Legends */}
								<div className="flex flex-col gap-2 mt-6 text-[11px] font-mono text-muted-foreground w-full">
									{rfmChartData.map((item) => (
										<div key={item.name} className="flex items-center gap-2">
											<span
												className="size-2 rounded-full shrink-0"
												style={{ backgroundColor: item.color }}
											/>
											<span>
												{item.name} · {item.value.toLocaleString()} ·{" "}
												{Math.round((item.value / total) * 100)}%
											</span>
										</div>
									))}
								</div>
							</div>

							{/* New vs Returning */}
							<div className="flex flex-col items-center md:pl-8">
								<h4 className="text-xs font-medium text-foreground/80 font-mono self-start mb-6">
									New vs returning
								</h4>
								<div className="relative size-40 flex items-center justify-center">
									<ResponsiveContainer width="100%" height="100%">
										<PieChart>
											<Pie
												data={typeChartData}
												cx="50%"
												cy="50%"
												innerRadius={45}
												outerRadius={60}
												paddingAngle={3}
												dataKey="value"
											>
												{typeChartData.map((entry, index) => (
													// biome-ignore lint/suspicious/noArrayIndexKey: stable chart segments
													<Cell key={`cell-${index}`} fill={entry.color} />
												))}
											</Pie>
										</PieChart>
									</ResponsiveContainer>
									<div className="absolute flex flex-col items-center justify-center">
										<span className="text-sm font-semibold text-foreground font-mono">
											{total.toLocaleString()}
										</span>
										<span className="text-[9px] text-muted-foreground font-mono uppercase tracking-wider">
											Total
										</span>
									</div>
								</div>

								{/* Legends */}
								<div className="flex flex-col gap-2 mt-6 text-[11px] font-mono text-muted-foreground w-full">
									{typeChartData.map((item) => (
										<div key={item.name} className="flex items-center gap-2">
											<span
												className="size-2 rounded-full shrink-0"
												style={{ backgroundColor: item.color }}
											/>
											<span>
												{item.name} · {item.value.toLocaleString()} ·{" "}
												{Math.round((item.value / total) * 100)}%
											</span>
										</div>
									))}
								</div>
							</div>
						</div>
					</Card>
				</div>

				{/* AOV Trend Chart */}
				<Card className="border-[0.5px] border-border bg-card p-6 rounded-[12px] shadow-none flex flex-col gap-4">
					<div className="flex items-start justify-between gap-3">
						<div>
							<h3 className="text-sm font-medium text-foreground/80 font-mono uppercase tracking-wider">
								AOV trend
							</h3>
							<p className="text-xs text-muted-foreground mt-1">
								Track spending stability month by month for the selected
								customer cohort.
							</p>
						</div>
						<Badge
							className={`rounded-[4px] border font-mono text-[10px] px-1.5 py-0.5 ${aovTrend.status === "Increasing" ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" : aovTrend.status === "Decreasing" ? "bg-red-500/10 text-red-500 border-red-500/20" : "bg-muted/50 text-muted-foreground border-border"}`}
						>
							{aovTrend.status}
						</Badge>
					</div>
					<div className="h-[300px] w-full mt-4">
						<ResponsiveContainer width="100%" height="100%">
							<LineChart
								data={aovTrend.series}
								margin={{ top: 10, right: 10, left: -20, bottom: 5 }}
							>
								<CartesianGrid
									strokeDasharray="3 3"
									stroke="var(--border)"
									vertical={false}
								/>
								<XAxis
									dataKey="month"
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
								<RechartsTooltip
									contentStyle={{
										backgroundColor: "var(--popover)",
										borderColor: "var(--border)",
										borderRadius: "8px",
										color: "var(--popover-foreground)",
										fontSize: "11px",
									}}
									formatter={(v) => [`₹${v}`, "AOV"]}
								/>
								<Line
									type="monotone"
									dataKey="aov"
									stroke="var(--chart-1)"
									strokeWidth={2}
									dot={{ r: 4, strokeWidth: 0, fill: "var(--chart-1)" }}
									activeDot={{ r: 6 }}
								/>
							</LineChart>
						</ResponsiveContainer>
					</div>
				</Card>
			</div>

			{/* Customer Segment List */}
			<Card className="border-[0.5px] border-border bg-card rounded-[12px] shadow-none overflow-hidden">
				<CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between pb-4 border-b border-border">
					<div className="flex flex-col gap-1">
						<CardTitle className="text-sm font-semibold tracking-tight text-foreground font-mono">
							Customer Segment List
						</CardTitle>
						<CardDescription className="text-muted-foreground text-xs">
							Filtered customer list with recalculated health, segment, and
							customer type.
						</CardDescription>
					</div>

					<div className="flex items-center gap-3 w-full sm:w-auto">
						<div className="relative w-full sm:w-[220px]">
							<Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
							<Input
								placeholder="Search name or mobile"
								className="pl-9 h-9 text-xs w-full border-[0.5px] border-border text-foreground rounded-lg focus-visible:ring-0 focus-visible:ring-offset-0"
								value={searchQuery}
								onChange={(e) => {
									setSearchQuery(e.target.value);
									setCurrentPage(1);
								}}
							/>
						</div>
						<Button
							variant="outline"
							size="sm"
							onClick={handleExport}
							className="h-9 px-3 border-[0.5px] border-border text-xs text-foreground hover:bg-muted rounded-lg flex items-center gap-1.5 shrink-0"
						>
							<Download className="size-4" />
							Export PDF
						</Button>
					</div>
				</CardHeader>

				<div className="overflow-x-auto w-full">
					<Table className="min-w-[760px] border-collapse">
						<TableHeader className="border-b-[0.5px] border-border">
							<TableRow className="border-b-[0.5px] border-border bg-card/60 hover:bg-card/60">
								<TableHead className="font-semibold text-xs py-3 pl-4 text-muted-foreground font-mono h-10">
									Customer
								</TableHead>
								<TableHead className="font-semibold text-xs py-3 text-center text-muted-foreground font-mono h-10">
									Customer Type
								</TableHead>
								<TableHead className="font-semibold text-xs py-3 text-center text-muted-foreground font-mono h-10">
									Health Score
								</TableHead>
								<TableHead className="font-semibold text-xs py-3 text-center text-muted-foreground font-mono h-10">
									Segment
								</TableHead>
								<TableHead className="font-semibold text-xs py-3 text-right text-muted-foreground font-mono h-10">
									Last Purchase
								</TableHead>
								<TableHead className="font-semibold text-xs py-3 text-center pr-4 text-muted-foreground font-mono h-10">
									Actions
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{paginatedCustomers.length === 0 ? (
								<TableRow>
									<TableCell
										colSpan={6}
										className="h-32 text-center text-muted-foreground text-xs"
									>
										No customer records found.
									</TableCell>
								</TableRow>
							) : (
								paginatedCustomers.map((customer: CustomerHealthEntry) => (
									<TableRow
										key={getCustomerRowKey(customer)}
										className="border-b-[0.5px] border-border hover:bg-muted/30"
									>
										<TableCell className="py-3 pl-4">
											<div className="font-semibold text-xs text-foreground">
												{customer.customerName ?? "Valued Customer"}
											</div>
											<div className="text-[10px] text-muted-foreground font-mono mt-0.5">
												{customer.customerMobile ?? "—"}
											</div>
										</TableCell>
										<TableCell className="py-3 text-center">
											<Badge className="bg-gray-500/10 text-gray-600 dark:text-gray-400 hover:bg-gray-500/10 border-none text-[10px] rounded-full px-2 py-0.5">
												{(
													customer as CustomerHealthEntry & {
														customerType?: string;
													}
												).customerType ?? "Existing"}
											</Badge>
										</TableCell>
										<TableCell className="py-3 text-center">
											{getHealthBadge(customer.healthScore ?? 0)}
										</TableCell>
										<TableCell className="py-3 text-center">
											{getSegmentBadge(customer.segment ?? "Regular")}
										</TableCell>
										<TableCell className="font-mono text-xs py-3 text-right tabular-nums text-muted-foreground">
											{(customer.lastPurchaseDays ?? 0) === 0
												? "Today"
												: (customer.lastPurchaseDays ?? 0) === 1
													? "Yesterday"
													: `${customer.lastPurchaseDays ?? 0} Days`}
										</TableCell>
										<TableCell className="py-3 pr-4 text-center">
											<div className="flex items-center justify-center gap-1.5">
												<TooltipProvider>
													<Tooltip>
														<TooltipTrigger asChild>
															<button
																type="button"
																onClick={() =>
																	handleAction(
																		"View",
																		String(customer.customerMobile ?? ""),
																	)
																}
																className="p-1 rounded hover:bg-foreground/10 text-muted-foreground hover:text-foreground transition"
															>
																<CheckCircle className="size-3.5" />
															</button>
														</TooltipTrigger>
														<TooltipContent className="text-[10px] p-2">
															View Details
														</TooltipContent>
													</Tooltip>
												</TooltipProvider>
												<TooltipProvider>
													<Tooltip>
														<TooltipTrigger asChild>
															<button
																type="button"
																onClick={() =>
																	handleAction(
																		"WhatsApp",
																		String(customer.customerMobile ?? ""),
																	)
																}
																className="p-1 rounded hover:bg-emerald-500/10 text-emerald-500 hover:text-emerald-400 transition"
															>
																<Sparkles className="size-3.5" />
															</button>
														</TooltipTrigger>
														<TooltipContent className="text-[10px] p-2">
															WhatsApp Client
														</TooltipContent>
													</Tooltip>
												</TooltipProvider>
											</div>
										</TableCell>
									</TableRow>
								))
							)}
						</TableBody>
					</Table>
				</div>

				{/* Pagination Controls */}
				<div className="flex items-center justify-between px-6 py-4 border-t border-border bg-card/60">
					<div className="flex items-center gap-2 text-xs text-muted-foreground font-mono">
						<span>Rows per page:</span>
						<Select
							value={String(pageSize)}
							onValueChange={(val) => {
								setPageSize(Number(val));
								setCurrentPage(1);
							}}
						>
							<SelectTrigger className="w-[70px] h-8 text-xs rounded-lg focus:ring-0">
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
								enrichedCustomers.length,
								(currentPage - 1) * pageSize + 1,
							)}
							-{Math.min(enrichedCustomers.length, currentPage * pageSize)} of{" "}
							{enrichedCustomers.length}
						</span>
					</div>

					<div className="flex items-center gap-2">
						<Button
							variant="outline"
							size="sm"
							onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
							disabled={currentPage === 1}
							className="h-8 w-8 p-0 bg-card border-border rounded-lg text-muted-foreground hover:text-foreground disabled:opacity-50"
						>
							<ChevronLeft className="size-4" />
						</Button>
						<span className="text-xs text-muted-foreground font-mono">
							Page {currentPage} of {totalPages}
						</span>
						<Button
							variant="outline"
							size="sm"
							onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
							disabled={currentPage === totalPages}
							className="h-8 w-8 p-0 bg-card border-border rounded-lg text-muted-foreground hover:text-foreground disabled:opacity-50"
						>
							<ChevronRight className="size-4" />
						</Button>
					</div>
				</div>
			</Card>
		</div>
	);
}
