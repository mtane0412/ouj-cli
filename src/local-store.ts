/**
 * サーバーへのログイン回数を減らすために、手元に保存する状態を管理する。
 * - data/: 取得した一覧のキャッシュ。個人情報を含むため所有者だけが読める権限で保存する
 * - last-login: 最後にログインを始めた時刻。連続ログインを通信の前に拒否するために使う
 * - last-login.lock: 時刻の確認と更新を同時に行わないためのロック
 * セッションや認証情報は保存しない。
 */
import { createHash, randomUUID } from "node:crypto";
import {
	link,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { OujError } from "./errors.js";

export const CACHE_TTL_MS = 60 * 60 * 1000;
export const LOGIN_INTERVAL_MS = 60 * 1000;

const OWNER_ONLY_DIRECTORY = 0o700;
const OWNER_ONLY_FILE = 0o600;
const ACCOUNT_KEY_LENGTH = 16;
const MS_PER_SECOND = 1000;

export interface StoredTable {
	headers: string[];
	rows: Record<string, string>[];
}

export interface CachedTable extends StoredTable {
	fetchedAt: string;
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return (
		typeof value === "object" &&
		value !== null &&
		Object.values(value).every((item) => typeof item === "string")
	);
}

function isCachedTable(value: unknown): value is CachedTable {
	if (typeof value !== "object" || value === null) return false;
	return (
		"fetchedAt" in value &&
		typeof value.fetchedAt === "string" &&
		!Number.isNaN(Date.parse(value.fetchedAt)) &&
		"headers" in value &&
		Array.isArray(value.headers) &&
		value.headers.every((header) => typeof header === "string") &&
		"rows" in value &&
		Array.isArray(value.rows) &&
		value.rows.every(isStringRecord)
	);
}

/** 保存データを解釈する。JSON でない場合と形式が違う場合は undefined を返す */
function parseCachedTable(content: string): CachedTable | undefined {
	try {
		const value: unknown = JSON.parse(content);
		return isCachedTable(value) ? value : undefined;
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

function hasErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

/** ファイルの内容を返す。ファイルがなければ undefined を返す */
async function readIfExists(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return undefined;
		throw error;
	}
}

export class LocalStore {
	private readonly dataDir: string;
	private readonly lastLoginPath: string;
	private readonly lockPath: string;

	/**
	 * @param dir 保存先のディレクトリ
	 * @param now テストで差し替えるための現在時刻（ミリ秒）
	 */
	constructor(
		private readonly dir: string,
		private readonly now: () => number = Date.now,
	) {
		this.dataDir = join(dir, "data");
		this.lastLoginPath = join(dir, "last-login");
		this.lockPath = join(dir, "last-login.lock");
	}

	/** ファイル名からログインIDが分からないよう、ハッシュで区別する */
	private cachePath(username: string, name: string): string {
		const account = createHash("sha256")
			.update(username)
			.digest("hex")
			.slice(0, ACCOUNT_KEY_LENGTH);
		return join(this.dataDir, `${account}-${name}.json`);
	}

	/** 有効期限内の一覧を返す。なければ undefined。壊れている場合はエラーにする */
	async readCache(
		username: string,
		name: string,
	): Promise<CachedTable | undefined> {
		const content = await readIfExists(this.cachePath(username, name));
		if (content === undefined) return undefined;
		const cached = parseCachedTable(content);
		if (!cached) {
			throw new OujError("CACHE_CORRUPT", `${name} の保存データが壊れています`);
		}
		return this.isExpired(cached) ? undefined : cached;
	}

	private isExpired(cached: CachedTable): boolean {
		return this.now() - Date.parse(cached.fetchedAt) >= CACHE_TTL_MS;
	}

	/**
	 * 全アカウントの期限切れの一覧をディスクから消す。
	 * 壊れた一覧は期限を判定できないため残し、読むときの CACHE_CORRUPT に任せる。
	 */
	async purgeExpiredCache(): Promise<void> {
		let fileNames: string[];
		try {
			fileNames = await readdir(this.dataDir);
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) return;
			throw error;
		}
		for (const fileName of fileNames.filter((name) => name.endsWith(".json"))) {
			const path = join(this.dataDir, fileName);
			// 同時に実行した別のプロセスが先に消している場合がある
			const content = await readIfExists(path);
			if (content === undefined) continue;
			const cached = parseCachedTable(content);
			if (cached && this.isExpired(cached)) await rm(path, { force: true });
		}
	}

	/** 一覧を現在時刻とともに保存し、保存した内容を返す。途中で失敗しても壊れたファイルを残さない */
	async writeCache(
		username: string,
		name: string,
		table: StoredTable,
	): Promise<CachedTable> {
		const cached = {
			fetchedAt: new Date(this.now()).toISOString(),
			headers: table.headers,
			rows: table.rows,
		};
		await mkdir(this.dataDir, {
			recursive: true,
			mode: OWNER_ONLY_DIRECTORY,
		});
		const temporaryPath = join(this.dataDir, `.${randomUUID()}.tmp`);
		await writeFile(temporaryPath, JSON.stringify(cached), {
			mode: OWNER_ONLY_FILE,
		});
		await rename(temporaryPath, this.cachePath(username, name));
		return cached;
	}

	/** 保存した一覧を消す。制限を回避できないよう、ログイン時刻は残す */
	async clearCache(): Promise<void> {
		await rm(this.dataDir, { recursive: true, force: true });
	}

	/**
	 * ログインしてよければ時刻を記録する。間隔内なら COOLDOWN エラーにする。
	 * 時刻の確認から更新までをロックで保護し、同時に実行しても1つだけを通す。
	 */
	async acquireLoginSlot(): Promise<void> {
		await mkdir(this.dir, { recursive: true, mode: OWNER_ONLY_DIRECTORY });
		const timestamp = new Date(this.now()).toISOString();
		if (!(await this.tryCreateLock(timestamp))) {
			return this.rejectWhileLocked();
		}
		try {
			const lastLogin = await readIfExists(this.lastLoginPath);
			if (lastLogin !== undefined) this.assertLoginAllowed(lastLogin);
			await this.writeOwnerOnlyFile(this.lastLoginPath, timestamp);
		} finally {
			await unlink(this.lockPath);
		}
	}

	private assertLoginAllowed(lastLogin: string): void {
		const startedAt = Date.parse(lastLogin);
		if (Number.isNaN(startedAt)) {
			throw new OujError("CACHE_CORRUPT", "last-login の内容が壊れています");
		}
		const remaining = startedAt + LOGIN_INTERVAL_MS - this.now();
		if (remaining > 0) {
			throw new OujError(
				"COOLDOWN",
				"前回のログインから間もないため、実行を取りやめました（通信はしていません）",
				Math.ceil(remaining / MS_PER_SECOND),
			);
		}
	}

	/**
	 * ロックが取れなかったときの結果を決める。
	 * 古いロックは異常終了の跡だが、自動で消すと同時実行の保護が崩れるため、利用者の確認に任せる。
	 */
	private async rejectWhileLocked(): Promise<void> {
		const lock = await readIfExists(this.lockPath);
		// 確認する間に解放された場合は、改めて時刻を確認する
		if (lock === undefined) return this.acquireLoginSlot();
		const lockedAt = Date.parse(lock);
		if (Number.isNaN(lockedAt) || this.now() - lockedAt >= LOGIN_INTERVAL_MS) {
			throw new OujError(
				"CACHE_CORRUPT",
				"last-login.lock が残っています。他に ouj が動いていなければ削除してください",
			);
		}
		this.assertLoginAllowed(lock);
	}

	/**
	 * ロックファイルを作成し、作成できたかを返す。
	 * link は既存ファイルがあると失敗するため、同時に実行しても1つだけが成功し、
	 * 書きかけの内容を他のプロセスに読まれることもない。
	 */
	private async tryCreateLock(timestamp: string): Promise<boolean> {
		const temporaryPath = join(this.dir, `.${randomUUID()}.tmp`);
		await writeFile(temporaryPath, timestamp, { mode: OWNER_ONLY_FILE });
		try {
			await link(temporaryPath, this.lockPath);
			return true;
		} catch (error) {
			if (hasErrorCode(error, "EEXIST")) return false;
			throw error;
		} finally {
			await unlink(temporaryPath);
		}
	}

	/** 途中で失敗しても壊れたファイルを残さないよう、一時ファイルから置き換える */
	private async writeOwnerOnlyFile(
		path: string,
		content: string,
	): Promise<void> {
		const temporaryPath = join(this.dir, `.${randomUUID()}.tmp`);
		await writeFile(temporaryPath, content, { mode: OWNER_ONLY_FILE });
		await rename(temporaryPath, path);
	}
}
