/**
 * ログインと画面遷移のテスト。
 * 実サイトで調査したフォーム構成を再現した HTML を使う。
 */
import { describe, expect, it } from "vitest";
import { HttpClient } from "../src/http-client.js";
import { login, openMenu, parseTable } from "../src/wakaba.js";

const PORTAL_URL = "https://www.wakaba.ouj.ac.jp/portal/";
// 新規セッションのログインフォームにはトークンがない（実サイトで確認済み）
const PORTAL_PAGE = `<form name="login_loginActionForm">
  <input type="text" name="userID"><input type="password" name="password">
  <input type="hidden" name="selectLocale" value="ja"><input type="hidden" name="mistakeChecker" value="0">
</form>`;
const CAS_URL = "https://sso.ouj.ac.jp/cas/login?service=wakaba";
const CAS_PAGE = `<form action="/cas/login" method="post">
  <input type="hidden" name="execution" value="実行キー"><input type="hidden" name="_eventId" value="submit">
</form>`;
const HOME_PAGE = `<title>ホーム</title><form name="common_generalPurposeActionForm">
  <input type="hidden" name="headTitle" value=""><input type="hidden" name="menuCode" value="">
  <input type="hidden" name="nextPath" value=""><input type="hidden" name="taglib.html.TOKEN" value="トークン">
</form>`;
const HOME_URL = "https://www.wakaba.ouj.ac.jp/portal/home/home/display";
const credentials = { username: "テスト学生", password: "テスト用パスワード" };

type RecordedPost = { url: string; body: URLSearchParams };

/**
 * WAKABA のログイン手順を再現する偽サイトを作る。
 * @param posts 受け取った POST を記録する配列
 * @param afterCasPost CAS へ POST した後の応答。既定はホーム画面へのリダイレクト
 */
function fakeSite(
	posts: RecordedPost[],
	afterCasPost: () => Response = () =>
		new Response(null, { status: 302, headers: { location: HOME_URL } }),
) {
	return new HttpClient(async (input, init) => {
		const url = String(input);
		if (init?.method === "POST") {
			posts.push({ url, body: new URLSearchParams(String(init.body)) });
			if (url.endsWith("/login/preLogin/preLogin")) return new Response("{}");
			if (url.endsWith("/portal/sso/")) {
				return new Response(null, {
					status: 302,
					headers: { location: CAS_URL },
				});
			}
			if (url.includes("/cas/login")) return afterCasPost();
			return new Response("<title>移動先</title>");
		}
		if (url === PORTAL_URL) return new Response(PORTAL_PAGE);
		if (url.includes("/portal/other")) {
			return new Response("<title>想定外の画面</title>");
		}
		return new Response(url.includes("/cas/login") ? CAS_PAGE : HOME_PAGE);
	});
}

describe("login", () => {
	it("ログインボタンと同じ順序で送信し、ホーム画面を返す", async () => {
		// 前提: ブラウザは preLogin、sso、CAS の順に POST している
		const posts: RecordedPost[] = [];

		const home = await login(fakeSite(posts), credentials);

		expect(home.url).toBe(HOME_URL);
		expect(posts.map((post) => post.url)).toEqual([
			"https://www.wakaba.ouj.ac.jp/portal/login/preLogin/preLogin",
			"https://www.wakaba.ouj.ac.jp/portal/sso/",
			CAS_URL,
		]);
	});

	it("preLogin に接続元 URL とログイン失敗回数を送る", async () => {
		const posts: RecordedPost[] = [];

		await login(fakeSite(posts), credentials);

		expect(posts[0]?.body.get("clientLocationUrl")).toBe(
			"https://www.wakaba.ouj.ac.jp/",
		);
		expect(posts[0]?.body.get("mistakeChecker")).toBe("0");
	});

	it("sso にはフォームの項目を送り、パスワードは送らない", async () => {
		const posts: RecordedPost[] = [];

		await login(fakeSite(posts), credentials);

		expect(posts[1]?.body.get("selectLocale")).toBe("ja");
		expect(posts[1]?.body.get("password")).toBe("");
	});

	it("CAS には execution と認証情報を送る", async () => {
		const posts: RecordedPost[] = [];

		await login(fakeSite(posts), credentials);

		expect(posts[2]?.body.get("username")).toBe("テスト学生");
		expect(posts[2]?.body.get("password")).toBe("テスト用パスワード");
		expect(posts[2]?.body.get("execution")).toBe("実行キー");
		expect(posts[2]?.body.get("_eventId")).toBe("submit");
	});

	it("ポータルにログインフォームがない場合はエラーにする", async () => {
		const client = new HttpClient(async () => new Response("メンテナンス中"));

		await expect(login(client, credentials)).rejects.toMatchObject({
			code: "SITE_CHANGED",
			message: expect.stringContaining("ログインフォーム"),
		});
	});

	it.each([
		["想定外のホスト", "https://evil.example.test/cas/login"],
		["暗号化されていない通信", "http://sso.ouj.ac.jp/cas/login"],
	])(
		"認証画面が%sの場合はパスワードを送らずエラーにする",
		async (_label, casUrl) => {
			// 前提: ポータルのリダイレクト先が正規の CAS ではない
			const posts: RecordedPost[] = [];
			const client = new HttpClient(async (input, init) => {
				const url = String(input);
				if (init?.method === "POST") {
					posts.push({ url, body: new URLSearchParams(String(init.body)) });
					if (url.endsWith("/portal/sso/")) {
						return new Response(null, {
							status: 302,
							headers: { location: casUrl },
						});
					}
					return new Response("{}");
				}
				return new Response(url === PORTAL_URL ? PORTAL_PAGE : CAS_PAGE);
			});

			await expect(login(client, credentials)).rejects.toThrow(
				"認証画面の接続先",
			);

			// 検証: パスワードを含む送信が 1 件もない
			expect(
				posts.some(
					(post) => post.body.get("password") === credentials.password,
				),
			).toBe(false);
		},
	);

	it("認証画面に戻された場合はエラーにする", async () => {
		const client = fakeSite([], () => new Response(CAS_PAGE));

		await expect(login(client, credentials)).rejects.toThrow("ログインに失敗");
		await expect(
			login(
				fakeSite([], () => new Response(CAS_PAGE)),
				credentials,
			),
		).rejects.toMatchObject({ code: "AUTH" });
	});

	it("失敗時のエラーに到達先と画面タイトルを含め、チケットは含めない", async () => {
		const client = fakeSite(
			[],
			() =>
				new Response(null, {
					status: 302,
					headers: {
						location:
							"https://www.wakaba.ouj.ac.jp/portal/other;jsessionid=secret-session?ticket=secret-ticket",
					},
				}),
		);
		const error: Error = await login(client, credentials).catch(
			(caught) => caught,
		);

		expect(error.message).toContain("www.wakaba.ouj.ac.jp/portal/other");
		expect(error.message).toContain("想定外の画面");
		expect(error.message).not.toContain("secret-ticket");
		expect(error.message).not.toContain("secret-session");
	});

	it("エラーにパスワードを含めない", async () => {
		const client = fakeSite([], () => new Response(CAS_PAGE));

		const error: Error = await login(client, credentials).catch(
			(caught) => caught,
		);

		expect(error.message).not.toContain(credentials.password);
	});
});

