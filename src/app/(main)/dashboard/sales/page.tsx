"use client";

import {
	BarChart3,
	Download,
	IndianRupee,
	Percent,
	ShoppingCart,
	Store,
	TrendingDown,
	TrendingUp,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { PolarAngleAxis, RadialBar, RadialBarChart } from "recharts";
import { DataFreshnessSystem } from "@/components/dashboard/data-freshness-system";
import {
	formatStoreName,
	GlobalFilterBar,
} from "@/components/founder/global-filter-bar";
import {
	AovAnalysisTable,
	BillCutAnalysisTable,
	BrandPerformanceTable,
	CustomerIntelligenceCard,
	DailyHealthTable,
	PaymentAnalysisCard,
	SkuPerformanceTable,
} from "@/components/founder/sales-dashboard-sections";
import { ConfidenceBadge } from "@/components/intelligence/ConfidenceBadge";
import { ContributionList } from "@/components/intelligence/ContributionList";
import { KPIExplanation } from "@/components/intelligence/KPIExplanation";
import { MetricBreakdown } from "@/components/intelligence/MetricBreakdown";
import { RecommendationPanel } from "@/components/intelligence/RecommendationPanel";
import { RootCausePopover } from "@/components/intelligence/RootCausePopover";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	type ChartConfig,
	ChartContainer,
	ChartTooltip,
} from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { exportToExcel } from "@/lib/export-excel";
import { formatSignedPercent } from "@/lib/growth-ui";
import { formatCurrency } from "@/lib/utils";
import { useFilterStore } from "@/stores/founder/filter-store";

/** Safely format a number to fixed decimal places; returns "0.0" on null/undefined/NaN. */
function safeFixed(value: number | null | undefined, digits = 1): string {
	const n = Number(value ?? 0);
	return Number.isFinite(n) ? n.toFixed(digits) : "0.0";
}

const CustomTooltip = ({ active, payload }: any) => {
	if (active && payload?.length) {
		const data = payload[0].payload;
		return (
			<div className="bg-popover border border-border p-2 rounded-md shadow-sm text-xs">
				<p className="font-semibold text-foreground">{data.name}</p>
				<p className="text-muted-foreground mt-0.5">Value: {data.display}</p>
			</div>
		);
	}
	return null;
};

const waterfallChartConfig = {
	mrpValue: {
		color: "var(--chart-1)",
		label: "MRP Value",
	},
	discount: {
		color: "var(--chart-5)",
		label: "Discount",
	},
	collection: {
		color: "var(--chart-3)",
		label: "Collection",
	},
	gst: {
		color: "var(--chart-2)",
		label: "GST Liability",
	},
	revenue: {
		color: "var(--chart-4)",
		label: "Net Revenue",
	},
} satisfies ChartConfig;

const EMPTY_STORE_KPI = {
	revenue: 0,
	revenueGrowth: 0,
	billCuts: 0,
	billCutsGrowth: 0,
	units: 0,
	aov: 0,
};

function _getStoreKpi(
	storePerformance: Array<{
		billedBy: string;
		revenue: number;
		revenueGrowth: number;
		billCuts: number;
		billCutsGrowth: number;
		units: number;
		aov: number;
	}>,
	billedBy: string,
) {
	return (
		storePerformance.find((s) => s.billedBy === billedBy) ?? EMPTY_STORE_KPI
	);
}

/**
 * Consolidated "why did revenue move" narrative — replaces what used to be two
 * independent, sometimes-disagreeing explanations (the revenueDriver banner and
 * the ad-hoc BusinessHealthInvestigation card). Purely a renderer: all reasoning
 * comes from data.rootCause, composed server-side by
 * src/lib/intelligence/root-cause-engine.ts from existing business-logic outputs.
 *
 * Sprint 2: rebuilt on the shared src/components/intelligence/* primitives so
 * this card and every KPI's Explain popover share one confidence/contribution
 * renderer instead of each having its own.
 */
