import * as os from "node:os";
import {
	Box,
	Container,
	getCapabilities,
	getImageDimensions,
	Image,
	imageFallback,
	Spacer,
	Text,
	type TUI,
} from "@oh-my-pi/pi-tui";
import stripAnsi from "strip-ansi";
import type { CustomTool } from "../../../core/custom-tools/types";
import { computeEditDiff, type EditDiffError, type EditDiffResult } from "../../../core/tools/edit-diff";
import { toolRenderers } from "../../../core/tools/renderers";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "../../../core/tools/truncate";
import { sanitizeBinaryOutput } from "../../../utils/shell";
import { getLanguageFromPath, highlightCode, theme } from "../theme/theme";
import { renderDiff } from "./diff";
import { truncateToVisualLines } from "./visual-truncate";

// Preview line limit for bash when not expanded
const BASH_PREVIEW_LINES = 5;
const GENERIC_PREVIEW_LINES = 6;
const GENERIC_ARG_PREVIEW = 6;
const GENERIC_VALUE_MAX = 80;
const EDIT_DIFF_PREVIEW_HUNKS = 2;
const EDIT_DIFF_PREVIEW_LINES = 24;

function wrapBrackets(text: string): string {
	return `${theme.format.bracketLeft}${text}${theme.format.bracketRight}`;
}

function countLines(text: string): number {
	if (!text) return 0;
	return text.split("\n").length;
}

function formatMetadataLine(lineCount: number | null, language: string | undefined): string {
	const icon = theme.getLangIcon(language);
	if (lineCount !== null) {
		return theme.fg("dim", `${icon} ${lineCount} lines`);
	}
	return theme.fg("dim", `${icon}`);
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "tiff"]);
const BINARY_EXTENSIONS = new Set(["pdf", "zip", "tar", "gz", "exe", "dll", "so", "dylib", "wasm"]);

function getFileType(filePath: string): "image" | "binary" | "text" {
	const ext = filePath.split(".").pop()?.toLowerCase();
	if (!ext) return "text";
	if (IMAGE_EXTENSIONS.has(ext)) return "image";
	if (BINARY_EXTENSIONS.has(ext)) return "binary";
	return "text";
}

function formatDiffStats(added: number, removed: number, hunks: number): string {
	const parts: string[] = [];
	if (added > 0) parts.push(theme.fg("success", `+${added}`));
	if (removed > 0) parts.push(theme.fg("error", `-${removed}`));
	if (hunks > 0) parts.push(theme.fg("dim", `${hunks} hunk${hunks !== 1 ? "s" : ""}`));
	return parts.join(theme.fg("dim", " / "));
}

type DiffStats = {
	added: number;
	removed: number;
	hunks: number;
	lines: number;
};

function getDiffStats(diffText: string): DiffStats {
	const lines = diffText ? diffText.split("\n") : [];
	let added = 0;
	let removed = 0;
	let hunks = 0;
	let inHunk = false;

	for (const line of lines) {
		const isAdded = line.startsWith("+");
		const isRemoved = line.startsWith("-");
		const isChange = isAdded || isRemoved;

		if (isAdded) added++;
		if (isRemoved) removed++;

		if (isChange && !inHunk) {
			hunks++;
			inHunk = true;
		} else if (!isChange) {
			inHunk = false;
		}
	}

	return { added, removed, hunks, lines: lines.length };
}

function truncateDiffByHunk(
	diffText: string,
	maxHunks: number,
	maxLines: number,
): { text: string; hiddenHunks: number; hiddenLines: number } {
	const lines = diffText ? diffText.split("\n") : [];
	const totalStats = getDiffStats(diffText);
	const kept: string[] = [];
	let inHunk = false;
	let currentHunks = 0;
	let reachedLimit = false;

	for (const line of lines) {
		const isChange = line.startsWith("+") || line.startsWith("-");
		if (isChange && !inHunk) {
			currentHunks++;
			inHunk = true;
		}
		if (!isChange) {
			inHunk = false;
		}

		if (currentHunks > maxHunks) {
			reachedLimit = true;
			break;
		}

		kept.push(line);
		if (kept.length >= maxLines) {
			reachedLimit = true;
			break;
		}
	}

	if (!reachedLimit) {
		return { text: diffText, hiddenHunks: 0, hiddenLines: 0 };
	}

	const keptStats = getDiffStats(kept.join("\n"));
	return {
		text: kept.join("\n"),
		hiddenHunks: Math.max(0, totalStats.hunks - keptStats.hunks),
		hiddenLines: Math.max(0, totalStats.lines - kept.length),
	};
}

