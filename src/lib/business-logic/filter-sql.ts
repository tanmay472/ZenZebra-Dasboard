import type { DashboardFilters } from "@/lib/founder/types";

export const FOOD_CATEGORIES = [
	"LIVE MENU",
	"SNACK CORNER",
	"BEVERAGES",
] as const;

export function retailCategoryClause(
	categoryScope?: DashboardFilters["categoryScope"],
) {
	if (categoryScope !== "retail") return null;
	return FOOD_CATEGORIES;
}
