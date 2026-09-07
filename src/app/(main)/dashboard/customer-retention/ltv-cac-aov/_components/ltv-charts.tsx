"use client";

import {
	Bar,
	BarChart,
	CartesianGrid,
	Legend,
	Line,
	LineChart,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";

interface CohortData {
	name: string;
	[cohort: string]: string | number;
}

interface AovBarData {
	name: string;
	aov: number;
}

interface LtvChartsProps {
	cohortChartData: CohortData[];
	cohortsList: string[];
	aovChartData: AovBarData[];
}

export function LtvCharts({
	cohortChartData,
	cohortsList,
	aovChartData,
}: LtvChartsProps) {
	// Line colors to match gray/black/white base aesthetic — theme CSS
	// variables so the palette stays grayscale-only while adapting contrast
	// between light and dark mode (chart-1 is highest contrast, chart-5 the
	// most subdued, per theme).
	const lineColors = [
		"var(--chart-1)",
		"var(--chart-2)",
		"var(--chart-3)",
		"var(--chart-4)",
		"var(--chart-5)",
		"var(--muted-foreground)",
	];

	return (
		<div className="grid gap-6 grid-cols-1 lg:grid-cols-2">
			{/* Cohort LTV Growth Chart */}
			<div className="border-[0.5px] border-border bg-card p-6 rounded-[12px] flex flex-col gap-4">
				<div>
					<h3 className="text-sm font-medium text-foreground font-mono">
						Cohort LTV Growth
					</h3>
					<p className="text-xs text-muted-foreground mt-1">
						LTV per cohort at month 0, month 3, and month 6
					</p>
				</div>
				<div className="h-[300px] w-full">
					<ResponsiveContainer width="100%" height="100%">
						<LineChart
							data={cohortChartData}
							margin={{ top: 10, right: 10, left: 0, bottom: 5 }}
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
								tickFormatter={(v) => `₹${v}`}
							/>
							<Tooltip
								contentStyle={{
									backgroundColor: "var(--popover)",
									borderColor: "var(--border)",
									borderRadius: "8px",
									color: "var(--popover-foreground)",
									fontSize: "11px",
								}}
								formatter={(value) => [`₹${value}`, "LTV"]}
							/>
							{cohortsList.map((cohort, index) => (
								<Line
									key={cohort}
									type="monotone"
									dataKey={cohort}
									stroke={lineColors[index % lineColors.length]}
									strokeWidth={1.5}
									strokeDasharray={index % 2 === 1 ? "6 3" : undefined}
									dot={{ r: 3, strokeWidth: 1 }}
									activeDot={{ r: 5 }}
								/>
							))}
							<Legend
								verticalAlign="bottom"
								align="center"
								wrapperStyle={{
									paddingTop: "15px",
									fontSize: "11px",
									color: "var(--muted-foreground)",
								}}
							/>
						</LineChart>
					</ResponsiveContainer>
				</div>
			</div>

			{/* AOV Expansion Chart */}
			<div className="border-[0.5px] border-border bg-card p-6 rounded-[12px] flex flex-col gap-4">
				<div>
					<h3 className="text-sm font-medium text-foreground font-mono">
						AOV Expansion
					</h3>
					<p className="text-xs text-muted-foreground mt-1">
						AOV by order number (1st, 2nd, 3rd, 4th+)
					</p>
				</div>
				<div className="h-[300px] w-full">
					<ResponsiveContainer width="100%" height="100%">
						<BarChart
							data={aovChartData}
							margin={{ top: 10, right: 10, left: 0, bottom: 5 }}
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
								tickFormatter={(v) => `₹${v}`}
							/>
							<Tooltip
								contentStyle={{
									backgroundColor: "var(--popover)",
									borderColor: "var(--border)",
									borderRadius: "8px",
									color: "var(--popover-foreground)",
									fontSize: "11px",
								}}
								formatter={(value) => [`₹${value}`, "AOV"]}
							/>
							<Bar
								dataKey="aov"
								fill="var(--chart-1)"
								radius={[4, 4, 0, 0]}
								barSize={45}
							/>
						</BarChart>
					</ResponsiveContainer>
				</div>
			</div>
		</div>
	);
}
