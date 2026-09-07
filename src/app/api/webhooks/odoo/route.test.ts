import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 7A regression: Odoo's native ir.actions.server webhook always
 * sends the triggering record's id/model as "_id"/"_model" (Odoo's own
 * reserved metadata keys), never as bare "id"/"model" — confirmed via a
 * live read-only query against the production Odoo instance. Without the
 * normalization in route.ts, every genuine Odoo-originated delivery would
 * be rejected with 400 "Missing required fields: id and model", making a
 * real end-to-end realtime test impossible no matter how Odoo itself is
 * configured.
 */
vi.mock("@/lib/odoo/webhook-handler", () => ({
	verifyWebhookSecret: vi.fn(() => true),
	enqueueWebhookEvent: vi.fn(async () => ({
		eventId: "evt_test",
		isDuplicate: false,
	})),
	processWebhookEvent: vi.fn(async () => {}),
}));

vi.mock("@/lib/odoo/incremental-sync", () => ({
	SUPPORTED_ODOO_MODELS: ["pos.order", "sale.order"],
}));

const { POST } = await import("./route");
const { enqueueWebhookEvent } = (await import(
	"@/lib/odoo/webhook-handler"
)) as unknown as {
	enqueueWebhookEvent: ReturnType<typeof vi.fn>;
};

function makeRequest(body: unknown) {
	return new NextRequest("https://example.com/api/webhooks/odoo", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("POST /api/webhooks/odoo — Odoo native _id/_model normalization", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("accepts Odoo's native webhook shape (_id/_model only, no bare id/model)", async () => {
		const res = await POST(
			makeRequest({
				_action: "Point of Sale Orders(#1197)",
				_id: 5945,
				_model: "pos.order",
			}),
		);
		expect(res.status).toBe(200);
		expect(enqueueWebhookEvent).toHaveBeenCalledTimes(1);
		const enqueuedPayload = enqueueWebhookEvent.mock.calls[0]?.[0];
		expect(enqueuedPayload.id).toBe(5945);
		expect(enqueuedPayload.model).toBe("pos.order");
	});

	it("still accepts a manually-constructed test payload with bare id/model (backward compatible)", async () => {
		const res = await POST(makeRequest({ id: 42, model: "pos.order" }));
		expect(res.status).toBe(200);
		const enqueuedPayload = enqueueWebhookEvent.mock.calls[0]?.[0];
		expect(enqueuedPayload.id).toBe(42);
		expect(enqueuedPayload.model).toBe("pos.order");
	});

	it("bare id/model takes precedence over _id/_model when both are present", async () => {
		const res = await POST(
			makeRequest({
				id: 1,
				model: "pos.order",
				_id: 999,
				_model: "sale.order",
			}),
		);
		expect(res.status).toBe(200);
		const enqueuedPayload = enqueueWebhookEvent.mock.calls[0]?.[0];
		expect(enqueuedPayload.id).toBe(1);
		expect(enqueuedPayload.model).toBe("pos.order");
	});

	it("still rejects a payload with neither id/model nor _id/_model", async () => {
		const res = await POST(makeRequest({ foo: "bar" }));
		expect(res.status).toBe(400);
		expect(enqueueWebhookEvent).not.toHaveBeenCalled();
	});

	it("still rejects an unsupported model even after normalization", async () => {
		const res = await POST(makeRequest({ _id: 1, _model: "res.users" }));
		expect(res.status).toBe(400);
		expect(enqueueWebhookEvent).not.toHaveBeenCalled();
	});
});
