"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

export interface UseRealtimeFreshnessOptions {
	intervalMs?: number; // default 5000ms
	enabled?: boolean;
}

/**
 * Client-side real-time freshness hook.
 * Polls a server freshness signal every 5 seconds (ONLY while the tab is
 * active) and triggers Next.js `router.refresh()` automatically when it
 * changes.
 *
 * The signal is the always-on poller's own `lastChangeTimestamp` (updated
 * every 1-15s by AlwaysOnSyncWorker whenever a poll cycle finds real
 * changes — src/lib/odoo/sync/worker.ts), not `webhookQueue.lastEventReceived`.
 * Odoo webhooks are not currently configured/firing in this environment
 * (webhook_events has had no new rows since 2026-09-04) — keying the
 * refresh trigger off a channel with no live traffic meant the dashboard
 * only ever updated on a manual reload, regardless of how fresh the
 * underlying DB actually was. The webhook signal is kept as a secondary
 * trigger so it starts working immediately if webhooks are ever wired up,
 * without needing this hook changed again.
 */
export function useRealtimeFreshness(
	options: UseRealtimeFreshnessOptions = {},
): void {
	const { intervalMs = 5000, enabled = true } = options;
	const router = useRouter();
	const lastProcessedRef = useRef<string | null>(null);

	useEffect(() => {
		if (!enabled) return;

		let isMounted = true;
		const checkFreshness = async () => {
			if (
				typeof document !== "undefined" &&
				document.visibilityState !== "visible"
			) {
				return; // Skip if tab is hidden
			}

			try {
				const res = await fetch("/api/health", {
					method: "GET",
					cache: "no-store",
				});
				if (!res.ok) return;
				const data = await res.json();
				const workerChange = data?.checks?.worker?.state?.lastChangeTimestamp;
				const webhookReceived = data?.checks?.webhookQueue?.lastEventReceived;
				// Combine both signals into one key — either one changing means
				// new data landed, and whichever is actually live drives the refresh.
				const signal =
					(workerChange ? `w:${workerChange}` : "") +
					(webhookReceived ? `h:${webhookReceived}` : "");

				if (signal) {
					if (lastProcessedRef.current && lastProcessedRef.current !== signal) {
						console.log(
							"[realtimeFreshness] New sync data detected. Triggering router.refresh()",
						);
						router.refresh();
						if (typeof window !== "undefined") {
							window.dispatchEvent(new CustomEvent("odoo-sync-updated"));
						}
					}
					lastProcessedRef.current = signal;
				}
			} catch {
				// Silent ignore network errors
			}
		};

		const timer = setInterval(() => {
			if (isMounted) {
				checkFreshness();
			}
		}, intervalMs);

		return () => {
			isMounted = false;
			clearInterval(timer);
		};
	}, [enabled, intervalMs, router]);
}