function RootCauseCard({
	rootCause,
	skuName,
	sku,
}: {
	rootCause: any;
	skuName?: string | null;
	sku?: string;
}) {
	if (!rootCause) return null;
	const {
		revenue,
		storeContribution = [],
		topCategory,
		topBrand,
		topSku,
		confidence,
		confidenceFactors = [],
		recommendation,
	} = rootCause;
	const revenueDown = revenue.status === "Down";

	return (
		<Card>
			<CardHeader>
				<div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
					<div>
						<CardTitle>Why did revenue move?</CardTitle>
						<CardDescription>
							Root cause across stores, categories, brands, and SKUs
						</CardDescription>
					</div>
					<div className="flex items-center gap-2">
						<Badge
							className={
								revenueDown
									? "border-transparent bg-destructive/10 text-destructive"
									: "border-transparent bg-green-500/10 text-green-700 dark:bg-green-500/15 dark:text-green-300"
							}
						>
							Revenue {formatSignedPercent(revenue.growthPct)}
						</Badge>
						<ConfidenceBadge
							confidence={confidence}
							factors={confidenceFactors}
						/>
					</div>
				</div>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="rounded-lg border bg-muted/20 p-3">
					<p className="text-muted-foreground text-xs">Reason</p>
					<p className="mt-1 font-semibold">{revenue.explanation}</p>
				</div>

				<MetricBreakdown
					drivers={[
						{ label: "Revenue", value: revenue.growthPct },
						{ label: "Bill Cuts", value: revenue.billsGrowthPct },
						{ label: "AOV", value: revenue.aovGrowthPct },
					]}
				/>

				<div className="grid gap-3 sm:grid-cols-2">
					<ContributionList
						title="Store Contribution"
						emptyText="No store data"
						rows={storeContribution.map(
							(s: {
								billedBy: string;
								storeDisplayName: string;
								revenueGrowthPct: number | "NEW STORE";
							}) => ({
								key: s.billedBy,
								label: s.storeDisplayName,
								value: s.revenueGrowthPct,
							}),
						)}
					/>
					<ContributionList
						title="Top Movers"
						rows={[
							{
								key: "category",
								label: "Category",
								value: null,
								displayValue: topCategory?.category ?? "—",
							},
							{
								key: "brand",
								label: "Brand",
								value: null,
								displayValue: topBrand?.brand ?? "—",
							},
							{
								key: "sku",
								label: "SKU",
								value: null,
								displayValue: topSku?.itemName ?? "—",
							},
						]}
					/>
				</div>

				{recommendation && (
					<RecommendationPanel
						action={recommendation.action}
						reason={recommendation.reason}
						tier={recommendation.tier}
					/>
				)}

				{skuName && (
					<div className="border-t pt-3 text-sm">
						<span className="text-muted-foreground">Filtered SKU: </span>
						<span className="font-semibold">{skuName}</span>
						<span className="ml-1 font-mono text-xs text-muted-foreground">
							{sku}
						</span>
					</div>
				)}
			</CardContent>
		</Card>
	);
}

import { useStabilizedDashboard } from "@/hooks/use-stabilized-dashboard";

