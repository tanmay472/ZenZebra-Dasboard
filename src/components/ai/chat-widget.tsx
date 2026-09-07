"use client";

import {
	Bot,
	Download,
	Loader2,
	RotateCcw,
	Send,
	Sparkles,
	X,
} from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { MarkdownLite } from "./markdown-lite";

interface ChatReportLink {
	id: string;
	filename: string;
	format: "xlsx" | "pdf";
	url: string;
}

interface ChatEntry {
	id: string;
	role: "user" | "assistant";
	content: string;
	isError?: boolean;
	reports?: ChatReportLink[];
}

function newId(): string {
	return typeof crypto !== "undefined" && "randomUUID" in crypto
		? crypto.randomUUID()
		: `${Date.now()}-${Math.random()}`;
}

/**
 * Floating AI assistant widget for the dashboard. Talks only to
 * POST /api/ai/chat — the same session-authenticated API every other
 * dashboard fetch call uses (no separate auth, no key ever touches this
 * component). No dashboard functionality is altered by mounting this.
 */
export function ChatWidget() {
	const [open, setOpen] = useState(false);
	const [messages, setMessages] = useState<ChatEntry[]>([]);
	const [input, setInput] = useState("");
	const [loading, setLoading] = useState(false);
	const lastMessageRef = useRef<string>("");

	async function send(text: string) {
		const trimmed = text.trim();
		if (!trimmed || loading) return;
		lastMessageRef.current = trimmed;

		const history = messages
			.filter((m) => !m.isError)
			.map((m) => ({ role: m.role, content: m.content }));

		setMessages((prev) => [
			...prev,
			{ id: newId(), role: "user", content: trimmed },
		]);
		setInput("");
		setLoading(true);

		try {
			const res = await fetch("/api/ai/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message: trimmed, history }),
			});
			const json = await res.json();
			if (res.ok && json.success) {
				setMessages((prev) => [
					...prev,
					{
						id: newId(),
						role: "assistant",
						content: json.answer,
						reports: Array.isArray(json.reports) ? json.reports : undefined,
					},
				]);
			} else {
				setMessages((prev) => [
					...prev,
					{
						id: newId(),
						role: "assistant",
						content: json.error || "Something went wrong. Please try again.",
						isError: true,
					},
				]);
			}
		} catch {
			setMessages((prev) => [
				...prev,
				{
					id: newId(),
					role: "assistant",
					content:
						"Couldn't reach the AI assistant. Check your connection and try again.",
					isError: true,
				},
			]);
		} finally {
			setLoading(false);
		}
	}

	function retry() {
		if (!lastMessageRef.current) return;
		setMessages((prev) => prev.slice(0, -1).filter((m) => !m.isError));
		send(lastMessageRef.current);
	}

	if (!open) {
		return (
			<Button
				onClick={() => setOpen(true)}
				className="fixed bottom-5 right-5 z-50 size-12 rounded-full shadow-lg p-0"
				aria-label="Open AI assistant"
			>
				<Sparkles className="size-5" />
			</Button>
		);
	}

	return (
		<Card className="fixed bottom-5 right-5 z-50 flex h-[520px] w-[92vw] max-w-sm flex-col shadow-xl sm:w-96">
			<CardHeader className="flex flex-row items-center justify-between gap-2 border-b pb-3">
				<CardTitle className="flex items-center gap-2 text-sm font-semibold">
					<Bot className="size-4" />
					ZenZebra Assistant
				</CardTitle>
				<Button
					variant="ghost"
					size="icon-xs"
					onClick={() => setOpen(false)}
					aria-label="Close AI assistant"
				>
					<X className="size-4" />
				</Button>
			</CardHeader>

			<CardContent className="flex-1 overflow-hidden p-0">
				<ScrollArea className="h-full px-4 py-3">
					{messages.length === 0 ? (
						<p className="text-xs text-muted-foreground">
							Ask about sales, stores, top products, low stock, or top customers
							— I only answer using your real dashboard data.
						</p>
					) : (
						<div className="flex flex-col gap-3">
							{messages.map((m) => (
								<div
									key={m.id}
									className={cn(
										"max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed",
										m.role === "user"
											? "ml-auto bg-primary text-primary-foreground"
											: m.isError
												? "bg-destructive/10 text-destructive"
												: "bg-muted text-foreground",
									)}
								>
									{m.role === "assistant" && !m.isError ? (
										<MarkdownLite content={m.content} />
									) : (
										m.content
									)}
									{m.reports && m.reports.length > 0 && (
										<div className="mt-2 flex flex-col gap-1.5">
											{m.reports.map((r) => (
												<a
													key={r.id}
													href={r.url}
													className="flex w-fit items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-[11px] font-medium text-foreground hover:bg-accent"
												>
													<Download className="size-3" />
													{r.filename}
												</a>
											))}
										</div>
									)}
								</div>
							))}
							{loading && (
								<div className="flex items-center gap-2 text-xs text-muted-foreground">
									<Loader2 className="size-3 animate-spin" />
									Thinking…
								</div>
							)}
							{!loading && messages.at(-1)?.isError && (
								<Button
									variant="outline"
									size="sm"
									onClick={retry}
									className="w-fit gap-1.5"
								>
									<RotateCcw className="size-3" />
									Retry
								</Button>
							)}
						</div>
					)}
				</ScrollArea>
			</CardContent>

			<CardFooter className="border-t p-3">
				<form
					className="flex w-full items-end gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						send(input);
					}}
				>
					<Textarea
						value={input}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								send(input);
							}
						}}
						placeholder="What are today's sales?"
						className="min-h-9 resize-none text-xs"
						rows={1}
						disabled={loading}
					/>
					<Button
						type="submit"
						size="icon-xs"
						disabled={loading || !input.trim()}
					>
						<Send className="size-3.5" />
					</Button>
				</form>
			</CardFooter>
		</Card>
	);
}
