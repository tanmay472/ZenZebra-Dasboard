"use client";

import {
	ArrowUpRight,
	BarChart3,
	CheckCircle2,
	DollarSign,
	IndianRupee,
	Package,
	Receipt,
	Store,
	TrendingDown,
	TrendingUp,
} from "lucide-react";
import {
	Area,
	AreaChart,
	Bar,
	BarChart,
	CartesianGrid,
	Cell,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/utils";

// ── Types ────────────────────────────────────────────────────────────────

interface SummaryData {
	summary: {
		netPurchase: number;
		grossPurchase: number;
		tax: number;
		rowCount: number;
		earliestDate: string | null;
		latestDate: string | null;
	};
	byStore: Array<{ store: string; net_purchase: number; row_count: number }>;
	byCategory: Array<{
		category: string;
		net_purchase: number;
		row_count: number;
	}>;
}

interface TrendPoint {
	period: string;
	netPurchase: number;
	grossPurchase: number;
	tax: number;
}

interface ComparisonData {
	netPurchase: number;
	revenue: number;
	estimatedCogs: number;
	purchaseToRevenueRatio: number | null;
	purchaseToCOGSRatio: number | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────

// Grayscale-only chart palette (dashboard-wide chart color standard) — these
// reference the theme's --chart-1..5 tokens, which are ordered for maximum
// contrast against the current theme's background in both light and dark
// mode (see globals.css). No hue, so distinctness for the multi-series
// charts below also relies on line/dash/opacity, not color alone.
const CHART_COLORS = {
	primary: "var(--chart-1)",
	secondary: "var(--chart-2)",
	accent: "var(--chart-3)",
	muted: "var(--chart-4)",
	warning: "var(--chart-2)",
	danger: "var(--chart-1)",
};

const STORE_COLORS = [
	"var(--chart-1)",
	"var(--chart-2)",
	"var(--chart-3)",
	"var(--chart-4)",
	"var(--chart-5)",
	"var(--muted-foreground)",
];

function CustomTooltip({ active, payload, label }: any) {
	if (!active || !payload?.length) return null;
	return (
		<div className="rounded-lg border bg-popover/95 px-3 py-2 shadow-xl backdrop-blur-sm">
			<p className="mb-1 font-medium text-xs text-foreground">{label}</p>
			{payload.map((item: any) => (
				<p
					key={item.dataKey || item.name}
					className="text-xs"
					style={{ color: item.color }}
				>
					{item.name}: {formatCurrency(item.value, { noDecimals: true })}
				</p>
			))}
		</div>
	);
}

// ── Odoo Sync Badge Component ──────────────────────────────────────────────

function NetPurchaseSyncBadge() {
	return (
		<Badge
			variant="outline"
			className="gap-1.5 py-1 px-3 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
		>
			<CheckCircle2 className="size-3.5" />
			Odoo Live Ledger
		</Badge>
	);
}

// ── Main Dashboard Page ──────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { GlobalFilterBar } from "@/components/founder/global-filter-bar";
import { useStabilizedDashboard } from "@/hooks/use-stabilized-dashboard";
import { useFilterStore } from "@/stores/founder/filter-store";

export default function NetPurchaseDashboardPage() {
	const [status, setStatus] = useState<any>(null);
	const { startDate, endDate, store, category, brand, sku } = useFilterStore();

	useEffect(() => {
		const fetchStatus = async () => {
			try {
				const res = await fetch("/api/sales/status");
				const json = await res.json();
				if (json.success) setStatus(json.data);
			} catch (err) {
				console.error("Failed to fetch status", err);
			}
		};
		fetchStatus();
	}, []);

	const fetcher = async (signal: AbortSignal) => {
		const params = new URLSearchParams();
		if (startDate) params.set("startDate", startDate);
		if (endDate) params.set("endDate", endDate);
		if (store !== "ALL") params.set("store", store);
		if (category !== "All Categories") params.set("category", category);
		if (brand !== "All Brands") params.set("brand", brand);
		if (sku) params.set("sku", sku);

		const paramStr = params.toString();
		const [summaryRes, trendRes, comparisonRes] = await Promise.all([
			fetch(`/api/net-purchase/summary?${paramStr}`, { signal }),
			fetch(`/api/net-purchase/trends?${paramStr}`, { signal }),
			fetch(`/api/net-purchase/comparison?${paramStr}`, { signal }),
		]);

		const [summaryJson, trendJson, comparisonJson] = await Promise.all([
			summaryRes.json(),
			trendRes.json(),
			comparisonRes.json(),
		]);

		return {
			summaryData: summaryJson.success ? summaryJson.data : null,
			trendData: trendJson.success ? trendJson.data : [],
			comparisonData: comparisonJson.success ? comparisonJson.data : null,
		};
	};

	const { data, isInitialLoading, refetch } = useStabilizedDashboard({
		fetcher,
		dependencies: [startDate, endDate, store, category, brand, sku],
	});

	const summaryData = data?.summaryData ?? null;
	const trendData = data?.trendData ?? [];
	const comparisonData = data?.comparisonData ?? null;

	const hasData = (summaryData?.summary?.rowCount ?? 0) > 0;

	// ── Loading State ──────────────────────────────────────────────────
	if (!summaryData) {
		return (
			<div className="flex flex-col gap-6 p-4 pt-4 md:p-8">
				<div className="flex items-center justify-between">
					<div className="flex flex-col gap-1">
						<Skeleton className="h-8 w-64" />
						<Skeleton className="h-4 w-40" />
					</div>
					<Skeleton className="h-10 w-48" />
				</div>
				<div className="grid gap-4 md:grid-cols-3">
					{[1, 2, 3].map((i) => (
						<Skeleton key={i} className="h-32 rounded-xl" />
					))}
				</div>
				<div className="grid gap-4 md:grid-cols-2">
					<Skeleton className="h-72 rounded-xl" />
					<Skeleton className="h-72 rounded-xl" />
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-6 p-4 pt-4 md:p-8">
			{/* ── Header ──────────────────────────────────────────────── */}
			<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
				<div className="flex flex-col gap-1">
					<h1 className="font-bold text-3xl leading-none tracking-tight">
						Net Purchase
					</h1>
					<p className="text-muted-foreground text-sm">
						Finance-owned purchase ledger — independent module
					</p>
				</div>
				<div className="flex items-center gap-3">
					{hasData && (
						<Badge
							variant="outline"
							className="gap-1.5 border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
						>
							<CheckCircle2 className="size-3" />
							{summaryData?.summary.rowCount.toLocaleString()} records
						</Badge>
					)}
					<NetPurchaseSyncBadge />
				</div>
			</div>

			<GlobalFilterBar
				availableStores={status?.availableStores || []}
				availableCategories={status?.availableCategories || []}
				availableBrands={status?.availableBrands || []}
				categoryBrandMap={status?.categoryBrandMap || {}}
			/>

			{/* ── Empty State ──────────────────────────────────────────── */}
			{!hasData && (
				<Card className="border-dashed">
					<CardContent className="flex flex-col items-center justify-center py-16">
						<div className="mb-4 rounded-full bg-primary/10 p-4">
							<Receipt className="size-8 text-primary" />
						</div>
						<h3 className="mb-2 font-semibold text-lg">
							No Net Purchase Data Yet
						</h3>
						<p className="mb-6 max-w-md text-center text-muted-foreground text-sm">
							Upload the finance team&apos;s Net Purchase Excel to see purchase
							analytics, store breakdowns, and comparison charts.
						</p>
						<NetPurchaseSyncBadge />
					</CardContent>
				</Card>
			)}

			{/* ── KPI Cards ───────────────────────────────────────────── */}
			{hasData && summaryData && (
				<>
					<div className="grid gap-4 md:grid-cols-3">
						{/* Net Purchase Total */}
						<Card className="relative overflow-hidden">
							<div className="absolute inset-0 bg-gradient-to-br from-blue-500/5 to-indigo-500/10" />
							<CardHeader className="relative flex flex-row items-center justify-between pb-2">
								<CardTitle className="font-medium text-sm">
									Total Net Purchase
								</CardTitle>
								<div className="rounded-lg bg-blue-500/10 p-2">
									<IndianRupee className="size-4 text-blue-600" />
								</div>
							</CardHeader>
							<CardContent className="relative">
								<div className="font-bold text-2xl tracking-tight">
									{formatCurrency(summaryData.summary.netPurchase, {
										noDecimals: true,
									})}
								</div>
								<p className="mt-1 text-muted-foreground text-xs">
									Gross:{" "}
									{formatCurrency(summaryData.summary.grossPurchase, {
										noDecimals: true,
									})}
								</p>
							</CardContent>
						</Card>

						{/* Tax */}
						<Card className="relative overflow-hidden">
							<div className="absolute inset-0 bg-gradient-to-br from-amber-500/5 to-orange-500/10" />
							<CardHeader className="relative flex flex-row items-center justify-between pb-2">
								<CardTitle className="font-medium text-sm">
									Tax Component
								</CardTitle>
								<div className="rounded-lg bg-amber-500/10 p-2">
									<Receipt className="size-4 text-amber-600" />
								</div>
							</CardHeader>
							<CardContent className="relative">
								<div className="font-bold text-2xl tracking-tight">
									{formatCurrency(summaryData.summary.tax, {
										noDecimals: true,
									})}
								</div>
								<p className="mt-1 text-muted-foreground text-xs">
									{summaryData.summary.grossPurchase > 0
										? (
												(summaryData.summary.tax /
													summaryData.summary.grossPurchase) *
												100
											).toFixed(1)
										: "0.0"}
									% of gross purchase
								</p>
							</CardContent>
						</Card>

						{/* Purchase vs Revenue */}
						<Card className="relative overflow-hidden">
							<div className="absolute inset-0 bg-gradient-to-br from-emerald-500/5 to-teal-500/10" />
							<CardHeader className="relative flex flex-row items-center justify-between pb-2">
								<CardTitle className="font-medium text-sm">
									Purchase vs Revenue
								</CardTitle>
								<div className="rounded-lg bg-emerald-500/10 p-2">
									<ArrowUpRight className="size-4 text-emerald-600" />
								</div>
							</CardHeader>
							<CardContent className="relative">
								<div className="font-bold text-2xl tracking-tight">
									{comparisonData?.purchaseToRevenueRatio != null
										? `${comparisonData.purchaseToRevenueRatio}%`
										: "—"}
								</div>
								<p className="mt-1 text-muted-foreground text-xs">
									{comparisonData?.revenue
										? `Revenue: ${formatCurrency(comparisonData.revenue, { noDecimals: true })}`
										: "No revenue data available"}
								</p>
							</CardContent>
						</Card>
					</div>

					{/* ── Charts Row ────────────────────────────────────────── */}
					<div className="grid gap-4 lg:grid-cols-2">
						{/* Trend Chart */}
						<Card>
							<CardHeader>
								<CardTitle className="flex items-center gap-2 text-base">
									<TrendingUp className="size-4 text-primary" />
									Net Purchase Trend
								</CardTitle>
								<CardDescription>Monthly purchase amounts</CardDescription>
							</CardHeader>
							<CardContent>
								{trendData.length > 0 ? (
									<ResponsiveContainer width="100%" height={260}>
										<AreaChart data={trendData}>
											<defs>
												<linearGradient
													id="npGradient"
													x1="0"
													y1="0"
													x2="0"
													y2="1"
												>
													<stop
														offset="5%"
														stopColor={CHART_COLORS.primary}
														stopOpacity={0.3}
													/>
													<stop
														offset="95%"
														stopColor={CHART_COLORS.primary}
														stopOpacity={0}
													/>
												</linearGradient>
											</defs>
											<CartesianGrid
												strokeDasharray="3 3"
												className="stroke-muted/30"
											/>
											<XAxis
												dataKey="period"
												className="text-xs"
												tick={{ fill: "hsl(var(--muted-foreground))" }}
											/>
											<YAxis
												className="text-xs"
												tick={{ fill: "hsl(var(--muted-foreground))" }}
												tickFormatter={(v) => `₹${(v / 1000).toFixed(0)}K`}
											/>
											<Tooltip content={<CustomTooltip />} />
											<Area
												type="monotone"
												dataKey="netPurchase"
												name="Net Purchase"
												stroke={CHART_COLORS.primary}
												fill="url(#npGradient)"
												strokeWidth={2}
											/>
										</AreaChart>
									</ResponsiveContainer>
								) : (
									<div className="flex h-[260px] items-center justify-center text-muted-foreground text-sm">
										No trend data available
									</div>
								)}
							</CardContent>
						</Card>

						{/* Store Breakdown */}
						<Card>
							<CardHeader>
								<CardTitle className="flex items-center gap-2 text-base">
									<Store className="size-4 text-primary" />
									Net Purchase by Store
								</CardTitle>
								<CardDescription>Breakdown by store location</CardDescription>
							</CardHeader>
							<CardContent>
								{summaryData.byStore.length > 0 ? (
									<ResponsiveContainer width="100%" height={260}>
										<BarChart
											data={summaryData.byStore.map(
												(s: {
													store: string;
													net_purchase: number;
													row_count: number;
												}) => ({
													name:
														s.store?.length > 16
															? `${s.store.slice(0, 14)}…`
															: s.store,
													value: Number(s.net_purchase),
												}),
											)}
											layout="vertical"
										>
											<CartesianGrid
												strokeDasharray="3 3"
												className="stroke-muted/30"
												horizontal={false}
											/>
											<XAxis
												type="number"
												className="text-xs"
												tick={{ fill: "hsl(var(--muted-foreground))" }}
												tickFormatter={(v) => `₹${(v / 1000).toFixed(0)}K`}
											/>
											<YAxis
												dataKey="name"
												type="category"
												className="text-xs"
												tick={{ fill: "hsl(var(--muted-foreground))" }}
												width={120}
											/>
											<Tooltip content={<CustomTooltip />} />
											<Bar
												dataKey="value"
												name="Net Purchase"
												radius={[0, 6, 6, 0]}
											>
												{summaryData.byStore.map(
													(s: { store: string }, idx: number) => (
														<Cell
															key={s.store || `store-${idx}`}
															fill={STORE_COLORS[idx % STORE_COLORS.length]}
														/>
													),
												)}
											</Bar>
										</BarChart>
									</ResponsiveContainer>
								) : (
									<div className="flex h-[260px] items-center justify-center text-muted-foreground text-sm">
										No store data available
									</div>
								)}
							</CardContent>
						</Card>
					</div>

					{/* ── Category + Comparison Row ─────────────────────────── */}
					<div className="grid gap-4 lg:grid-cols-2">
						{/* Category Breakdown */}
						<Card>
							<CardHeader>
								<CardTitle className="flex items-center gap-2 text-base">
									<Package className="size-4 text-primary" />
									Net Purchase by Category
								</CardTitle>
								<CardDescription>
									Category-wise purchase distribution
								</CardDescription>
							</CardHeader>
							<CardContent>
								<div className="space-y-3">
									{summaryData.byCategory
										.slice(0, 8)
										.map(
											(
												cat: { category: string; net_purchase: number },
												idx: number,
											) => {
												const maxVal = Math.max(
													...summaryData.byCategory.map(
														(c: { net_purchase: number }) =>
															Number(c.net_purchase),
													),
												);
												const pct =
													maxVal > 0
														? (Number(cat.net_purchase) / maxVal) * 100
														: 0;
												return (
													<div key={cat.category} className="space-y-1.5">
														<div className="flex items-center justify-between">
															<span className="font-medium text-sm">
																{cat.category}
															</span>
															<span className="tabular-nums text-muted-foreground text-sm">
																{formatCurrency(Number(cat.net_purchase), {
																	noDecimals: true,
																})}
															</span>
														</div>
														<div className="h-2 overflow-hidden rounded-full bg-muted/30">
															<div
																className="h-full rounded-full transition-all duration-500"
																style={{
																	width: `${pct}%`,
																	background:
																		STORE_COLORS[idx % STORE_COLORS.length],
																}}
															/>
														</div>
													</div>
												);
											},
										)}
									{summaryData.byCategory.length === 0 && (
										<p className="py-8 text-center text-muted-foreground text-sm">
											No category data available
										</p>
									)}
								</div>
							</CardContent>
						</Card>

						{/* Purchase vs Revenue vs COGS */}
						<Card>
							<CardHeader>
								<CardTitle className="flex items-center gap-2 text-base">
									<BarChart3 className="size-4 text-primary" />
									Purchase vs Revenue vs COGS
								</CardTitle>
								<CardDescription>
									Finance cross-reference comparison
								</CardDescription>
							</CardHeader>
							<CardContent>
								{comparisonData ? (
									<div className="space-y-6 py-2">
										{[
											{
												label: "Net Purchase",
												value: comparisonData.netPurchase,
												color: CHART_COLORS.primary,
												icon: DollarSign,
											},
											{
												label: "Sales Revenue",
												value: comparisonData.revenue,
												color: CHART_COLORS.accent,
												icon: TrendingUp,
											},
											{
												label: "Estimated COGS",
												value: comparisonData.estimatedCogs,
												color: CHART_COLORS.warning,
												icon: TrendingDown,
											},
										].map((item) => {
											const maxVal = Math.max(
												comparisonData.netPurchase,
												comparisonData.revenue,
												comparisonData.estimatedCogs,
											);
											const pct = maxVal > 0 ? (item.value / maxVal) * 100 : 0;
											return (
												<div key={item.label} className="space-y-2">
													<div className="flex items-center justify-between">
														<div className="flex items-center gap-2">
															<item.icon
																className="size-4"
																style={{ color: item.color }}
															/>
															<span className="font-medium text-sm">
																{item.label}
															</span>
														</div>
														<span className="font-semibold tabular-nums text-sm">
															{formatCurrency(item.value, {
																noDecimals: true,
															})}
														</span>
													</div>
													<div className="h-3 overflow-hidden rounded-full bg-muted/20">
														<div
															className="h-full rounded-full transition-all duration-700"
															style={{
																width: `${pct}%`,
																background: `linear-gradient(90deg, ${item.color}, ${item.color}dd)`,
															}}
														/>
													</div>
												</div>
											);
										})}
										<div className="mt-4 grid grid-cols-2 gap-3">
											<div className="rounded-lg border bg-muted/10 p-3">
												<p className="text-muted-foreground text-xs">
													Purchase/Revenue
												</p>
												<p className="mt-1 font-bold text-lg tabular-nums">
													{comparisonData.purchaseToRevenueRatio != null
														? `${comparisonData.purchaseToRevenueRatio}%`
														: "—"}
												</p>
											</div>
											<div className="rounded-lg border bg-muted/10 p-3">
												<p className="text-muted-foreground text-xs">
													Purchase/COGS
												</p>
												<p className="mt-1 font-bold text-lg tabular-nums">
													{comparisonData.purchaseToCOGSRatio != null
														? `${comparisonData.purchaseToCOGSRatio}%`
														: "—"}
												</p>
											</div>
										</div>
									</div>
								) : (
									<div className="flex h-[260px] items-center justify-center text-muted-foreground text-sm">
										No comparison data available
									</div>
								)}
							</CardContent>
						</Card>
					</div>
				</>
			)}
		</div>
	);
}
