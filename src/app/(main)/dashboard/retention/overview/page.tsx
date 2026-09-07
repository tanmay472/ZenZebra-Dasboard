"use client";

import { format } from "date-fns";
import {
	BarChart3,
	DollarSign,
	Layers,
	Repeat,
	ShoppingBag,
	Sparkles,
	TrendingUp,
	Upload,
	Users,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
	Area,
	AreaChart,
	CartesianGrid,
	Tooltip as ChartTooltip,
	Legend,
	ResponsiveContainer,
	XAxis,
	YAxis,
} from "recharts";
import { GlobalFilterBar } from "@/components/founder/global-filter-bar";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { MetricCard } from "@/components/ui/metric-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRetention } from "@/hooks/useRetention";

export default function OverviewPage() {
	const router = useRouter();
	const [status, setStatus] = useState<any>(null);

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
	const { data, isLoading } = useRetention(hasData);

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
	const overview = data?.overview;
	const trend = data?.trend || [];
	const aiInsights = data?.aiInsights || [];

	return (
		<div className="flex flex-col gap-6 p-4 md:p-8 pt-4">
			{/* Title Section */}
			<div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
				<div className="flex flex-col gap-1">
					<h1 className="text-3xl font-bold leading-none tracking-tight">
						Customer Retention Overview
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
				<div className="grid gap-6 grid-cols-1 md:grid-cols-2 lg:grid-cols-3 mt-2">
					<Skeleton className="h-[120px] rounded-2xl" />
					<Skeleton className="h-[120px] rounded-2xl" />
					<Skeleton className="h-[120px] rounded-2xl" />
					<Skeleton className="h-[300px] col-span-full rounded-2xl" />
				</div>
			) : (
				<div className="flex flex-col gap-6">
					{/* KPI Card Grid */}
					<div className="grid gap-4 grid-cols-2 lg:grid-cols-3">
						<MetricCard
							title="Retention Rate"
							value={`${overview?.retentionRate?.current}%`}
							growth={overview?.retentionRate?.growth}
							comparisonLabel="vs last period"
							icon={Repeat}
						/>
						<MetricCard
							title="Repeat Purchase Rate"
							value={`${overview?.repeatPurchaseRate?.current}%`}
							growth={overview?.repeatPurchaseRate?.growth}
							comparisonLabel="vs last period"
							icon={TrendingUp}
						/>
						<MetricCard
							title="Revenue per Customer (Period)"
							value={`₹${overview?.ltv?.current}`}
							growth={overview?.ltv?.growth}
							comparisonLabel="vs last period"
							icon={DollarSign}
						/>
						<MetricCard
							title="Customer Acquisition Cost"
							value={`₹${overview?.cac?.current}`}
							growth={overview?.cac?.growth}
							comparisonLabel="vs last period"
							icon={Users}
						/>
						<MetricCard
							title="LTV:CAC Ratio"
							value={`${overview?.ltvCacRatio?.current}x`}
							growth={overview?.ltvCacRatio?.growth}
							comparisonLabel="vs last period"
							icon={Layers}
						/>
						<MetricCard
							title="Average Orders / Customer"
							value={overview?.avgOrdersPerCustomer?.current}
							growth={overview?.avgOrdersPerCustomer?.growth}
							comparisonLabel="vs last period"
							icon={ShoppingBag}
						/>
					</div>

					{/* AI Insights & Trends */}
					<div className="grid gap-6 grid-cols-1 lg:grid-cols-3 items-stretch">
						{/* Trend Section (2 columns on wide screens) */}
						<Card className="lg:col-span-2 border-white/10 bg-white/5 dark:bg-black/20 backdrop-blur-xl shadow-[0_8px_32px_rgba(0,0,0,0.08)]">
							<CardHeader>
								<CardTitle className="text-lg">
									Customer Activity Trends
								</CardTitle>
								<CardDescription>
									Decomposition of revenue and active customer additions
								</CardDescription>
							</CardHeader>
							<CardContent>
								<Tabs defaultValue="revenue" className="flex flex-col gap-4">
									<TabsList className="w-fit">
										<TabsTrigger value="revenue">Revenue Mix</TabsTrigger>
										<TabsTrigger value="customers">Customer Mix</TabsTrigger>
									</TabsList>
									<TabsContent value="revenue" className="h-[280px]">
										<ResponsiveContainer width="100%" height="100%">
											<AreaChart
												data={trend}
												margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
											>
												<defs>
													<linearGradient
														id="newRev"
														x1="0"
														y1="0"
														x2="0"
														y2="1"
													>
														<stop
															offset="5%"
															stopColor="var(--chart-1)"
															stopOpacity={0.4}
														/>
														<stop
															offset="95%"
															stopColor="var(--chart-1)"
															stopOpacity={0}
														/>
													</linearGradient>
													<linearGradient
														id="retRev"
														x1="0"
														y1="0"
														x2="0"
														y2="1"
													>
														<stop
															offset="5%"
															stopColor="var(--chart-4)"
															stopOpacity={0.4}
														/>
														<stop
															offset="95%"
															stopColor="var(--chart-4)"
															stopOpacity={0}
														/>
													</linearGradient>
												</defs>
												<CartesianGrid strokeDasharray="3 3" opacity={0.15} />
												<XAxis
													dataKey="date"
													tickLine={false}
													style={{ fontSize: 11 }}
												/>
												<YAxis tickLine={false} style={{ fontSize: 11 }} />
												<ChartTooltip />
												<Legend
													verticalAlign="top"
													height={36}
													style={{ fontSize: 12 }}
												/>
												<Area
													type="monotone"
													name="New Customer Revenue"
													dataKey="newRevenue"
													stroke="var(--chart-1)"
													fillOpacity={1}
													fill="url(#newRev)"
													strokeWidth={2}
												/>
												<Area
													type="monotone"
													name="Returning Customer Revenue"
													dataKey="returningRevenue"
													stroke="var(--chart-4)"
													strokeDasharray="6 3"
													fillOpacity={1}
													fill="url(#retRev)"
													strokeWidth={2}
												/>
											</AreaChart>
										</ResponsiveContainer>
									</TabsContent>
									<TabsContent value="customers" className="h-[280px]">
										<ResponsiveContainer width="100%" height="100%">
											<AreaChart
												data={trend}
												margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
											>
												<defs>
													<linearGradient
														id="newCust"
														x1="0"
														y1="0"
														x2="0"
														y2="1"
													>
														<stop
															offset="5%"
															stopColor="var(--chart-1)"
															stopOpacity={0.4}
														/>
														<stop
															offset="95%"
															stopColor="var(--chart-1)"
															stopOpacity={0}
														/>
													</linearGradient>
													<linearGradient
														id="retCust"
														x1="0"
														y1="0"
														x2="0"
														y2="1"
													>
														<stop
															offset="5%"
															stopColor="var(--chart-4)"
															stopOpacity={0.4}
														/>
														<stop
															offset="95%"
															stopColor="var(--chart-4)"
															stopOpacity={0}
														/>
													</linearGradient>
												</defs>
												<CartesianGrid strokeDasharray="3 3" opacity={0.15} />
												<XAxis
													dataKey="date"
													tickLine={false}
													style={{ fontSize: 11 }}
												/>
												<YAxis tickLine={false} style={{ fontSize: 11 }} />
												<ChartTooltip />
												<Legend
													verticalAlign="top"
													height={36}
													style={{ fontSize: 12 }}
												/>
												<Area
													type="monotone"
													name="New Customers"
													dataKey="newCustomers"
													stroke="var(--chart-1)"
													fillOpacity={1}
													fill="url(#newCust)"
													strokeWidth={2}
												/>
												<Area
													type="monotone"
													name="Returning Customers"
													dataKey="returningCustomers"
													stroke="var(--chart-4)"
													strokeDasharray="6 3"
													fillOpacity={1}
													fill="url(#retCust)"
													strokeWidth={2}
												/>
											</AreaChart>
										</ResponsiveContainer>
									</TabsContent>
								</Tabs>
							</CardContent>
						</Card>

						{/* AI Insights (1 column) */}
						<Card className="border-white/10 bg-white/5 dark:bg-black/20 backdrop-blur-xl shadow-[0_8px_32px_rgba(0,0,0,0.08)] flex flex-col justify-between">
							<CardHeader>
								<CardTitle className="text-lg flex items-center gap-2">
									<Sparkles className="size-4 text-amber-500" />
									AI Insights Panel
								</CardTitle>
								<CardDescription>
									Retention patterns and intelligence summaries
								</CardDescription>
							</CardHeader>
							<CardContent className="flex-1 flex flex-col justify-between gap-4">
								<ul className="space-y-4">
									{aiInsights.map((insight: string) => (
										<li
											key={insight}
											className="flex gap-2 text-sm leading-relaxed"
										>
											<span className="text-blue-500 font-bold">•</span>
											<span className="text-foreground/90">{insight}</span>
										</li>
									))}
								</ul>
								<div className="rounded-xl bg-amber-500/10 border border-amber-500/20 p-3 mt-4 text-xs text-amber-600 dark:text-amber-400">
									<strong>Recommendation:</strong> Consider launching targeted
									retention offers for cohorts where repeat purchase behaviors
									are slipping below standard thresholds.
								</div>
							</CardContent>
						</Card>
					</div>
				</div>
			)}
		</div>
	);
}