export default function SalesDashboardPage() {
	const router = useRouter();
	const [status, setStatus] = useState<any>(null);

	const {
		startDate,
		endDate,
		store,
		category,
		brand,
		sku,
		categoryScope,
		compareMode,
		compareStartDate,
		compareEndDate,
		setDataBounds,
	} = useFilterStore();

	useEffect(() => {
		const fetchStatus = async () => {
			try {
				const res = await fetch("/api/sales/status");
				const json = await res.json();
				if (json.success) {
					setStatus(json.data);
					if (json.data?.minDate && json.data?.maxDate) {
						setDataBounds(json.data.minDate, json.data.maxDate);
					}
				}
			} catch (err) {
				console.error("Failed to fetch status", err);
			}
		};

		fetchStatus();
	}, [setDataBounds]);

	const fetcher = async (signal: AbortSignal) => {
		const params = new URLSearchParams({ startDate, endDate });
		if (store !== "ALL") params.set("store", store);
		if (category !== "All Categories") params.set("category", category);
		if (brand !== "All Brands") params.set("brand", brand);
		if (sku) params.set("sku", sku);
		if (categoryScope !== "all") params.set("categoryScope", categoryScope);
		params.set("compareMode", compareMode);
		if (compareMode === "custom") {
			params.set("compareStartDate", compareStartDate);
			params.set("compareEndDate", compareEndDate);
		}

		const res = await fetch(`/api/sales/dashboard?${params.toString()}`, {
			cache: "no-store",
			signal,
		});
		if (res.status === 401) {
			window.location.href = "/login";
			return null;
		}
		const json = await res.json();
		if (json.success) {
			return json.data;
		} else if (
			json.error === "Unauthorized" ||
			json.message === "Unauthorized"
		) {
			window.location.href = "/login";
			return null;
		} else {
			throw new Error(json.error ?? "Failed to load dashboard data.");
		}
	};

	const { data, isInitialLoading, isRefreshing, error, refetch } =
		useStabilizedDashboard({
			fetcher,
			enabled: Boolean(status?.hasData),
			refreshInterval: 10000,
			dependencies: [
				status?.hasData,
				startDate,
				endDate,
				store,
				category,
				brand,
				sku,
				categoryScope,
				compareMode,
				compareStartDate,
				compareEndDate,
			],
		});

	if (!status) {
		return (
			<div className="p-8">
				<Skeleton className="h-[400px] w-full" />
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
						No data synced yet. Ensure Odoo SaaS background sync worker is
						running.
					</p>
				</div>
				<Button size="lg" onClick={() => router.push("/dashboard/inventory")}>
					<Store className="mr-2 size-5" />
					Open Inventory Dashboard
				</Button>
			</div>
		);
	}

	return (
		<div className="flex flex-col space-y-2 p-4 md:p-8 pt-4">
			<div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-2">
				<div>
					<h2 className="text-3xl font-bold tracking-tight">Sales Dashboard</h2>
					<p className="text-muted-foreground mt-1">
						System of Attention • Odoo SaaS Live Sync
					</p>
				</div>
				<div className="flex items-center gap-3">
					<DataFreshnessSystem />
					<Button
						size="lg"
						variant="outline"
						className="shadow-sm gap-2"
						onClick={() => router.push("/dashboard/inventory")}
					>
						<Store className="size-4" />
						Inventory Ops
					</Button>
				</div>
			</div>

			<GlobalFilterBar
				availableStores={status.availableStores || []}
				availableCategories={status.availableCategories || []}
				availableBrands={status.availableBrands || []}
				categoryBrandMap={status.categoryBrandMap || {}}
				skuName={data?.skuName}
			/>

			{error ? (
				<div className="flex flex-col items-center justify-center min-h-[40vh] p-4 text-center space-y-4">
					<div className="bg-destructive/10 p-6 rounded-full">
						<BarChart3 className="size-16 text-destructive" />
					</div>
					<div className="max-w-md space-y-2">
						<h2 className="text-xl font-bold">Couldn't load the dashboard</h2>
						<p className="text-muted-foreground text-sm">{error}</p>
					</div>
					<Button variant="outline" onClick={() => refetch()}>
						Retry
					</Button>
				</div>
			) : !data && isInitialLoading ? (
				<div className="space-y-4">
					<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
						{["revenue", "bill-cuts", "units", "aov", "discount"].map((key) => (
							<Skeleton key={key} className="h-32 rounded-xl" />
						))}
					</div>
					<div className="grid gap-4 md:grid-cols-3">
						{[1, 2, 3].map((key) => (
							<Skeleton key={key} className="h-44 rounded-xl" />
						))}
					</div>
				</div>
			) : (
				<>
					{/* 1. Daily Business Health (KPIs) */}
					<div className="grid gap-4 grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
						<Card>
							<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
								<CardTitle className="text-sm font-medium">
									Total Revenue
								</CardTitle>
								<IndianRupee className="size-4 text-muted-foreground" />
							</CardHeader>
							<CardContent>
								<div className="text-2xl font-bold">
									{formatCurrency(data.salesKpis.revenue.current)}
								</div>
								<p
									className={`text-xs mt-1 flex items-center ${data.salesKpis.revenue.growth >= 0 ? "text-status-on-track" : "text-status-delayed"}`}
								>
									{data.salesKpis.revenue.growth >= 0 ? (
										<TrendingUp className="mr-1 size-3" />
									) : (
										<TrendingDown className="mr-1 size-3" />
									)}
									{data.salesKpis.revenue.growth > 0 ? "+" : ""}
									{safeFixed(data.salesKpis.revenue.growth)}% vs prev
								</p>
							</CardContent>
						</Card>
						<Card>
							<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
								<CardTitle className="text-sm font-medium">Bill Cuts</CardTitle>
								<div className="flex items-center gap-1">
									{data.explanations?.bills && (
										<RootCausePopover title="Bill Cuts">
											<KPIExplanation
												reason={data.explanations.bills.explanation}
												drivers={[
													{
														label: "Bill Cuts",
														value: data.explanations.bills.growthPct,
													},
													{
														label: "Customers",
														value: data.explanations.bills.customerGrowthPct,
													},
												]}
												contributionSections={[
													{
														title: "Store Mix",
														rows: data.explanations.bills.storeMix.map(
															(s: {
																billedBy: string;
																storeDisplayName: string;
																billCutsGrowthPct: number | "NEW STORE";
															}) => ({
																key: s.billedBy,
																label: s.storeDisplayName,
																value: s.billCutsGrowthPct,
															}),
														),
													},
												]}
											/>
										</RootCausePopover>
									)}
									<ShoppingCart className="size-4 text-muted-foreground" />
								</div>
							</CardHeader>
							<CardContent>
								<div className="text-2xl font-bold">
									{data.salesKpis.billCuts.current.toLocaleString()}
								</div>
								<p
									className={`text-xs mt-1 flex items-center ${data.salesKpis.billCuts.growth >= 0 ? "text-status-on-track" : "text-status-delayed"}`}
								>
									{data.salesKpis.billCuts.growth >= 0 ? (
										<TrendingUp className="mr-1 size-3" />
									) : (
										<TrendingDown className="mr-1 size-3" />
									)}
									{data.salesKpis.billCuts.growth > 0 ? "+" : ""}
									{safeFixed(data.salesKpis.billCuts.growth)}% vs prev
								</p>
							</CardContent>
						</Card>
						<Card>
							<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
								<CardTitle className="text-sm font-medium">
									Units Sold
								</CardTitle>
								<BarChart3 className="size-4 text-muted-foreground" />
							</CardHeader>
							<CardContent>
								<div className="text-2xl font-bold">
									{data.salesKpis.unitsSold.current.toLocaleString()}
								</div>
								<p
									className={`text-xs mt-1 flex items-center ${data.salesKpis.unitsSold.growth >= 0 ? "text-status-on-track" : "text-status-delayed"}`}
								>
									{data.salesKpis.unitsSold.growth >= 0 ? (
										<TrendingUp className="mr-1 size-3" />
									) : (
										<TrendingDown className="mr-1 size-3" />
									)}
									{data.salesKpis.unitsSold.growth > 0 ? "+" : ""}
									{safeFixed(data.salesKpis.unitsSold.growth)}% vs prev
								</p>
							</CardContent>
						</Card>
						<Card>
							<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
								<CardTitle className="text-sm font-medium">
									Average Order Value
								</CardTitle>
								<div className="flex items-center gap-1">
									{data.explanations?.aov && (
										<RootCausePopover title="Average Order Value">
											<KPIExplanation
												reason={data.explanations.aov.explanation}
												drivers={[
													{
														label: "AOV",
														value: data.explanations.aov.growthPct,
													},
												]}
												contributionSections={[
													{
														title: "Category Mix",
														rows: [
															{
																key: "category",
																label:
																	data.explanations.aov.topCategory?.category ??
																	"—",
																value:
																	data.explanations.aov.topCategory
																		?.aovGrowthPct ?? null,
															},
														],
													},
													{
														title: "Top Customers",
														rows: data.explanations.aov.topCustomers.map(
															(
																c: { label: string; revenue: number },
																index: number,
															) => ({
																key: `${index}-${c.label}`,
																label: c.label,
																value: null,
																displayValue: formatCurrency(c.revenue),
															}),
														),
													},
												]}
											/>
										</RootCausePopover>
									)}
									<TrendingUp className="size-4 text-muted-foreground" />
								</div>
							</CardHeader>
							<CardContent>
								<div className="text-2xl font-bold">
									{formatCurrency(data.aovKpi.current)}
								</div>
								<p
									className={`text-xs mt-1 flex items-center ${data.aovKpi.growth >= 0 ? "text-status-on-track" : "text-status-delayed"}`}
								>
									{data.aovKpi.growth >= 0 ? (
										<TrendingUp className="mr-1 size-3" />
									) : (
										<TrendingDown className="mr-1 size-3" />
									)}
									{data.aovKpi.growth > 0 ? "+" : ""}
									{safeFixed(data.aovKpi.growth)}% vs prev
								</p>
							</CardContent>
						</Card>
						<Card>
							<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
								<CardTitle className="text-sm font-medium">
									Discount Given
								</CardTitle>
								<Percent className="size-4 text-muted-foreground" />
							</CardHeader>
							<CardContent>
								<div className="text-2xl font-bold">
									{formatCurrency(data.salesKpis.discount.current)}
								</div>
								<p
									className={`text-xs mt-1 flex items-center ${data.salesKpis.discount.growth >= 0 ? "text-status-on-track" : "text-status-delayed"}`}
								>
									{data.salesKpis.discount.growth >= 0 ? (
										<TrendingUp className="mr-1 size-3" />
									) : (
										<TrendingDown className="mr-1 size-3" />
									)}
									{data.salesKpis.discount.growth > 0 ? "+" : ""}
									{safeFixed(data.salesKpis.discount.growth)}% vs prev
								</p>
							</CardContent>
						</Card>
					</div>

					{/* 1.5 Financial Operations Analysis & Waterfall Chart */}
					<div className="grid gap-4 md:grid-cols-3 mt-4">
						{/* Collection vs Revenue Card */}
						<Card className="flex flex-col">
							<CardHeader className="pb-2">
								<CardTitle className="text-sm font-semibold text-muted-foreground">
									Collection vs Revenue
								</CardTitle>
							</CardHeader>
							<CardContent className="flex-1 flex flex-col justify-between">
								<div>
									<div className="text-3xl font-bold">
										{formatCurrency(data.salesKpis.collection.current)}
									</div>
									<p className="text-xs text-muted-foreground mt-0.5">
										Gross Collection (GST Inclusive)
									</p>
								</div>
								<div className="mt-4 pt-4 border-t space-y-2 text-sm">
									<div className="flex justify-between items-center">
										<span className="text-muted-foreground text-xs">
											Net Revenue (Taxable)
										</span>
										<span className="font-semibold">
											{formatCurrency(data.salesKpis.revenue.current)}
										</span>
									</div>
									<div className="flex justify-between items-center">
										<span className="text-muted-foreground text-xs">
											GST Liability
										</span>
										<span className="font-medium text-muted-foreground">
											{formatCurrency(data.salesKpis.gst.current)}
										</span>
									</div>
								</div>
							</CardContent>
						</Card>

						{/* Discount Impact Card */}
						<Card className="flex flex-col">
							<CardHeader className="pb-2">
								<CardTitle className="text-sm font-semibold text-muted-foreground">
									Discount Impact
								</CardTitle>
							</CardHeader>
							<CardContent className="flex-1 flex flex-col justify-between">
								<div>
									<div className="text-3xl font-bold">
										{safeFixed(
											data.salesKpis.mrp.current > 0
												? (data.salesKpis.discount.current /
														data.salesKpis.mrp.current) *
														100
												: 0,
											1,
										)}
										%
									</div>
									<p className="text-xs text-muted-foreground mt-0.5">
										Effective Discount Rate on MRP
									</p>
								</div>
								<div className="mt-4 pt-4 border-t space-y-2 text-sm">
									<div className="flex justify-between items-center">
										<span className="text-muted-foreground text-xs">
											Discount Value
										</span>
										<span className="font-semibold">
											{formatCurrency(data.salesKpis.discount.current)}
										</span>
									</div>
									<div className="flex justify-between items-center">
										<span className="text-muted-foreground text-xs">
											Total MRP Value
										</span>
										<span className="font-medium text-muted-foreground">
											{formatCurrency(data.salesKpis.mrp.current)}
										</span>
									</div>
								</div>
							</CardContent>
						</Card>

						{/* Deduction Waterfall Card */}
						<Card className="flex flex-col">
							<CardHeader className="pb-2">
								<CardTitle className="text-sm font-semibold text-muted-foreground">
									Deduction Waterfall
								</CardTitle>
								<CardDescription className="text-xs">
									Share of MRP Value retained at each stage
								</CardDescription>
							</CardHeader>
							<CardContent className="flex-1 pt-0">
								{(() => {
									const mrp = data.salesKpis.mrp.current || 0;
									const pctOfMrp = (value: number) =>
										mrp > 0 ? (value / mrp) * 100 : 0;
									const rings = [
										{
											name: "Collection",
											amount: data.salesKpis.collection.current,
											value: pctOfMrp(data.salesKpis.collection.current),
											fill: "var(--chart-3)",
										},
										{
											name: "Net Revenue",
											amount: data.salesKpis.revenue.current,
											value: pctOfMrp(data.salesKpis.revenue.current),
											fill: "var(--chart-4)",
										},
										{
											name: "GST Liability",
											amount: data.salesKpis.gst.current,
											value: pctOfMrp(data.salesKpis.gst.current),
											fill: "var(--chart-2)",
										},
										{
											name: "Discount",
											amount: data.salesKpis.discount.current,
											value: pctOfMrp(data.salesKpis.discount.current),
											fill: "var(--chart-5)",
										},
									].map((ring) => ({
										...ring,
										display: formatCurrency(ring.amount),
									}));

									return (
										<div className="flex h-full flex-col xl:flex-row items-center justify-center gap-4 xl:gap-6 py-2">
											<ChartContainer
												config={waterfallChartConfig}
												className="aspect-square h-[140px] w-[140px] shrink-0"
											>
												<RadialBarChart
													data={rings}
													innerRadius="30%"
													outerRadius="100%"
													startAngle={90}
													endAngle={-270}
												>
													<PolarAngleAxis
														type="number"
														domain={[0, 100]}
														angleAxisId={0}
														tick={false}
													/>
													<ChartTooltip content={<CustomTooltip />} />
													<RadialBar
														dataKey="value"
														background={{ fill: "var(--muted)" }}
														cornerRadius={6}
													/>
												</RadialBarChart>
											</ChartContainer>
											<div className="w-full flex-1 space-y-1.5 text-[11px] xl:text-xs">
												<div className="flex items-center justify-between gap-2 border-b pb-1 font-medium">
													<div className="flex min-w-0 items-center gap-1.5">
														<span className="size-2 shrink-0 rounded-full bg-muted-foreground/40" />
														<span className="truncate text-muted-foreground">
															MRP Value
														</span>
													</div>
													<div className="flex shrink-0 items-center gap-2">
														<span className="font-semibold">
															{formatCurrency(mrp)}
														</span>
														<span className="text-muted-foreground">100%</span>
													</div>
												</div>
												{rings.map((ring) => (
													<div
														key={ring.name}
														className="flex items-center justify-between gap-2"
													>
														<div className="flex min-w-0 items-center gap-1.5">
															<span
																className="size-2 shrink-0 rounded-full"
																style={{ backgroundColor: ring.fill }}
															/>
															<span className="truncate text-muted-foreground">
																{ring.name}
															</span>
														</div>
														<div className="flex shrink-0 items-center gap-2">
															<span className="font-semibold">
																{ring.display}
															</span>
															<span className="text-muted-foreground">
																{safeFixed(ring.value, 0)}%
															</span>
														</div>
													</div>
												))}
											</div>
										</div>
									);
								})()}
							</CardContent>
						</Card>
					</div>

					{/* Store KPI Split cards */}
					{data.storePerformance && (
						<div className="grid gap-4 md:grid-cols-2 mt-4">
							{data.storePerformance.map((storeKpi: any) => {
								const storeName = storeKpi.billedBy;
								const displayName = `${formatStoreName(storeName)} KPIs`;

								return (
									<Card key={storeName} className="border-border bg-card/40">
										<CardHeader className="pb-3">
											<CardTitle className="text-sm font-semibold flex items-center justify-between">
												<span>{displayName}</span>
												<span className="text-xs font-normal text-muted-foreground">
													Store Performance
												</span>
											</CardTitle>
										</CardHeader>
										<CardContent className="grid grid-cols-2 gap-3">
											<div className="bg-muted/30 p-3 rounded-lg border">
												<p className="text-xs text-muted-foreground">Revenue</p>
												<p className="text-lg font-bold mt-1">
													{formatCurrency(storeKpi.revenue)}
												</p>
												<p
													className={`text-xs mt-0.5 flex items-center ${storeKpi.revenueGrowth >= 0 ? "text-status-on-track" : "text-status-delayed"}`}
												>
													{storeKpi.revenueGrowth >= 0 ? (
														<TrendingUp className="mr-1 size-3" />
													) : (
														<TrendingDown className="mr-1 size-3" />
													)}
													{storeKpi.revenueGrowth > 0 ? "+" : ""}
													{safeFixed(storeKpi.revenueGrowth)}% vs prev
												</p>
											</div>
											<div className="bg-muted/30 p-3 rounded-lg border">
												<p className="text-xs text-muted-foreground">
													Bill Cuts
												</p>
												<p className="text-lg font-bold mt-1">
													{storeKpi.billCuts.toLocaleString()}
												</p>
												<p
													className={`text-xs mt-0.5 flex items-center ${storeKpi.billCutsGrowth >= 0 ? "text-status-on-track" : "text-status-delayed"}`}
												>
													{storeKpi.billCutsGrowth >= 0 ? (
														<TrendingUp className="mr-1 size-3" />
													) : (
														<TrendingDown className="mr-1 size-3" />
													)}
													{storeKpi.billCutsGrowth > 0 ? "+" : ""}
													{safeFixed(storeKpi.billCutsGrowth)}% vs prev
												</p>
											</div>
											<div className="bg-muted/30 p-3 rounded-lg border">
												<p className="text-xs text-muted-foreground">AOV</p>
												<p className="text-lg font-bold mt-1">
													{formatCurrency(storeKpi.aov)}
												</p>
											</div>
											<div className="bg-muted/30 p-3 rounded-lg border">
												<p className="text-xs text-muted-foreground">
													Units Sold
												</p>
												<p className="text-lg font-bold mt-1">
													{storeKpi.units.toLocaleString()}
												</p>
											</div>
										</CardContent>
									</Card>
								);
							})}
						</div>
					)}

					{/* Store Comparison */}
					{data.storePerformance && data.storePerformance.length > 0 && (
						<Card>
							<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
								<div>
									<CardTitle>Store Comparison</CardTitle>
									<CardDescription>
										<span>Which store is carrying the business?</span>
										{data.periods?.label && (
											<span className="block text-xs text-muted-foreground/80 mt-0.5">
												Compared: {data.periods.label}
											</span>
										)}
									</CardDescription>
								</div>
								<div className="flex items-center gap-2">
									<Button
										variant="outline"
										size="sm"
										className="h-8 gap-1.5 text-xs shadow-sm hover:bg-accent"
										onClick={() => {
											const exportData = data.storePerformance.map(
												(row: any) => ({
													Store: row.storeDisplayName,
													Revenue: row.revenue,
													"Growth (%)": row.revenueGrowth,
													"Contribution (%)": row.contributionPercent,
													"Bill Cuts": row.billCuts,
													AOV: row.aov,
												}),
											);
											exportToExcel(exportData, "Store_Comparison", "Stores");
										}}
									>
										<Download className="h-3.5 w-3.5" />
										Export Excel
									</Button>
									<Store className="size-5 text-muted-foreground" />
								</div>
							</CardHeader>
							<CardContent>
								<div className="overflow-x-auto">
									<table className="w-full text-sm text-left min-w-[700px]">
										<thead className="text-xs text-muted-foreground uppercase bg-muted/50 border-b">
											<tr>
												<th className="px-4 py-3 font-medium">Store</th>
												<th className="px-4 py-3 font-medium text-right">
													Revenue
												</th>
												<th className="px-4 py-3 font-medium text-right">
													Growth
												</th>
												<th className="px-4 py-3 font-medium text-right">
													Contribution
												</th>
												<th className="px-4 py-3 font-medium text-right">
													Bill Cuts
												</th>
												<th className="px-4 py-3 font-medium text-right">
													AOV
												</th>
											</tr>
										</thead>
										<tbody>
											{data.storePerformance.map(
												(storeRow: {
													billedBy: string;
													storeDisplayName: string;
													revenue: number;
													revenueGrowth: number;
													contributionPercent: number;
													billCuts: number;
													aov: number;
												}) => (
													<tr
														key={storeRow.billedBy}
														className="border-b last:border-0 hover:bg-muted/20 transition-colors"
													>
														<td className="px-4 py-3 font-medium">
															{storeRow.storeDisplayName}
														</td>
														<td className="px-4 py-3 text-right font-semibold">
															{formatCurrency(storeRow.revenue)}
														</td>
														<td
															className={`px-4 py-3 text-right ${storeRow.revenueGrowth >= 0 ? "text-status-on-track" : "text-status-delayed"}`}
														>
															{storeRow.revenueGrowth > 0 ? "+" : ""}
															{safeFixed(storeRow.revenueGrowth)}%
														</td>
														<td className="px-4 py-3 text-right">
															<div className="flex items-center justify-end gap-2">
																<span>
																	{safeFixed(storeRow.contributionPercent)}%
																</span>
																<div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
																	<div
																		className="h-full bg-primary"
																		style={{
																			width: `${storeRow.contributionPercent}%`,
																		}}
																	/>
																</div>
															</div>
														</td>
														<td className="px-4 py-3 text-right">
															{storeRow.billCuts.toLocaleString()}
														</td>
														<td className="px-4 py-3 text-right">
															{formatCurrency(storeRow.aov)}
														</td>
													</tr>
												),
											)}
										</tbody>
									</table>
								</div>
							</CardContent>
						</Card>
					)}

					<div className="grid gap-4 md:grid-cols-2">
						{data.brandPerformance && (
							<BrandPerformanceTable
								data={data.brandPerformance}
								comparisonLabel={data.comparisonLabel}
							/>
						)}
						{data.skuPerformance && (
							<SkuPerformanceTable
								data={data.skuPerformance}
								comparisonLabel={data.comparisonLabel}
							/>
						)}
						{data.billCutAnalysis && (
							<BillCutAnalysisTable
								data={data.billCutAnalysis}
								comparisonLabel={data.comparisonLabel}
							/>
						)}
						{data.aovAnalysis && (
							<AovAnalysisTable
								data={data.aovAnalysis}
								comparisonLabel={data.comparisonLabel}
							/>
						)}
						{data.customerIntelligence && (
							<CustomerIntelligenceCard
								data={data.customerIntelligence}
								comparisonLabel={data.comparisonLabel}
							/>
						)}
						{data.paymentAnalysis && (
							<PaymentAnalysisCard
								data={data.paymentAnalysis}
								comparisonLabel={data.comparisonLabel}
							/>
						)}
					</div>

					<div className="w-full max-w-sm">
						{/* Sales Coverage Calendar */}
						<Card>
							<CardHeader>
								<CardTitle>Sales Coverage Calendar</CardTitle>
								<CardDescription>
									Data coverage between min and max sale dates
								</CardDescription>
							</CardHeader>
							<CardContent className="flex justify-center pb-6">
								<Calendar
									mode="range"
									selected={{
										from: status?.minDate
											? new Date(status.minDate)
											: undefined,
										to: status?.maxDate ? new Date(status.maxDate) : undefined,
									}}
									defaultMonth={
										status?.maxDate ? new Date(status.maxDate) : new Date()
									}
									className="rounded-md border shadow-sm pointer-events-none"
								/>
							</CardContent>
						</Card>
					</div>

					<RootCauseCard
						rootCause={data.rootCause}
						skuName={data.skuName}
						sku={sku}
					/>

					{data.dailyHealth && (
						<DailyHealthTable
							metrics={data.dailyHealth}
							comparisonLabel={data.comparisonLabel}
						/>
					)}
				</>
			)}
		</div>
	);
}
