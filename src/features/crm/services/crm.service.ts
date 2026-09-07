import { calculateLeadScore } from "@/lib/intelligence/score";
import {
	calculatePipelineVelocity,
	calculateWinRate,
} from "@/lib/metrics/engine";
import {
	getCrmLeads,
	getCrmPipelineSummary,
} from "@/lib/repositories/crm.repository";

export async function getCrmIntelligence() {
	const [summary, rawLeads] = await Promise.all([
		getCrmPipelineSummary(),
		getCrmLeads(),
	]);

	// Fabrication fix (repo-wide sweep): this previously passed
	// industryFit/engagementRecencyDays/hasDecisionMakerAccess/
	// buyingTimelineDays as hardcoded constants identical for every lead —
	// none of those are real per-lead fields on crm_leads (see
	// crm.repository.ts's CrmLead interface). Only expectedRevenue and
	// source are genuine per-lead data, so only those are passed through;
	// the unset factors fall back to calculateLeadScore()'s own neutral
	// defaults instead of an invented specific value per lead.
	const scoredLeads = rawLeads.map((lead) => {
		const scoreResult = calculateLeadScore({
			expectedRevenue: lead.expectedRevenue,
			sourceQuality: lead.source,
		});

		return {
			...lead,
			leadScore: scoreResult.score,
			leadBadge: scoreResult.badge,
			leadBadgeColor: scoreResult.color,
		};
	});

	const closedWonCount = rawLeads.filter((l) => l.won).length;
	// summary.winRate is already null when there are 0 leads (a real "no CRM
	// data" state, not a fabricated 0% win rate) — only recompute it here
	// when there's real data to recompute from, so that null survives rather
	// than being silently overwritten by calculateWinRate(0, 0) === 0.
	const winRate =
		rawLeads.length > 0
			? calculateWinRate(closedWonCount, rawLeads.length)
			: null;
	const velocity =
		winRate !== null
			? calculatePipelineVelocity(summary.totalPipelineValue, winRate, 30)
			: null;

	return {
		summary: {
			...summary,
			winRate,
			pipelineVelocity: velocity,
		},
		leads: scoredLeads,
		// Fabrication fix: these were hardcoded literals (4.2/18.5/42.0
		// hours) with no query behind them at all — crm_leads has no
		// stage-transition timestamps to compute a real per-stage duration
		// from. Honest "unavailable" beats a plausible-looking constant.
		slaStatus: null,
	};
}
