"use client";

import { Filter, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { DATE_PRESETS, getPresetRange } from "@/lib/date-presets";
import { useFilterStore } from "@/stores/founder/filter-store";

export interface ProductSuggestion {
	id: number;
	name: string;
	sku: string | null;
	barcode: string | null;
	category: string | null;
}

const AUTOCOMPLETE_DEBOUNCE_MS = 250;

export function formatStoreName(name: string): string {
	if (!name) return "";
	if (name === "Klj store") return "KLJ";
	if (name === "SmartworksNoida Noida") return "Smart Works Noida";
	if (name === "Head office" || name === "Head Office") return "Head office";
	// Generic camelCase boundary splitter: preserves uppercase acronyms (e.g. HQ27GGN, KLJ, SWN)
	// while cleanly separating camelCase words (e.g. ZenZebra -> Zen Zebra)
	return name
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.replace(/[_-]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

interface GlobalFilterBarProps {
	availableStores?: string[];
	availableCategories: string[];
	availableBrands: string[];
	categoryBrandMap?: Record<string, string[]>;
	skuName?: string | null;
	/**
	 * Opt-in product autocomplete. When provided, the search field becomes a
	 * dropdown-driven autocomplete sourced from whatever this callback
	 * resolves (e.g. the Inventory Dashboard's dim_products-backed search
	 * endpoint). When omitted, the search field is the original plain text
	 * input — every other consumer of this shared component is unaffected.
	 */
	onSearchProducts?: (query: string) => Promise<ProductSuggestion[]>;
	/**
	 * Opt-in "All Time" support for the Analysis Period preset dropdown.
	 * The real min/max sale_date across all synced data (e.g. from
	 * /api/sales/status), never hardcoded. When omitted, selecting "All
	 * Time" is a safe no-op — every other consumer is unaffected.
	 */
	dataBounds?: { minDate: string; maxDate: string } | null;
	/**
	 * Opt-in SKU-search disable. When set, the SKU/Name search field is
	 * rendered disabled with this string shown as the explanation (e.g.
	 * because the active tab's metric has no per-product SKU scoping).
	 * Omitted by every other consumer — zero behavior change elsewhere.
	 */
	skuDisabledReason?: string;
	/**
	 * Opt-in: hides the Analysis Period / Compare Against date controls
	 * entirely. For the Inventory Dashboard, which reflects current stock
	 * only (no historical time series exists to filter by — see Phase 14/15
	 * audit), showing a date picker implies a capability that doesn't exist.
	 * Omitted by every other consumer — zero behavior change elsewhere.
	 */
	hideDateRange?: boolean;
}

export function GlobalFilterBar({
	availableStores = [],
	availableCategories,
	availableBrands,
	categoryBrandMap = {},
	skuName,
	onSearchProducts,
	dataBounds,
	skuDisabledReason,
	hideDateRange = false,
}: GlobalFilterBarProps) {
	const {
		startDate,
		endDate,
		store,
		category,
		brand,
		sku,
		categoryScope,
		compareMode,
		compareStartDate,
		compareEndDate,
		setStartDate,
		setEndDate,
		setDateRange,
		setStore,
		setCategory,
		setBrand,
		setSku,
		setCategoryScope,
		setCompareMode,
		setCompareStartDate,
		setCompareEndDate,
		reset,
	} = useFilterStore();

	// Local text state for the autocomplete input — kept separate from the
	// committed `sku` filter so typing doesn't refetch every dashboard section
	// on every keystroke; only a selected suggestion (or blur-commit) updates
	// the actual global filter.
	const [searchText, setSearchText] = useState(sku);
	const [suggestions, setSuggestions] = useState<ProductSuggestion[]>([]);
	const [isSearching, setIsSearching] = useState(false);
	const [isOpen, setIsOpen] = useState(false);
	const [highlightedIndex, setHighlightedIndex] = useState(-1);
	const searchContainerRef = useRef<HTMLDivElement>(null);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		setSearchText(sku);
	}, [sku]);

	useEffect(() => {
		if (!onSearchProducts) return;
		if (debounceRef.current) clearTimeout(debounceRef.current);

		const query = searchText.trim();
		if (query.length < 2) {
			setSuggestions([]);
			setIsOpen(false);
			return;
		}

		debounceRef.current = setTimeout(async () => {
			setIsSearching(true);
			try {
				const results = await onSearchProducts(query);
				setSuggestions(results);
				setIsOpen(true);
				setHighlightedIndex(-1);
			} catch {
				setSuggestions([]);
			} finally {
				setIsSearching(false);
			}
		}, AUTOCOMPLETE_DEBOUNCE_MS);

		return () => {
			if (debounceRef.current) clearTimeout(debounceRef.current);
		};
	}, [searchText, onSearchProducts]);

	// Close the dropdown on outside click.
	useEffect(() => {
		if (!onSearchProducts) return;
		function handleClickOutside(e: MouseEvent) {
			if (
				searchContainerRef.current &&
				!searchContainerRef.current.contains(e.target as Node)
			) {
				setIsOpen(false);
			}
		}
		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, [onSearchProducts]);

	function selectSuggestion(suggestion: ProductSuggestion) {
		// Prefer the canonical Odoo identifier (default_code) when available;
		// most products have no default_code synced, so fall back to the
		// exact product name — still a precise, non-fuzzy match since it's
		// the full name, not a fragment of what the user typed.
		const filterValue = suggestion.sku || suggestion.name;
		setSku(filterValue);
		setSearchText(filterValue);
		setIsOpen(false);
		setSuggestions([]);
		setHighlightedIndex(-1);
	}

	function handleSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
		if (!isOpen || suggestions.length === 0) return;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setHighlightedIndex((i) => Math.min(i + 1, suggestions.length - 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setHighlightedIndex((i) => Math.max(i - 1, 0));
		} else if (e.key === "Enter") {
			e.preventDefault();
			const target = suggestions[highlightedIndex] ?? suggestions[0];
			if (target) selectSuggestion(target);
		} else if (e.key === "Escape") {
			setIsOpen(false);
		}
	}

	// Reset selected brand if it is not valid for the newly selected category
	useEffect(() => {
		if (
			category &&
			category !== "All Categories" &&
			brand &&
			brand !== "All Brands"
		) {
			const validBrands = categoryBrandMap[category] || [];
			if (!validBrands.includes(brand)) {
				setBrand("All Brands");
			}
		}
	}, [category, brand, categoryBrandMap, setBrand]);

	const hasActiveFilters =
		store !== "ALL" ||
		category !== "All Categories" ||
		brand !== "All Brands" ||
		sku !== "" ||
		categoryScope !== "all" ||
		compareMode !== "mirror";

	// Filter available brands based on the selected category
	const filteredBrands =
		category && category !== "All Categories"
			? categoryBrandMap[category] || []
			: availableBrands;

	return (
		<div className="sticky top-0 z-40 mb-6 w-full border-b bg-background/95 pt-4 pb-4 backdrop-blur supports-[backdrop-filter]:bg-background/60">
			<div className="flex flex-col gap-4">
				{/* Row 1: Time Filters (Analysis Period vs Compare Against) —
				    hidden when hideDateRange is set, since date filtering has
				    no effect on current-stock-only data (e.g. Inventory). */}
				<div className="flex flex-wrap items-center gap-3">
					<div className="flex items-center gap-2 font-medium text-muted-foreground text-sm mr-2 shrink-0">
						<Filter className="size-4" />
						<span>Global Filters</span>
					</div>

					{!hideDateRange && (
						<>
							{/* Analysis Period Box */}
							<div className="flex flex-wrap items-center gap-2 border bg-muted/20 p-1 px-3 rounded-lg text-sm max-w-full">
								<span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider shrink-0 border-r pr-2 mr-1">
									Analysis Period
								</span>
								<Select
									onValueChange={(value) => {
										if (value === "allTime") {
											if (dataBounds) {
												setDateRange(dataBounds.minDate, dataBounds.maxDate);
											}
											return;
										}
										const range = getPresetRange(value);
										if (range) setDateRange(range.startDate, range.endDate);
									}}
								>
									<SelectTrigger className="h-7 w-[120px] sm:w-[130px] border-0 bg-transparent p-0 shadow-none focus:ring-0 text-xs">
										<SelectValue placeholder="Quick range" />
									</SelectTrigger>
									<SelectContent>
										{DATE_PRESETS.map((preset) => (
											<SelectItem key={preset.value} value={preset.value}>
												{preset.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<Input
									type="date"
									value={startDate}
									onChange={(e) => setStartDate(e.target.value)}
									className="h-7 w-[110px] sm:w-[120px] border-0 bg-transparent p-0 shadow-none focus-visible:ring-0 text-xs font-medium"
								/>
								<span className="text-muted-foreground text-xs shrink-0">
									→
								</span>
								<Input
									type="date"
									value={endDate}
									onChange={(e) => setEndDate(e.target.value)}
									className="h-7 w-[110px] sm:w-[120px] border-0 bg-transparent p-0 shadow-none focus-visible:ring-0 text-xs font-medium"
								/>
							</div>

							{/* Compare Against Box */}
							<div className="flex flex-wrap items-center gap-2 border bg-muted/20 p-1 px-3 rounded-lg text-sm max-w-full">
								<span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider shrink-0 border-r pr-2 mr-1">
									Compare Against
								</span>
								<Select
									value={compareMode}
									onValueChange={(v) =>
										setCompareMode(v as "mirror" | "custom")
									}
								>
									<SelectTrigger className="h-7 w-[130px] sm:w-[150px] border-0 bg-transparent p-0 shadow-none focus:ring-0 text-xs">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="mirror">vs Previous Period</SelectItem>
										<SelectItem value="custom">vs Custom Period</SelectItem>
									</SelectContent>
								</Select>
								{compareMode === "custom" && (
									<>
										<Input
											type="date"
											value={compareStartDate}
											onChange={(e) => setCompareStartDate(e.target.value)}
											className="h-7 w-[110px] sm:w-[120px] border-0 bg-transparent p-0 shadow-none focus-visible:ring-0 text-xs font-medium"
										/>
										<span className="text-muted-foreground text-xs shrink-0">
											→
										</span>
										<Input
											type="date"
											value={compareEndDate}
											onChange={(e) => setCompareEndDate(e.target.value)}
											className="h-7 w-[110px] sm:w-[120px] border-0 bg-transparent p-0 shadow-none focus-visible:ring-0 text-xs font-medium"
										/>
									</>
								)}
							</div>
						</>
					)}
				</div>

				{/* Row 2: Dimension Filters */}
				<div className="flex flex-wrap items-center gap-2.5 sm:gap-3 border-t pt-3">
					<Select value={store} onValueChange={setStore}>
						<SelectTrigger className="h-9 w-full sm:w-[150px]">
							<SelectValue placeholder="Store" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="ALL">All Stores</SelectItem>
							{availableStores.map((storeName) => (
								<SelectItem key={storeName} value={storeName}>
									{formatStoreName(storeName)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>

					<Select
						value={categoryScope}
						onValueChange={(v) => setCategoryScope(v as "all" | "retail")}
					>
						<SelectTrigger className="h-9 w-full sm:w-[130px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">All categories</SelectItem>
							<SelectItem value="retail">Retail only</SelectItem>
						</SelectContent>
					</Select>

					<Select value={category} onValueChange={setCategory}>
						<SelectTrigger className="h-9 w-full sm:w-[150px]">
							<SelectValue placeholder="Category" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="All Categories">All Categories</SelectItem>
							{availableCategories.map((value) => (
								<SelectItem key={value} value={value}>
									{value === "LIVE MENU" ? "(Live menu)" : value}
								</SelectItem>
							))}
						</SelectContent>
					</Select>

					<Select value={brand} onValueChange={setBrand}>
						<SelectTrigger className="h-9 w-full sm:w-[150px]">
							<SelectValue placeholder="Brand" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="All Brands">All Brands</SelectItem>
							{filteredBrands.map((value) => (
								<SelectItem key={value} value={value}>
									{value}
								</SelectItem>
							))}
						</SelectContent>
					</Select>

					<div className="flex items-center gap-2 shrink-0 w-full sm:w-auto">
						{skuDisabledReason ? (
							<Input
								placeholder="Not available for this view"
								disabled
								title={skuDisabledReason}
								className="h-9 w-full sm:w-[180px]"
							/>
						) : onSearchProducts ? (
							<div ref={searchContainerRef} className="relative">
								<Input
									placeholder="Search SKU or Name..."
									value={searchText}
									onChange={(e) => setSearchText(e.target.value)}
									onFocus={() => {
										if (suggestions.length > 0) setIsOpen(true);
									}}
									onKeyDown={handleSearchKeyDown}
									className="h-9 w-[180px]"
								/>
								{isOpen && (
									<div className="absolute top-full left-0 z-50 mt-1 w-[280px] rounded-md border bg-popover shadow-md">
										{isSearching ? (
											<div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
												<Loader2 className="size-3.5 animate-spin" />
												Searching products...
											</div>
										) : suggestions.length === 0 ? (
											<div className="px-3 py-2 text-xs text-muted-foreground">
												No products found
											</div>
										) : (
											<ul className="max-h-72 overflow-y-auto py-1">
												{suggestions.map((s, i) => (
													<li key={s.id}>
														<button
															type="button"
															onClick={() => selectSuggestion(s)}
															onMouseEnter={() => setHighlightedIndex(i)}
															className={`w-full px-3 py-1.5 text-left text-xs ${
																i === highlightedIndex
																	? "bg-muted"
																	: "hover:bg-muted/60"
															}`}
														>
															<div className="font-medium truncate">
																{s.name}
															</div>
															<div className="text-muted-foreground truncate">
																{s.sku
																	? s.sku
																	: s.barcode
																		? `Barcode: ${s.barcode}`
																		: null}
																{(s.sku || s.barcode) && s.category
																	? " • "
																	: ""}
																{s.category}
															</div>
														</button>
													</li>
												))}
											</ul>
										)}
									</div>
								)}
							</div>
						) : (
							<Input
								placeholder="Search SKU or Name..."
								value={sku}
								onChange={(e) => setSku(e.target.value)}
								className="h-9 w-[180px]"
							/>
						)}
						{sku && skuName && (
							<span
								className="text-xs font-bold text-foreground bg-muted border px-2.5 py-1 rounded max-w-[220px] truncate"
								title={skuName}
							>
								{skuName}
							</span>
						)}
					</div>

					{hasActiveFilters && (
						<Button
							variant="ghost"
							size="sm"
							onClick={reset}
							className="h-9 px-2 text-muted-foreground hover:text-foreground"
						>
							<X className="mr-1 size-4" />
							Clear All
						</Button>
					)}
				</div>
			</div>
		</div>
	);
}
