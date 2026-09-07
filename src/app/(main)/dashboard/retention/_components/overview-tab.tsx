"use client";

import { Coins, Layers, TrendingUp, Users } from "lucide-react";
import { useMemo } from "react";
import {
	CartesianGrid,
	Tooltip as ChartTooltip,
	Legend,
	Line,
	LineChart,
	ResponsiveContainer,
	XAxis,
	YAxis,
} from "recharts";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { MetricCard } from "@/components/ui/metric-card";
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

export function OverviewTab({ hasData }: { hasData: boolean }) {
	const { data, isLoading } = useLTV(hasData);
	const overview = data?.overview;
	const trend = data?.trend || [];
	const topCustomers = data?.topCustomers || [];

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
		return {
			avgLtv: Math.round(overview.ltv?.current || 0),
			avgAov: Math.round(overview.avgAov?.current || 0),
			cac: Math.round(overview.cac?.current || 0),
			ratio: hasSpendData ? `${overview.ltvCacRatio?.current || 0}:1` : "N/A",
			hasSpendData,
		};
	}, [overview]);

	return (
		<div className="flex flex-col gap-6">
			<div className="grid gap-4 md:grid-cols-3">
				<MetricCard
					title="Average AOV"
					value={formatCurrency(summaryStats.avgAov, { noDecimals: true })}
					growth={overview?.avgAov?.growth}
					comparisonLabel="Average ticket size"
					icon={Coins}
				/>
				<MetricCard
					title="Revenue / Customer (Period)"
					value={formatCurrency(summaryStats.avgLtv, { noDecimals: true })}
					growth={overview?.ltv?.growth}
					comparisonLabel="Period revenue per customer (not lifetime)"
					icon={TrendingUp}
				/>
				<MetricCard
					title="Average CAC"
					value={
						summaryStats.hasSpendData
							? formatCurrency(summaryStats.cac, { noDecimals: true })
							: "N/A"
					}
					growth={summaryStats.hasSpendData ? overview?.cac?.growth : undefined}
					comparisonLabel={
						summaryStats.hasSpendData
							? "Cost to acquire a new customer"
							: "No marketing spend data recorded"
					}
					icon={Users}
				/>
			</div>

			<div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr] items-stretch">
				<Card className="xl:col-span-1 border-[0.5px] border-border bg-card rounded-[12px] shadow-none">
					<CardHeader>
						<CardTitle className="text-lg text-foreground font-mono">
							LTV / AOV / CAC Trend
						</CardTitle>
						<CardDescription className="text-muted-foreground">
							Track how customer value and acquisition efficiency are moving
							across the selected period.
						</CardDescription>
					</CardHeader>
					<CardContent className="h-[300px] pb-4">
						{trend.length === 0 ? (
							<div className="flex h-full items-center justify-center text-xs text-muted-foreground">
								No monthly trend data is available yet.
							</div>
						) : (
							<ResponsiveContainer width="100%" height="100%">
								<LineChart
									data={trend}
									margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
								>
									<CartesianGrid
										strokeDasharray="3 3"
										stroke="var(--border)"
										vertical={false}
									/>
									<XAxis
										dataKey="monthLabel"
										stroke="var(--muted-foreground)"
										tickLine={false}
										axisLine={false}
										style={{ fontSize: 11 }}
									/>
									<YAxis
										stroke="var(--muted-foreground)"
										tickLine={false}
										axisLine={false}
										style={{ fontSize: 11 }}
									/>
									<ChartTooltip
										contentStyle={{
											backgroundColor: "var(--popover)",
											borderColor: "var(--border)",
											borderRadius: "8px",
											color: "var(--popover-foreground)",
											fontSize: "11px",
										}}
										formatter={(value) => [
											formatCurrency(Number(value), { noDecimals: true }),
											"Value",
										]}
									/>
									<Legend
										verticalAlign="top"
										height={36}
										wrapperStyle={{
											fontSize: 11,
											color: "var(--muted-foreground)",
										}}
									/>
									<Line
										type="monotone"
										name="LTV"
										dataKey="ltv"
										stroke="var(--chart-1)"
										strokeWidth={2}
										dot={{ r: 3, strokeWidth: 0, fill: "var(--chart-1)" }}
									/>
									<Line
										type="monotone"
										name="AOV"
										dataKey="aov"
										stroke="var(--chart-3)"
										strokeWidth={2}
										dot={{ r: 3, strokeWidth: 0, fill: "var(--chart-3)" }}
									/>
									<Line
										type="monotone"
										name="CAC"
										dataKey="cac"
										stroke="var(--chart-4)"
										strokeWidth={2}
										strokeDasharray="6 3"
										dot={{ r: 3, strokeWidth: 0, fill: "var(--chart-4)" }}
									/>
								</LineChart>
							</ResponsiveContainer>
						)}
					</CardContent>
				</Card>

				<Card className="xl:col-span-1 border-[0.5px] border-border bg-card rounded-[12px] shadow-none">
					<CardHeader>
						<CardTitle className="text-lg text-foreground font-mono flex items-center gap-2">
							<Layers className="size-4 text-muted-foreground" />
							LTV:CAC Relationship
						</CardTitle>
						<CardDescription className="text-muted-foreground">
							Relationship between acquisition cost, order value and long-term
							customer value.
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-4">
						<div className="rounded-xl border border-border bg-muted/40 p-4">
							<div className="text-xs uppercase tracking-[0.2em] text-muted-foreground font-mono">
								Current ratio
							</div>
							<div className="mt-2 text-3xl font-semibold text-foreground font-mono">
								{summaryStats.ratio}
							</div>
							<div className="mt-2 text-sm text-muted-foreground">
								CAC → First purchase → AOV → Repeat purchase → LTV
							</div>
						</div>
						<div className="rounded-xl border border-border p-4 text-sm text-muted-foreground">
							<div className="font-medium text-foreground">Status</div>
							<div className="mt-2 flex items-center gap-2">
								<span
									className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${Number(summaryStats.ratio.split(":")[0]) >= 3 ? "bg-emerald-500/10 text-emerald-500" : "bg-amber-500/10 text-amber-500"}`}
								>
									{Number(summaryStats.ratio.split(":")[0]) >= 3
										? "Excellent"
										: "Healthy"}
								</span>
								<span>
									Customer value is creating a healthy return on acquisition
									spend.
								</span>
							</div>
						</div>
					</CardContent>
				</Card>
			</div>

			<div className="grid gap-6 xl:grid-cols-[1.3fr_0.7fr] items-stretch">
				<Card className="border-[0.5px] border-border bg-card rounded-[12px] shadow-none">
					<CardHeader>
						<CardTitle className="text-lg text-foreground font-mono">
							Customer Analytics
						</CardTitle>
						<CardDescription className="text-muted-foreground">
							High-value customers with their order count, revenue, AOV and LTV.
						</CardDescription>
					</CardHeader>
					<CardContent className="p-0">
						<div className="overflow-x-auto">
							<Table>
								<TableHeader>
									<TableRow className="border-b border-border hover:bg-transparent">
										<TableHead className="text-xs py-3 pl-4 text-muted-foreground">
											Customer
										</TableHead>
										<TableHead className="text-xs py-3 text-right text-muted-foreground">
											Orders
										</TableHead>
										<TableHead className="text-xs py-3 text-right text-muted-foreground">
											Revenue
										</TableHead>
										<TableHead className="text-xs py-3 text-right text-muted-foreground">
											AOV
										</TableHead>
										<TableHead className="text-xs py-3 text-right text-muted-foreground">
											LTV
										</TableHead>
										<TableHead className="text-xs py-3 text-right pr-4 text-muted-foreground">
											Status
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{topCustomers.slice(0, 8).map((customer: any) => {
										const status =
											customer.retentionScore >= 70
												? "VIP"
												: customer.retentionScore >= 40
													? "Loyal"
													: customer.customerType === "New"
														? "New"
														: "Standard";
										return (
											<TableRow
												key={customer.customerMobile}
												className="border-b border-border hover:bg-muted/40"
											>
												<TableCell className="py-3 pl-4">
													<div className="text-xs font-semibold text-foreground">
														{customer.customerName}
													</div>
													<div className="text-[10px] text-muted-foreground">
														{customer.customerMobile}
													</div>
												</TableCell>
												<TableCell className="py-3 text-right font-mono text-xs text-foreground/80">
													{customer.orders ?? 0}
												</TableCell>
												<TableCell className="py-3 text-right font-mono text-xs text-foreground/80">
													{formatCurrency(customer.revenue ?? 0, {
														noDecimals: true,
													})}
												</TableCell>
												<TableCell className="py-3 text-right font-mono text-xs text-foreground/80">
													{formatCurrency(customer.aov ?? 0, {
														noDecimals: true,
													})}
												</TableCell>
												<TableCell className="py-3 text-right font-mono text-xs text-foreground font-semibold">
													{formatCurrency(customer.ltv ?? 0, {
														noDecimals: true,
													})}
												</TableCell>
												<TableCell className="py-3 text-right pr-4">
													<span
														className={`inline-flex rounded-full px-2.5 py-1 text-[10px] font-medium ${status === "VIP" ? "bg-foreground/10 text-foreground" : status === "Loyal" ? "bg-emerald-500/10 text-emerald-500" : status === "New" ? "bg-muted text-muted-foreground" : "bg-muted text-muted-foreground"}`}
													>
														{status}
													</span>
												</TableCell>
											</TableRow>
										);
									})}
								</TableBody>
							</Table>
						</div>
					</CardContent>
				</Card>

				<Card className="border-[0.5px] border-border bg-card rounded-[12px] shadow-none">
					<CardHeader>
						<CardTitle className="text-lg text-foreground font-mono">
							AOV Stability
						</CardTitle>
						<CardDescription className="text-muted-foreground">
							Customer spending behaviour and whether their AOV is stable,
							growing or declining.
						</CardDescription>
					</CardHeader>
					<CardContent className="p-0">
						<div className="overflow-x-auto">
							<Table>
								<TableHeader>
									<TableRow className="border-b border-border hover:bg-transparent">
										<TableHead className="text-xs py-3 pl-4 text-muted-foreground">
											Customer
										</TableHead>
										<TableHead className="text-xs py-3 text-right text-muted-foreground">
											Latest AOV
										</TableHead>
										<TableHead className="text-xs py-3 text-right pr-4 text-muted-foreground">
											Stability
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{topCustomers.slice(0, 6).map((customer: any) => (
										<TableRow
											key={customer.customerMobile}
											className="border-b border-border hover:bg-muted/40"
										>
											<TableCell className="py-3 pl-4">
												<div className="text-xs font-semibold text-foreground">
													{customer.customerName}
												</div>
											</TableCell>
											<TableCell className="py-3 text-right font-mono text-xs text-foreground/80">
												{formatCurrency(customer.aov ?? 0, {
													noDecimals: true,
												})}
											</TableCell>
											<TableCell className="py-3 text-right pr-4">
												<span
													className={`inline-flex rounded-full px-2.5 py-1 text-[10px] font-medium ${customer.aovStability === "Increasing" ? "bg-emerald-500/10 text-emerald-500" : customer.aovStability === "Decreasing" ? "bg-rose-500/10 text-rose-500" : "bg-muted text-muted-foreground"}`}
												>
													{customer.aovStability ?? "Stable"}
												</span>
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</div>
					</CardContent>
				</Card>
			</div>
		</div>
	);
}
