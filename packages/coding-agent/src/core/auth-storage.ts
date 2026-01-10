/**
 * Credential storage for API keys and OAuth tokens.
 * Handles loading, saving, and refreshing credentials from auth.json.
 *
 * Uses file locking to prevent race conditions when multiple pi instances
 * try to refresh tokens simultaneously.
 */

import {
	chmodSync,
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
	getEnvApiKey,
	getOAuthApiKey,
	loginAnthropic,
	loginAntigravity,
	loginGeminiCli,
	loginGitHubCopilot,
	loginOpenAICodex,
	type OAuthCredentials,
	type OAuthProvider,
} from "@oh-my-pi/pi-ai";
import { logger } from "./logger";

export type ApiKeyCredential = {
	type: "api_key";
	key: string;
};

export type OAuthCredential = {
	type: "oauth";
} & OAuthCredentials;

export type AuthCredential = ApiKeyCredential | OAuthCredential;

export type AuthCredentialEntry = AuthCredential | AuthCredential[];

export type AuthStorageData = Record<string, AuthCredentialEntry>;

/** Rate limit window from Codex usage API (primary or secondary quota). */
type CodexUsageWindow = {
	usedPercent?: number;
	limitWindowSeconds?: number;
	resetAt?: number; // Unix timestamp (seconds)
};

/** Parsed usage data from Codex /wham/usage endpoint. */
type CodexUsage = {
	allowed?: boolean;
	limitReached?: boolean;
	primary?: CodexUsageWindow;
	secondary?: CodexUsageWindow;
};

