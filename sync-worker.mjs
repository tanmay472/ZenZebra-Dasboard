import { spawn } from "child_process";
import path from "path";

console.log("==================================================");
console.log("🚀 Initializing ZenZebra Always-On Odoo Sync Worker...");
console.log("==================================================");

const child = spawn(
	"npx",
	["ts-node", "-P", "tsconfig.scripts.json", "src/scripts/sync/start-sync-worker.ts"],
	{
		stdio: "inherit",
		shell: true,
		cwd: process.cwd(),
	},
);

child.on("error", (err) => {
	console.error("❌ Failed to start sync worker process:", err);
});

child.on("exit", (code) => {
	console.log(`🏁 Sync worker exited with code ${code}`);
});
