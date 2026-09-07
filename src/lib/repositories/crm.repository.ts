import { sql } from "@/lib/db";

export interface CrmLead {
	id: number;
	odooLeadId?: number;
	name: string;
	type: string;
	stage: string;
	salesperson?: string;
	partnerName?: string;
	email?: string;
	phone?: string;
	expectedRevenue: number;
	probability: number;
	dateDeadline?: string;
	source?: string;
	medium?: string;
	active: boolean;
	won: boolean;
	store?: string;
	health?: string;
	notes?: string;
	createdAt?: string;
	updatedAt?: string;
}

export interface CrmPipelineSummary {
	totalPipelineValue: number;
	totalLeads: number;
	avgDealSize: number;
	/** Null when totalLeads is 0 — "no CRM data" is not the same as "0%
	 * win rate" and must never be conflated. */
	winRate: number | null;
	stageCounts: Record<string, { count: number; value: number }>;
}

export async function getCrmLeads(filters?: {
	stage?: string;
	store?: string;
	search?: string;
	salesperson?: string;
}): Promise<CrmLead[]> {
	try {
		const stage =
			filters?.stage && filters.stage !== "ALL" ? filters.stage : null;
		const store =
			filters?.store && filters.store !== "ALL" ? filters.store : null;
		const search = filters?.search ? `%${filters.search.toLowerCase()}%` : null;

		const rows = await sql`
			SELECT 
				id,
				odoo_lead_id AS "odooLeadId",
				name,
				type,
				stage,
				salesperson,
				partner_name AS "partnerName",
				email,
				phone,
				COALESCE(expected_revenue, 0)::FLOAT AS "expectedRevenue",
				COALESCE(probability, 0)::FLOAT AS "probability",
				date_deadline::TEXT AS "dateDeadline",
				source,
				medium,
				active,
				won,
				store,
				health,
				notes,
				created_at AS "createdAt",
				updated_at AS "updatedAt"
			FROM crm_leads
			WHERE active = true
				AND (${stage}::TEXT IS NULL OR stage = ${stage})
				AND (${store}::TEXT IS NULL OR store = ${store})
				AND (${search}::TEXT IS NULL OR (
					LOWER(name) LIKE ${search} OR 
					LOWER(partner_name) LIKE ${search} OR 
					LOWER(COALESCE(phone, '')) LIKE ${search}
				))
			ORDER BY updated_at DESC;
		`;

		return rows as CrmLead[];
	} catch (err) {
		console.warn("DB query for crm_leads failed, using fallback data:", err);
		return [];
	}
}

export async function getCrmPipelineSummary(filters?: {
	store?: string;
}): Promise<CrmPipelineSummary> {
	try {
		const store =
			filters?.store && filters.store !== "ALL" ? filters.store : null;

		const rows = await sql`
			SELECT
				COALESCE(SUM(expected_revenue), 0)::FLOAT AS "totalPipelineValue",
				COUNT(*)::INT AS "totalLeads",
				COALESCE(AVG(expected_revenue), 0)::FLOAT AS "avgDealSize",
				COALESCE(
					(COUNT(*) FILTER (WHERE won = true)::FLOAT / NULLIF(COUNT(*), 0) * 100),
					0
				)::FLOAT AS "winRate"
			FROM crm_leads
			WHERE active = true
				AND (${store}::TEXT IS NULL OR store = ${store});
		`;

		const stageRows = await sql`
			SELECT
				stage,
				COUNT(*)::INT AS count,
				COALESCE(SUM(expected_revenue), 0)::FLOAT AS value
			FROM crm_leads
			WHERE active = true
				AND (${store}::TEXT IS NULL OR store = ${store})
			GROUP BY stage;
		`;

		const stageCounts: Record<string, { count: number; value: number }> = {};
		for (const row of stageRows) {
			stageCounts[row.stage] = {
				count: Number(row.count),
				value: Number(row.value),
			};
		}

		const stat = rows[0] || {
			totalPipelineValue: 0,
			totalLeads: 0,
			avgDealSize: 0,
			winRate: 0,
		};
		const totalLeads = Number(stat.totalLeads);

		return {
			totalPipelineValue: Number(stat.totalPipelineValue),
			totalLeads,
			avgDealSize: Number(stat.avgDealSize),
			// 0 leads means "no CRM data", not a real 0% win rate — never
			// conflate the two.
			winRate: totalLeads > 0 ? Number(stat.winRate) : null,
			stageCounts,
		};
	} catch (err) {
		console.warn("DB query for crm pipeline summary failed:", err);
		return {
			totalPipelineValue: 0,
			totalLeads: 0,
			avgDealSize: 0,
			winRate: null,
			stageCounts: {},
		};
	}
}

export async function createCrmLead(data: {
	name: string;
	partnerName?: string;
	email?: string;
	phone?: string;
	stage?: string;
	expectedRevenue?: number;
	probability?: number;
	store?: string;
	salesperson?: string;
	notes?: string;
}): Promise<CrmLead | null> {
	try {
		const rows = await sql`
			INSERT INTO crm_leads (
				name,
				partner_name,
				email,
				phone,
				stage,
				expected_revenue,
				probability,
				store,
				salesperson,
				notes
			) VALUES (
				${data.name},
				${data.partnerName || null},
				${data.email || null},
				${data.phone || null},
				${data.stage || "Qualified"},
				${data.expectedRevenue || 0},
				${data.probability || 20},
				${data.store || null},
				${data.salesperson || "Unassigned"},
				${data.notes || null}
			)
			RETURNING 
				id,
				odoo_lead_id AS "odooLeadId",
				name,
				type,
				stage,
				salesperson,
				partner_name AS "partnerName",
				email,
				phone,
				COALESCE(expected_revenue, 0)::FLOAT AS "expectedRevenue",
				COALESCE(probability, 0)::FLOAT AS "probability",
				date_deadline::TEXT AS "dateDeadline",
				source,
				medium,
				active,
				won,
				store,
				health,
				notes;
		`;
		return rows[0] as CrmLead;
	} catch (err) {
		console.error("Failed to create CRM lead:", err);
		return null;
	}
}

export async function updateCrmLeadStage(
	id: number,
	stage: string,
): Promise<boolean> {
	try {
		const won = stage === "Closed Won";
		await sql`
			UPDATE crm_leads
			SET stage = ${stage},
				won = ${won},
				updated_at = CURRENT_TIMESTAMP
			WHERE id = ${id};
		`;
		return true;
	} catch (err) {
		console.error(`Failed to update lead ${id} stage:`, err);
		return false;
	}
}
