import {
	getLastSyncTime,
	logSyncTelemetry,
} from "../../repositories/odoo.repository";
import { OdooClient } from "../client";
import { syncCustomers } from "./syncCustomers";
import { syncInventory } from "./syncInventory";
import { syncProducts } from "./syncProducts";
import { syncSales } from "./syncSales";

/**
 * Executes the entire Odoo Standard to ZenZebra CRM synchronization pipeline.
 *
 * @deprecated As of the Oracle-hosted always-on worker
 * (`src/lib/odoo/sync/worker.ts` + `queue.ts`), this is no longer the
 * primary sync engine. It has no queue, retry/backoff, dead-letter queue,
 * or advisory locking — running it automatically alongside the worker would
 * risk duplicate/racing writes to the same tables. It is retained only as:
 * (a) a manually-controlled backup path, gated behind
 * `LEGACY_CRON_SYNC_ENABLED=true` in the three cron routes that call it
 * (`src/app/api/cron/{route,sync,odoo-sync}.ts` — disabled by default), and
 * (b) the implementation behind `reconciliation.ts`'s manual, admin-triggered
 * `runCatchupSweep()`, which is a deliberate one-off action, not an
 * automatic recurring writer, and is intentionally NOT gated by that flag.
 * Do not wire this into any new automatic/scheduled trigger.
 */
export async function runSyncPipeline(): Promise<void> {
	console.log("==================================================");
	console.log("🔄 Starting ZenZebra Odoo Sync Engine Pipeline...");
	console.log("==================================================");

	const client = new OdooClient();
	const isMock = client.getMockModeStatus();
	if (isMock) {
		console.log(
			"ℹ️ Running sync in [Mock Validation Mode] with simulated data.",
		);
	}

	const pipelineStart = new Date().toISOString();
	let totalRecords = 0;
	let hasError = false;
	let errorMsg: string | null = null;

	try {
		// Authenticate first (failure guard)
		await client.authenticate();

		// 1. Sync Products (Variants & Stock)
		const productStart = new Date().toISOString();
		let productCount = 0;
		try {
			const lastSync = await getLastSyncTime("products");
			productCount = await syncProducts(client, lastSync);
			totalRecords += productCount;
			await logSyncTelemetry(
				"products",
				productStart,
				new Date().toISOString(),
				"success",
				productCount,
				null,
			);
		} catch (err: any) {
			console.error("❌ Products sync failed:", err.message);
			await logSyncTelemetry(
				"products",
				productStart,
				new Date().toISOString(),
				"failed",
				0,
				err.message,
			);
			hasError = true;
			errorMsg = `Products sync failed: ${err.message}`;
		}

		// 2. Sync Customers (res.partner)
		const customerStart = new Date().toISOString();
		let customerCount = 0;
		try {
			const lastSync = await getLastSyncTime("customers");
			customerCount = await syncCustomers(client, lastSync);
			totalRecords += customerCount;
			await logSyncTelemetry(
				"customers",
				customerStart,
				new Date().toISOString(),
				"success",
				customerCount,
				null,
			);
		} catch (err: any) {
			console.error("❌ Customers sync failed:", err.message);
			await logSyncTelemetry(
				"customers",
				customerStart,
				new Date().toISOString(),
				"failed",
				0,
				err.message,
			);
			hasError = true;
			errorMsg = errorMsg
				? `${errorMsg}; Customers: ${err.message}`
				: `Customers: ${err.message}`;
		}

		// 3. Sync Sales (sale.order and pos.order)
		const salesStart = new Date().toISOString();
		let salesCount = 0;
		try {
			const lastSync = await getLastSyncTime("sales");
			salesCount = await syncSales(client, lastSync);
			totalRecords += salesCount;
			await logSyncTelemetry(
				"sales",
				salesStart,
				new Date().toISOString(),
				"success",
				salesCount,
				null,
			);
		} catch (err: any) {
			console.error("❌ Sales sync failed:", err.message);
			await logSyncTelemetry(
				"sales",
				salesStart,
				new Date().toISOString(),
				"failed",
				0,
				err.message,
			);
			hasError = true;
			errorMsg = errorMsg
				? `${errorMsg}; Sales: ${err.message}`
				: `Sales: ${err.message}`;
		}

		// 4. Sync Inventory (stock.quant snapshots)
		const inventoryStart = new Date().toISOString();
		let inventoryCount = 0;
		try {
			inventoryCount = await syncInventory(client, null);
			totalRecords += inventoryCount;
			await logSyncTelemetry(
				"inventory",
				inventoryStart,
				new Date().toISOString(),
				"success",
				inventoryCount,
				null,
			);
		} catch (err: any) {
			console.error("❌ Inventory sync failed:", err.message);
			await logSyncTelemetry(
				"inventory",
				inventoryStart,
				new Date().toISOString(),
				"failed",
				0,
				err.message,
			);
			hasError = true;
			errorMsg = errorMsg
				? `${errorMsg}; Inventory: ${err.message}`
				: `Inventory: ${err.message}`;
		}

		const pipelineEnd = new Date().toISOString();
		const finalStatus = hasError ? "failed" : "success";

		await logSyncTelemetry(
			"full",
			pipelineStart,
			pipelineEnd,
			finalStatus,
			totalRecords,
			errorMsg,
		);

		console.log("==================================================");
		console.log(`✅ Odoo Sync Finished: [${finalStatus.toUpperCase()}]`);
		console.log(`📈 Total records processed: ${totalRecords}`);
		if (errorMsg) {
			console.log(`⚠️ Errors reported: ${errorMsg}`);
		}
		console.log("==================================================");
	} catch (authErr: any) {
		console.error(
			"❌ Critical: Odoo Client Authentication failed. Stopping sync. Error:",
			authErr.message,
		);
		await logSyncTelemetry(
			"full",
			pipelineStart,
			new Date().toISOString(),
			"failed",
			0,
			`Authentication failed: ${authErr.message}`,
		);
	}
}

// Standalone execution runner
if (require.main === module) {
	runSyncPipeline().catch((err) => {
		console.error("❌ Pipeline run error:", err);
		process.exit(1);
	});
}
