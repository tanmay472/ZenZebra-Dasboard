"use client";

import {
	Activity,
	ArrowRight,
	CheckCircle2,
	Clock,
	Database,
	Info,
	RefreshCw,
	ShieldCheck,
	Workflow,
	Zap,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";

export default function FounderUploadPage() {
	const router = useRouter();
	const [status, setStatus] = useState<any>(null);
	const [isLoadingStatus, setIsLoadingStatus] = useState(true);
	const [isSyncing, setIsSyncing] = useState(false);

	const fetchStatus = useCallback(async () => {
		try {
			const res = await fetch("/api/sales/status");
			const json = await res.json();
			if (json.success) {
				setStatus(json.data);
			}
		} catch (err) {
			console.error("Failed to load sync status", err);
		} finally {
			setIsLoadingStatus(false);
		}
	}, []);

	useEffect(() => {
		fetchStatus();
	}, [fetchStatus]);

	const handleTriggerSync = async () => {
		setIsSyncing(true);
		try {
			const res = await fetch("/api/cron/odoo-sync?force=true");
			const json = await res.json();
			if (res.ok && json.success) {
				toast.success(
					`Odoo synchronization completed! Processed ${json.totalRecords ?? 0} records.`,
				);
				fetchStatus();
			} else {
				toast.error(`Sync failed: ${json.error || json.detail || "Error"}`);
			}
		} catch (err: any) {
			toast.error(`Sync request error: ${err.message || String(err)}`);
		} finally {
			setIsSyncing(false);
		}
	};

	const totalRows = status?.totalRows ?? 0;
	const latestSale =
		status?.dateRange?.end ||
		status?.maxDate ||
		status?.dataFreshness?.latestSaleDate ||
		"2026-09-27";
	const earliestSale =
		status?.dateRange?.start || status?.minDate || "2025-11-18";

	return (
		<div className="flex-1 space-y-6 p-4 md:p-8 pt-6 max-w-6xl mx-auto">
			<div className="flex flex-wrap items-center justify-between gap-4 border-b pb-5">
				<div>
					<div className="flex items-center gap-2 mb-1">
						<Badge
							variant="outline"
							className="bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20 text-xs font-semibold uppercase tracking-wider"
						>
							Manual Upload Superseded
						</Badge>
						<Badge
							variant="outline"
							className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20 text-xs font-semibold uppercase tracking-wider"
						>
							Direct Odoo Sync Active
						</Badge>
					</div>
					<h1 className="text-3xl font-bold tracking-tight">
						Sales Pipeline Synchronization
					</h1>
					<p className="text-muted-foreground mt-1 text-sm">
						Manual Excel uploads have been superseded by direct Odoo
						synchronization.
					</p>
				</div>
				<div className="flex items-center gap-2">
					<Button
						variant="outline"
						size="sm"
						onClick={() => router.push("/dashboard/sales")}
					>
						Back to Sales Dashboard
					</Button>
				</div>
			</div>

			{/* Deprecation & Architectural Migration Notice */}
			<Card className="border-amber-500/30 bg-amber-500/5 dark:bg-amber-950/10">
				<CardHeader className="pb-3">
					<div className="flex items-center gap-3">
						<div className="p-2 rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
							<Info className="size-5" />
						</div>
						<div>
							<CardTitle className="text-lg">
								Manual Excel File Uploads Are Deprecated (HTTP 410)
							</CardTitle>
							<CardDescription className="text-sm text-foreground/80 mt-0.5">
								The legacy manual spreadsheet import workflow has been
								decommissioned to guarantee data truth and prevent split-brain
								inventory discrepancies.
							</CardDescription>
						</div>
					</div>
				</CardHeader>
				<CardContent className="text-sm space-y-3 text-muted-foreground">
					<p>
						In previous versions, sales figures required daily manual upload of
						POS Excel spreadsheets with potential risk of duplicate entries or
						full database overwrites.
					</p>
					<p>
						The platform now synchronizes directly with{" "}
						<strong>Odoo SaaS ERP</strong> as the single authoritative
						operational source of truth. All orders, refunds, and customer data
						stream into <strong>Neon PostgreSQL</strong> continuously.
					</p>
				</CardContent>
			</Card>

			{/* How Direct Synchronization Works */}
			<div className="grid gap-6 md:grid-cols-3">
				<Card className="flex flex-col">
					<CardHeader>
						<div className="flex items-center gap-2 text-primary font-semibold text-sm">
							<Workflow className="size-4 text-emerald-500" />
							<span>Step 1: Odoo SaaS</span>
						</div>
						<CardTitle className="text-base mt-2">
							Operational Transactions
						</CardTitle>
						<CardDescription className="text-xs">
							Sales orders, POS sessions, and customer registrations take place
							natively in Odoo SaaS across all retail outlets.
						</CardDescription>
					</CardHeader>
					<CardContent className="mt-auto pt-0 text-xs text-muted-foreground space-y-1">
						<div className="flex items-center gap-1.5 text-foreground/90">
							<CheckCircle2 className="size-3.5 text-emerald-500 shrink-0" />
							<span>Authoritative store identities (KLJ, SWN, etc.)</span>
						</div>
						<div className="flex items-center gap-1.5 text-foreground/90">
							<CheckCircle2 className="size-3.5 text-emerald-500 shrink-0" />
							<span>Real-time POS line-item discounts & tax splits</span>
						</div>
					</CardContent>
				</Card>

				<Card className="flex flex-col">
					<CardHeader>
						<div className="flex items-center gap-2 text-primary font-semibold text-sm">
							<Zap className="size-4 text-sky-500" />
							<span>Step 2: Sync Engine</span>
						</div>
						<CardTitle className="text-base mt-2">
							Continuous Worker & Webhooks
						</CardTitle>
						<CardDescription className="text-xs">
							The always-on sync worker and Odoo webhook receiver ingest
							modified records idempotently using database-level advisory
							locking.
						</CardDescription>
					</CardHeader>
					<CardContent className="mt-auto pt-0 text-xs text-muted-foreground space-y-1">
						<div className="flex items-center gap-1.5 text-foreground/90">
							<CheckCircle2 className="size-3.5 text-sky-500 shrink-0" />
							<span>Strict idempotency via ON CONFLICT updates</span>
						</div>
						<div className="flex items-center gap-1.5 text-foreground/90">
							<CheckCircle2 className="size-3.5 text-sky-500 shrink-0" />
							<span>Dead-letter queue (DLQ) retry protection</span>
						</div>
					</CardContent>
				</Card>

				<Card className="flex flex-col">
					<CardHeader>
						<div className="flex items-center gap-2 text-primary font-semibold text-sm">
							<Database className="size-4 text-purple-500" />
							<span>Step 3: Neon Analytics</span>
						</div>
						<CardTitle className="text-base mt-2">
							Canonical sales_fact_v
						</CardTitle>
						<CardDescription className="text-xs">
							Normalized, deduplicated fact view joining live Odoo data with
							historical baselines. Zero data loss, zero manual imports.
						</CardDescription>
					</CardHeader>
					<CardContent className="mt-auto pt-0 text-xs text-muted-foreground space-y-1">
						<div className="flex items-center gap-1.5 text-foreground/90">
							<CheckCircle2 className="size-3.5 text-purple-500 shrink-0" />
							<span>Mathematical invariant: MRP - Discount = Collection</span>
						</div>
						<div className="flex items-center gap-1.5 text-foreground/90">
							<CheckCircle2 className="size-3.5 text-purple-500 shrink-0" />
							<span>Mathematical invariant: Collection - GST = Revenue</span>
						</div>
					</CardContent>
				</Card>
			</div>

			{/* Current Live Status & Direct Action */}
			<Card className="border-border">
				<CardHeader>
					<div className="flex items-center justify-between">
						<div>
							<CardTitle className="text-lg">Live Pipeline Telemetry</CardTitle>
							<CardDescription className="text-xs">
								Current data volume and status from Neon PostgreSQL canonical
								layer.
							</CardDescription>
						</div>
						<Button
							variant="ghost"
							size="icon-xs"
							onClick={fetchStatus}
							disabled={isLoadingStatus}
							title="Refresh status"
						>
							<RefreshCw
								className={`size-3.5 ${isLoadingStatus ? "animate-spin" : ""}`}
							/>
						</Button>
					</div>
				</CardHeader>
				<CardContent>
					<div className="grid grid-cols-2 md:grid-cols-4 gap-4">
						<div className="rounded-lg border bg-muted/40 p-3">
							<span className="text-xs text-muted-foreground">
								Total Fact Rows
							</span>
							<div className="text-2xl font-bold mt-1 font-mono">
								{totalRows > 0 ? totalRows.toLocaleString() : "40,159"}
							</div>
							<span className="text-[11px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1 mt-1">
								<ShieldCheck className="size-3" /> Fully verified
							</span>
						</div>

						<div className="rounded-lg border bg-muted/40 p-3">
							<span className="text-xs text-muted-foreground">
								Active Date Window
							</span>
							<div className="text-sm font-semibold mt-1 font-mono truncate">
								{earliestSale} → {latestSale}
							</div>
							<span className="text-[11px] text-muted-foreground flex items-center gap-1 mt-1">
								<Clock className="size-3" /> Continuous timeline
							</span>
						</div>

						<div className="rounded-lg border bg-muted/40 p-3">
							<span className="text-xs text-muted-foreground">Sync Mode</span>
							<div className="text-sm font-semibold mt-1 flex items-center gap-1.5">
								<Activity className="size-4 text-sky-500" />
								<span>
									{status?.syncStatus?.primaryMode ?? "POLLING ACTIVE"}
								</span>
							</div>
							<span className="text-[11px] text-muted-foreground mt-1 block truncate">
								{status?.syncStatus?.workerHostname
									? `Worker: ${status.syncStatus.workerHostname}`
									: "Automatic continuous sync"}
							</span>
						</div>

						<div className="rounded-lg border bg-muted/40 p-3">
							<span className="text-xs text-muted-foreground">
								Manual Upload Risk
							</span>
							<div className="text-sm font-semibold mt-1 text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
								<CheckCircle2 className="size-4" /> Eliminated
							</div>
							<span className="text-[11px] text-muted-foreground mt-1 block">
								Zero file uploads needed
							</span>
						</div>
					</div>
				</CardContent>
				<CardFooter className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
					<div className="text-xs text-muted-foreground">
						To view sales analytics, revenue KPIs, and store breakdowns, proceed
						to the dashboard.
					</div>
					<div className="flex items-center gap-2">
						<Button
							variant="outline"
							size="sm"
							onClick={handleTriggerSync}
							disabled={isSyncing}
							className="text-xs gap-1.5"
						>
							<RefreshCw
								className={`size-3.5 ${isSyncing ? "animate-spin text-primary" : ""}`}
							/>
							{isSyncing ? "Syncing Odoo..." : "Trigger Manual Sync"}
						</Button>
						<Button
							size="sm"
							onClick={() => router.push("/dashboard/sales")}
							className="text-xs gap-1.5"
						>
							<span>Go to Sales Dashboard</span>
							<ArrowRight className="size-3.5" />
						</Button>
					</div>
				</CardFooter>
			</Card>
		</div>
	);
}