describe("openMenu", () => {
	const home = { url: HOME_URL, body: HOME_PAGE };

	it("ポータル内の画面はトークンとメニューコードを generalPurpose へ送る", async () => {
		const posts: { url: string; body: URLSearchParams }[] = [];

		await openMenu(fakeSite(posts), home, "contacts");

		expect(posts[0]?.url).toBe(
			"https://www.wakaba.ouj.ac.jp/portal/common/generalPurpose/",
		);
		expect(posts[0]?.body.get("taglib.html.TOKEN")).toBe("トークン");
		expect(posts[0]?.body.get("menuCode")).toBe("B0201");
		expect(posts[0]?.body.get("nextPath")).toBe(
			"/commoncontact/commonContact/initialize",
		);
	});

	it("教務系の画面は externalPurpose へ送る", async () => {
		const posts: { url: string; body: URLSearchParams }[] = [];

		await openMenu(fakeSite(posts), home, "grades");

		expect(posts[0]?.url).toBe(
			"https://www.wakaba.ouj.ac.jp/portal/common/externalPurpose/",
		);
		expect(posts[0]?.body.get("menuCode")).toBe("N0213");
	});

	it("ホーム画面にフォームがない場合はエラーにする", async () => {
		const posts: { url: string; body: URLSearchParams }[] = [];

		await expect(
			openMenu(
				fakeSite(posts),
				{ url: HOME_URL, body: "メンテナンス中" },
				"files",
			),
		).rejects.toThrow("フォーム");
	});
});

describe("parseTable", () => {
	it("見出しをキーにした行データへ変換する", () => {
		const html = `<table id="一覧"><thead><tr><th>科目名</th><th>評語</th></tr></thead>
      <tbody><tr><td> 心理学入門 </td><td>〇A</td></tr></tbody></table>`;

		expect(parseTable(html, "#一覧")).toEqual({
			headers: ["科目名", "評語"],
			rows: [{ 科目名: "心理学入門", 評語: "〇A" }],
		});
	});

	it("見出しが空の列は結果に含めない", () => {
		// 前提: 実サイトの表には、操作用リンクなどが入る見出しなしの列がある
		const html = `<table id="一覧"><thead><tr><th></th><th>タイトル</th><th></th></tr></thead>
      <tbody><tr><td>操作リンク</td><td>第1回 通信指導問題</td><td>内部の値</td></tr></tbody></table>`;

		expect(parseTable(html, "#一覧")).toEqual({
			headers: ["タイトル"],
			rows: [{ タイトル: "第1回 通信指導問題" }],
		});
	});

	it("表がない場合はエラーにする", () => {
		expect(() => parseTable("<p>表なし</p>", "#一覧")).toThrow("#一覧");
		expect(() => parseTable("<title>エラー画面</title>", "#一覧")).toThrow(
			"エラー画面",
		);
	});

	it("列数が見出しと合わない場合はエラーにする", () => {
		const html = `<table id="一覧"><thead><tr><th>科目名</th><th>評語</th></tr></thead>
      <tbody><tr><td>心理学入門</td></tr></tbody></table>`;

		expect(() => parseTable(html, "#一覧")).toThrow(
			expect.objectContaining({
				code: "SITE_CHANGED",
				message: expect.stringContaining("列数"),
			}),
		);
	});
});
