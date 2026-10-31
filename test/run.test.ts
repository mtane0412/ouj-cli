/**
 * コマンド処理 run のテスト。
 * サイトへの通信は差し替え、出力形式、終了コード、キャッシュと連続ログイン拒否の連携を検証する。
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OujError } from "../src/errors.js";
import {
	CACHE_TTL_MS,
	LOGIN_INTERVAL_MS,
	LocalStore,
} from "../src/local-store.js";
import { type Dependencies, run } from "../src/run.js";

const START = Date.parse("2026-10-31T00:00:00.000Z");
const gradesTable = {
	headers: ["科目名", "成績"],
	rows: [
		{ 科目名: "心理学概論", 成績: "◎" },
		{ 科目名: "統計学入門", 成績: "○" },
	],
};

describe("run", () => {
	let dir: string;
	let currentTime: number;
	let stdout: string[];
	let stderr: string[];
	let dependencies: Dependencies;
	let fetchTable: ReturnType<typeof vi.fn<Dependencies["fetchTable"]>>;
	let doctor: ReturnType<typeof vi.fn<Dependencies["doctor"]>>;
	let fetchFileDetail: ReturnType<
		typeof vi.fn<Dependencies["fetchFileDetail"]>
	>;
	let fetchContact: ReturnType<typeof vi.fn<Dependencies["fetchContact"]>>;
	let fetchSyllabus: ReturnType<typeof vi.fn<Dependencies["fetchSyllabus"]>>;

	/** 標準エラーへ書かれた JSON のエラーを取り出す */
	const errorOutput = () => JSON.parse(stderr.join("")).error;
	const output = () => JSON.parse(stdout.join(""));

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "ouj-run-"));
		currentTime = START;
		stdout = [];
		stderr = [];
		fetchTable = vi.fn<Dependencies["fetchTable"]>(async () => gradesTable);
		doctor = vi.fn<Dependencies["doctor"]>(async () => ({ login: "ok" }));
		fetchSyllabus = vi.fn<Dependencies["fetchSyllabus"]>(async () => ({
			headers: ["項目", "内容"],
			rows: [{ 項目: "科目名", 内容: "心理学概論" }],
		}));
		fetchContact = vi.fn<Dependencies["fetchContact"]>(async () => ({
			headers: ["項目", "内容"],
			rows: [{ 項目: "タイトル", 内容: "図書館の休館" }],
		}));
		fetchFileDetail = vi.fn<Dependencies["fetchFileDetail"]>(async () => ({
			headers: ["項目", "内容"],
			rows: [{ 項目: "タイトル", 内容: "復習用スライド" }],
		}));
		dependencies = {
			fetchFileDetail,
			fetchContact,
			fetchSyllabus,
			env: { OUJ_USERNAME: "学生A", OUJ_PASSWORD: "秘密の文字列" },
			store: new LocalStore(dir, () => currentTime),
			fetchTable,
			doctor,
			stdout: (text) => stdout.push(text),
			stderr: (text) => stderr.push(text),
		};
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	describe("通信しないコマンド", () => {
		it("--help は認証情報なしで全コマンド、制限、終了コードを表示する", async () => {
			dependencies.env = {};

			expect(await run(["--help"], dependencies)).toBe(0);

			const help = stdout.join("");
			for (const command of [
				"grades",
				"contacts",
				"files",
				"schedule",
				"class-contacts",
				"exam-timetable",
				"syllabus",
				"contact",
				"file",
				"doctor",
				"cache-clear",
			]) {
				expect(help).toContain(command);
			}
			expect(help).toContain("AUTH: 4");
			expect(help).toContain("60秒");
			expect(help).toContain("OUJ_PASSWORD");
			expect(fetchTable).not.toHaveBeenCalled();
		});

		it("一覧のコマンドの --help は通信せず、指定できるオプションを表示する", async () => {
			dependencies.env = {};

			expect(await run(["grades", "--help"], dependencies)).toBe(0);

			expect(stdout.join("")).toContain("--fields");
			expect(fetchTable).not.toHaveBeenCalled();
		});

		it("一覧以外のコマンドの --help に一覧用のオプションを表示しない", async () => {
			expect(await run(["doctor", "--help"], dependencies)).toBe(0);

			expect(stdout.join("")).not.toContain("--fields");
			expect(doctor).not.toHaveBeenCalled();
		});

		it("cache-clear は保存した一覧を消す", async () => {
			await run(["grades"], dependencies);
			currentTime += LOGIN_INTERVAL_MS;

			expect(await run(["cache-clear"], dependencies)).toBe(0);
			await run(["grades"], dependencies);

			expect(fetchTable).toHaveBeenCalledTimes(2);
		});
	});

	describe("引数の誤り", () => {
		it.each([
			["コマンドなし", []],
			["未知のコマンド", ["未知"]],
			["未知のオプション", ["grades", "--未知"]],
			["0件の --limit", ["grades", "--limit", "0"]],
			["数値でない --limit", ["grades", "--limit", "多数"]],
			["空の --fields", ["grades", "--fields", ""]],
			["doctor への --fields", ["doctor", "--fields", "科目名"]],
			["廃止した describe", ["describe"]],
			["doctor の未知の画面", ["doctor", "未知"]],
			["doctor の複数の画面", ["doctor", "contacts", "grades"]],
			["一覧のコマンドへの余分な引数", ["grades", "contacts"]],
			["未知のコマンドの --help", ["未知", "--help"]],
		])("%s は通信せず終了コード 2 を返す", async (_label, argv) => {
			expect(await run(argv, dependencies)).toBe(2);

			expect(errorOutput().code).toBe("USAGE");
			expect(errorOutput().hint).toContain("ouj --help");
			expect(fetchTable).not.toHaveBeenCalled();
			expect(doctor).not.toHaveBeenCalled();
		});

		it("認証情報がなければログイン枠を消費せずに終了コード 4 を返す", async () => {
			dependencies.env = { OUJ_USERNAME: "学生A" };

			expect(await run(["grades"], dependencies)).toBe(4);

			expect(errorOutput().code).toBe("AUTH");
			dependencies.env = {
				OUJ_USERNAME: "学生A",
				OUJ_PASSWORD: "秘密の文字列",
			};
			expect(await run(["grades"], dependencies)).toBe(0);
		});
	});

	describe("一覧の取得", () => {
		it("取得結果を、取得元と全列名つきで標準出力へ書く", async () => {
			expect(await run(["grades"], dependencies)).toBe(0);

			expect(fetchTable).toHaveBeenCalledWith(
				{ username: "学生A", password: "秘密の文字列" },
				"grades",
				undefined,
			);
			expect(output()).toEqual({
				source: "network",
				fetchedAt: "2026-10-31T00:00:00.000Z",
				fields: ["科目名", "成績"],
				total: 2,
				rows: gradesTable.rows,
			});
		});

		it("有効期限内の再実行は通信せず、パスワードも要求しない", async () => {
			await run(["grades"], dependencies);
			stdout = [];
			dependencies.env = { OUJ_USERNAME: "学生A" };

			expect(await run(["grades"], dependencies)).toBe(0);

			expect(fetchTable).toHaveBeenCalledTimes(1);
			expect(output().source).toBe("cache");
			expect(output().fetchedAt).toBe("2026-10-31T00:00:00.000Z");
		});

		it("--fields と --limit は全列名と総件数を変えずに結果だけを絞る", async () => {
			await run(["grades", "--fields", "成績", "--limit", "1"], dependencies);

			expect(output()).toMatchObject({
				fields: ["科目名", "成績"],
				total: 2,
				rows: [{ 成績: "◎" }],
			});
		});

		it("存在しない列名は列名の一覧を示し、取得済みの結果を再利用できる", async () => {
			expect(await run(["grades", "--fields", "点数"], dependencies)).toBe(2);
			expect(errorOutput().message).toContain("科目名");

			expect(await run(["grades", "--fields", "成績"], dependencies)).toBe(0);
			expect(fetchTable).toHaveBeenCalledTimes(1);
		});

		it("--refresh は有効期限内でも取得し直すが、連続ログインの拒否は受ける", async () => {
			await run(["grades"], dependencies);

			expect(await run(["grades", "--refresh"], dependencies)).toBe(7);
			expect(errorOutput().code).toBe("COOLDOWN");
			expect(errorOutput().retryAfterSeconds).toBe(60);
			expect(fetchTable).toHaveBeenCalledTimes(1);

			stderr = [];
			currentTime += LOGIN_INTERVAL_MS;
			expect(await run(["grades", "--refresh"], dependencies)).toBe(0);
			expect(fetchTable).toHaveBeenCalledTimes(2);
		});

		it("別の画面の連続取得はログイン間隔を過ぎるまで拒否する", async () => {
			await run(["grades"], dependencies);

			expect(await run(["contacts"], dependencies)).toBe(7);

			expect(fetchTable).toHaveBeenCalledTimes(1);
		});

		it("失敗した結果は保存せず、再試行もログイン間隔を待たせる", async () => {
			fetchTable.mockRejectedValueOnce(new OujError("AUTH", "ログインに失敗"));

			expect(await run(["grades"], dependencies)).toBe(4);
			expect(errorOutput()).toMatchObject({
				code: "AUTH",
				message: "ログインに失敗",
			});
			expect(errorOutput().hint).toBeTruthy();

			stderr = [];
			expect(await run(["grades"], dependencies)).toBe(7);
			expect(fetchTable).toHaveBeenCalledTimes(1);
		});
	});

	describe("検索条件のある一覧", () => {
		it("class-contacts は条件なしなら既定の画面をそのまま取得する", async () => {
			expect(await run(["class-contacts"], dependencies)).toBe(0);

			expect(fetchTable).toHaveBeenCalledWith(
				expect.anything(),
				"class-contacts",
				undefined,
			);
		});

		it("class-contacts は年度と学期を検索条件として渡す", async () => {
			await run(
				["class-contacts", "--year", "2026", "--term", "1"],
				dependencies,
			);

			expect(fetchTable).toHaveBeenCalledWith(
				expect.anything(),
				"class-contacts",
				{ year: "2026", term: "1" },
			);
		});

		it("exam-timetable は --type を授業区分の値に変換して渡す", async () => {
			await run(
				[
					"exam-timetable",
					"--year",
					"2026",
					"--term",
					"2",
					"--type",
					"broadcast",
				],
				dependencies,
			);

			expect(fetchTable).toHaveBeenCalledWith(
				expect.anything(),
				"exam-timetable",
				{ year: "2026", term: "2", lectureClass: "1" },
			);
		});

		it("検索のない画面の --help に検索のオプションを表示しない", async () => {
			await run(["grades", "--help"], dependencies);

			expect(stdout.join("")).not.toContain("--year");
		});

		it("検索できる画面の --help に使えるオプションだけを表示する", async () => {
			await run(["class-contacts", "--help"], dependencies);
			expect(stdout.join("")).toContain("--year");
			expect(stdout.join("")).not.toContain("--type");

			stdout = [];
			await run(["exam-timetable", "--help"], dependencies);
			expect(stdout.join("")).toContain("--type");
		});

		it("同じ条件の再実行はキャッシュを使い、別の条件は別に取得する", async () => {
			const firstTerm = ["exam-timetable", "--year", "2026", "--term", "1"];
			await run(firstTerm, dependencies);
			expect(await run(firstTerm, dependencies)).toBe(0);
			expect(fetchTable).toHaveBeenCalledTimes(1);

			currentTime += LOGIN_INTERVAL_MS;
			await run(
				["exam-timetable", "--year", "2026", "--term", "2"],
				dependencies,
			);

			expect(fetchTable).toHaveBeenCalledTimes(2);
		});

		it.each([
			["年度なしの exam-timetable", ["exam-timetable", "--term", "1"]],
			["学期なしの exam-timetable", ["exam-timetable", "--year", "2026"]],
			["条件なしの exam-timetable", ["exam-timetable"]],
			["学期だけの class-contacts", ["class-contacts", "--term", "1"]],
			["4桁でない年度", ["exam-timetable", "--year", "26", "--term", "1"]],
			[
				"20で始まらない年度",
				["exam-timetable", "--year", "1999", "--term", "1"],
			],
			["1と2以外の学期", ["exam-timetable", "--year", "2026", "--term", "3"]],
			[
				"未知の授業区分",
				["exam-timetable", "--year", "2026", "--term", "1", "--type", "面接"],
			],
			[
				"class-contacts への --type",
				["class-contacts", "--year", "2026", "--term", "1", "--type", "all"],
			],
			[
				"検索のない画面への --year",
				["grades", "--year", "2026", "--term", "1"],
			],
			["doctor の検索が必須の画面", ["doctor", "exam-timetable"]],
			["doctor への --year", ["doctor", "--year", "2026"]],
		])("%s は通信せず USAGE で失敗する", async (_label, argv) => {
			expect(await run(argv, dependencies)).toBe(2);

			expect(errorOutput().code).toBe("USAGE");
			expect(fetchTable).not.toHaveBeenCalled();
			expect(doctor).not.toHaveBeenCalled();
		});
	});

	describe("syllabus", () => {
		const psychology = [
			"syllabus",
			"--year",
			"2026",
			"--term",
			"2",
			"--name",
			"心理学",
		];

		it("条件を渡して取得し、同じ条件の再実行はキャッシュを使う", async () => {
			expect(await run(psychology, dependencies)).toBe(0);
			expect(fetchSyllabus).toHaveBeenCalledWith(
				{ username: "学生A", password: "秘密の文字列" },
				{ year: "2026", term: "2", name: "心理学" },
			);
			expect(output().fields).toEqual(["項目", "内容"]);

			stdout = [];
			expect(await run(psychology, dependencies)).toBe(0);
			expect(output().source).toBe("cache");
			expect(fetchSyllabus).toHaveBeenCalledTimes(1);
		});

		it("--code を渡し、別の条件は別に取得する", async () => {
			await run(psychology, dependencies);
			currentTime += LOGIN_INTERVAL_MS;

			await run([...psychology, "--code", "1234567"], dependencies);

			expect(fetchSyllabus).toHaveBeenLastCalledWith(expect.anything(), {
				year: "2026",
				term: "2",
				name: "心理学",
				code: "1234567",
			});
			expect(fetchSyllabus).toHaveBeenCalledTimes(2);
		});

		it("科目名に記号があっても保存先のディレクトリの外へ書かない", async () => {
			await run(
				["syllabus", "--year", "2026", "--term", "2", "--name", "../../外"],
				dependencies,
			);

			const files = await readdir(join(dir, "data"));
			expect(files).toHaveLength(1);
			expect(files[0]).not.toContain("外");
		});

		it.each([
			["科目名なし", ["syllabus", "--year", "2026", "--term", "2"]],
			["年度なし", ["syllabus", "--term", "2", "--name", "心理学"]],
			["数字でない科目コード", [...psychology, "--code", "心理学"]],
			["--type の指定", [...psychology, "--type", "all"]],
			["他の画面への --name", ["grades", "--name", "心理学"]],
			["他の画面への --code", ["grades", "--code", "1234567"]],
		])("%s は通信せず USAGE で失敗する", async (_label, argv) => {
			expect(await run(argv, dependencies)).toBe(2);

			expect(errorOutput().code).toBe("USAGE");
			expect(fetchSyllabus).not.toHaveBeenCalled();
			expect(fetchTable).not.toHaveBeenCalled();
		});
	});

	describe("contact", () => {
		it("指定の1件を取得し、同じ連絡IDの再実行はキャッシュを使う", async () => {
			expect(await run(["contact", "--id", "6155"], dependencies)).toBe(0);
			expect(fetchContact).toHaveBeenCalledWith(
				{ username: "学生A", password: "秘密の文字列" },
				"6155",
			);

			stdout = [];
			expect(await run(["contact", "--id", "6155"], dependencies)).toBe(0);
			expect(output().source).toBe("cache");
			expect(fetchContact).toHaveBeenCalledTimes(1);
		});

		it("--help は既読になることを示す", async () => {
			await run(["contact", "--help"], dependencies);

			expect(stdout.join("")).toContain("既読");
		});

		it.each([
			["--id なし", ["contact"]],
			["数字でない --id", ["contact", "--id", "../外"]],
			["--year の指定", ["contact", "--id", "6155", "--year", "2026"]],
			["--refresh の指定", ["contact", "--id", "6155", "--refresh"]],
			["他の画面への --id", ["grades", "--id", "6155"]],
			["syllabus への --id", ["syllabus", "--id", "6155"]],
		])("%s は通信せず USAGE で失敗する", async (_label, argv) => {
			expect(await run(argv, dependencies)).toBe(2);

			expect(errorOutput().code).toBe("USAGE");
			expect(fetchContact).not.toHaveBeenCalled();
		});
	});

	describe("file", () => {
		it("指定の1件の詳細を取得し、--refresh で取得し直せる", async () => {
			expect(await run(["file", "--id", "0"], dependencies)).toBe(0);
			expect(fetchFileDetail).toHaveBeenCalledWith(
				{ username: "学生A", password: "秘密の文字列" },
				"0",
			);

			currentTime += LOGIN_INTERVAL_MS;
			expect(await run(["file", "--id", "0", "--refresh"], dependencies)).toBe(
				0,
			);
			expect(fetchFileDetail).toHaveBeenCalledTimes(2);
		});

		it("--help はファイル本体を取得しないことを示す", async () => {
			await run(["file", "--help"], dependencies);

			expect(stdout.join("")).toContain("ファイル本体は取得しません");
		});

		it.each([
			["--id なし", ["file"]],
			["数字でない --id", ["file", "--id", "../外"]],
			["--year の指定", ["file", "--id", "0", "--year", "2026"]],
		])("%s は通信せず USAGE で失敗する", async (_label, argv) => {
			expect(await run(argv, dependencies)).toBe(2);

			expect(errorOutput().code).toBe("USAGE");
			expect(fetchFileDetail).not.toHaveBeenCalled();
		});
	});

	describe("期限切れの一覧の削除", () => {
		const storedFiles = () => readdir(join(dir, "data"));

		it("別の画面のコマンドが失敗しても、期限切れの一覧をディスクから消す", async () => {
			// 前提: grades の一覧を保存してから有効期限が過ぎている
			await run(["grades"], dependencies);
			expect(await storedFiles()).toHaveLength(1);
			currentTime += CACHE_TTL_MS;
			dependencies.env = { OUJ_USERNAME: "学生A" };

			// パスワードがないため contacts の取得自体は失敗する
			expect(await run(["contacts"], dependencies)).toBe(4);

			expect(await storedFiles()).toEqual([]);
		});

		it("有効期限内の一覧は消さない", async () => {
			await run(["grades"], dependencies);
			currentTime += CACHE_TTL_MS - 1;

			await run(["grades"], dependencies);

			expect(await storedFiles()).toHaveLength(1);
		});

		it("--help では保存データに触れない", async () => {
			await run(["grades"], dependencies);
			currentTime += CACHE_TTL_MS;

			await run(["--help"], dependencies);

			expect(await storedFiles()).toHaveLength(1);
		});
	});

	describe("doctor", () => {
		it("対象を省略すると代表の contacts だけを確認する", async () => {
			await run(["doctor"], dependencies);

			expect(doctor).toHaveBeenCalledTimes(1);
			expect(doctor).toHaveBeenCalledWith(
				{ username: "学生A", password: "秘密の文字列" },
				"contacts",
			);
		});

		it("指定した1画面を確認する", async () => {
			expect(await run(["doctor", "grades"], dependencies)).toBe(0);

			expect(doctor).toHaveBeenCalledWith(expect.anything(), "grades");
		});

		it("--help は1画面だけを開くことを示す", async () => {
			await run(["doctor", "--help"], dependencies);

			expect(stdout.join("")).toContain("1画面");
		});

		it("結果を保存せず、毎回ログイン間隔の制限を受ける", async () => {
			expect(await run(["doctor"], dependencies)).toBe(0);
			expect(output()).toEqual({ login: "ok" });

			expect(await run(["doctor"], dependencies)).toBe(7);
			expect(doctor).toHaveBeenCalledTimes(1);
		});
	});

	it("想定外の例外は終了コード 1 で JSON のエラーにする", async () => {
		fetchTable.mockRejectedValueOnce(new Error("想定外の失敗"));

		expect(await run(["grades"], dependencies)).toBe(1);

		expect(errorOutput()).toMatchObject({
			code: "UNEXPECTED",
			message: "想定外の失敗",
		});
	});
});
