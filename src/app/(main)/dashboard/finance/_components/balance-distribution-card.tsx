"use client";

import * as React from "react";
import { Label, Pie, PieChart } from "recharts";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
	type ChartConfig,
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
} from "@/components/ui/chart";
import { formatCurrency } from "@/lib/utils";

// Grayscale palette cycled across however many real stores exist — no
// fixed store count. Previously any store other than the two originally
// known ones (KLJ / Smart Works Noida) was silently bucketed into a
// generic "Head office" slice, mislabeling real revenue for any newer
// store (Phase 6 audit: same class of hardcoded-store defect as the CAC
// payback table).
const STORE_CHART_COLORS = [
	"var(--chart-1)",
	"var(--chart-2)",
	"var(--chart-3)",
	"var(--chart-4)",
	"var(--chart-5)",
];

const chartConfig = {
	amount: {
		label: "Sales Allocation",
	},
} satisfies ChartConfig;

export function BalanceDistributionCard({ data }: { data: any }) {
	const storePerformance = data?.storePerformance || [];
	const currentTotalRevenue = data?.salesKpis?.revenue?.current || 0;

	// Process actual database store splits
	const chartData = React.useMemo(() => {
		if (storePerformance.length === 0 || currentTotalRevenue <= 0) {
			return [] as {
				account: string;
				amount: number;
				key: string;
				percentage: number;
				fill: string;
			}[];
		}

		return storePerformance.map(
			(
				item: {
					storeDisplayName: string;
					billedBy: string;
					revenue: number;
				},
				index: number,
			) => {
				const share =
					currentTotalRevenue > 0
						? (item.revenue / currentTotalRevenue) * 100
						: 0;
				return {
					account: item.storeDisplayName,
					amount: Number(item.revenue),
					key: item.billedBy,
					percentage: Number(share.toFixed(1)),
					fill: STORE_CHART_COLORS[index % STORE_CHART_COLORS.length],
				};
			},
		);
	}, [storePerformance, currentTotalRevenue]);

	return (
		<Card>
			<CardHeader>
				<CardTitle className="font-normal text-muted-foreground text-sm">
					Store Allocation Split
				</CardTitle>
			</CardHeader>

			<CardContent className="grid items-center gap-4 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1fr)]">
				{chartData.length === 0 ? (
					<div className="col-span-full flex h-40 items-center justify-center text-xs text-muted-foreground">
						No store revenue data available for this period.
					</div>
				) : (
					<>
						<ChartContainer
							config={chartConfig}
							className="mx-auto aspect-square h-50"
						>
							<PieChart>
								<ChartTooltip
									cursor={false}
									content={
										<ChartTooltipContent
											hideLabel
											className="w-52"
											nameKey="account"
										/>
									}
								/>
								<Pie
									cornerRadius={6}
									data={chartData}
									dataKey="amount"
									innerRadius={65}
									nameKey="account"
									outerRadius={90}
									paddingAngle={2}
									strokeWidth={5}
								>
									<Label
										content={({ viewBox }) => {
											if (!(viewBox && "cx" in viewBox && "cy" in viewBox)) {
												return null;
											}

											return (
												<text
													dominantBaseline="middle"
													textAnchor="middle"
													x={viewBox.cx}
													y={viewBox.cy}
												>
													<tspan
														className="fill-muted-foreground text-xs"
														x={viewBox.cx}
														y={(viewBox.cy ?? 0) - 8}
													>
														Total Sales
													</tspan>
													<tspan
														className="fill-foreground font-medium text-lg tabular-nums font-bold font-mono"
														x={viewBox.cx}
														y={(viewBox.cy ?? 0) + 14}
													>
														{formatCurrency(currentTotalRevenue, {
															noDecimals: true,
														})}
													</tspan>
												</text>
											);
										}}
									/>
								</Pie>
							</PieChart>
						</ChartContainer>

						<div className="flex min-w-0 flex-col gap-3">
							{chartData.map((item: any) => (
								<div
									className="grid grid-cols-[1fr_auto] items-end gap-3"
									key={item.key}
								>
									<div className="min-w-0">
										<div className="flex min-w-0 items-center gap-1">
											<span
												aria-hidden="true"
												className="h-2 w-1 rounded-full"
												style={{ backgroundColor: item.fill }}
											/>
											<p className="truncate text-muted-foreground text-xs">
												{item.account}
											</p>
										</div>
										<p className="font-medium tabular-nums font-mono">
											{formatCurrency(item.amount, { noDecimals: true })}
										</p>
									</div>
									<div className="font-medium tabular-nums font-mono">
										{item.percentage}%
									</div>
								</div>
							))}
						</div>
					</>
				)}
			</CardContent>
		</Card>
	);
}
