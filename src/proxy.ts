import crypto from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/lib/auth";

// Proxy files (Next.js 16's middleware equivalent) always run on the
// Node.js runtime — confirmed via build error when an explicit runtime
// segment config was declared here ("Route segment config is not allowed
// in Proxy file... Proxy always runs on Node.js runtime"). That resolves
// the only real architectural risk in this fix: validateSession() needs a
// DB round-trip (Neon serverless driver) and transitively loads
// @node-rs/argon2 (a native compiled addon) via auth.ts's top-level
// imports — neither would work under an Edge/V8-isolate runtime, but
// neither is a concern here since Node.js is the only runtime available.

// Routes that don't require authentication
const publicPaths = [
	"/login",
	"/api/auth/login",
	"/api/auth/logout",
	"/api/auth/verify",
	"/api/public",
	"/api/webhooks",
	"/api/cron",
	"/api/admin/odoo-sync",
	// Called by the Oracle-hosted worker process, not a logged-in browser —
	// self-authenticates via INTERNAL_API_SECRET, same pattern as webhooks.
	"/api/internal",
];

function isPublicPath(pathname: string): boolean {
	return publicPaths.some((path) => pathname.startsWith(path));
}

function sha256(input: string): string {
	return crypto.createHash("sha256").update(input).digest("hex");
}

export default async function proxy(req: NextRequest) {
	const { pathname } = req.nextUrl;

	// Allow public routes and static assets
	if (isPublicPath(pathname)) {
		return NextResponse.next();
	}

	// Only protect dashboard routes and dashboard API routes
	const isProtected =
		pathname.startsWith("/dashboard") ||
		pathname.startsWith("/api/") ||
		pathname === "/register";

	if (!isProtected) {
		return NextResponse.next();
	}

	// Check for session cookie
	const sessionToken = req.cookies.get("zz_session")?.value;

	// Auth bypass requires an EXPLICIT opt-in only — never inferred from
	// NODE_ENV. The prior check also bypassed auth whenever
	// NODE_ENV === "development", which meant any misconfigured deployment
	// (NODE_ENV unset, a staging box cloned from a dev .env, `next start`
	// without setting it) would silently and fully disable authentication
	// with no warning. DISABLE_AUTH=true is still available for local
	// development convenience, but it must be set on purpose.
	if (process.env.DISABLE_AUTH === "true") {
		return NextResponse.next();
	}

	if (!sessionToken) {
		// Redirect to login for page requests, return 401 for API
		if (pathname.startsWith("/api/")) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}
		return NextResponse.redirect(new URL("/login", req.url));
	}

	// A cookie merely being present proves nothing — validate it against the
	// sessions table (hash, expiry, existence) the same way getCurrentUser()
	// already does for the one route that previously bothered to check. A
	// forged/random/expired/deleted token must fail here, not pass through.
	const user = await validateSession(sessionToken);
	if (!user) {
		if (pathname.startsWith("/api/")) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}
		return NextResponse.redirect(new URL("/login", req.url));
	}

	return NextResponse.next();
}

export const config = {
	matcher: [
		"/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
		"/(api|trpc)(.*)",
	],
};
