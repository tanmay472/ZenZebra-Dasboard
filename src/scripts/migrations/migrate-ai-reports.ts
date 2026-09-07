import path from "node:path";
import { neon } from "@neondatabase/serverless";
import * as dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

/**
 * Metadata for AI-generated report files (xlsx/pdf). The files themselves
 * live on disk under data/ai-reports/ (gitignored, regenerated on demand) —
 * this table only stores enough to authenticate and serve a download.
 */
async function migrate() {
	if (!process.env.DATABASE_URL) {
		console.error("Missing DATABASE_URL in environment.");
		process.exit(1);
	}

	console.log("Connecting to database...");
	const sql = neon(process.env.DATABASE_URL);

	console.log("Creating ai_generated_reports...");
	await sql`
		CREATE TABLE IF NOT EXISTS ai_generated_reports (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			filename TEXT NOT NULL,
			mime_type TEXT NOT NULL,
			file_path TEXT NOT NULL,
			row_count INTEGER NOT NULL DEFAULT 0,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)
	`;

	console.log(
		"✅ ai_generated_reports schema migration completed successfully.",
	);
}

migrate().catch((err) => {
	console.error("Migration failed:", err);
	process.exit(1);
});
