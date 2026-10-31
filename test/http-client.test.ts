/**
 * HttpClient のテスト。
 * Cookie の保持とリダイレクト追跡を、外部通信なしで検証する。
 */
import { describe, expect, it } from "vitest";
import { HttpClient, pathWithoutSession } from "../src/http-client.js";

describe("HttpClient", () => {
	it("リダイレクト先へ Cookie を送り、POST は GET に変わる", async () => {
		const requests: { url: string; method: string; cookie: string | null }[] =
			[];
		const client = new HttpClient(async (input, init) => {
			const headers = new Headers(init?.headers);
			requests.push({
				url: String(input),
				method: init?.method ?? "GET",
				cookie: headers.get("cookie"),
			});
			if (String(input).endsWith("/start")) {
				return new Response(null, {
					status: 302,
					headers: { location: "/next", "set-cookie": "SESSION=abc; Path=/" },
				});
			}
			return new Response("到着しました");
		});

		const page = await client.post("https://example.test/start", {
			項目: "値",
		});

		expect(page.url).toBe("https://example.test/next");
		expect(page.body).toBe("到着しました");
		expect(requests[1]).toEqual({
			url: "https://example.test/next",
			method: "GET",
			cookie: "SESSION=abc",
		});
	});

	it("接続に失敗したらパスだけを含む NETWORK エラーにする", async () => {
		const client = new HttpClient(async () => {
			throw new TypeError("fetch failed");
		});

		const error = await client
			.get("https://example.test/画面;jsessionid=秘密?ticket=秘密")
			.catch((caught: unknown) => caught);

		expect(error).toMatchObject({ code: "NETWORK" });
		expect(String(error)).not.toContain("秘密");
	});

	it("HTTP エラーは NETWORK エラーにする", async () => {
		const client = new HttpClient(
			async () => new Response(null, { status: 503 }),
		);

		await expect(client.get("https://example.test/画面")).rejects.toMatchObject(
			{ code: "NETWORK" },
		);
	});

	it("応答を待ち続けないよう fetch に中断シグナルを渡す", async () => {
		let signal: AbortSignal | null | undefined;
		const client = new HttpClient(async (_input, init) => {
			signal = init?.signal;
			return new Response("到着しました");
		});

		await client.get("https://example.test/画面");

		expect(signal).toBeInstanceOf(AbortSignal);
	});

	it("トレースには名前だけを記録し、値を含めない", async () => {
		const traces: string[] = [];
		const client = new HttpClient(
			async (input) =>
				String(input).includes("/start")
					? new Response(null, {
							status: 302,
							headers: {
								location:
									"/next;jsessionid=secret-session?ticket=secret-ticket",
								"set-cookie": "SESSION=secret-cookie; Path=/",
							},
						})
					: new Response("到着しました"),
			(line) => traces.push(line),
		);

		await client.post("https://example.test/start", {
			password: "secret-password",
		});

		const output = traces.join("\n");
		expect(output).toContain("/next");
		expect(output).toContain("ticket");
		expect(output).toContain("SESSION");
		expect(output).toContain("jsessionid");
		expect(output).not.toMatch(/secret-/);
	});

	it("同一ホストへは遷移元の URL を、別ホストへはオリジンだけを Referer として送る", async () => {
		const referers: (string | null)[] = [];
		const client = new HttpClient(async (input, init) => {
			referers.push(new Headers(init?.headers).get("referer"));
			return String(input).includes("/first")
				? new Response(null, {
						status: 302,
						headers: { location: "/second?key=value" },
					})
				: new Response("到着しました");
		});

		await client.get("https://example.test/first");
		await client.get("https://example.test/third");
		await client.get("https://other.test/fourth");

		expect(referers).toEqual([
			null,
			"https://example.test/first",
			"https://example.test/second?key=value",
			"https://example.test/",
		]);
	});

	it("307 は同一オリジンなら POST と本文を保ち、別オリジンなら GET に変える", async () => {
		const requests: { url: string; method?: string; body?: unknown }[] = [];
		const client = new HttpClient(async (input, init) => {
			const url = String(input);
			requests.push({ url, method: init?.method, body: init?.body });
			if (url.endsWith("/same")) {
				return new Response(null, {
					status: 307,
					headers: { location: "/kept" },
				});
			}
			if (url.endsWith("/cross")) {
				return new Response(null, {
					status: 307,
					headers: { location: "https://other.test/dropped" },
				});
			}
			return new Response("到着しました");
		});

		await client.post("https://example.test/same", { 氏名: "放送太郎" });
		await client.post("https://example.test/cross", { 氏名: "放送太郎" });

		expect(requests[1]).toMatchObject({
			url: "https://example.test/kept",
			method: "POST",
			body: new URLSearchParams({ 氏名: "放送太郎" }).toString(),
		});
		expect(requests[3]).toEqual({
			url: "https://other.test/dropped",
			method: "GET",
			body: undefined,
		});
	});

	it("リダイレクトが終わらない場合はエラーにする", async () => {
		const client = new HttpClient(
			async () =>
				new Response(null, { status: 302, headers: { location: "/loop" } }),
		);

		await expect(client.get("https://example.test/loop")).rejects.toThrow(
			"リダイレクト",
		);
	});

	it("HTTP エラーはエラーにする", async () => {
		const client = new HttpClient(
			async () => new Response("障害", { status: 500 }),
		);

		await expect(client.get("https://example.test/")).rejects.toThrow("500");
	});
});

describe("pathWithoutSession", () => {
	it("パス内のセッション ID とクエリを取り除く", () => {
		expect(
			pathWithoutSession(
				"https://example.test/portal/home;jsessionid=secret-session?ticket=secret-ticket",
			),
		).toBe("/portal/home");
	});
});
