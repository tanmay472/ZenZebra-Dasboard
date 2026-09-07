import { sql } from "../../db";
import { refreshMaterializedViews } from "../../materialized-views";
import {
	insertDeadLetterJob,
	logSyncTelemetry,
} from "../../repositories/odoo.repository";
import type { OdooClient } from "../client";
import { syncCustomers } from "./syncCustomers";
import { syncInventory } from "./syncInventory";
import { syncProducts } from "./syncProducts";
import { syncSales } from "./syncSales";

const BASE_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 30000;

/**
 * Classifies a sync failure so permanent errors (bad request, validation,
 * access denied) dead-letter immediately instead of burning through retries
 * that can never succeed. Anything not recognized as permanent is treated
 * as transient (network blip, timeout, session expiry) and retried as before.
 */
export function classifyError(message: string): "transient" | "permanent" {
	if (
		/RPC Error|invalid|does not exist|access denied|forbidden|403/i.test(
			message,
		)
	) {
		return "permanent";
	}
	return "transient";
}

export type QueueJobType =
	| "products"
	| "customers"
	| "inventory"
	| "sales_orders"
	| "analytics_refresh";

export type PriorityLevel = "HIGH" | "MEDIUM" | "LOW";

export interface QueueJob {
	id: string;
	type: QueueJobType;
	priority: PriorityLevel;
	lastSyncTime: string | null;
	attempts: number;
	maxRetries: number;
	createdAt: number;
	nextRetryAt?: number;
}

export class SyncQueueManager {
	private queue: QueueJob[] = [];
	private deadLetterQueue: Array<QueueJob & { error: string }> = [];
	private isProcessing = false;

	/** Enqueue jobs grouped by priority */
	public enqueueBatch(lastSyncMap: Record<string, string | null>): void {
		const timestamp = Date.now();
		const jobDefs: Array<{ type: QueueJobType; priority: PriorityLevel }> = [
			{ type: "inventory", priority: "HIGH" },
			{ type: "sales_orders", priority: "HIGH" },
			{ type: "products", priority: "MEDIUM" },
			{ type: "customers", priority: "MEDIUM" },
			{ type: "analytics_refresh", priority: "LOW" },
		];

		for (const def of jobDefs) {
			const jobId = `${def.type}_${timestamp}`;
			if (!this.queue.some((j) => j.type === def.type)) {
				this.queue.push({
					id: jobId,
					type: def.type,
					priority: def.priority,
					lastSyncTime: lastSyncMap[def.type] || null,
					attempts: 0,
					maxRetries: 3,
					createdAt: timestamp,
				});
			}
		}
	}

	public getPendingCount(): number {
		return this.queue.length;
	}

	public getDeadLetterCount(): number {
		return this.deadLetterQueue.length;
	}

	public getDeadLetterJobs() {
		return [...this.deadLetterQueue];
	}

	private async executeSingleJob(
		client: OdooClient,
		job: QueueJob,
	): Promise<number> {
		const startedAt = new Date().toISOString();
		job.attempts += 1;

		try {
			let count = 0;
			if (job.type === "products") {
				count = await syncProducts(client, job.lastSyncTime);
			} else if (job.type === "customers") {
				count = await syncCustomers(client, job.lastSyncTime);
			} else if (job.type === "inventory") {
				count = await syncInventory(client, job.lastSyncTime);
			} else if (job.type === "sales_orders") {
				count = await syncSales(client, job.lastSyncTime);
			} else if (job.type === "analytics_refresh") {
				await refreshMaterializedViews(sql);
				count = 1;
			}

			await logSyncTelemetry(
				job.type,
				startedAt,
				new Date().toISOString(),
				"success",
				count,
				null,
				job.attempts,
				this.queue.length,
				"active",
			);

			return count;
		} catch (err: any) {
			const errMsg = err instanceof Error ? err.message : String(err);
			await logSyncTelemetry(
				job.type,
				startedAt,
				new Date().toISOString(),
				"failed",
				0,
				errMsg,
				job.attempts,
				this.queue.length,
				"active",
			);
			throw err;
		}
	}

	/** Process jobs concurrently by priority level */
	public async processQueue(client: OdooClient): Promise<{
		totalProcessedRecords: number;
		hasChanges: boolean;
		errors: string[];
	}> {
		if (this.isProcessing) {
			return { totalProcessedRecords: 0, hasChanges: false, errors: [] };
		}

		this.isProcessing = true;
		let totalProcessedRecords = 0;
		let hasChanges = false;
		const errors: string[] = [];
		const now = Date.now();

		// Jobs backing off after a transient failure stay in the queue
		// untouched this cycle; only "due" jobs get processed.
		const isDue = (j: QueueJob) => (j.nextRetryAt ?? 0) <= now;
		const notDue = this.queue.filter((j) => !isDue(j));
		const due = this.queue.filter(isDue);

		const highPriority = due.filter((j) => j.priority === "HIGH");
		const mediumPriority = due.filter((j) => j.priority === "MEDIUM");
		const lowPriority = due.filter((j) => j.priority === "LOW");

		this.queue = notDue;

		const handleFailure = async (job: QueueJob, reason: unknown) => {
			const errMsg = reason instanceof Error ? reason.message : String(reason);
			errors.push(`${job.type}: ${errMsg}`);

			const classification = classifyError(errMsg);
			const exhausted = job.attempts >= job.maxRetries;

			if (classification === "permanent" || exhausted) {
				this.deadLetterQueue.push({ ...job, error: errMsg });
				try {
					await insertDeadLetterJob({
						jobType: job.type,
						attempts: job.attempts,
						errorMessage: errMsg,
						lastSyncTime: job.lastSyncTime,
					});
				} catch (dlqErr) {
					console.error(
						"[SyncQueueManager] Failed to persist dead-letter job:",
						dlqErr,
					);
				}
			} else {
				job.nextRetryAt =
					now + Math.min(BASE_BACKOFF_MS * 2 ** job.attempts, MAX_BACKOFF_MS);
				this.queue.push(job);
			}
		};

		// 1. Process HIGH priority (Inventory & Sales) simultaneously in parallel
		if (highPriority.length > 0) {
			const results = await Promise.allSettled(
				highPriority.map((j) => this.executeSingleJob(client, j)),
			);
			for (let i = 0; i < results.length; i++) {
				const res = results[i];
				const job = highPriority[i];
				if (res.status === "fulfilled") {
					totalProcessedRecords += res.value;
					if (res.value > 0) hasChanges = true;
				} else {
					await handleFailure(job, res.reason);
				}
			}
		}

		// 2. Process MEDIUM priority (Products & Customers) simultaneously in parallel
		if (mediumPriority.length > 0) {
			const results = await Promise.allSettled(
				mediumPriority.map((j) => this.executeSingleJob(client, j)),
			);
			for (let i = 0; i < results.length; i++) {
				const res = results[i];
				const job = mediumPriority[i];
				if (res.status === "fulfilled") {
					totalProcessedRecords += res.value;
					if (res.value > 0) hasChanges = true;
				} else {
					await handleFailure(job, res.reason);
				}
			}
		}

		// 3. Process LOW priority (Analytics Refresh)
		for (const job of lowPriority) {
			try {
				const count = await this.executeSingleJob(client, job);
				totalProcessedRecords += count;
				if (count > 0) hasChanges = true;
			} catch (err: any) {
				await handleFailure(job, err);
			}
		}

		this.isProcessing = false;
		return { totalProcessedRecords, hasChanges, errors };
	}
}