/** Cached usage entry with TTL for avoiding redundant API calls. */
type CodexUsageCacheEntry = {
	fetchedAt: number;
	expiresAt: number;
	usage?: CodexUsage;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function toNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function toBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

/**
 * Credential storage backed by a JSON file.
 * Reads from multiple fallback paths, writes to primary path.
 */
export class AuthStorage {
	// File locking configuration for concurrent access protection
	private static readonly lockRetryDelayMs = 50; // Polling interval when waiting for lock
	private static readonly lockTimeoutMs = 5000; // Max wait time before failing
	private static readonly lockStaleMs = 30000; // Age threshold for auto-removing orphaned locks
	private static readonly codexUsageCacheTtlMs = 60_000; // Cache usage data for 1 minute
	private static readonly defaultBackoffMs = 60_000; // Default backoff when no reset time available

	private data: AuthStorageData = {};
	private runtimeOverrides: Map<string, string> = new Map();
	/** Tracks next credential index per provider:type key for round-robin distribution (non-session use). */
	private providerRoundRobinIndex: Map<string, number> = new Map();
	/** Tracks the last used credential per provider for a session (used for rate-limit switching). */
	private sessionLastCredential: Map<string, Map<string, { type: AuthCredential["type"]; index: number }>> = new Map();
	/** Maps provider:type -> credentialIndex -> blockedUntilMs for temporary backoff. */
	private credentialBackoff: Map<string, Map<number, number>> = new Map();
	/** Cached usage info for providers that expose usage endpoints. */
	private codexUsageCache: Map<string, CodexUsageCacheEntry> = new Map();
	private fallbackResolver?: (provider: string) => string | undefined;

	/**
	 * @param authPath - Primary path for reading/writing auth.json
	 * @param fallbackPaths - Additional paths to check when reading (legacy support)
	 */
	constructor(
		private authPath: string,
		private fallbackPaths: string[] = [],
	) {}

	/**
	 * Set a runtime API key override (not persisted to disk).
	 * Used for CLI --api-key flag.
	 */
	setRuntimeApiKey(provider: string, apiKey: string): void {
		this.runtimeOverrides.set(provider, apiKey);
	}

	/**
	 * Remove a runtime API key override.
	 */
	removeRuntimeApiKey(provider: string): void {
		this.runtimeOverrides.delete(provider);
	}

	/**
	 * Set a fallback resolver for API keys not found in auth.json or env vars.
	 * Used for custom provider keys from models.json.
	 */
	setFallbackResolver(resolver: (provider: string) => string | undefined): void {
		this.fallbackResolver = resolver;
	}

	/**
	 * Reload credentials from disk.
	 * Checks primary path first, then fallback paths.
	 */
	async reload(): Promise<void> {
		const pathsToCheck = [this.authPath, ...this.fallbackPaths];

		logger.debug("AuthStorage.reload checking paths", { paths: pathsToCheck });

		for (const authPath of pathsToCheck) {
			const exists = existsSync(authPath);
			logger.debug("AuthStorage.reload path check", { path: authPath, exists });

			if (exists) {
				try {
					this.data = JSON.parse(readFileSync(authPath, "utf-8"));
					logger.debug("AuthStorage.reload loaded", { path: authPath, providers: Object.keys(this.data) });
					return;
				} catch (e) {
					logger.error("AuthStorage failed to parse auth file", { path: authPath, error: String(e) });
					// Continue to next path on parse error
				}
			}
		}

		logger.warn("AuthStorage no auth file found", { checkedPaths: pathsToCheck });
		this.data = {};
	}

	/**
	 * Save credentials to disk.
	 */
	private async save(): Promise<void> {
		const lockFd = await this.acquireLock();
		const tempPath = this.getTempPath();

		try {
			writeFileSync(tempPath, JSON.stringify(this.data, null, 2), { mode: 0o600 });
			renameSync(tempPath, this.authPath);
			chmodSync(this.authPath, 0o600);
			const dir = dirname(this.authPath);
			chmodSync(dir, 0o700);
		} finally {
			this.safeUnlink(tempPath);
			this.releaseLock(lockFd);
		}
	}

	/** Returns the lock file path (auth.json.lock) */
	private getLockPath(): string {
		return `${this.authPath}.lock`;
	}

	/** Returns a unique temp file path using pid and timestamp to avoid collisions */
	private getTempPath(): string {
		return `${this.authPath}.tmp-${process.pid}-${Date.now()}`;
	}

	/** Checks if lock file is older than lockStaleMs (orphaned by crashed process) */
	private isLockStale(lockPath: string): boolean {
		try {
			const stats = statSync(lockPath);
			return Date.now() - stats.mtimeMs > AuthStorage.lockStaleMs;
		} catch {
			return false;
		}
	}

	/**
	 * Acquires exclusive file lock using O_EXCL atomic create.
	 * Polls with exponential backoff, removes stale locks from crashed processes.
	 * @returns File descriptor for the lock (must be passed to releaseLock)
	 */
	private async acquireLock(): Promise<number> {
		const lockPath = this.getLockPath();
		const start = Date.now();
		const timeoutMs = AuthStorage.lockTimeoutMs;
		const retryDelayMs = AuthStorage.lockRetryDelayMs;

		while (true) {
			try {
				// O_EXCL fails if file exists, providing atomic lock acquisition
				return openSync(lockPath, "wx", 0o600);
			} catch (error) {
				const err = error as NodeJS.ErrnoException;
				if (err.code !== "EEXIST") {
					throw err;
				}
				if (this.isLockStale(lockPath)) {
					this.safeUnlink(lockPath);
					logger.warn("AuthStorage lock was stale, removing", { path: lockPath });
					continue;
				}
				if (Date.now() - start > timeoutMs) {
					throw new Error(`Timed out waiting for auth lock: ${lockPath}`);
				}
				await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
			}
		}
	}

	/** Releases file lock by closing fd and removing lock file */
	private releaseLock(lockFd: number): void {
		const lockPath = this.getLockPath();
		try {
			closeSync(lockFd);
		} catch (error) {
			logger.warn("AuthStorage failed to close lock file", { error: String(error) });
		}
		this.safeUnlink(lockPath);
	}

	/** Removes file if it exists, ignoring ENOENT errors */
	private safeUnlink(path: string): void {
		try {
			unlinkSync(path);
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			if (err.code !== "ENOENT") {
				logger.warn("AuthStorage failed to remove file", { path, error: String(error) });
			}
		}
	}

	/** Normalizes credential storage format: single credential becomes array of one */
	private normalizeCredentialEntry(entry: AuthCredentialEntry | undefined): AuthCredential[] {
		if (!entry) return [];
		return Array.isArray(entry) ? entry : [entry];
	}

	/** Returns all credentials for a provider as an array */
	private getCredentialsForProvider(provider: string): AuthCredential[] {
		return this.normalizeCredentialEntry(this.data[provider]);
	}

	/** Composite key for round-robin tracking: "anthropic:oauth" or "openai:api_key" */
	private getProviderTypeKey(provider: string, type: AuthCredential["type"]): string {
		return `${provider}:${type}`;
	}

	/**
	 * Returns next index in round-robin sequence for load distribution.
	 * Increments stored counter and wraps at total.
	 */
	private getNextRoundRobinIndex(providerKey: string, total: number): number {
		if (total <= 1) return 0;
		const current = this.providerRoundRobinIndex.get(providerKey) ?? -1;
		const next = (current + 1) % total;
		this.providerRoundRobinIndex.set(providerKey, next);
		return next;
	}

	/**
	 * FNV-1a hash for deterministic session-to-credential mapping.
	 * Ensures the same session always starts with the same credential.
	 */
	private getHashedIndex(sessionId: string, total: number): number {
		if (total <= 1) return 0;
		let hash = 2166136261; // FNV offset basis
		for (let i = 0; i < sessionId.length; i++) {
			hash ^= sessionId.charCodeAt(i);
			hash = Math.imul(hash, 16777619); // FNV prime
		}
		return (hash >>> 0) % total;
	}

	/**
	 * Returns credential indices in priority order for selection.
	 * With sessionId: starts from hashed index (consistent per session).
	 * Without sessionId: starts from round-robin index (load balancing).
	 * Order wraps around so all credentials are tried if earlier ones are blocked.
	 */
	private getCredentialOrder(providerKey: string, sessionId: string | undefined, total: number): number[] {
		if (total <= 1) return [0];
		const start = sessionId ? this.getHashedIndex(sessionId, total) : this.getNextRoundRobinIndex(providerKey, total);
		const order: number[] = [];
		for (let i = 0; i < total; i++) {
			order.push((start + i) % total);
		}
		return order;
	}

	/** Checks if a credential is temporarily blocked due to usage limits. */
	private isCredentialBlocked(providerKey: string, credentialIndex: number): boolean {
		const backoffMap = this.credentialBackoff.get(providerKey);
		if (!backoffMap) return false;
		const blockedUntil = backoffMap.get(credentialIndex);
		if (!blockedUntil) return false;
		if (blockedUntil <= Date.now()) {
			backoffMap.delete(credentialIndex);
			if (backoffMap.size === 0) {
				this.credentialBackoff.delete(providerKey);
			}
			return false;
		}
		return true;
	}

	/** Marks a credential as blocked until the specified time. */
	private markCredentialBlocked(providerKey: string, credentialIndex: number, blockedUntilMs: number): void {
		const backoffMap = this.credentialBackoff.get(providerKey) ?? new Map<number, number>();
		const existing = backoffMap.get(credentialIndex) ?? 0;
		backoffMap.set(credentialIndex, Math.max(existing, blockedUntilMs));
		this.credentialBackoff.set(providerKey, backoffMap);
	}

	/** Records which credential was used for a session (for rate-limit switching). */
	private recordSessionCredential(
		provider: string,
		sessionId: string | undefined,
		type: AuthCredential["type"],
		index: number,
	): void {
		if (!sessionId) return;
		const sessionMap = this.sessionLastCredential.get(provider) ?? new Map();
		sessionMap.set(sessionId, { type, index });
		this.sessionLastCredential.set(provider, sessionMap);
	}

	/** Retrieves the last credential used by a session. */
	private getSessionCredential(
		provider: string,
		sessionId: string | undefined,
	): { type: AuthCredential["type"]; index: number } | undefined {
		if (!sessionId) return undefined;
		return this.sessionLastCredential.get(provider)?.get(sessionId);
	}

	/**
	 * Selects a credential of the specified type for a provider.
	 * Returns both the credential and its index in the original array (for updates/removal).
	 * Uses deterministic hashing for session stickiness and skips blocked credentials when possible.
	 */
	private selectCredentialByType<T extends AuthCredential["type"]>(
		provider: string,
		type: T,
		sessionId?: string,
	): { credential: Extract<AuthCredential, { type: T }>; index: number } | undefined {
		const credentials = this.getCredentialsForProvider(provider)
			.map((credential, index) => ({ credential, index }))
			.filter(
				(entry): entry is { credential: Extract<AuthCredential, { type: T }>; index: number } =>
					entry.credential.type === type,
			);

		if (credentials.length === 0) return undefined;
		if (credentials.length === 1) return credentials[0];

		const providerKey = this.getProviderTypeKey(provider, type);
		const order = this.getCredentialOrder(providerKey, sessionId, credentials.length);
		const fallback = credentials[order[0]];

		for (const idx of order) {
			const candidate = credentials[idx];
			if (!this.isCredentialBlocked(providerKey, candidate.index)) {
				return candidate;
			}
		}

		return fallback;
	}

	/**
	 * Clears round-robin and session assignment state for a provider.
	 * Called when credentials are added/removed to prevent stale index references.
	 */
	private resetProviderAssignments(provider: string): void {
		for (const key of this.providerRoundRobinIndex.keys()) {
			if (key.startsWith(`${provider}:`)) {
				this.providerRoundRobinIndex.delete(key);
			}
		}
		this.sessionLastCredential.delete(provider);
		for (const key of this.credentialBackoff.keys()) {
			if (key.startsWith(`${provider}:`)) {
				this.credentialBackoff.delete(key);
			}
		}
	}

	/** Updates credential at index in-place (used for OAuth token refresh) */
	private replaceCredentialAt(provider: string, index: number, credential: AuthCredential): void {
		const entry = this.data[provider];
		if (!entry) return;

		if (Array.isArray(entry)) {
			if (index >= 0 && index < entry.length) {
				const updated = [...entry];
				updated[index] = credential;
				this.data[provider] = updated;
			}
			return;
		}

		if (index === 0) {
			this.data[provider] = credential;
		}
	}

	/**
	 * Removes credential at index (used when OAuth refresh fails).
	 * Cleans up provider entry if last credential removed.
	 */
	private removeCredentialAt(provider: string, index: number): void {
		const entry = this.data[provider];
		if (!entry) return;

		if (Array.isArray(entry)) {
			const updated = entry.filter((_value, idx) => idx !== index);
			if (updated.length > 0) {
				this.data[provider] = updated;
			} else {
				delete this.data[provider];
			}
		} else {
			delete this.data[provider];
		}

		this.resetProviderAssignments(provider);
	}

	/**
	 * Get credential for a provider (first entry if multiple).
	 */
	get(provider: string): AuthCredential | undefined {
		return this.getCredentialsForProvider(provider)[0];
	}

	/**
	 * Set credential for a provider.
	 */
	async set(provider: string, credential: AuthCredentialEntry): Promise<void> {
		this.data[provider] = credential;
		this.resetProviderAssignments(provider);
		await this.save();
	}

	/**
	 * Remove credential for a provider.
	 */
	async remove(provider: string): Promise<void> {
		delete this.data[provider];
		this.resetProviderAssignments(provider);
		await this.save();
	}

	/**
	 * List all providers with credentials.
	 */
	list(): string[] {
		return Object.keys(this.data);
	}

	/**
	 * Check if credentials exist for a provider in auth.json.
	 */
	has(provider: string): boolean {
		return this.getCredentialsForProvider(provider).length > 0;
	}

	/**
	 * Check if any form of auth is configured for a provider.
	 * Unlike getApiKey(), this doesn't refresh OAuth tokens.
	 */
	hasAuth(provider: string): boolean {
		if (this.runtimeOverrides.has(provider)) return true;
		if (this.getCredentialsForProvider(provider).length > 0) return true;
		if (getEnvApiKey(provider)) return true;
		if (this.fallbackResolver?.(provider)) return true;
		return false;
	}

	/**
	 * Check if OAuth credentials are configured for a provider.
	 */
	hasOAuth(provider: string): boolean {
		return this.getCredentialsForProvider(provider).some((credential) => credential.type === "oauth");
	}

	/**
	 * Get OAuth credentials for a provider.
	 */
	getOAuthCredential(provider: string): OAuthCredential | undefined {
		return this.getCredentialsForProvider(provider).find(
			(credential): credential is OAuthCredential => credential.type === "oauth",
		);
	}

	/**
	 * Get all credentials.
	 */
	getAll(): AuthStorageData {
		return { ...this.data };
	}

	/**
	 * Login to an OAuth provider.
	 */
	async login(
		provider: OAuthProvider,
		callbacks: {
			onAuth: (info: { url: string; instructions?: string }) => void;
			onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string>;
			onProgress?: (message: string) => void;
			/** For providers with local callback servers (e.g., openai-codex), races with browser callback */
			onManualCodeInput?: () => Promise<string>;
			/** For cancellation support (e.g., github-copilot polling) */
			signal?: AbortSignal;
		},
	): Promise<void> {
		let credentials: OAuthCredentials;

		switch (provider) {
			case "anthropic":
				credentials = await loginAnthropic(
					(url) => callbacks.onAuth({ url }),
					() => callbacks.onPrompt({ message: "Paste the authorization code:" }),
				);
				break;
			case "github-copilot":
				credentials = await loginGitHubCopilot({
					onAuth: (url, instructions) => callbacks.onAuth({ url, instructions }),
					onPrompt: callbacks.onPrompt,
					onProgress: callbacks.onProgress,
					signal: callbacks.signal,
				});
				break;
			case "google-gemini-cli":
				credentials = await loginGeminiCli(callbacks.onAuth, callbacks.onProgress, callbacks.onManualCodeInput);
				break;
			case "google-antigravity":
				credentials = await loginAntigravity(callbacks.onAuth, callbacks.onProgress, callbacks.onManualCodeInput);
				break;
			case "openai-codex":
				credentials = await loginOpenAICodex({
					onAuth: callbacks.onAuth,
					onPrompt: callbacks.onPrompt,
					onProgress: callbacks.onProgress,
					onManualCodeInput: callbacks.onManualCodeInput,
				});
				break;
			default:
				throw new Error(`Unknown OAuth provider: ${provider}`);
		}

		const newCredential: OAuthCredential = { type: "oauth", ...credentials };
		const existing = this.getCredentialsForProvider(provider);
		if (existing.length === 0) {
			await this.set(provider, newCredential);
			return;
		}

		await this.set(provider, [...existing, newCredential]);
	}

	/**
	 * Logout from a provider.
	 */
	async logout(provider: string): Promise<void> {
		await this.remove(provider);
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// Codex Usage API Integration
	// Queries ChatGPT/Codex usage endpoints to detect rate limits before they occur.
	// ─────────────────────────────────────────────────────────────────────────────

	/** Normalizes Codex base URL to include /backend-api path. */
	private normalizeCodexBaseUrl(baseUrl?: string): string {
		const fallback = "https://chatgpt.com/backend-api";
		const trimmed = baseUrl?.trim() ? baseUrl.trim() : fallback;
		const base = trimmed.replace(/\/+$/, "");
		const lower = base.toLowerCase();
		if (
			(lower.startsWith("https://chatgpt.com") || lower.startsWith("https://chat.openai.com")) &&
			!lower.includes("/backend-api")
		) {
			return `${base}/backend-api`;
		}
		return base;
	}

	private getCodexUsagePath(baseUrl: string): string {
		return baseUrl.includes("/backend-api") ? "wham/usage" : "api/codex/usage";
	}

	private buildCodexUsageUrl(baseUrl: string, path: string): string {
		const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
		return `${normalized}${path.replace(/^\/+/, "")}`;
	}

	private getCodexUsageCacheKey(accountId: string, baseUrl: string): string {
		return `${baseUrl}|${accountId}`;
	}

	private extractCodexUsageWindow(window: unknown): CodexUsageWindow | undefined {
		if (!isRecord(window)) return undefined;
		const usedPercent = toNumber(window.used_percent);
		const limitWindowSeconds = toNumber(window.limit_window_seconds);
		const resetAt = toNumber(window.reset_at);
		if (usedPercent === undefined && limitWindowSeconds === undefined && resetAt === undefined) return undefined;
		return { usedPercent, limitWindowSeconds, resetAt };
	}

	private extractCodexUsage(payload: unknown): CodexUsage | undefined {
		if (!isRecord(payload)) return undefined;
		const rateLimit = isRecord(payload.rate_limit) ? payload.rate_limit : undefined;
		if (!rateLimit) return undefined;
		const primary = this.extractCodexUsageWindow(rateLimit.primary_window);
		const secondary = this.extractCodexUsageWindow(rateLimit.secondary_window);
		const usage: CodexUsage = {
			allowed: toBoolean(rateLimit.allowed),
			limitReached: toBoolean(rateLimit.limit_reached),
			primary,
			secondary,
		};
		if (!primary && !secondary && usage.allowed === undefined && usage.limitReached === undefined) return undefined;
		return usage;
	}

	/** Returns true if usage indicates rate limit has been reached. */
	private isCodexUsageLimitReached(usage: CodexUsage): boolean {
		if (usage.allowed === false || usage.limitReached === true) return true;
		if (usage.primary?.usedPercent !== undefined && usage.primary.usedPercent >= 100) return true;
		if (usage.secondary?.usedPercent !== undefined && usage.secondary.usedPercent >= 100) return true;
		return false;
	}

	/** Extracts the earliest reset timestamp from usage windows (in ms). */
	private getCodexResetAtMs(usage: CodexUsage): number | undefined {
		const now = Date.now();
		const candidates: number[] = [];
		const addCandidate = (value: number | undefined) => {
			if (!value) return;
			const ms = value > 1_000_000_000_000 ? value : value * 1000;
			if (Number.isFinite(ms) && ms > now) {
				candidates.push(ms);
			}
		};
		const useAll = usage.limitReached === true || usage.allowed === false;
		if (useAll) {
			addCandidate(usage.primary?.resetAt);
			addCandidate(usage.secondary?.resetAt);
		} else {
			if (usage.primary?.usedPercent !== undefined && usage.primary.usedPercent >= 100) {
				addCandidate(usage.primary.resetAt);
			}
			if (usage.secondary?.usedPercent !== undefined && usage.secondary.usedPercent >= 100) {
				addCandidate(usage.secondary.resetAt);
			}
		}
		if (candidates.length === 0) return undefined;
		return Math.min(...candidates);
	}

	private getCodexUsageExpiryMs(usage: CodexUsage, nowMs: number): number {
		const resetAtMs = this.getCodexResetAtMs(usage);
		if (this.isCodexUsageLimitReached(usage)) {
			if (resetAtMs) return resetAtMs;
			return nowMs + AuthStorage.defaultBackoffMs;
		}
		const defaultExpiry = nowMs + AuthStorage.codexUsageCacheTtlMs;
		if (!resetAtMs) return defaultExpiry;
		return Math.min(defaultExpiry, resetAtMs);
	}

	/** Fetches usage data from Codex API. */
	private async fetchCodexUsage(credential: OAuthCredential, baseUrl?: string): Promise<CodexUsage | undefined> {
		const accountId = credential.accountId;
		if (!accountId) return undefined;

		const normalizedBase = this.normalizeCodexBaseUrl(baseUrl);
		const url = this.buildCodexUsageUrl(normalizedBase, this.getCodexUsagePath(normalizedBase));
		const headers = {
			authorization: `Bearer ${credential.access}`,
			"chatgpt-account-id": accountId,
			"openai-beta": "responses=experimental",
			originator: "codex_cli_rs",
		};

		try {
			const response = await fetch(url, { headers });
			if (!response.ok) {
				logger.debug("AuthStorage codex usage fetch failed", {
					status: response.status,
					statusText: response.statusText,
				});
				return undefined;
			}

			const payload = (await response.json()) as unknown;
			return this.extractCodexUsage(payload);
		} catch (error) {
			logger.debug("AuthStorage codex usage fetch error", { error: String(error) });
			return undefined;
		}
	}

	/** Gets usage data with caching to avoid redundant API calls. */
	private async getCodexUsage(credential: OAuthCredential, baseUrl?: string): Promise<CodexUsage | undefined> {
		const accountId = credential.accountId;
		if (!accountId) return undefined;

		const normalizedBase = this.normalizeCodexBaseUrl(baseUrl);
		const cacheKey = this.getCodexUsageCacheKey(accountId, normalizedBase);
		const now = Date.now();
		const cached = this.codexUsageCache.get(cacheKey);
		if (cached && cached.expiresAt > now) {
			return cached.usage;
		}

		const usage = await this.fetchCodexUsage(credential, normalizedBase);
		if (usage) {
			const expiresAt = this.getCodexUsageExpiryMs(usage, now);
			this.codexUsageCache.set(cacheKey, { fetchedAt: now, expiresAt, usage });
			return usage;
		}

		this.codexUsageCache.set(cacheKey, {
			fetchedAt: now,
			expiresAt: now + AuthStorage.defaultBackoffMs,
		});
		return undefined;
	}

	/**
	 * Marks the current session's credential as temporarily blocked due to usage limits.
	 * Queries the Codex usage API to determine accurate reset time.
	 * Returns true if a credential was blocked, enabling automatic fallback to the next credential.
	 */
	async markUsageLimitReached(
		provider: string,
		sessionId: string | undefined,
		options?: { retryAfterMs?: number; baseUrl?: string },
	): Promise<boolean> {
		const sessionCredential = this.getSessionCredential(provider, sessionId);
		if (!sessionCredential) return false;

		const providerKey = this.getProviderTypeKey(provider, sessionCredential.type);
		const now = Date.now();
		let blockedUntil = now + (options?.retryAfterMs ?? AuthStorage.defaultBackoffMs);

		if (provider === "openai-codex" && sessionCredential.type === "oauth") {
			const credential = this.getCredentialsForProvider(provider)[sessionCredential.index];
			if (credential?.type === "oauth") {
				const usage = await this.getCodexUsage(credential, options?.baseUrl);
				if (usage) {
					const resetAtMs = this.getCodexResetAtMs(usage);
					if (resetAtMs && resetAtMs > blockedUntil) {
						blockedUntil = resetAtMs;
					}
				}
			}
		}

		this.markCredentialBlocked(providerKey, sessionCredential.index, blockedUntil);
		return true;
	}

	/**
	 * Resolves an OAuth API key, trying credentials in priority order.
	 * Skips blocked credentials and checks usage limits for Codex accounts.
	 * Falls back to earliest-unblocking credential if all are blocked.
	 */
	private async resolveOAuthApiKey(
		provider: string,
		sessionId?: string,
		options?: { baseUrl?: string },
	): Promise<string | undefined> {
		const credentials = this.getCredentialsForProvider(provider)
			.map((credential, index) => ({ credential, index }))
			.filter((entry): entry is { credential: OAuthCredential; index: number } => entry.credential.type === "oauth");

		if (credentials.length === 0) return undefined;

		const providerKey = this.getProviderTypeKey(provider, "oauth");
		const order = this.getCredentialOrder(providerKey, sessionId, credentials.length);
		const fallback = credentials[order[0]];
		const checkUsage = provider === "openai-codex" && credentials.length > 1;

		for (const idx of order) {
			const selection = credentials[idx];
			const apiKey = await this.tryOAuthCredential(
				provider,
				selection,
				providerKey,
				sessionId,
				options,
				checkUsage,
				false,
			);
			if (apiKey) return apiKey;
		}

		if (fallback && this.isCredentialBlocked(providerKey, fallback.index)) {
			return this.tryOAuthCredential(provider, fallback, providerKey, sessionId, options, checkUsage, true);
		}

		return undefined;
	}

	/** Attempts to use a single OAuth credential, checking usage and refreshing token. */
	private async tryOAuthCredential(
		provider: string,
		selection: { credential: OAuthCredential; index: number },
		providerKey: string,
		sessionId: string | undefined,
		options: { baseUrl?: string } | undefined,
		checkUsage: boolean,
		allowBlocked: boolean,
	): Promise<string | undefined> {
		if (!allowBlocked && this.isCredentialBlocked(providerKey, selection.index)) {
			return undefined;
		}

		if (checkUsage) {
			const usage = await this.getCodexUsage(selection.credential, options?.baseUrl);
			if (usage && this.isCodexUsageLimitReached(usage)) {
				const resetAtMs = this.getCodexResetAtMs(usage);
				this.markCredentialBlocked(
					providerKey,
					selection.index,
					resetAtMs ?? Date.now() + AuthStorage.defaultBackoffMs,
				);
				return undefined;
			}
		}

		const oauthCreds: Record<string, OAuthCredentials> = {
			[provider]: selection.credential,
		};

		try {
			const result = await getOAuthApiKey(provider as OAuthProvider, oauthCreds);
			if (!result) return undefined;

			const updated: OAuthCredential = { type: "oauth", ...result.newCredentials };
			this.replaceCredentialAt(provider, selection.index, updated);
			await this.save();

			if (checkUsage) {
				const usage = await this.getCodexUsage(updated, options?.baseUrl);
				if (usage && this.isCodexUsageLimitReached(usage)) {
					const resetAtMs = this.getCodexResetAtMs(usage);
					this.markCredentialBlocked(
						providerKey,
						selection.index,
						resetAtMs ?? Date.now() + AuthStorage.defaultBackoffMs,
					);
					return undefined;
				}
			}

			this.recordSessionCredential(provider, sessionId, "oauth", selection.index);
			return result.apiKey;
		} catch {
			this.removeCredentialAt(provider, selection.index);
			await this.save();
			if (this.getCredentialsForProvider(provider).some((credential) => credential.type === "oauth")) {
				return this.getApiKey(provider, sessionId, options);
			}
		}

		return undefined;
	}

	/**
	 * Get API key for a provider.
	 * Priority:
	 * 1. Runtime override (CLI --api-key)
	 * 2. API key from auth.json
	 * 3. OAuth token from auth.json (auto-refreshed)
	 * 4. Environment variable
	 * 5. Fallback resolver (models.json custom providers)
	 */
	async getApiKey(provider: string, sessionId?: string, options?: { baseUrl?: string }): Promise<string | undefined> {
		// Runtime override takes highest priority
		const runtimeKey = this.runtimeOverrides.get(provider);
		if (runtimeKey) {
			return runtimeKey;
		}

		const apiKeySelection = this.selectCredentialByType(provider, "api_key", sessionId);
		if (apiKeySelection) {
			this.recordSessionCredential(provider, sessionId, "api_key", apiKeySelection.index);
			return apiKeySelection.credential.key;
		}

		const oauthKey = await this.resolveOAuthApiKey(provider, sessionId, options);
		if (oauthKey) {
			return oauthKey;
		}

		// Fall back to environment variable
		const envKey = getEnvApiKey(provider);
		if (envKey) return envKey;

		// Fall back to custom resolver (e.g., models.json custom providers)
		return this.fallbackResolver?.(provider) ?? undefined;
	}
}
