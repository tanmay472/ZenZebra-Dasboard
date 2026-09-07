/**
 * A row's store was resolved to a real, known store via an exact
 * `store_dimension` name match or a registered `store_alias_mapping` row.
 */
export interface ResolvedStore {
	resolved: true;
	storeId: number;
	canonicalStore: string;
	displayName: string;
}

/**
 * A row's raw `billed_by` value matched neither `store_dimension` nor
 * `store_alias_mapping`. This must never be silently coerced into an
 * existing store (Phase 6A data-integrity fix) — the caller is required
 * to handle this case explicitly (TypeScript enforces this via the
 * `resolved` discriminant) rather than reading `canonicalStore`/`storeId`
 * off an unresolved result.
 */
export interface UnresolvedStore {
	resolved: false;
	/** The original, unmodified raw value that failed to resolve. */
	rawValue: string;
}

export type StoreResolution = ResolvedStore | UnresolvedStore;

export interface StoreNormalizer {
	normalize(rawBilledBy: string): StoreResolution;
}

/**
 * Fetches all aliases and store dimensions from the database and returns a normalizer instance.
 *
 * Phase 6A data-integrity fix: a raw store value that doesn't exactly match
 * a `store_dimension.store_name` and has no registered `store_alias_mapping`
 * row is returned as UNRESOLVED, never guessed. The prior version defaulted
 * anything containing "klj" to "Klj store" and everything else — including
 * a brand-new, never-seen store name — to "SmartworksNoida Noida". That
 * meant a future/unmapped store's sales or purchase data could silently be
 * attributed to the wrong physical store. A new store must be given an
 * explicit `store_dimension`/`store_alias_mapping` row before its data can
 * enter the canonical layer; this function will never invent one.
 */
export async function createStoreNormalizer(
	sql: any,
): Promise<StoreNormalizer> {
	const aliases = await sql`
		SELECT source_name, canonical_store
		FROM store_alias_mapping
		WHERE active = true
	`;

	const dimensions = await sql`
		SELECT id, store_name, display_name
		FROM store_dimension
		WHERE active = true
	`;

	// Map to store dimension details by store_name (case-insensitive key)
	const storeMap = new Map<
		string,
		{ id: number; display_name: string; store_name: string }
	>();
	for (const d of dimensions) {
		storeMap.set(d.store_name.toLowerCase(), {
			id: d.id,
			display_name: d.display_name,
			store_name: d.store_name,
		});
	}

	// Map from normalized alias to canonical store_name
	const aliasMap = new Map<string, string>();
	for (const a of aliases) {
		aliasMap.set(a.source_name.toLowerCase().trim(), a.canonical_store);
	}

	return {
		normalize(rawBilledBy: string): StoreResolution {
			const cleanRaw = (rawBilledBy || "").trim().toLowerCase();

			if (!cleanRaw) {
				return { resolved: false, rawValue: rawBilledBy ?? "" };
			}

			// Known alias?
			let canonicalStore = aliasMap.get(cleanRaw);

			// Not an alias — is it already an exact canonical store_dimension name?
			if (!canonicalStore) {
				const match = storeMap.get(cleanRaw);
				if (match) {
					canonicalStore = match.store_name;
				}
			}

			// No alias match and no exact dimension match — genuinely unknown.
			// Never guess by substring ("klj" → Klj store) or default to any
			// existing store.
			if (!canonicalStore) {
				return { resolved: false, rawValue: rawBilledBy };
			}

			const dim = storeMap.get(canonicalStore.toLowerCase());
			if (!dim) {
				// An alias row points at a canonical_store that isn't an active
				// store_dimension entry — a data-integrity problem in the
				// mapping table itself, not something to paper over by guessing.
				return { resolved: false, rawValue: rawBilledBy };
			}

			return {
				resolved: true,
				storeId: dim.id,
				canonicalStore: dim.store_name,
				displayName: dim.display_name,
			};
		},
	};
}
