"use client";

import { Filter, HelpCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatCurrency } from "@/lib/utils";
import { useFilterStore } from "@/stores/founder/filter-store";

type CohortMetricType = "retention" | "revenue" | "aov" | "billCuts";

export function CohortsTab({ hasData }: { hasData: boolean }) {
	const [selectedMetric, setSelectedMetric] =
		useState<CohortMetricType>("retention");

	// Local cohort filters
	const [customerType, setCustomerType] = useState<string>("all");
	const [billRangeFilter, setBillRangeFilter] = useState<string>("all");

	// sku intentionally excluded: SKU-level filtering isn't supported for
	// Cohort Analysis — see GlobalFilterBar's skuDisabledReason on this tab.
	const { startDate, endDate, store, category, brand, categoryScope } =
		useFilterStore();
	const [dataPayload, setDataPayload] = useState<any>(null);
	const [isLoading, setIsLoading] = useState(true);

	useEffect(() => {
		if (!hasData) return;

		const fetchData = async () => {
			setIsLoading(true);
			try {
				const params = new URLSearchParams({
					startDate,
					endDate,
					customerType,
					billRange: billRangeFilter,
				});
				if (store !== "ALL") params.set("store", store);
				if (category && category !== "All Categories")
					params.set("category", category);
				if (brand && brand !== "All Brands") params.set("brand", brand);
				if (categoryScope !== "all") params.set("categoryScope", categoryScope);

				const res = await fetch(
					`/api/customer-retention/cohorts?${params.toString()}`,
				);
				const json = await res.json();
				if (json.success) {
					setDataPayload(json.data);
				}
			} catch (err) {
				console.error("Failed to fetch cohorts data", err);
			} finally {
				setIsLoading(false);
			}
		};

		fetchData();
	}, [
		hasData,
		startDate,
		endDate,
		store,
		category,
		brand,
		categoryScope,
		customerType,
		billRangeFilter,
	]);

	const data = dataPayload?.cohorts || [];
	const billCuts = dataPayload?.billCuts || [];

	const limits = useMemo(() => {
		if (!data || data.length === 0)
			return { maxRevenue: 1, maxAov: 1, maxBillCuts: 1 };

		let maxRevenue = 1;
		let maxAov = 1;
		let maxBillCuts = 1;

		for (const cohort of data) {
			for (const m of cohort.months) {
				if (m.revenue > maxRevenue) maxRevenue = m.revenue;
				if (m.aov > maxAov) maxAov = m.aov;
				if (m.billCuts > maxBillCuts) maxBillCuts = m.billCuts;
			}
		}

		return { maxRevenue, maxAov, maxBillCuts };
	}, [data]);

	// Header summary stats (derived from already-fetched cohort data, M1 = first retention checkpoint)
	const summaryStats = useMemo(() => {
		if (!data || data.length === 0) {
			return {
				totalCustomers: 0,
				avgM1Retention: 0,
				strongestLabel: "—",
				weakestLabel: "—",
			};
		}

		const totalCustomers = data.reduce(
			(sum: number, c: any) => sum + (c.cohortCustomers || 0),
			0,
		);

		const withM1 = data
			.map((c: any) => ({
				label: c.cohortLabel,
				m1: c.months.find((m: any) => m.monthIndex === 1),
			}))
			.filter((c: any) => c.m1 && c.m1.activeCustomers > 0);

		const avgM1Retention =
			withM1.length > 0
				? Math.round(
						(withM1.reduce(
							(sum: number, c: any) => sum + c.m1.retentionPct,
							0,
						) /
							withM1.length) *
							10,
					) / 10
				: 0;

		let strongest = withM1[0] ?? null;
		let weakest = withM1[0] ?? null;
		for (const c of withM1) {
			if (c.m1.retentionPct > (strongest?.m1.retentionPct ?? -Infinity))
				strongest = c;
			if (c.m1.retentionPct < (weakest?.m1.retentionPct ?? Infinity))
				weakest = c;
		}

		return {
			totalCustomers,
			avgM1Retention,
			strongestLabel: strongest?.label ?? "—",
			weakestLabel: weakest?.label ?? "—",
		};
	}, [data]);

	if (isLoading || !dataPayload) {
		return (
			<div className="flex flex-col gap-6 mt-2">
				<Skeleton className="h-[40px] w-full rounded-lg" />
				<Skeleton className="h-[350px] w-full rounded-2xl" />
				<Skeleton className="h-[200px] w-full rounded-2xl" />
			</div>
		);
	}

	const renderCell = (_cohortCustomers: number, m: any) => {
		if (!m || m.activeCustomers === 0) {
			return (
				<TableCell
					key={m?.monthIndex ?? Math.random()}
					className="text-center text-muted-foreground font-mono text-[11px] p-2 md:p-3 border-r border-border bg-muted/20"
				>
					-
				</TableCell>
			);
		}

		let valueText = "";
		let textStyle = {};
		let pillClass = "";

		if (selectedMetric === "retention") {
			const pct = m.retentionPct;
			valueText = `${pct}%`;

			// Same thresholds as before (100% Dark Green, 70% Green, 50% Yellow, 20% Red) — now rendered as a pill badge
			if (pct >= 80) {
				pillClass = "bg-emerald-500 text-foreground";
			} else if (pct >= 60) {
				pillClass = "bg-emerald-400 text-emerald-950";
			} else if (pct >= 40) {
				pillClass = "bg-amber-400 text-amber-950";
			} else {
				pillClass = "bg-rose-500 text-foreground";
			}

			return (
				<TableCell
					key={m.monthIndex}
					className="text-center font-mono text-[11px] p-2 md:p-3 border-r border-border"
				>
					<span
						className={`inline-block min-w-[52px] px-2.5 py-1 rounded-full font-bold ${pillClass}`}
					>
						{valueText}
					</span>
				</TableCell>
			);
		}

		if (selectedMetric === "revenue") {
			valueText = formatCurrency(m.revenue, { noDecimals: true });
			const opacity = Math.min(1, Math.max(0.1, m.revenue / limits.maxRevenue));
			textStyle = {
				backgroundColor: `rgba(16, 185, 129, ${opacity * 0.55})`,
				color: "var(--foreground)",
				fontWeight: opacity > 0.5 ? "600" : "500",
			};
		} else if (selectedMetric === "aov") {
			valueText = formatCurrency(m.aov, { noDecimals: true });
			const opacity = Math.min(1, Math.max(0.1, m.aov / limits.maxAov));
			textStyle = {
				backgroundColor: `rgba(99, 102, 241, ${opacity * 0.55})`,
				color: "var(--foreground)",
				fontWeight: opacity > 0.5 ? "600" : "500",
			};
		} else if (selectedMetric === "billCuts") {
			valueText = `${m.billCuts}x`;
			const opacity = Math.min(
				1,
				Math.max(0.1, m.billCuts / limits.maxBillCuts),
			);
			textStyle = {
				backgroundColor: `rgba(245, 158, 11, ${opacity * 0.55})`,
				color: "var(--foreground)",
				fontWeight: opacity > 0.5 ? "600" : "500",
			};
		}

		return (
			<TableCell
				key={m.monthIndex}
				className="text-center font-mono text-[11px] p-2 md:p-3 border-r border-border transition-all duration-150 hover:brightness-110"
				style={textStyle}
			>
				<span className="block leading-none">{valueText}</span>
				<span className="block text-[9px] text-muted-foreground/80 mt-0.5 font-sans">
					({m.activeCustomers} active)
				</span>
			</TableCell>
		);
	};

	return (
		<div className="flex flex-col gap-6">
			{/* Cohort Heatmap Card */}
			<Card className="overflow-hidden border-[0.5px] border-border bg-card rounded-[12px] shadow-none">
				<CardHeader className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between pb-4 border-b border-border">
					<div className="flex flex-col gap-1">
						<CardTitle className="text-lg text-foreground font-mono flex items-center gap-2">
							Retention Cohort Analysis
							<TooltipProvider>
								<Tooltip>
									<TooltipTrigger asChild>
										<HelpCircle className="size-4 text-muted-foreground cursor-pointer" />
									</TooltipTrigger>
									<TooltipContent className="max-w-xs p-3 space-y-1.5 text-xs">
										<p>
											<strong>Month 0</strong> is the month the customer made
											their first purchase.
										</p>
										<p>
											<strong>Month 1-5</strong> represents subsequent active
											spending in the months following initial acquisition.
										</p>
									</TooltipContent>
								</Tooltip>
							</TooltipProvider>
						</CardTitle>
						<CardDescription className="text-muted-foreground">
							Retail cohort behavior across the active period, with retention,
							revenue, AOV, and bill-cut views.
						</CardDescription>
					</div>

					{/* Custom Local Cohort Filters */}
					<div className="flex flex-wrap items-center gap-2">
						<div className="flex items-center gap-2">
							<Filter className="size-3.5 text-muted-foreground" />
							<span className="text-[10px] uppercase font-bold text-muted-foreground">
								Type
							</span>
							<Select value={customerType} onValueChange={setCustomerType}>
								<SelectTrigger className="w-[100px] h-8 text-xs bg-muted border-border text-foreground rounded-lg">
									<SelectValue placeholder="All" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="all">All</SelectItem>
									<SelectItem value="new">New Customers</SelectItem>
									<SelectItem value="existing">Existing Customers</SelectItem>
								</SelectContent>
							</Select>
						</div>

						<div className="flex items-center gap-2">
							<span className="text-[10px] uppercase font-bold text-muted-foreground">
								Bill Cut
							</span>
							<Select
								value={billRangeFilter}
								onValueChange={setBillRangeFilter}
							>
								<SelectTrigger className="w-[110px] h-8 text-xs bg-muted border-border text-foreground rounded-lg">
									<SelectValue placeholder="All" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="all">All Cuts</SelectItem>
									<SelectItem value="0-500">0-500</SelectItem>
									<SelectItem value="500-1000">500-1000</SelectItem>
									<SelectItem value="1000-2000">1000-2000</SelectItem>
									<SelectItem value="2000-5000">2000-5000</SelectItem>
									<SelectItem value="5000+">5000+</SelectItem>
								</SelectContent>
							</Select>
						</div>
					</div>
				</CardHeader>

				{/* Metric Selector Toggle — its own row, matching the reference layout */}
				<div className="px-4 pt-4">
					<Tabs
						value={selectedMetric}
						onValueChange={(val) => setSelectedMetric(val as CohortMetricType)}
					>
						<TabsList className="bg-muted border border-border rounded-lg p-1 h-auto">
							<TabsTrigger
								value="retention"
								className="text-xs px-3 py-1.5 rounded-md data-[state=active]:bg-background data-[state=active]:text-foreground"
							>
								Retention
							</TabsTrigger>
							<TabsTrigger
								value="revenue"
								className="text-xs px-3 py-1.5 rounded-md data-[state=active]:bg-background data-[state=active]:text-foreground"
							>
								Revenue
							</TabsTrigger>
							<TabsTrigger
								value="aov"
								className="text-xs px-3 py-1.5 rounded-md data-[state=active]:bg-background data-[state=active]:text-foreground"
							>
								AOV
							</TabsTrigger>
							<TabsTrigger
								value="billCuts"
								className="text-xs px-3 py-1.5 rounded-md data-[state=active]:bg-background data-[state=active]:text-foreground"
							>
								Bill cut
							</TabsTrigger>
						</TabsList>
					</Tabs>
				</div>

				{/* Summary stat tiles */}
				<div className="grid grid-cols-2 lg:grid-cols-4 gap-3 px-4 pt-4">
					<div className="rounded-[10px] border border-border bg-muted/60 p-3">
						<div className="text-[11px] text-muted-foreground font-mono">
							Total customers
						</div>
						<div className="text-xl font-semibold text-foreground font-mono mt-1">
							{summaryStats.totalCustomers.toLocaleString()}
						</div>
					</div>
					<div className="rounded-[10px] border border-border bg-muted/60 p-3">
						<div className="text-[11px] text-muted-foreground font-mono">
							Avg M1 retention
						</div>
						<div className="text-xl font-semibold text-amber-400 font-mono mt-1">
							{summaryStats.avgM1Retention}%
						</div>
					</div>
					<div className="rounded-[10px] border border-border bg-muted/60 p-3">
						<div className="text-[11px] text-muted-foreground font-mono">
							Strongest cohort
						</div>
						<div className="text-xl font-semibold text-amber-400 font-mono mt-1">
							{summaryStats.strongestLabel}
						</div>
					</div>
					<div className="rounded-[10px] border border-border bg-muted/60 p-3">
						<div className="text-[11px] text-muted-foreground font-mono">
							Weakest cohort
						</div>
						<div className="text-xl font-semibold text-rose-400 font-mono mt-1">
							{summaryStats.weakestLabel}
						</div>
					</div>
				</div>

				{selectedMetric === "retention" && (
					<div className="px-4 pt-4 pb-2 text-[11px] text-muted-foreground">
						<span className="mr-3 inline-flex items-center gap-1">
							<span className="h-2.5 w-2.5 rounded-full bg-emerald-500" /> 80%+
						</span>
						<span className="mr-3 inline-flex items-center gap-1">
							<span className="h-2.5 w-2.5 rounded-full bg-emerald-300" />{" "}
							60-79%
						</span>
						<span className="mr-3 inline-flex items-center gap-1">
							<span className="h-2.5 w-2.5 rounded-full bg-amber-400" /> 40-59%
						</span>
						<span className="inline-flex items-center gap-1">
							<span className="h-2.5 w-2.5 rounded-full bg-rose-400" /> Below
							40%
						</span>
					</div>
				)}
				<CardContent className="p-0">
					<div className="overflow-x-auto w-full">
						<Table className="min-w-[800px] border-collapse">
							<TableHeader>
								<TableRow className="border-b border-border hover:bg-transparent">
									<TableHead className="font-semibold text-xs py-3 pl-4 border-r border-border text-muted-foreground">
										Cohort
									</TableHead>
									<TableHead className="font-semibold text-xs py-3 pl-4 text-right border-r border-border text-muted-foreground">
										Size
									</TableHead>
									{["M0", "M1", "M2", "M3", "M4", "M5"].map((label) => (
										<TableHead
											key={label}
											className="font-semibold text-xs py-3 text-center border-r border-border text-muted-foreground"
										>
											{label}
										</TableHead>
									))}
								</TableRow>
							</TableHeader>
							<TableBody>
								{data.length === 0 ? (
									<TableRow className="hover:bg-transparent">
										<TableCell
											colSpan={8}
											className="h-32 text-center text-muted-foreground"
										>
											No cohort data matches filters in selected period.
										</TableCell>
									</TableRow>
								) : (
									data.map((cohort: any) => (
										<TableRow
											key={cohort.cohortMonth}
											className="border-b border-border hover:bg-muted/40"
										>
											<TableCell className="font-semibold py-3 pl-4 text-xs whitespace-nowrap border-r border-border text-foreground">
												{cohort.cohortLabel}
											</TableCell>
											<TableCell className="font-mono text-xs py-3 pl-4 text-right tabular-nums pr-6 border-r border-border text-muted-foreground">
												{cohort.cohortCustomers.toLocaleString()}
											</TableCell>
											{Array.from({ length: 6 }).map((_, idx) => {
												const m = cohort.months.find(
													(month: any) => month.monthIndex === idx,
												);
												return renderCell(
													cohort.cohortCustomers,
													m || { monthIndex: idx, activeCustomers: 0 },
												);
											})}
										</TableRow>
									))
								)}
							</TableBody>
						</Table>
					</div>
				</CardContent>
			</Card>

			{/* Bill Cuts Summary Analysis Table */}
			<div className="grid gap-6 grid-cols-1 md:grid-cols-3">
				<Card className="md:col-span-2 overflow-hidden border-[0.5px] border-border bg-card rounded-[12px] shadow-none">
					<CardHeader className="pb-3 border-b border-border">
						<CardTitle className="text-sm font-bold text-foreground font-mono">
							Cohort By Bill Cut
						</CardTitle>
						<CardDescription className="text-xs text-muted-foreground">
							Repeat purchase rate grouped by initial bill size showing
							retention tiering.
						</CardDescription>
					</CardHeader>
					<CardContent className="p-0">
						<Table>
							<TableHeader>
								<TableRow className="border-b border-border hover:bg-transparent">
									<TableHead className="font-semibold text-xs pl-4 text-muted-foreground">
										Bill Range (₹)
									</TableHead>
									<TableHead className="font-semibold text-xs text-right text-muted-foreground">
										Total Customers
									</TableHead>
									<TableHead className="font-semibold text-xs text-right text-muted-foreground">
										Repeat Customers
									</TableHead>
									<TableHead className="font-semibold text-xs text-right pr-4 text-muted-foreground">
										Retention Rate
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{billCuts.length === 0 ? (
									<TableRow className="hover:bg-transparent">
										<TableCell
											colSpan={4}
											className="h-24 text-center text-xs text-muted-foreground"
										>
											No billing transaction records found.
										</TableCell>
									</TableRow>
								) : (
									billCuts.map((cut: any) => (
										<TableRow
											key={cut.billRange}
											className="border-b border-border hover:bg-muted/40"
										>
											<TableCell className="font-semibold text-xs pl-4 text-foreground">
												{cut.billRange}
											</TableCell>
											<TableCell className="font-mono text-xs text-right tabular-nums text-foreground/80">
												{cut.totalCustomers.toLocaleString()}
											</TableCell>
											<TableCell className="font-mono text-xs text-right tabular-nums text-foreground/80">
												{cut.repeatCustomers.toLocaleString()}
											</TableCell>
											<TableCell className="font-mono text-xs text-right pr-4 tabular-nums">
												<span
													className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold ${
														cut.retentionPct >= 70
															? "bg-emerald-500/15 text-emerald-500"
															: cut.retentionPct >= 45
																? "bg-amber-500/15 text-amber-500"
																: "bg-rose-500/15 text-rose-500"
													}`}
												>
													{cut.retentionPct}%
												</span>
											</TableCell>
										</TableRow>
									))
								)}
							</TableBody>
						</Table>
					</CardContent>
				</Card>

				<Card className="p-5 flex flex-col justify-between md:col-span-1 border-[0.5px] border-border bg-card rounded-[12px] shadow-none">
					<div>
						<h3 className="text-sm font-bold mb-2 text-foreground font-mono">
							Bill Range Insights
						</h3>
						<p className="text-xs text-muted-foreground leading-relaxed">
							Analyzing cohorts grouped by **Bill Cut** helps you identify your
							most valuable customer entries. Typically, customers starting with
							larger invoice ranges (&gt; ₹2000) show higher subsequent trust,
							resulting in stronger repeat retention densities.
						</p>
					</div>
					<div className="rounded-xl bg-emerald-950/20 border border-emerald-950 p-3 mt-4 text-xs text-emerald-500">
						<strong>Strategy Tip:</strong> Provide entry incentives (discounts,
						combos) to push first bills into higher cuts to lift overall
						lifetime retention rates.
					</div>
				</Card>
			</div>
		</div>
	);
}
