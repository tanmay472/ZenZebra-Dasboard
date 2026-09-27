"use client";

import {
	Activity,
	AlertCircle,
	CheckCircle2,
	Clock,
	RefreshCw,
	Zap,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function PipelineStatusBanner() {
	const [status, setStatus] = useState<any>(null);
	const [isRefreshing, setIsRefreshing] = useState(false);
	const [isSyncing, setIsSyncing] = useState(false);

	const fetchStatus = useCallback(async () => {
		setIsRefreshing(true);
		try {
			const res = await fetch("/api/sales/status");
			const json = await res.json();
			if (json.success) {
				setStatus(json.data);
			}
		} catch (err) {
			console.error("Failed to fetch pipeline status", err);
		} finally {
			setIsRefreshing(false);
		}
	}, []);

	const handleSync = async () => {
		setIsSyncing(true);
		try {
			const res = await fetch("/api/cron/odoo-sync?force=true");
			const json = await res.json();
			if (res.ok && json.success) {
				toast.success(
					`Odoo sync completed! Processed ${json.totalRecords ?? 0} records.`,
				);
				fetchStatus();
			} else {
				toast.error(`Sync failed: ${json.error || json.detail || "Error"}`);
			}
		} catch (err: any) {
			toast.error(`Connection error: ${err.message || String(err)}`);
		} finally {
			setIsSyncing(false);
		}
	};

	useEffect(() => {
		fetchStatus();
	}, [fetchStatus]);

	const latestSale =
		status?.dateRange?.end ||
		status?.maxDate ||
		status?.dataFreshness?.latestSaleDate;

	const isLiveSync =
		status?.syncStatus?.primaryMode === "WEBHOOK ACTIVE" ||
		status?.syncStatus?.primaryMode === "POLLING ACTIVE";

	return (
		<div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/80 bg-card/60 backdrop-blur p-3.5 shadow-xs transition-all">
			<div className="flex flex-wrap items-center gap-3">
				<div className="flex items-center gap-2 font-semibold text-xs tracking-wide uppercase text-foreground">
					<Zap
						className={`size-4 ${
							isLiveSync ? "text-emerald-500 animate-pulse" : "text-amber-500"
						}`}
					/>
					<span>Pipeline Sync:</span>
				</div>

				{status?.syncStatus?.primaryMode === "WEBHOOK ACTIVE" ? (
					<Badge
						variant="outline"
						className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20 gap-1.5 py-0.5 text-xs"
						title={`Verified organic webhooks: ${status?.syncStatus?.organicWebhookCount ?? 0} events`}
					>
						<CheckCircle2 className="size-3.5" />
						Odoo Webhooks Active
					</Badge>
				) : status?.syncStatus?.primaryMode === "POLLING ACTIVE" ? (
					<Badge
						variant="outline"
						className="bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20 gap-1.5 py-0.5 text-xs"
						title={`Odoo polling worker alive (${status?.syncStatus?.workerHostname ?? "cloud"} updated ${status?.syncStatus?.workerLastSeenSecondsAgo ?? 0}s ago)`}
					>
						<Activity className="size-3.5" />
						Odoo Polling Sync Active
					</Badge>
				) : status?.syncStatus?.primaryMode === "DELAYED" ? (
					<Badge
						variant="outline"
						className="bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20 gap-1.5 py-0.5 text-xs"
						title={`Worker heartbeat delayed (${status?.syncStatus?.workerLastSeenSecondsAgo ?? 0}s ago)`}
					>
						<Clock className="size-3.5" />
						Odoo Sync Delayed
					</Badge>
				) : status?.syncStatus?.primaryMode === "ERROR" ? (
					<Badge
						variant="outline"
						className="bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20 gap-1.5 py-0.5 text-xs"
						title="Sync worker reported errors or dead letter items"
					>
						<AlertCircle className="size-3.5" />
						Odoo Sync Error
					</Badge>
				) : (
					<Badge
						variant="outline"
						className="bg-zinc-500/10 text-zinc-600 dark:text-zinc-400 border-zinc-500/20 gap-1.5 py-0.5 text-xs"
						title="No organic webhooks or active sync worker telemetry recorded"
					>
						<AlertCircle className="size-3.5" />
						Odoo Webhook: Not Verified
					</Badge>
				)}

				<Badge
					variant="outline"
					className="bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20 gap-1.5 py-0.5 text-xs"
				>
					<Activity className="size-3.5" />
					Staging-to-Fact Validated
				</Badge>

				{latestSale && (
					<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
						<Clock className="size-3.5" />
						<span>
							Latest Sale: <strong>{latestSale}</strong>
						</span>
					</div>
				)}
			</div>

			<div className="flex items-center gap-2">
				{status?.totalRows !== undefined && (
					<span className="text-xs text-muted-foreground font-mono">
						{status.totalRows.toLocaleString()} fact rows
					</span>
				)}
				<Button
					variant="outline"
					size="xs"
					onClick={handleSync}
					disabled={isSyncing}
					className="text-xs gap-1.5 h-7 px-2.5 font-medium shadow-2xs"
					title="Trigger immediate Odoo sync"
				>
					<RefreshCw
						className={`size-3 ${isSyncing ? "animate-spin text-primary" : ""}`}
					/>
					{isSyncing ? "Syncing..." : "Sync Odoo"}
				</Button>
				<Button
					variant="ghost"
					size="icon-xs"
					onClick={fetchStatus}
					disabled={isRefreshing || isSyncing}
					className="text-muted-foreground hover:text-foreground"
					title="Refresh pipeline status"
				>
					<RefreshCw
						className={`size-3.5 ${isRefreshing ? "animate-spin" : ""}`}
					/>
				</Button>
			</div>
		</div>
	);
}
