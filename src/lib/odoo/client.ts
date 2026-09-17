import * as path from "node:path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

export interface OdooSession {
	sessionId: string;
	uid: number;
	userContext: Record<string, any>;
	db: string;
	isApiKey?: boolean;
}

export class OdooClient {
	private url: string;
	private db: string;
	private username: string;
	private password?: string;
	private session: OdooSession | null = null;
	private isMockMode = false;

	constructor() {
		this.url = (process.env.ODOO_URL || "").replace(/\/$/, "");
		this.db = process.env.ODOO_DB || "";
		this.username = process.env.ODOO_USERNAME || "";
		this.password = process.env.ODOO_PASSWORD || "";

		if (!this.url || !this.db || !this.username || !this.password) {
			console.warn(
				"⚠️ Odoo connection parameters are incomplete. Running in [Mock Validation Mode].",
			);
			this.isMockMode = true;
		}
	}

	public getMockModeStatus(): boolean {
		return this.isMockMode;
	}

	/**
	 * Authenticates with Odoo using the configured credentials.
	 */
	public async authenticate(): Promise<OdooSession> {
		if (this.isMockMode) {
			console.log("[OdooClient] Mock Authentication Succeeded");
			this.session = {
				sessionId: "mock_session_id_12345",
				uid: 2,
				userContext: { lang: "en_US", tz: "UTC" },
				db: this.db || "mock_db",
			};
			return this.session;
		}

		console.log(
			`[OdooClient] Authenticating to ${this.url} (DB: ${this.db}, User: ${this.username})...`,
		);

		try {
			const response = await fetch(`${this.url}/web/session/authenticate`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					method: "call",
					params: {
						db: this.db,
						login: this.username,
						password: this.password,
					},
				}),
			});

			if (response.ok) {
				const data = await response.json();
				if (!data.error && data.result?.uid) {
					const setCookie = response.headers.get("set-cookie");
					let cookieSessionId = "";
					if (setCookie) {
						const match = setCookie.match(/session_id=([^;]+)/);
						if (match) {
							cookieSessionId = match[1];
						}
					}

					this.session = {
						sessionId: data.result.session_id || cookieSessionId,
						uid: data.result.uid,
						userContext: data.result.user_context || {},
						db: data.result.db || this.db,
						isApiKey: false,
					};

					console.log(
						`[OdooClient] Session Auth successful. Session ID: ${this.session.sessionId.substring(0, 8)}... (UID: ${this.session.uid})`,
					);
					return this.session;
				}
			}
		} catch (sessionErr) {
			console.warn(
				"[OdooClient] /web/session/authenticate failed, falling back to JSON-RPC API Key auth:",
				sessionErr,
			);
		}

		// Fallback for Odoo API Keys via /jsonrpc service: "common", method: "authenticate"
		console.log(
			`[OdooClient] Attempting JSON-RPC API Key authentication to ${this.url}...`,
		);
		const jsonRpcRes = await fetch(`${this.url}/jsonrpc`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				method: "call",
				params: {
					service: "common",
					method: "authenticate",
					args: [this.db, this.username, this.password, {}],
				},
				id: 1,
			}),
		});

		if (!jsonRpcRes.ok) {
			throw new Error(
				`HTTP Error during JSON-RPC authentication: ${jsonRpcRes.status} ${jsonRpcRes.statusText}`,
			);
		}

		const jsonRpcData = await jsonRpcRes.json();
		if (jsonRpcData.error) {
			throw new Error(
				`Odoo API Key Authentication Failed: ${jsonRpcData.error.message} - ${JSON.stringify(jsonRpcData.error.data)}`,
			);
		}

		const uid = jsonRpcData.result;
		if (typeof uid !== "number" || uid <= 0) {
			throw new Error(
				"Odoo Authentication Failed: Invalid API Key or user credentials.",
			);
		}

		this.session = {
			sessionId: `apikey_session_${uid}`,
			uid,
			userContext: { lang: "en_US", tz: "Asia/Kolkata" },
			db: this.db,
			isApiKey: true,
		};

		console.log(
			`[OdooClient] API Key JSON-RPC Auth successful. (UID: ${this.session.uid})`,
		);
		return this.session;
	}

	/**
	 * Calls a method on an Odoo model via JSON-RPC /web/dataset/call_kw
	 */
	public async callKw<T = any>(
		model: string,
		method: string,
		args: any[] = [],
		kwargs: Record<string, any> = {},
	): Promise<T> {
		if (this.isMockMode) {
			return this.mockCallKw<T>(model, method, args, kwargs);
		}

		if (!this.session) {
			await this.authenticate();
		}

		// A single request must never be able to hang the calling job forever
		// (this was a confirmed structural gap — see
		// docs/ODOO_SOURCE_OF_TRUTH_AUDIT.md's forensic audit — the previous
		// bare fetch() here had no bound at all). This timeout is per-request,
		// not per-job: a job making many paginated calls (e.g. a 39-minute
		// historical sales backfill) is expected and fine — each individual
		// call just can't silently hang past ODOO_REQUEST_TIMEOUT_MS.
		const timeoutMs = Number(process.env.ODOO_REQUEST_TIMEOUT_MS) || 60_000;
		const traceId = `okw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

		const executeCall = async () => {
			const startedAt = Date.now();
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			let response: Response;
			try {
				if (this.session?.isApiKey) {
					response = await fetch(`${this.url}/jsonrpc`, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							jsonrpc: "2.0",
							method: "call",
							params: {
								service: "object",
								method: "execute_kw",
								args: [
									this.db,
									this.session.uid,
									this.password,
									model,
									method,
									args,
									kwargs,
								],
							},
							id: Date.now(),
						}),
						signal: controller.signal,
					});
				} else {
					response = await fetch(`${this.url}/web/dataset/call_kw`, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Cookie: `session_id=${this.session?.sessionId}`,
						},
						body: JSON.stringify({
							jsonrpc: "2.0",
							method: "call",
							params: {
								model,
								method,
								args,
								kwargs: {
									context: this.session?.userContext,
									...kwargs,
								},
							},
						}),
						signal: controller.signal,
					});
				}
			} catch (err: any) {
				const elapsedMs = Date.now() - startedAt;
				if (err.name === "AbortError") {
					console.error(
						`[OdooClient] TIMEOUT trace_id=${traceId} model=${model} method=${method} elapsed_ms=${elapsedMs} timeout_ms=${timeoutMs} error_type=timeout`,
					);
					throw new Error(
						`Odoo request timed out after ${timeoutMs}ms [${model}.${method}]`,
					);
				}
				console.error(
					`[OdooClient] NETWORK_ERROR trace_id=${traceId} model=${model} method=${method} elapsed_ms=${elapsedMs} error_type=network message=${err.message}`,
				);
				throw err;
			} finally {
				clearTimeout(timer);
			}

			if (response.status === 401) {
				throw new Error("SESSION_EXPIRED");
			}

			if (!response.ok) {
				throw new Error(
					`HTTP Error during callKw: ${response.status} ${response.statusText}`,
				);
			}

			const data = await response.json();
			if (data.error) {
				// Detect Odoo session expiration
				const errDataStr = JSON.stringify(data.error.data || {});
				if (
					data.error.message?.includes("Session expired") ||
					errDataStr.includes("expired")
				) {
					throw new Error("SESSION_EXPIRED");
				}
				const detailedMsg =
					data.error.data?.message ||
					data.error.data?.arguments?.join(", ") ||
					"";
				throw new Error(
					`RPC Error in callKw [${model}.${method}]: ${data.error.message}. Detail: ${detailedMsg}`,
				);
			}

			return data.result as T;
		};

		try {
			return await executeCall();
		} catch (err: any) {
			if (err.message === "SESSION_EXPIRED") {
				console.log(
					"[OdooClient] Session expired or invalid. Attempting re-authentication...",
				);
				await this.authenticate();
				return await executeCall(); // Retry call after re-auth
			}
			throw err;
		}
	}

	/**
	 * Batch fetches records with pagination and sorting.
	 */
	public async fetchBatch<T = any>(
		model: string,
		fields: string[],
		domain: any[] = [],
		orderBy = "write_date desc",
		limit = 100,
		offset = 0,
	): Promise<T[]> {
		return await this.callKw<T[]>(model, "search_read", [], {
			fields,
			domain,
			order: orderBy,
			limit,
			offset,
		});
	}

	/**
	 * Mock Odoo Standard calls when credentials are not configured.
	 */
	private mockCallKw<T>(
		model: string,
		method: string,
		_args: any[],
		kwargs: Record<string, any>,
	): T {
		console.log(`[OdooClient] Mock callKw: ${model}.${method}(...)`);

		if (method === "fields_get") {
			const mockFields: Record<string, any> = {
				id: { type: "integer", string: "ID" },
				write_date: { type: "datetime", string: "Latest Write Date" },
				active: { type: "boolean", string: "Active" },
			};
			if (model === "product.product" || model === "product.template") {
				Object.assign(mockFields, {
					name: { type: "char", string: "Name" },
					default_code: { type: "char", string: "SKU" },
					barcode: { type: "char", string: "Barcode" },
					list_price: { type: "float", string: "Sales Price" },
					standard_price: { type: "float", string: "Cost Price" },
					qty_available: { type: "float", string: "Qty Available" },
					free_qty: { type: "float", string: "Free Qty" },
				});
			} else if (model === "res.partner") {
				Object.assign(mockFields, {
					name: { type: "char", string: "Name" },
					email: { type: "char", string: "Email" },
					mobile: { type: "char", string: "Mobile" },
					city: { type: "char", string: "City" },
					customer_rank: { type: "integer", string: "Customer Rank" },
				});
			} else if (model === "sale.order") {
				Object.assign(mockFields, {
					name: { type: "char", string: "Order Reference" },
					date_order: { type: "datetime", string: "Order Date" },
					partner_id: {
						type: "many2one",
						relation: "res.partner",
						string: "Customer",
					},
					amount_total: { type: "float", string: "Total" },
					amount_untaxed: { type: "float", string: "Untaxed Amount" },
					state: { type: "selection", string: "Status" },
					order_line: {
						type: "one2many",
						relation: "sale.order.line",
						string: "Order Lines",
					},
				});
			} else if (model === "sale.order.line") {
				Object.assign(mockFields, {
					order_id: { type: "many2one", relation: "sale.order" },
					product_id: { type: "many2one", relation: "product.product" },
					price_unit: { type: "float" },
					discount: { type: "float" },
					product_uom_qty: { type: "float" },
					price_subtotal: { type: "float" },
				});
			} else if (model === "pos.order") {
				Object.assign(mockFields, {
					name: { type: "char", string: "POS Order Reference" },
					date_order: { type: "datetime", string: "POS Order Date" },
					partner_id: {
						type: "many2one",
						relation: "res.partner",
						string: "Customer",
					},
					amount_total: { type: "float", string: "Total" },
					amount_tax: { type: "float", string: "Tax" },
					state: { type: "selection", string: "Status" },
					config_id: {
						type: "many2one",
						relation: "pos.config",
						string: "POS Config Store",
					},
					lines: {
						type: "one2many",
						relation: "pos.order.line",
						string: "POS Lines",
					},
				});
			} else if (model === "pos.order.line") {
				Object.assign(mockFields, {
					order_id: { type: "many2one", relation: "pos.order" },
					product_id: { type: "many2one", relation: "product.product" },
					price_unit: { type: "float" },
					discount: { type: "float" },
					qty: { type: "float" },
					price_subtotal: { type: "float" },
				});
			} else if (model === "stock.quant") {
				Object.assign(mockFields, {
					product_id: { type: "many2one", relation: "product.product" },
					location_id: { type: "many2one", relation: "stock.location" },
					quantity: { type: "float" },
					reserved_quantity: { type: "float" },
				});
			}
			return mockFields as any;
		}

		if (method === "search_read") {
			const limit = kwargs.limit || 10;
			const list: any[] = [];
			const nowStr = new Date().toISOString();

			for (let i = 1; i <= Math.min(limit, 5); i++) {
				if (model === "product.product" || model === "product.template") {
					list.push({
						id: 100 + i,
						name: `Mock Product variant ${i}`,
						default_code: `SKU-MOCK-${i}`,
						barcode: `890123456789${i}`,
						list_price: 1200 + i * 100,
						standard_price: 800 + i * 50,
						qty_available: 50 + i * 10,
						free_qty: 45 + i * 10,
						active: true,
						write_date: nowStr,
					});
				} else if (model === "res.partner") {
					list.push({
						id: 200 + i,
						name: `Mock Customer Name ${i}`,
						email: `customer${i}@mockexample.com`,
						mobile: `987654321${i}`,
						city: i % 2 === 0 ? "Delhi" : "Noida",
						customer_rank: i % 2 === 0 ? 1 : 2,
						active: true,
						write_date: nowStr,
					});
				} else if (model === "pos.config") {
					list.push(
						{ id: 1, name: "ZenZebra Flagship Store" },
						{ id: 2, name: "KLJ Noida Store" },
						{ id: 3, name: "Smartworks Noida Store" },
					);
					return list as any;
				} else if (model === "sale.order") {
					list.push({
						id: 300 + i,
						name: `SO${1000 + i}`,
						date_order: nowStr,
						partner_id: [201, `Mock Customer Name 1`],
						amount_total: 2500 * i,
						amount_untaxed: 2200 * i,
						state: "sale",
						write_date: nowStr,
						order_line: [400 + i],
					});
				} else if (model === "sale.order.line") {
					list.push({
						id: 400 + i,
						order_id: [301, "SO1001"],
						product_id: [101, "Mock Product variant 1"],
						price_unit: 1300,
						discount: 10.0,
						product_uom_qty: 2.0,
						price_subtotal: 2340,
						write_date: nowStr,
					});
				} else if (model === "pos.order") {
					list.push({
						id: 500 + i,
						name: `KLJ-00027${i}`,
						date_order: nowStr,
						partner_id: i % 2 === 0 ? [202, "Mock Customer Name 2"] : null,
						amount_total: i === 3 ? -2600 : 3500 * i, // Include return order
						amount_tax: i === 3 ? -200 : 300 * i,
						state: "paid",
						config_id: [
							(i % 3) + 1,
							i % 3 === 0
								? "SWN Store"
								: i % 3 === 1
									? "ZenZebra Flagship"
									: "KLJ Store",
						],
						write_date: nowStr,
						lines: [600 + i],
					});
				} else if (model === "pos.order.line") {
					list.push({
						id: 600 + i,
						order_id: [501, "KLJ-000271"],
						product_id: [102, "Mock Product variant 2"],
						price_unit: 1400,
						discount: 0,
						qty: i === 3 ? -2 : 2.0, // Negative if return
						price_subtotal: i === 3 ? -2800 : 2800,
						write_date: nowStr,
					});
				} else if (model === "stock.quant") {
					list.push({
						id: 700 + i,
						product_id: [100 + i, `Mock Product variant ${i}`],
						location_id: [12, "WH/Stock"],
						quantity: 30 + i * 5,
						reserved_quantity: i,
						write_date: nowStr,
					});
				}
			}
			return list as any;
		}

		return null as any;
	}
}

/**
 * Formats a Date object or ISO string into a timezone-naive UTC string (YYYY-MM-DD HH:MM:SS)
 * expected by Odoo Standard SaaS API filters.
 */
export function formatDateTimeForOdoo(dateInput: string | Date): string {
	const d = typeof dateInput === "string" ? new Date(dateInput) : dateInput;

	// Check if date is valid
	if (Number.isNaN(d.getTime())) {
		console.warn(
			`[OdooClient] Warning: Invalid date string received: ${dateInput}. Defaulting to current time.`,
		);
		return formatDateTimeForOdoo(new Date());
	}

	const pad = (num: number) => String(num).padStart(2, "0");

	const year = d.getUTCFullYear();
	const month = pad(d.getUTCMonth() + 1);
	const day = pad(d.getUTCDate());
	const hours = pad(d.getUTCHours());
	const minutes = pad(d.getUTCMinutes());
	const seconds = pad(d.getUTCSeconds());

	return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}
