import { Fragment } from "react";

/**
 * Minimal, dependency-free renderer for the small subset of markdown the
 * Claude assistant actually produces (bold, bullet/numbered lists, simple
 * tables, paragraphs). No HTML is ever parsed or injected — every node is
 * built as a React element, so there's no dangerouslySetInnerHTML/XSS
 * surface even though the content comes from an LLM.
 */

function renderInline(text: string, keyPrefix: string) {
	const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
	return parts.map((part, i) => {
		// biome-ignore lint/suspicious/noArrayIndexKey: static text split, never reordered
		const key = `${keyPrefix}-${i}`;
		if (part.startsWith("**") && part.endsWith("**")) {
			return <strong key={key}>{part.slice(2, -2)}</strong>;
		}
		return <Fragment key={key}>{part}</Fragment>;
	});
}

function isTableBlock(lines: string[]): boolean {
	return (
		lines.length >= 2 &&
		lines[0].trim().startsWith("|") &&
		/^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?$/.test(lines[1].trim())
	);
}

function splitRow(line: string): string[] {
	return line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((c) => c.trim());
}

function Table({ lines, blockKey }: { lines: string[]; blockKey: string }) {
	const header = splitRow(lines[0]);
	const rows = lines.slice(2).map(splitRow);
	return (
		<div className="overflow-x-auto">
			<table className="w-full border-collapse text-xs">
				<thead>
					<tr className="border-b">
						{header.map((cell, i) => (
							<th
								// biome-ignore lint/suspicious/noArrayIndexKey: fixed column order from parsed table row
								key={`${blockKey}-h-${i}`}
								className="px-2 py-1 text-left font-semibold"
							>
								{renderInline(cell, `${blockKey}-h-${i}`)}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map((row, ri) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: fixed row order from parsed table body
						<tr key={`${blockKey}-r-${ri}`} className="border-b last:border-0">
							{row.map((cell, ci) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: fixed column order from parsed table row
								<td key={`${blockKey}-r-${ri}-${ci}`} className="px-2 py-1">
									{renderInline(cell, `${blockKey}-r-${ri}-${ci}`)}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function renderBlock(block: string, blockKey: string) {
	const lines = block.split("\n").filter((l) => l.trim().length > 0);
	if (lines.length === 0) return null;

	if (isTableBlock(lines)) {
		return <Table key={blockKey} lines={lines} blockKey={blockKey} />;
	}

	const isBulletList = lines.every((l) => /^[-*]\s+/.test(l.trim()));
	if (isBulletList) {
		return (
			<ul key={blockKey} className="list-disc space-y-0.5 pl-4">
				{lines.map((l, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: fixed line order from parsed message text
					<li key={`${blockKey}-${i}`}>
						{renderInline(l.trim().replace(/^[-*]\s+/, ""), `${blockKey}-${i}`)}
					</li>
				))}
			</ul>
		);
	}

	const isNumberedList = lines.every((l) => /^\d+[.)]\s+/.test(l.trim()));
	if (isNumberedList) {
		return (
			<ol key={blockKey} className="list-decimal space-y-0.5 pl-4">
				{lines.map((l, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: fixed line order from parsed message text
					<li key={`${blockKey}-${i}`}>
						{renderInline(
							l.trim().replace(/^\d+[.)]\s+/, ""),
							`${blockKey}-${i}`,
						)}
					</li>
				))}
			</ol>
		);
	}

	return (
		<p key={blockKey}>
			{lines.map((l, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: fixed line order from parsed message text
				<Fragment key={`${blockKey}-${i}`}>
					{i > 0 && <br />}
					{renderInline(l, `${blockKey}-${i}`)}
				</Fragment>
			))}
		</p>
	);
}

export function MarkdownLite({ content }: { content: string }) {
	const blocks = content.split(/\n\s*\n/);
	return (
		<div className="space-y-2">
			{blocks.map((block, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: fixed block order from parsed message text
				<Fragment key={`b-${i}`}>{renderBlock(block, `b-${i}`)}</Fragment>
			))}
		</div>
	);
}
