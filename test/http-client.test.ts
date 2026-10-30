/**
 * HttpClient のテスト。
 * Cookie の保持とリダイレクト追跡を、外部通信なしで検証する。
 */
import { describe, expect, it } from "vitest";
import { HttpClient } from "../src/http-client.js";

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
