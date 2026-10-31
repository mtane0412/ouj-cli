/**
 * LocalStore のテスト。
 * 一時ディレクトリだけを使い、キャッシュの有効期限、ファイル権限、連続ログインの拒否を検証する。
 */
import {
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CACHE_TTL_MS,
	LOGIN_INTERVAL_MS,
	LocalStore,
} from "../src/local-store.js";

const START = Date.parse("2026-10-31T00:00:00.000Z");
const table = {
	headers: ["科目名"],
	rows: [{ 科目名: "心理学概論" }],
};

describe("LocalStore", () => {
	let dir: string;
	let currentTime: number;
	let store: LocalStore;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "ouj-store-"));
		currentTime = START;
		store = new LocalStore(dir, () => currentTime);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	describe("キャッシュ", () => {
		it("保存した一覧を取得時刻とともに読み戻せる", async () => {
			await store.writeCache("学生A", "grades", table);

			expect(await store.readCache("学生A", "grades")).toEqual({
				...table,
				fetchedAt: "2026-10-31T00:00:00.000Z",
			});
		});

		it("有効期限を過ぎた一覧は返さない", async () => {
			await store.writeCache("学生A", "grades", table);

			currentTime = START + CACHE_TTL_MS;

			expect(await store.readCache("学生A", "grades")).toBeUndefined();
		});

		it("別のアカウントの一覧は返さない", async () => {
			await store.writeCache("学生A", "grades", table);

			expect(await store.readCache("学生B", "grades")).toBeUndefined();
		});

		it("所有者だけが読める権限で保存し、ファイル名にログインIDを含めない", async () => {
			await store.writeCache("学生A", "grades", table);

			const dataDir = join(dir, "data");
			const [fileName] = await readdir(dataDir);
			expect(fileName).toBeDefined();
			expect(fileName).not.toContain("学生A");
			const dataFile = join(dataDir, fileName ?? "");
			expect((await stat(dataFile)).mode & 0o777).toBe(0o600);
			expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
		});

		it("壊れたキャッシュは黙って無視せずエラーにする", async () => {
			await store.writeCache("学生A", "grades", table);
			const dataDir = join(dir, "data");
			const [fileName] = await readdir(dataDir);
			await writeFile(join(dataDir, fileName ?? ""), "壊れた内容");

			await expect(store.readCache("学生A", "grades")).rejects.toMatchObject({
				code: "CACHE_CORRUPT",
			});
		});

		it("purgeExpiredCache は全アカウントの期限切れの一覧だけを消す", async () => {
			// 前提: 学生A と学生B の一覧を保存した後、学生B の一覧だけを保存し直す
			await store.writeCache("学生A", "grades", table);
			await store.writeCache("学生B", "grades", table);
			currentTime = START + CACHE_TTL_MS - 1;
			await store.writeCache("学生B", "grades", table);
			currentTime = START + CACHE_TTL_MS;

			await store.purgeExpiredCache();

			expect(await readdir(join(dir, "data"))).toHaveLength(1);
			expect(await store.readCache("学生B", "grades")).toBeDefined();
		});

		it("purgeExpiredCache は壊れた一覧を消さず、読むときのエラーに任せる", async () => {
			await store.writeCache("学生A", "grades", table);
			const dataDir = join(dir, "data");
			const [fileName] = await readdir(dataDir);
			await writeFile(join(dataDir, fileName ?? ""), "壊れた内容");

			await expect(store.purgeExpiredCache()).resolves.toBeUndefined();

			await expect(store.readCache("学生A", "grades")).rejects.toMatchObject({
				code: "CACHE_CORRUPT",
			});
		});

		it("purgeExpiredCache は一覧の取得後に消えたファイルでエラーにしない", async () => {
			// 前提: 別のプロセスが先に消した状態を、読むと ENOENT になるリンクで再現する
			await store.writeCache("学生A", "grades", table);
			await symlink(
				join(dir, "存在しないファイル"),
				join(dir, "data", "消えた一覧.json"),
			);

			await expect(store.purgeExpiredCache()).resolves.toBeUndefined();
		});

		it("purgeExpiredCache は保存先がなくてもエラーにしない", async () => {
			await expect(store.purgeExpiredCache()).resolves.toBeUndefined();
		});

		it("clearCache は一覧を消すが、ログイン時刻は残す", async () => {
			await store.writeCache("学生A", "grades", table);
			await store.acquireLoginSlot();

			await store.clearCache();

			expect(await store.readCache("学生A", "grades")).toBeUndefined();
			await expect(store.acquireLoginSlot()).rejects.toMatchObject({
				code: "COOLDOWN",
			});
		});
	});

	describe("連続ログインの拒否", () => {
		it("間隔内の2回目は残り秒数つきで拒否する", async () => {
			await store.acquireLoginSlot();

			currentTime = START + LOGIN_INTERVAL_MS - 1500;

			await expect(store.acquireLoginSlot()).rejects.toMatchObject({
				code: "COOLDOWN",
				retryAfterSeconds: 2,
			});
		});

		it("間隔を過ぎれば再びログインできる", async () => {
			await store.acquireLoginSlot();

			currentTime = START + LOGIN_INTERVAL_MS;

			await expect(store.acquireLoginSlot()).resolves.toBeUndefined();
		});

		it("同時に実行しても1つだけがログインできる", async () => {
			const results = await Promise.allSettled([
				store.acquireLoginSlot(),
				store.acquireLoginSlot(),
				store.acquireLoginSlot(),
			]);

			expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		});

		it("時刻ファイルが壊れていてもログインを許可せずエラーにする", async () => {
			await store.acquireLoginSlot();
			await writeFile(join(dir, "last-login"), "壊れた内容");

			await expect(store.acquireLoginSlot()).rejects.toMatchObject({
				code: "CACHE_CORRUPT",
			});
			expect(await readFile(join(dir, "last-login"), "utf8")).toBe(
				"壊れた内容",
			);
		});
	});
});
