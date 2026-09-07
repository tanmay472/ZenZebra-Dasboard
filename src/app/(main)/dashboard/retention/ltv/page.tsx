"use client";

import { format } from "date-fns";
import {
	BarChart3,
	Percent,
	Search,
	Trophy,
	Upload,
	Users,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
	Bar,
	BarChart,
	CartesianGrid,
	Tooltip as ChartTooltip,
	ResponsiveContainer,
	XAxis,
	YAxis,
} from "recharts";
import { GlobalFilterBar } from "@/components/founder/global-filter-bar";
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
import { formatCurrency } from "@/lib/utils";

type LtvPageCustomer = {
	customerName?: string;
	customerMobile?: string | number;
	orders?: number;
	aov?: number;
	ltv?: number;
	retentionScore?: number;
};

type LtvPageStatus = {
	hasData?: boolean;
	availableCategories?: string[];
	availableBrands?: string[];
};

export default function LTVPage() {
	const router = useRouter();
	const [status, setStatus] = useState<LtvPageStatus | null>(null);
	const [searchQuery, setSearchQuery] = useState("");

	useEffect(() => {
		const fetchStatus = async () => {
			try {
				const res = await fetch("/api/sales/status");
				const json = await res.json();
				if (json.success) {
					setStatus(json.data);
				}
			} catch (err) {
				console.error("Failed to fetch status", err);
			}
		};
		fetchStatus();
	}, []);

	const hasData = status?.hasData ?? false;
	const { data, isLoading } = useLTV(hasData);

	const distribution = data?.distribution || [];
	const topCustomers = data?.topCustomers || [];

	const getCustomerRowKey = (cust: LtvPageCustomer) =>
		[
			cust.customerMobile ?? "unknown",
			cust.customerName ?? "unknown",
			cust.orders ?? "",
			cust.aov ?? "",
			cust.ltv ?? "",
			cust.retentionScore ?? "",
		].join("|");

	// Local filtering for top customers table
	const filteredCustomers = useMemo<LtvPageCustomer[]>(() => {
		if (!searchQuery) return topCustomers;
		const query = searchQuery.toLowerCase();
		return topCustomers.filter(
			(c: LtvPageCustomer) =>
				c.customerName?.toLowerCase().includes(query) ||
				String(c.customerMobile ?? "").includes(query),
		);
	}, [searchQuery, topCustomers]);

	// Calculate summary indicators
	const summaryStats = useMemo(() => {
		if (topCustomers.length === 0)
			return { avgTopLtv: 0, maxLtv: 0, highValueShare: 0 };
		const avgTopLtv = Math.round(
			topCustomers.reduce(
				(sum: number, c: LtvPageCustomer) => sum + (c.ltv ?? 0),
				0,
			) / topCustomers.length,
		);
		const maxLtv = topCustomers[0]?.ltv || 0;

		// Find % of top customers who have a retention score >= 70
		const loyalCount = topCustomers.filter(
			(c: LtvPageCustomer) => (c.retentionScore ?? 0) >= 75,
		).length;
		const highValueShare = Math.round((loyalCount / topCustomers.length) * 100);

		return { avgTopLtv, maxLtv, highValueShare };
	}, [topCustomers]);

	if (!status) {
		return (
			<div className="p-8">
				<Skeleton className="h-[400px] w-full animate-pulse" />
			</div>
		);
	}

	if (!status.hasData) {
		return (
			<div className="flex flex-col items-center justify-center min-h-[60vh] p-4 text-center space-y-6">
				<div className="bg-muted/30 p-8 rounded-full">
					<BarChart3 className="size-20 text-muted-foreground" />
				</div>
				<div className="max-w-md space-y-2">
					<h2 className="text-2xl font-bold">Welcome to ZenZebra</h2>
					<p className="text-muted-foreground">
						No data has been uploaded yet. Upload your first daily sales sheet
						to unlock insights.
					</p>
				</div>
				<Button
					size="lg"
					onClick={() => router.push("/dashboard/sales/upload")}
				>
					<Upload className="mr-2 size-5" />
					Upload Sales Data
				</Button>
			</div>
		);
	}

	const formattedDate = format(new Date(), "EEEE, do MMMM yyyy");

	// Color matching for retention score badges
	const getRetentionBadge = (score: number) => {
		if (score >= 75) {
			return (
				<Badge className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10 border-none font-semibold font-mono text-[10px] rounded-sm">
					{score} (VIP)
				</Badge>
			);
		}
		if (score >= 40) {
			return (
				<Badge className="bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10 border-none font-semibold font-mono text-[10px] rounded-sm">
					{score} (Stable)
				</Badge>
			);
		}
		return (
			<Badge className="bg-rose-500/10 text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 border-none font-semibold font-mono text-[10px] rounded-sm">
				{score} (At Risk)
			</Badge>
		);
	};

	return (
		<div className="flex flex-col gap-6 p-4 md:p-8 pt-4">
			{/* Title Section */}
			<div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
				<div className="flex flex-col gap-1">
					<h1 className="text-3xl font-bold leading-none tracking-tight">
						Customer LTV & AOV Analytics
					</h1>
					<p className="text-muted-foreground text-sm">{formattedDate}</p>
				</div>
				<div className="flex items-center gap-3">
					<Button
						variant="outline"
						onClick={() => router.push("/dashboard/sales/upload")}
					>
						<Upload className="mr-2 size-4" />
						Upload Data
					</Button>
				</div>
			</div>

			<GlobalFilterBar
				availableCategories={status.availableCategories || []}
				availableBrands={status.availableBrands || []}
			/>

			{isLoading || !data ? (
				<div className="grid gap-6 grid-cols-1 md:grid-cols-3 mt-2">
					<Skeleton className="h-[120px] rounded-2xl" />
					<Skeleton className="h-[120px] rounded-2xl" />
					<Skeleton className="h-[120px] rounded-2xl" />
					<Skeleton className="h-[300px] md:col-span-3 rounded-2xl" />
				</div>
			) : (
				<div className="flex flex-col gap-6">
					{/* Top Metrics Row */}
					<div className="grid gap-4 grid-cols-3">
						<MetricCard
							title="Top Customers Average LTV"
							value={formatCurrency(summaryStats.avgTopLtv, {
								noDecimals: true,
							})}
							comparisonLabel="Cohort size = 50"
							icon={Trophy}
						/>
						<MetricCard
							title="Highest Customer LTV"
							value={formatCurrency(summaryStats.maxLtv, { noDecimals: true })}
							comparisonLabel="Peak account size"
							icon={Users}
						/>
						<MetricCard
							title="Loyal VIP Ratio"
							value={`${summaryStats.highValueShare}%`}
							comparisonLabel="VIP retention scores >= 75"
							icon={Percent}
						/>
					</div>

					<div className="grid gap-6 grid-cols-1 lg:grid-cols-3 items-stretch">
						{/* LTV Distribution Histogram Chart */}
						<Card className="lg:col-span-3 border-white/10 bg-white/5 dark:bg-black/20 backdrop-blur-xl shadow-[0_8px_32px_rgba(0,0,0,0.08)]">
							<CardHeader>
								<CardTitle className="text-lg">
									Customer Value Distribution
								</CardTitle>
								<CardDescription>
									Histogram representing customer count distribution by LTV
									tiers
								</CardDescription>
							</CardHeader>
							<CardContent className="h-[260px] pb-4">
								{distribution.length === 0 ? (
									<div className="h-full flex items-center justify-center text-xs text-muted-foreground">
										No customer revenue distribution available.
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
												maxBarSize={60}
											/>
										</BarChart>
									</ResponsiveContainer>
								)}
							</CardContent>
						</Card>

						{/* Top LTV Customers DataTable */}
						<Card className="lg:col-span-3 border-white/10 bg-white/5 dark:bg-black/20 backdrop-blur-xl shadow-[0_8px_32px_rgba(0,0,0,0.08)] overflow-hidden">
							<CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between pb-4">
								<div className="flex flex-col gap-1">
									<CardTitle className="text-lg">
										Top 50 Lifetime Value Customers
									</CardTitle>
									<CardDescription>
										Enterprise accounts and high-value repeat retail buyers
										ranking.
									</CardDescription>
								</div>

								{/* Customer Search Bar */}
								<div className="relative w-full sm:w-[250px]">
									<Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
									<Input
										placeholder="Search name or mobile..."
										className="pl-9 h-9 border-white/10 bg-black/10 text-xs w-full focus:ring-0"
										value={searchQuery}
										onChange={(e) => setSearchQuery(e.target.value)}
									/>
								</div>
							</CardHeader>
							<CardContent className="p-0">
								<div className="overflow-x-auto w-full">
									<Table className="min-w-[700px] border-collapse">
										<TableHeader>
											<TableRow className="bg-white/5 border-b border-white/10 hover:bg-white/5">
												<TableHead className="font-semibold text-xs py-3 pl-4">
													Rank
												</TableHead>
												<TableHead className="font-semibold text-xs py-3">
													Customer Mobile
												</TableHead>
												<TableHead className="font-semibold text-xs py-3">
													Customer Name
												</TableHead>
												<TableHead className="font-semibold text-xs py-3 text-right">
													Orders
												</TableHead>
												<TableHead className="font-semibold text-xs py-3 text-right">
													AOV
												</TableHead>
												<TableHead className="font-semibold text-xs py-3 text-right">
													Total Spent
												</TableHead>
												<TableHead className="font-semibold text-xs py-3 text-center">
													Retention Score
												</TableHead>
											</TableRow>
										</TableHeader>
										<TableBody>
											{filteredCustomers.length === 0 ? (
												<TableRow>
													<TableCell
														colSpan={7}
														className="h-32 text-center text-muted-foreground text-xs"
													>
														No matching high LTV customers found.
													</TableCell>
												</TableRow>
											) : (
												filteredCustomers.map((cust: LtvPageCustomer) => (
													<TableRow
														key={getCustomerRowKey(cust)}
														className="hover:bg-white/5 border-b border-white/5"
													>
														<TableCell className="font-mono text-xs py-3 pl-4 text-muted-foreground">
															#
															{filteredCustomers.findIndex(
																(item) =>
																	item.customerMobile === cust.customerMobile,
															) + 1}
														</TableCell>
														<TableCell className="font-mono text-xs py-3">
															{cust.customerMobile}
														</TableCell>
														<TableCell className="font-semibold text-xs py-3">
															{cust.customerName}
														</TableCell>
														<TableCell className="font-mono text-xs py-3 text-right tabular-nums">
															{(cust.orders ?? 0).toLocaleString()}
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
															{getRetentionBadge(cust.retentionScore ?? 0)}
														</TableCell>
													</TableRow>
												))
											)}
										</TableBody>
									</Table>
								</div>
							</CardContent>
						</Card>
					</div>
				</div>
			)}
		</div>
	);
}
