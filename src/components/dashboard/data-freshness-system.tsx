"use client";

import { format } from "date-fns";
import { AlertCircle, Clock, Database, RefreshCw, Zap } from "lucide-react";
import { memo, useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";

interface SyncStatusData {
	status: "LIVE" | "FRESH" | "SYNCING" | "DELAYED" | "OFFLINE";
	lastSyncAt: string | null;
	secondsAgo: number | null;
	formattedTimeAgo: string;
	isStale: boolean;
	entityStatuses?: Record<
		string,
		{
			syncType: string;
			lastSyncAt: string | null;
			recordsProcessed: number;
			status: string;
			errorMessage: string | null;
			secondsAgo: number | null;
			isStale: boolean;
		}
	>;
}

export const DataFreshnessSystem = memo(function DataFreshnessSystem() {
	const [data, setData] = useState<SyncStatusData | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [_error, setError] = useState<string | null>(null);

	const fetchStatus = useCallback(async () => {
		try {
			const res = await fetch("/api/sync/status", { cache: "no-store" });
			const json = await res.json();

			if (json.success) {
				setData(json.data);
				setError(null);
			} else {
				setError("Failed to load sync status");
			}
		} catch (err) {
			console.error("Failed to fetch sync status:", err);
			setError("Network error");
		} finally {
			setIsLoading(false);
		}
	}, []);

	useEffect(() => {
		fetchStatus();
		// Poll status every 5 seconds for live status
		const interval = setInterval(fetchStatus, 5000);
		return () => clearInterval(interval);
	}, [fetchStatus]);

	if (isLoading && !data) {
		return <Skeleton className="h-9 w-28 rounded-full" />;
	}

	const status = data?.status || "OFFLINE";
	const timeAgo = data?.formattedTimeAgo || "just now";

	return (
		<Sheet>
			<SheetTrigger asChild>
				<button
					type="button"
					className="flex h-9 items-center justify-center gap-2 rounded-full border bg-muted/20 px-3.5 text-xs font-medium leading-none outline-none transition-colors hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50"
				>
					{status === "LIVE" && (
						<>
							<span className="relative flex size-2">
								<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
								<span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
							</span>
							<span className="font-semibold text-emerald-600 dark:text-emerald-400">
								🟢 LIVE — Last Sync {timeAgo}
							</span>
						</>
					)}
					{status === "FRESH" && (
						<>
							<span className="relative flex size-2">
								<span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
							</span>
							<span className="font-semibold text-emerald-600 dark:text-emerald-400">
								🟢 FRESH — {timeAgo}
							</span>
						</>
					)}
					{status === "SYNCING" && (
						<>
							<RefreshCw className="size-3.5 animate-spin text-blue-500" />
							<span className="font-semibold text-blue-600 dark:text-blue-400">
								🟡 SYNCING — {timeAgo}
							</span>
						</>
					)}
					{status === "DELAYED" && (
						<>
							<AlertCircle className="size-3.5 text-amber-500" />
							<span className="font-semibold text-amber-600 dark:text-amber-400">
								🔴 DELAYED — {timeAgo}
							</span>
						</>
					)}
					{status === "OFFLINE" && (
						<span className="text-muted-foreground font-semibold">
							🔴 OFFLINE
						</span>
					)}
				</button>
			</SheetTrigger>

			<SheetContent className="w-[400px] sm:w-[540px]">
				<SheetHeader className="mb-6">
					<SheetTitle className="flex items-center">
						<Database className="mr-2 size-5 text-muted-foreground" />
						Odoo 19 Live Synchronization Telemetry
					</SheetTitle>
					<SheetDescription>
						Near real-time incremental synchronization powered by Neon
						PostgreSQL.
					</SheetDescription>
				</SheetHeader>

				<div className="space-y-4">
					<Card>
						<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
							<CardTitle className="text-sm font-medium">Sync Status</CardTitle>
							<Zap className="size-4 text-emerald-500" />
						</CardHeader>
						<CardContent>
							<div className="flex items-center gap-2">
								<Badge
									className={
										status === "LIVE" || status === "FRESH"
											? "bg-emerald-500 text-white"
											: status === "SYNCING"
												? "bg-blue-500 text-white"
												: "bg-amber-500 text-white"
									}
								>
									{status}
								</Badge>
								<span className="text-xs text-muted-foreground">
									Last successful sync: {timeAgo}
								</span>
							</div>
						</CardContent>
					</Card>

					<Card>
						<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
							<CardTitle className="text-sm font-medium">
								Last Write Date Timestamp
							</CardTitle>
							<Clock className="size-4 text-muted-foreground" />
						</CardHeader>
						<CardContent>
							<div className="text-lg font-semibold">
								{data?.lastSyncAt
									? format(new Date(data.lastSyncAt), "dd MMM yyyy, HH:mm:ss")
									: "N/A"}
							</div>
						</CardContent>
					</Card>

					{status === "DELAYED" && (
						<div className="bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20 rounded-md p-3 flex items-start mt-4">
							<AlertCircle className="size-5 mr-2 mt-0.5 shrink-0" />
							<div className="text-sm">
								<p className="font-semibold">Sync Delay Warning</p>
								<p className="opacity-90">
									Data update latency is currently {timeAgo}. Click below to
									manually trigger an immediate Odoo API sync.
								</p>
							</div>
						</div>
					)}

					<div className="pt-4 border-t border-border mt-4">
						<SyncTriggerButton onSyncComplete={fetchStatus} />
					</div>
				</div>
			</SheetContent>
		</Sheet>
	);
});

function SyncTriggerButton({ onSyncComplete }: { onSyncComplete: () => void }) {
	const [isSyncing, setIsSyncing] = useState(false);
	const [syncResult, setSyncResult] = useState<{
		success: boolean;
		message: string;
	} | null>(null);

	const handleSync = async () => {
		setIsSyncing(true);
		setSyncResult(null);

		try {
			const res = await fetch("/api/cron/odoo-sync", {
				method: "GET",
				headers: {
					Authorization: "Bearer zenzebra_cron_secret_2026",
				},
			});
			const json = await res.json();

			if (res.ok && json.success) {
				setSyncResult({
					success: true,
					message: `✅ Sync completed successfully! Processed ${json.totalRecords ?? 0} records.`,
				});
				onSyncComplete();
			} else {
				setSyncResult({
					success: false,
					message: `❌ Sync failed: ${json.error || json.detail || "Authentication or network error"}`,
				});
			}
		} catch (err: any) {
			setSyncResult({
				success: false,
				message: `❌ Connection error: ${err.message || String(err)}`,
			});
		} finally {
			setIsSyncing(false);
		}
	};

	return (
		<div className="space-y-3">
			<button
				type="button"
				onClick={handleSync}
				disabled={isSyncing}
				className="w-full flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-xs font-semibold text-primary-foreground shadow-sm transition-all hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
			>
				<RefreshCw className={`size-4 ${isSyncing ? "animate-spin" : ""}`} />
				<span>
					{isSyncing ? "Syncing Data from Odoo API..." : "Sync Odoo Data Now"}
				</span>
			</button>

			{syncResult && (
				<div
					className={`text-xs p-3 rounded-md border font-medium ${
						syncResult.success
							? "bg-emerald-500/10 text-emerald-700 border-emerald-500/20"
							: "bg-destructive/10 text-destructive border-destructive/20"
					}`}
				>
					{syncResult.message}
				</div>
			)}
		</div>
	);
}
