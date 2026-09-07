"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { formatStoreName } from "@/components/founder/global-filter-bar";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";

interface StoreFilterProps {
	currentStore: string;
	/** Real, currently-synced store list (raw billed_by values) — never
	 * hardcoded, so a new store added in Odoo appears here automatically
	 * once it has synced sales data. */
	availableStores: string[];
}

export function StoreFilter({
	currentStore,
	availableStores,
}: StoreFilterProps) {
	const router = useRouter();
	const searchParams = useSearchParams();

	return (
		<div className="flex items-center gap-3">
			<span className="text-xs text-muted-foreground font-mono">Store:</span>
			<Select
				value={currentStore || "ALL"}
				onValueChange={(val) => {
					const params = new URLSearchParams(searchParams.toString());
					if (val === "ALL") {
						params.delete("store");
					} else {
						params.set("store", val);
					}
					router.push(`?${params.toString()}`);
				}}
			>
				<SelectTrigger className="w-[180px] border-[0.5px] border-border text-xs text-foreground rounded-[12px] h-9 focus:ring-0 focus:ring-offset-0">
					<SelectValue placeholder="All Stores" />
				</SelectTrigger>
				<SelectContent className="border-[0.5px] border-border text-foreground rounded-[12px] shadow-none">
					<SelectItem value="ALL">All Stores</SelectItem>
					{availableStores.map((s) => (
						<SelectItem key={s} value={s}>
							{formatStoreName(s)}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}