interface ParsedDiagnostic {
	filePath: string;
	line: number;
	col: number;
	severity: "error" | "warning" | "info" | "hint";
	source?: string;
	message: string;
	code?: string;
}

function parseDiagnosticMessage(msg: string): ParsedDiagnostic | null {
	// Format: filePath:line:col [severity] [source] message (code)
	const match = msg.match(/^(.+?):(\d+):(\d+)\s+\[(\w+)\]\s+(?:\[([^\]]+)\]\s+)?(.+?)(?:\s+\(([^)]+)\))?$/);
	if (!match) return null;
	return {
		filePath: match[1],
		line: parseInt(match[2], 10),
		col: parseInt(match[3], 10),
		severity: match[4] as ParsedDiagnostic["severity"],
		source: match[5],
		message: match[6],
		code: match[7],
	};
}

function formatDiagnostics(diag: { errored: boolean; summary: string; messages: string[] }, expanded: boolean): string {
	if (diag.messages.length === 0) return "";

	// Parse and group diagnostics by file
	const byFile = new Map<string, ParsedDiagnostic[]>();
	const unparsed: string[] = [];

	for (const msg of diag.messages) {
		const parsed = parseDiagnosticMessage(msg);
		if (parsed) {
			const existing = byFile.get(parsed.filePath) ?? [];
			existing.push(parsed);
			byFile.set(parsed.filePath, existing);
		} else {
			unparsed.push(msg);
		}
	}

	const headerIcon = diag.errored
		? theme.styledSymbol("status.error", "error")
		: theme.styledSymbol("status.warning", "warning");
	let output = `\n\n${headerIcon} ${theme.fg("toolTitle", "Diagnostics")} ${theme.fg("dim", `(${diag.summary})`)}`;

	const maxDiags = expanded ? diag.messages.length : 5;
	let shown = 0;

	// Render grouped diagnostics with file icons
	const files = Array.from(byFile.entries());
	for (let fi = 0; fi < files.length && shown < maxDiags; fi++) {
		const [filePath, diagnostics] = files[fi];
		const isLastFile = fi === files.length - 1 && unparsed.length === 0;
		const fileBranch = isLastFile ? theme.tree.last : theme.tree.branch;

		// File header with icon
		output += `\n ${theme.fg("dim", fileBranch)} ${theme.fg("muted", theme.icon.file)} ${theme.fg("accent", filePath)}`;
		shown++;

		// Render diagnostics for this file
		for (let di = 0; di < diagnostics.length && shown < maxDiags; di++) {
			const d = diagnostics[di];
			const isLastDiag = di === diagnostics.length - 1;
			const diagBranch = isLastFile
				? isLastDiag
					? `   ${theme.tree.last}`
					: `   ${theme.tree.branch}`
				: isLastDiag
					? ` ${theme.tree.vertical} ${theme.tree.last}`
					: ` ${theme.tree.vertical} ${theme.tree.branch}`;

			const sevIcon =
				d.severity === "error"
					? theme.styledSymbol("status.error", "error")
					: d.severity === "warning"
						? theme.styledSymbol("status.warning", "warning")
						: theme.styledSymbol("status.info", "muted");
			const location = theme.fg("dim", `:${d.line}:${d.col}`);
			const codeTag = d.code ? theme.fg("dim", ` (${d.code})`) : "";
			const msgColor = d.severity === "error" ? "error" : d.severity === "warning" ? "warning" : "toolOutput";

			output += `\n ${theme.fg("dim", diagBranch)} ${sevIcon}${location} ${theme.fg(msgColor, d.message)}${codeTag}`;
			shown++;
		}
	}

	// Render unparsed messages (fallback)
	for (const msg of unparsed) {
		if (shown >= maxDiags) break;
		const color = msg.includes("[error]") ? "error" : msg.includes("[warning]") ? "warning" : "dim";
		output += `\n ${theme.fg("dim", theme.tree.branch)} ${theme.fg(color, msg)}`;
		shown++;
	}

	if (diag.messages.length > shown) {
		const remaining = diag.messages.length - shown;
		output += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg("muted", `${theme.format.ellipsis} ${remaining} more`)} ${theme.fg("dim", "(Ctrl+O to expand)")}`;
	}

	return output;
}

function formatCompactValue(value: unknown, maxLength: number): string {
	let rendered = "";

	if (value === null) {
		rendered = "null";
	} else if (value === undefined) {
		rendered = "undefined";
	} else if (typeof value === "string") {
		rendered = value;
	} else if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
		rendered = String(value);
	} else if (Array.isArray(value)) {
		const previewItems = value.slice(0, 3).map((item) => formatCompactValue(item, maxLength));
		rendered = `[${previewItems.join(", ")}${value.length > 3 ? ", ..." : ""}]`;
	} else if (typeof value === "object") {
		try {
			rendered = JSON.stringify(value);
		} catch {
			rendered = "[object]";
		}
	} else if (typeof value === "function") {
		rendered = "[function]";
	} else {
		rendered = String(value);
	}

	if (rendered.length > maxLength) {
		rendered = `${rendered.slice(0, maxLength - 1)}${theme.format.ellipsis}`;
	}

	return rendered;
}

function formatArgsPreview(
	args: unknown,
	maxEntries: number,
	maxValueLength: number,
): { lines: string[]; remaining: number; total: number } {
	if (args === undefined) {
		return { lines: [theme.fg("dim", "(none)")], remaining: 0, total: 0 };
	}
	if (args === null || typeof args !== "object") {
		const single = theme.fg("toolOutput", formatCompactValue(args, maxValueLength));
		return { lines: [single], remaining: 0, total: 1 };
	}

	const entries = Object.entries(args as Record<string, unknown>);
	const total = entries.length;
	const visible = entries.slice(0, maxEntries);
	const lines = visible.map(([key, value]) => {
		const keyText = theme.fg("accent", key);
		const valueText = theme.fg("toolOutput", formatCompactValue(value, maxValueLength));
		return `${keyText}: ${valueText}`;
	});

	return { lines, remaining: Math.max(total - visible.length, 0), total };
}

/**
 * Convert absolute path to tilde notation if it's in home directory
 */
function shortenPath(path: string): string {
	const home = os.homedir();
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

/**
 * Replace tabs with spaces for consistent rendering
 */
function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

export interface ToolExecutionOptions {
	showImages?: boolean; // default: true (only used if terminal supports images)
}

/**
 * Component that renders a tool call with its result (updateable)
 */
export class ToolExecutionComponent extends Container {
	private contentBox: Box; // Used for custom tools and bash visual truncation
	private contentText: Text; // For built-in tools (with its own padding/bg)
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	private args: any;
	private expanded = false;
	private showImages: boolean;
	private isPartial = true;
	private customTool?: CustomTool;
	private ui: TUI;
	private cwd: string;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: any;
	};
	// Cached edit diff preview (computed when args arrive, before tool executes)
	private editDiffPreview?: EditDiffResult | EditDiffError;
	private editDiffArgsKey?: string; // Track which args the preview is for
	// Spinner animation for partial task results
	private spinnerFrame = 0;
	private spinnerInterval: ReturnType<typeof setInterval> | null = null;

	constructor(
		toolName: string,
		args: any,
		options: ToolExecutionOptions = {},
		customTool: CustomTool | undefined,
		ui: TUI,
		cwd: string = process.cwd(),
	) {
		super();
		this.toolName = toolName;
		this.args = args;
		this.showImages = options.showImages ?? true;
		this.customTool = customTool;
		this.ui = ui;
		this.cwd = cwd;

		this.addChild(new Spacer(1));

		// Always create both - contentBox for custom tools/bash/tools with renderers, contentText for other built-ins
		this.contentBox = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.contentText = new Text("", 1, 1, (text: string) => theme.bg("toolPendingBg", text));

		// Use Box for custom tools, bash, or built-in tools that have renderers
		const hasRenderer = toolName in toolRenderers;
		if (customTool || toolName === "bash" || hasRenderer) {
			this.addChild(this.contentBox);
		} else {
			this.addChild(this.contentText);
		}

		this.updateDisplay();
	}

	updateArgs(args: any): void {
		this.args = args;
		this.updateDisplay();
	}

	/**
	 * Signal that args are complete (tool is about to execute).
	 * This triggers diff computation for edit tool.
	 */
	setArgsComplete(): void {
		this.maybeComputeEditDiff();
	}

	/**
	 * Compute edit diff preview when we have complete args.
	 * This runs async and updates display when done.
	 */
	private maybeComputeEditDiff(): void {
		if (this.toolName !== "edit") return;

		const path = this.args?.path;
		const oldText = this.args?.oldText;
		const newText = this.args?.newText;

		// Need all three params to compute diff
		if (!path || oldText === undefined || newText === undefined) return;

		// Create a key to track which args this computation is for
		const argsKey = JSON.stringify({ path, oldText, newText });

		// Skip if we already computed for these exact args
		if (this.editDiffArgsKey === argsKey) return;

		this.editDiffArgsKey = argsKey;

		// Compute diff async
		computeEditDiff(path, oldText, newText, this.cwd).then((result) => {
			// Only update if args haven't changed since we started
			if (this.editDiffArgsKey === argsKey) {
				this.editDiffPreview = result;
				this.updateDisplay();
				this.ui.requestRender();
			}
		});
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
		},
		isPartial = false,
	): void {
		this.result = result;
		this.isPartial = isPartial;
		this.updateSpinnerAnimation();
		this.updateDisplay();
	}

	/**
	 * Start or stop spinner animation based on whether this is a partial task result.
	 */
	private updateSpinnerAnimation(): void {
		const needsSpinner = this.isPartial && this.toolName === "task";
		if (needsSpinner && !this.spinnerInterval) {
			this.spinnerInterval = setInterval(() => {
				this.spinnerFrame = (this.spinnerFrame + 1) % 10;
				this.updateDisplay();
				this.ui.requestRender();
			}, 80);
		} else if (!needsSpinner && this.spinnerInterval) {
			clearInterval(this.spinnerInterval);
			this.spinnerInterval = null;
		}
	}

	/**
	 * Stop spinner animation and cleanup resources.
	 */
	stopAnimation(): void {
		if (this.spinnerInterval) {
			clearInterval(this.spinnerInterval);
			this.spinnerInterval = null;
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	private updateDisplay(): void {
		// Set background based on state
		const bgFn = this.isPartial
			? (text: string) => theme.bg("toolPendingBg", text)
			: this.result?.isError
				? (text: string) => theme.bg("toolErrorBg", text)
				: (text: string) => theme.bg("toolSuccessBg", text);

		// Check for custom tool rendering
		if (this.customTool) {
			// Custom tools use Box for flexible component rendering
			this.contentBox.setBgFn(bgFn);
			this.contentBox.clear();

			// Render call component
			if (this.customTool.renderCall) {
				try {
					const callComponent = this.customTool.renderCall(this.args, theme);
					if (callComponent) {
						this.contentBox.addChild(callComponent);
					}
				} catch {
					// Fall back to default on error
					this.contentBox.addChild(new Text(theme.fg("toolTitle", theme.bold(this.toolName)), 0, 0));
				}
			} else {
				// No custom renderCall, show tool name
				this.contentBox.addChild(new Text(theme.fg("toolTitle", theme.bold(this.toolName)), 0, 0));
			}

			// Render result component if we have a result
			if (this.result && this.customTool.renderResult) {
				try {
					const resultComponent = this.customTool.renderResult(
						{ content: this.result.content as any, details: this.result.details },
						{ expanded: this.expanded, isPartial: this.isPartial, spinnerFrame: this.spinnerFrame },
						theme,
					);
					if (resultComponent) {
						this.contentBox.addChild(resultComponent);
					}
				} catch {
					// Fall back to showing raw output on error
					const output = this.getTextOutput();
					if (output) {
						this.contentBox.addChild(new Text(theme.fg("toolOutput", output), 0, 0));
					}
				}
			} else if (this.result) {
				// Has result but no custom renderResult
				const output = this.getTextOutput();
				if (output) {
					this.contentBox.addChild(new Text(theme.fg("toolOutput", output), 0, 0));
				}
			}
		} else if (this.toolName === "bash") {
			// Bash uses Box with visual line truncation
			this.contentBox.setBgFn(bgFn);
			this.contentBox.clear();
			this.renderBashContent();
		} else if (this.toolName in toolRenderers) {
			// Built-in tools with custom renderers
			const renderer = toolRenderers[this.toolName];
			this.contentBox.setBgFn(bgFn);
			this.contentBox.clear();

			// Render call component
			try {
				const callComponent = renderer.renderCall(this.args, theme);
				if (callComponent) {
					this.contentBox.addChild(callComponent);
				}
			} catch {
				// Fall back to default on error
				this.contentBox.addChild(new Text(theme.fg("toolTitle", theme.bold(this.toolName)), 0, 0));
			}

			// Render result component if we have a result
			if (this.result) {
				try {
					const resultComponent = renderer.renderResult(
						{ content: this.result.content as any, details: this.result.details },
						{ expanded: this.expanded, isPartial: this.isPartial, spinnerFrame: this.spinnerFrame },
						theme,
					);
					if (resultComponent) {
						this.contentBox.addChild(resultComponent);
					}
				} catch {
					// Fall back to showing raw output on error
					const output = this.getTextOutput();
					if (output) {
						this.contentBox.addChild(new Text(theme.fg("toolOutput", output), 0, 0));
					}
				}
			}
		} else {
			// Other built-in tools: use Text directly with caching
			this.contentText.setCustomBgFn(bgFn);
			this.contentText.setText(this.formatToolExecution());
		}

		// Handle images (same for both custom and built-in)
		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];

		if (this.result) {
			const imageBlocks = this.result.content?.filter((c: any) => c.type === "image") || [];
			const caps = getCapabilities();

			for (const img of imageBlocks) {
				if (caps.images && this.showImages && img.data && img.mimeType) {
					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.imageSpacers.push(spacer);
					const imageComponent = new Image(
						img.data,
						img.mimeType,
						{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
						{ maxWidthCells: 60 },
					);
					this.imageComponents.push(imageComponent);
					this.addChild(imageComponent);
				}
			}
		}
	}

	/**
	 * Render bash content using visual line truncation (like bash-execution.ts)
	 */
	private renderBashContent(): void {
		const command = this.args?.command || "";

		// Header
		this.contentBox.addChild(
			new Text(
				theme.fg("toolTitle", theme.bold(`$ ${command || theme.fg("toolOutput", theme.format.ellipsis)}`)),
				0,
				0,
			),
		);

		if (this.result) {
			const output = this.getTextOutput().trim();

			if (output) {
				// Style each line for the output
				const styledOutput = output
					.split("\n")
					.map((line) => theme.fg("toolOutput", line))
					.join("\n");

				if (this.expanded) {
					// Show all lines when expanded
					this.contentBox.addChild(new Text(`\n${styledOutput}`, 0, 0));
				} else {
					// Use visual line truncation when collapsed
					// Box has paddingX=1, so content width = terminal.columns - 2
					const { visualLines, skippedCount } = truncateToVisualLines(
						`\n${styledOutput}`,
						BASH_PREVIEW_LINES,
						this.ui.terminal.columns - 2,
					);

					const totalVisualLines = skippedCount + visualLines.length;
					if (skippedCount > 0) {
						this.contentBox.addChild(
							new Text(
								theme.fg(
									"dim",
									`\n${theme.format.ellipsis} (${skippedCount} earlier lines, showing ${visualLines.length} of ${totalVisualLines}) (ctrl+o to expand)`,
								),
								0,
								0,
							),
						);
					}

					// Add pre-rendered visual lines as a raw component
					this.contentBox.addChild({
						render: () => visualLines,
						invalidate: () => {},
					});
				}
			}

			// Truncation warnings
			const truncation = this.result.details?.truncation;
			const fullOutputPath = this.result.details?.fullOutputPath;
			if (truncation?.truncated || fullOutputPath) {
				const warnings: string[] = [];
				if (fullOutputPath) {
					warnings.push(`Full output: ${fullOutputPath}`);
				}
				if (truncation?.truncated) {
					if (truncation.truncatedBy === "lines") {
						warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
					} else {
						warnings.push(
							`Truncated: ${truncation.outputLines} lines shown (${formatSize(
								truncation.maxBytes ?? DEFAULT_MAX_BYTES,
							)} limit)`,
						);
					}
				}
				this.contentBox.addChild(new Text(`\n${theme.fg("warning", wrapBrackets(warnings.join(". ")))}`, 0, 0));
			}
		}
	}

	private getTextOutput(): string {
		if (!this.result) return "";

		const textBlocks = this.result.content?.filter((c: any) => c.type === "text") || [];
		const imageBlocks = this.result.content?.filter((c: any) => c.type === "image") || [];

		let output = textBlocks
			.map((c: any) => {
				// Use sanitizeBinaryOutput to handle binary data that crashes string-width
				return sanitizeBinaryOutput(stripAnsi(c.text || "")).replace(/\r/g, "");
			})
			.join("\n");

		const caps = getCapabilities();
		if (imageBlocks.length > 0 && (!caps.images || !this.showImages)) {
			const imageIndicators = imageBlocks
				.map((img: any) => {
					const dims = img.data ? (getImageDimensions(img.data, img.mimeType) ?? undefined) : undefined;
					return imageFallback(img.mimeType, dims);
				})
				.join("\n");
			output = output ? `${output}\n${imageIndicators}` : imageIndicators;
		}

		return output;
	}

	private formatToolExecution(): string {
		let text = "";

		if (this.toolName === "read") {
			const rawPath = this.args?.file_path || this.args?.path || "";
			const path = shortenPath(rawPath);
			const offset = this.args?.offset;
			const limit = this.args?.limit;
			const fileType = getFileType(rawPath);

			let pathDisplay = path ? theme.fg("accent", path) : theme.fg("toolOutput", theme.format.ellipsis);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				pathDisplay += theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}

			text = `${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}`;

			if (this.result) {
				const output = this.getTextOutput();

				if (fileType === "image") {
					// Image file - use image icon
					const ext = rawPath.split(".").pop()?.toLowerCase() ?? "image";
					text += `${theme.sep.dot}${theme.fg("dim", theme.getLangIcon(ext))}`;
					// Images are rendered by the image component, just show hint
					text += `\n${theme.fg("muted", "Image rendered below")}`;
				} else if (fileType === "binary") {
					// Binary file - use binary/pdf/archive icon based on extension
					const ext = rawPath.split(".").pop()?.toLowerCase() ?? "binary";
					text += `${theme.sep.dot}${theme.fg("dim", theme.getLangIcon(ext))}`;
				} else {
					// Text file - show line count and language on same line
					const lang = getLanguageFromPath(rawPath);
					const lines = lang ? highlightCode(replaceTabs(output), lang) : output.split("\n");
					text += `${theme.sep.dot}${formatMetadataLine(null, lang)}`;

					// Content is hidden by default, only shown when expanded
					if (this.expanded) {
						text +=
							"\n\n" +
							lines
								.map((line: string) => (lang ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line))))
								.join("\n");
					} else {
						text += `\n${theme.fg("dim", `${theme.nav.expand} Ctrl+O to show content`)}`;
					}

					// Truncation warning
					const truncation = this.result.details?.truncation;
					if (truncation?.truncated) {
						let warning: string;
						if (truncation.firstLineExceedsLimit) {
							warning = `First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`;
						} else if (truncation.truncatedBy === "lines") {
							warning = `Truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)`;
						} else {
							warning = `Truncated: ${truncation.outputLines} lines (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`;
						}
						text += `\n${theme.fg("warning", wrapBrackets(warning))}`;
					}
				}
			}
		} else if (this.toolName === "write") {
			const rawPath = this.args?.file_path || this.args?.path || "";
			const path = shortenPath(rawPath);
			const fileContent = this.args?.content || "";
			const lang = getLanguageFromPath(rawPath);
			const lines = fileContent
				? lang
					? highlightCode(replaceTabs(fileContent), lang)
					: fileContent.split("\n")
				: [];
			const totalLines = lines.length;

			text =
				theme.fg("toolTitle", theme.bold("write")) +
				" " +
				(path ? theme.fg("accent", path) : theme.fg("toolOutput", theme.format.ellipsis));

			text += `\n${formatMetadataLine(countLines(fileContent), lang ?? "text")}`;

			if (fileContent) {
				const maxLines = this.expanded ? lines.length : 10;
				const displayLines = lines.slice(0, maxLines);
				const remaining = lines.length - maxLines;

				text +=
					"\n\n" +
					displayLines
						.map((line: string) => (lang ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line))))
						.join("\n");
				if (remaining > 0) {
					text += theme.fg(
						"toolOutput",
						`\n${theme.format.ellipsis} (${remaining} more lines, ${totalLines} total) ${wrapBrackets("Ctrl+O to expand")}`,
					);
				}
			}

			// Show LSP diagnostics if available
			if (this.result?.details?.diagnostics) {
				text += formatDiagnostics(this.result.details.diagnostics, this.expanded);
			}
		} else if (this.toolName === "edit") {
			const rawPath = this.args?.file_path || this.args?.path || "";
			const path = shortenPath(rawPath);

			// Build path display, appending :line if we have diff info
			let pathDisplay = path ? theme.fg("accent", path) : theme.fg("toolOutput", theme.format.ellipsis);
			const firstChangedLine =
				(this.editDiffPreview && "firstChangedLine" in this.editDiffPreview
					? this.editDiffPreview.firstChangedLine
					: undefined) ||
				(this.result && !this.result.isError ? this.result.details?.firstChangedLine : undefined);
			if (firstChangedLine) {
				pathDisplay += theme.fg("warning", `:${firstChangedLine}`);
			}

			text = `${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;

			const editLanguage = getLanguageFromPath(rawPath) ?? "text";
			const editLineCount = countLines(this.args?.newText ?? this.args?.oldText ?? "");
			text += `\n${formatMetadataLine(editLineCount, editLanguage)}`;

			if (this.result?.isError) {
				// Show error from result
				const errorText = this.getTextOutput();
				if (errorText) {
					text += `\n\n${theme.fg("error", errorText)}`;
				}
			} else if (this.editDiffPreview) {
				// Use cached diff preview (works both before and after execution)
				if ("error" in this.editDiffPreview) {
					text += `\n\n${theme.fg("error", this.editDiffPreview.error)}`;
				} else if (this.editDiffPreview.diff) {
					const diffStats = getDiffStats(this.editDiffPreview.diff);
					text += `\n${theme.fg("dim", theme.format.bracketLeft)}${formatDiffStats(diffStats.added, diffStats.removed, diffStats.hunks)}${theme.fg("dim", theme.format.bracketRight)}`;

					const {
						text: diffText,
						hiddenHunks,
						hiddenLines,
					} = this.expanded
						? { text: this.editDiffPreview.diff, hiddenHunks: 0, hiddenLines: 0 }
						: truncateDiffByHunk(this.editDiffPreview.diff, EDIT_DIFF_PREVIEW_HUNKS, EDIT_DIFF_PREVIEW_LINES);

					text += `\n\n${renderDiff(diffText, { filePath: rawPath })}`;
					if (!this.expanded && (hiddenHunks > 0 || hiddenLines > 0)) {
						const remainder: string[] = [];
						if (hiddenHunks > 0) remainder.push(`${hiddenHunks} more hunks`);
						if (hiddenLines > 0) remainder.push(`${hiddenLines} more lines`);
						text += theme.fg(
							"toolOutput",
							`\n${theme.format.ellipsis} (${remainder.join(", ")}) ${wrapBrackets("Ctrl+O to expand")}`,
						);
					}
				}
			}

			// Show LSP diagnostics if available
			if (this.result?.details?.diagnostics) {
				text += formatDiagnostics(this.result.details.diagnostics, this.expanded);
			}
		} else {
			// Generic tool (shouldn't reach here for custom tools)
			text = theme.fg("toolTitle", theme.bold(this.toolName));

			const argTotal =
				this.args && typeof this.args === "object"
					? Object.keys(this.args as Record<string, unknown>).length
					: this.args === undefined
						? 0
						: 1;
			const argPreviewLimit = this.expanded ? argTotal : GENERIC_ARG_PREVIEW;
			const valueLimit = this.expanded ? 2000 : GENERIC_VALUE_MAX;
			const argsPreview = formatArgsPreview(this.args, argPreviewLimit, valueLimit);

			text += `\n\n${theme.fg("toolTitle", "Args")} ${theme.fg("dim", `(${argsPreview.total})`)}`;
			if (argsPreview.lines.length > 0) {
				text += `\n${argsPreview.lines.join("\n")}`;
			} else {
				text += `\n${theme.fg("dim", "(none)")}`;
			}
			if (argsPreview.remaining > 0) {
				text += theme.fg(
					"dim",
					`\n${theme.format.ellipsis} (${argsPreview.remaining} more args) (ctrl+o to expand)`,
				);
			}

			const output = this.getTextOutput().trim();
			text += `\n\n${theme.fg("toolTitle", "Output")}`;
			if (output) {
				const lines = output.split("\n");
				const maxLines = this.expanded ? lines.length : GENERIC_PREVIEW_LINES;
				const displayLines = lines.slice(-maxLines);
				const remaining = lines.length - displayLines.length;
				text += ` ${theme.fg("dim", `(${lines.length} lines)`)}`;
				text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
				if (remaining > 0) {
					text += theme.fg("dim", `\n${theme.format.ellipsis} (${remaining} earlier lines) (ctrl+o to expand)`);
				}
			} else {
				text += ` ${theme.fg("dim", "(empty)")}`;
			}
		}

		return text;
	}
}
