/**
 * ログインと画面遷移のテスト。
 * 実サイトで調査したフォーム構成を再現した HTML を使う。
 */
import { describe, expect, it } from "vitest";
import { HttpClient } from "../src/http-client.js";
import {
	checkMenu,
	fetchContact,
	fetchFileDetail,
	fetchSyllabus,
	login,
	MENUS,
	openMenu,
	parseTable,
	parseWeeklySchedule,
	searchMenu,
} from "../src/wakaba.js";

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
 * @param menuPage メニューから開いた画面の HTML
 */
function fakeSite(
	posts: RecordedPost[],
	afterCasPost: () => Response = () =>
		new Response(null, { status: 302, headers: { location: HOME_URL } }),
	menuPage = "<title>移動先</title>",
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
			return new Response(menuPage);
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

describe("checkMenu", () => {
	const contactsPage = `<title>学内連絡</title><table id="tbl_commoncontact_rcv">
	  <thead><tr><th>件名</th><th>発信者</th></tr></thead>
	  <tbody><tr><td><a onclick="dtlScreen('6155', '0', 'initializeRcv', '1')">休講のお知らせ</a></td><td>教務課</td></tr></tbody>
	</table>`;
	const siteWithContacts = (posts: RecordedPost[]) =>
		fakeSite(posts, undefined, contactsPage);

	it("指定の1画面だけを開き、メニューへの遷移は1回で済ませる", async () => {
		const posts: RecordedPost[] = [];

		await checkMenu(siteWithContacts(posts), credentials, "contacts");

		const menuPosts = posts.filter(({ url }) =>
			url.includes("/portal/common/"),
		);
		expect(menuPosts).toHaveLength(1);
		expect(menuPosts[0]?.body.get("menuCode")).toBe("B0201");
	});

	it("列名と件数を返し、行の中身は返さない", async () => {
		const result = await checkMenu(
			siteWithContacts([]),
			credentials,
			"contacts",
		);

		expect(result).toMatchObject({
			login: "ok",
			menu: "contacts",
			headers: ["件名", "発信者", "連絡ID"],
			rowCount: 1,
		});
		expect(JSON.stringify(result)).not.toContain("休講のお知らせ");
	});

	it("表が見つからない場合は SITE_CHANGED で失敗する", async () => {
		await expect(
			checkMenu(fakeSite([]), credentials, "contacts"),
		).rejects.toMatchObject({ code: "SITE_CHANGED" });
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

describe("searchMenu", () => {
	const classContactsPage = {
		url: "https://www.wakaba.ouj.ac.jp/portal/classcontact/classContactList/display",
		body: `<form name="classcontact_classContactActionForm">
		  <select name="schoolYear"><option value="2027">2027年度</option><option value="2026" selected>2026年度</option></select>
		  <select name="semesterCode"><option value="">選択</option><option value="2" selected>２学期</option></select>
		  <input type="radio" name="subjectZemiClas" value="1" checked><input type="radio" name="subjectZemiClas" value="2">
		  <input type="text" name="reportDateStart" value="2026/04/01">
		  <input type="checkbox" name="onlyUnRead" value="true">
		  <input type="text" name="studentCode" value="学生番号" disabled>
		  <input type="hidden" name="taglib.html.TOKEN" value="検索トークン">
		</form>`,
	};
	const examPage = {
		url: "https://www.wakaba.ouj.ac.jp/kyoumu/SC02020100101/display.do",
		body: `<form name="SC02020100101F01Form">
		  <input type="radio" name="searchCondVo.lectureClas" value="0" checked>
		  <input type="hidden" name="taglib.html.TOKEN" value="検索トークン">
		</form>`,
	};

	it("授業連絡は画面のフォームの値に検索条件を重ねて1回だけ送る", async () => {
		const posts: RecordedPost[] = [];

		await searchMenu(fakeSite(posts), classContactsPage, "class-contacts", {
			year: "2025",
			term: "1",
		});

		expect(posts).toHaveLength(1);
		expect(posts[0]?.url).toBe(
			"https://www.wakaba.ouj.ac.jp/portal/classcontact/classContactList/selectClassContactList",
		);
		expect(posts[0]?.body.get("schoolYear")).toBe("2025");
		expect(posts[0]?.body.get("semesterCode")).toBe("1");
		expect(posts[0]?.body.get("subjectZemiClas")).toBe("1");
		expect(posts[0]?.body.get("taglib.html.TOKEN")).toBe("検索トークン");
		// 既定の連絡日で過去の学期が絞られないよう、開始日を空にする
		expect(posts[0]?.body.get("reportDateStart")).toBe("");
		// ブラウザと同じく、未選択のチェックボックスと無効な入力欄は送らない
		expect(posts[0]?.body.has("onlyUnRead")).toBe(false);
		expect(posts[0]?.body.has("studentCode")).toBe(false);
	});

	it("押していないボタンは送らず、値のない選択肢はブラウザと同じ値を送る", async () => {
		const posts: RecordedPost[] = [];
		const body = `<form name="classcontact_classContactActionForm">
		  <input type="submit" name="clear" value="クリア">
		  <input type="reset" name="reset" value="戻す">
		  <input type="image" name="icon" value="画像">
		  <input type="button" name="action" value="操作">
		  <input type="checkbox" name="onlyTodo" checked>
		  <select name="subjectDispCode"><option selected>心理学概論</option></select>
		</form>`;

		await searchMenu(
			fakeSite(posts),
			{ url: classContactsPage.url, body },
			"class-contacts",
			{ year: "2026", term: "1" },
		);

		for (const button of ["clear", "reset", "icon", "action"]) {
			expect(posts[0]?.body.has(button)).toBe(false);
		}
		expect(posts[0]?.body.get("onlyTodo")).toBe("on");
		expect(posts[0]?.body.get("subjectDispCode")).toBe("心理学概論");
	});

	it("試験時間割は授業区分も送る", async () => {
		const posts: RecordedPost[] = [];

		await searchMenu(fakeSite(posts), examPage, "exam-timetable", {
			year: "2026",
			term: "2",
			lectureClass: "1",
		});

		expect(posts[0]?.url).toBe(
			"https://www.wakaba.ouj.ac.jp/kyoumu/SC02020100101/search.do",
		);
		expect(posts[0]?.body.get("searchCondVo.registerYear")).toBe("2026");
		expect(posts[0]?.body.get("searchCondVo.registerSemesterCode")).toBe("2");
		expect(posts[0]?.body.get("searchCondVo.lectureClas")).toBe("1");
	});

	it("検索フォームがない画面は通信せず SITE_CHANGED で失敗する", async () => {
		const posts: RecordedPost[] = [];

		await expect(
			searchMenu(
				fakeSite(posts),
				{ url: classContactsPage.url, body: "<title>エラー画面</title>" },
				"class-contacts",
				{ year: "2026", term: "1" },
			),
		).rejects.toMatchObject({ code: "SITE_CHANGED" });
		expect(posts).toHaveLength(0);
	});
});

describe("検索結果の解析", () => {
	it("授業連絡の空の結果は0件として返す", () => {
		const html = `<div id="search-result"><div class="center">表示するデータがありません。</div></div>`;

		expect(MENUS["class-contacts"].parse(html)).toEqual({
			headers: [],
			rows: [],
		});
	});

	it("授業連絡の結果の表が消えた画面は SITE_CHANGED で失敗する", () => {
		expect(() =>
			MENUS["class-contacts"].parse("<title>エラー画面</title>"),
		).toThrow(expect.objectContaining({ code: "SITE_CHANGED" }));
	});

	it("結果の欄以外に同じ文言があるだけの画面は SITE_CHANGED で失敗する", () => {
		const html =
			"<p>該当がない場合は「表示するデータがありません」と表示します</p>";

		expect(() => MENUS["class-contacts"].parse(html)).toThrow(
			expect.objectContaining({ code: "SITE_CHANGED" }),
		);
	});

	it("途中に「（非表示）」を含むだけの見出しは残す", () => {
		const html = `<table id="searchResultList"><thead><tr><th>備考（非表示を含む）</th></tr></thead>
		  <tbody><tr><td>振替あり</td></tr></tbody></table>`;

		expect(MENUS["exam-timetable"].parse(html).headers).toEqual([
			"備考（非表示を含む）",
		]);
	});

	it("授業連絡の結果から、操作用と非表示の列を除く", () => {
		const html = `<table id="tbl_A01_01"><thead><tr><th></th><th>タイトル</th><th></th></tr></thead>
		  <tbody><tr><td><input></td><td>休講のお知らせ（未読）</td><td>12345</td></tr></tbody></table>`;

		expect(MENUS["class-contacts"].parse(html).rows).toEqual([
			{ タイトル: "休講のお知らせ（未読）" },
		]);
	});

	it("試験時間割の結果から、非表示と書かれた列を除く", () => {
		const html = `<table id="searchResultList"><thead><tr><th>試験日</th><th>科目名</th><th>曜日コード（非表示）</th></tr></thead>
		  <tbody><tr><td>*&nbsp;</td><td>初歩からの数学&nbsp;</td><td>0</td></tr></tbody></table>`;

		expect(MENUS["exam-timetable"].parse(html)).toEqual({
			headers: ["試験日", "科目名"],
			rows: [{ 試験日: "*", 科目名: "初歩からの数学" }],
		});
	});
});

describe("parseWeeklySchedule", () => {
	/** 実サイトのカレンダーの形を再現した予定の欄 */
	const cell = (content: string) =>
		`<td><div class="div_add"><a class="btn">＋</a></div><div class="div_content">${content}</div></td>`;
	const emptyCells = (count: number) => cell("").repeat(count);
	const dates = [
		"10/26(月)",
		"10/27(火)",
		"10/28(水)",
		"10/29(木)",
		"10/30(金)",
		"10/31(土)",
		"11/1(日)",
	];
	const calendar = (rows: string) => `<table class="calendar-body table">
	  <thead><tr><th></th>${dates.map((date) => `<th>${date}</th>`).join("")}</tr></thead>
	  <tbody>${rows}</tbody>
	</table>`;
	const broadcast =
		"15:45-16:30<br /><a>データの分析と知識発見（’２４）</a><br/>放送授業<br />テレビ<br />通常放送<br/>";

	it("予定を日付、時間、内容の行にする", () => {
		const html = calendar(
			`<tr><th>15:00|</th>${emptyCells(5)}${cell(broadcast)}${emptyCells(1)}</tr>`,
		);

		expect(parseWeeklySchedule(html)).toEqual({
			headers: ["日付", "時間", "内容"],
			rows: [
				{
					日付: "10/31(土)",
					時間: "15:45-16:30",
					内容: "データの分析と知識発見（’２４） 放送授業 テレビ 通常放送",
				},
			],
		});
	});

	it("複数の時間帯にまたがる予定は1件にまとめる", () => {
		const html = calendar(
			`<tr><th>15:00|</th>${emptyCells(5)}${cell(broadcast)}${emptyCells(1)}</tr>
			 <tr><th>16:00|</th>${emptyCells(5)}${cell(broadcast)}${emptyCells(1)}</tr>`,
		);

		expect(parseWeeklySchedule(html).rows).toHaveLength(1);
	});

	it("1つの欄に複数の予定があれば分けて、日付順に並べる", () => {
		const html = calendar(
			`<tr><th>10:00|</th>${emptyCells(1)}${cell("10:00-10:45<br/>心理学概論<br/>11:00-11:45<br/>統計学入門")}${emptyCells(5)}</tr>
			 <tr><th>12:00|</th>${cell("12:00-12:45<br/>日本史")}${emptyCells(6)}</tr>`,
		);

		expect(parseWeeklySchedule(html).rows).toEqual([
			{ 日付: "10/26(月)", 時間: "12:00-12:45", 内容: "日本史" },
			{ 日付: "10/27(火)", 時間: "10:00-10:45", 内容: "心理学概論" },
			{ 日付: "10/27(火)", 時間: "11:00-11:45", 内容: "統計学入門" },
		]);
	});

	it("属性のついた br でも行を分ける", () => {
		const html = calendar(
			`<tr><th>10:00|</th>${cell('10:00-10:45<br class="改行"/>心理学概論')}${emptyCells(6)}</tr>`,
		);

		expect(parseWeeklySchedule(html).rows).toEqual([
			{ 日付: "10/26(月)", 時間: "10:00-10:45", 内容: "心理学概論" },
		]);
	});

	it("時刻のない行事は、行の見出しを時間にする", () => {
		const html = calendar(
			`<tr><th>行事</th>${cell("開講式")}${emptyCells(6)}</tr>`,
		);

		expect(parseWeeklySchedule(html).rows).toEqual([
			{ 日付: "10/26(月)", 時間: "行事", 内容: "開講式" },
		]);
	});

	it("予定がない週は0件を返す", () => {
		const html = calendar(`<tr><th>09:00|</th>${emptyCells(7)}</tr>`);

		expect(parseWeeklySchedule(html).rows).toEqual([]);
	});

	it.each([
		["カレンダーがない画面", "<title>エラー画面</title>"],
		[
			"日付の見出しが7日分でない表",
			'<table class="calendar-body table"><thead><tr><th></th><th>10/26(月)</th></tr></thead></table>',
		],
		[
			"予定の入れ物がない欄",
			calendar(`<tr><th>09:00|</th>${"<td></td>".repeat(7)}</tr>`),
		],
		[
			"欄の数が日付と合わない行",
			calendar(`<tr><th>09:00|</th>${emptyCells(3)}</tr>`),
		],
	])("%s は SITE_CHANGED で失敗する", (_label, html) => {
		expect(() => parseWeeklySchedule(html)).toThrow(
			expect.objectContaining({ code: "SITE_CHANGED" }),
		);
	});
});

describe("fetchSyllabus", () => {
	const resultRow = (index: number, code: string, name: string) =>
		`<tr><td>専門科目</td><td>${code}</td><td><a onclick="forwardBroadcastEducationDetail(&#39;${index}&#39;)">${name}</a></td></tr>`;
	const searchForm = `<form name="SC02060200201F01Form">
	  <select name="registerTerm"><option value="">選択</option></select>
	  <input type="text" name="subjectName" value="">
	  <input type="hidden" name="taglib.html.TOKEN" value="検索トークン">
	</form>`;
	const resultPage = (rows: string) => `${searchForm}
	  <form name="SC02060200201F02Form">
	    <table id="broadcastEducationVOList"><thead><tr><th>科目区分</th><th>科目コード</th><th>科目名</th></tr></thead>
	    <tbody>${rows}</tbody></table>
	    <input type="hidden" name="selectBroadcastEducationIndex" value="">
	    <input type="hidden" name="taglib.html.TOKEN" value="詳細トークン">
	  </form>`;
	const detailPage = `<title>シラバス参照</title><div class="right-module-bold-inner">
	  <p id="SC_0206_02002_11_SIZE">心理学概論（’２４）<p id="SC_0206_02002_11_SIZE"></p>
	  <p id="SC_0206_02002_11_BOLD">主任講師名：放送　太郎（放送大学教授）</p>
	  <p id="SC_0206_02002_11_ALIGNLEFT">【講義概要】<br/>心の働きを学ぶ。<br/><br/>【授業の目標】<br/>基礎を身につける。</p>
	  <div class="ttb_entry"><div class="row"><div class="col-lg-12 td"><p id="SC_0206_02002_11_SIZESMALL">第1回　心理学とは</p><br/>歴史を学ぶ。</div></div></div>
	  <div class="ttb_entry"><div class="row"><div class="col-lg-12 td"><p id="SC_0206_02002_11_SIZESMALL">第1回　心理学とは</p><br/>歴史を学ぶ。</div></div></div>
	  <div class="row"><div class="col-lg-6 th">単位数</div><div class="col-lg-6 td">2単位</div></div>
	</div>`;

	/** 検索と詳細の応答を返す偽サイト。HOME から開く画面は検索フォームとする */
	function syllabusSite(posts: RecordedPost[], searchResult: string) {
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
				if (url.includes("/cas/login")) {
					return new Response(null, {
						status: 302,
						headers: { location: HOME_URL },
					});
				}
				if (url.includes("/search.do")) return new Response(searchResult);
				if (url.includes("Detail.do")) return new Response(detailPage);
				return new Response(searchForm);
			}
			if (url === PORTAL_URL) return new Response(PORTAL_PAGE);
			return new Response(url.includes("/cas/login") ? CAS_PAGE : HOME_PAGE);
		});
	}
	const query = { year: "2026", term: "2", name: "心理学" };
	const pagePosts = (posts: RecordedPost[]) =>
		posts.filter(({ url }) => /common\/|search\.do|Detail\.do/.test(url));

	it("該当が1件なら詳細を開き、項目と内容の行にする", async () => {
		const posts: RecordedPost[] = [];

		const table = await fetchSyllabus(
			syllabusSite(posts, resultPage(resultRow(0, "1234567", "心理学概論"))),
			credentials,
			query,
		);

		// 開く画面はメニュー、検索、詳細の3つだけ
		expect(pagePosts(posts)).toHaveLength(3);
		const [, search, detail] = pagePosts(posts);
		expect(search?.body.get("registerTerm")).toBe("20262");
		expect(search?.body.get("subjectName")).toBe("心理学");
		expect(detail?.url).toBe(
			"https://www.wakaba.ouj.ac.jp/kyoumu/SC02060200201/forwardBroadcastEducationDetail.do",
		);
		expect(detail?.body.get("selectBroadcastEducationIndex")).toBe("0");
		expect(detail?.body.get("taglib.html.TOKEN")).toBe("詳細トークン");
		expect(table).toEqual({
			headers: ["項目", "内容"],
			rows: [
				{ 項目: "科目名", 内容: "心理学概論（’２４）" },
				{ 項目: "主任講師名", 内容: "放送 太郎（放送大学教授）" },
				{ 項目: "講義概要", 内容: "心の働きを学ぶ。" },
				{ 項目: "授業の目標", 内容: "基礎を身につける。" },
				{ 項目: "第1回", 内容: "心理学とは 歴史を学ぶ。" },
				{ 項目: "単位数", 内容: "2単位" },
			],
		});
	});

	it("該当が複数なら詳細を開かず、候補を示して USAGE で失敗する", async () => {
		const posts: RecordedPost[] = [];
		const rows =
			resultRow(0, "1234567", "心理学概論") +
			resultRow(1, "7654321", "発達心理学");

		const failure = fetchSyllabus(
			syllabusSite(posts, resultPage(rows)),
			credentials,
			query,
		);

		await expect(failure).rejects.toMatchObject({ code: "USAGE" });
		await expect(failure).rejects.toThrow("7654321");
		expect(posts.some(({ url }) => url.includes("Detail.do"))).toBe(false);
	});

	it("--code で候補を1件に絞って詳細を開く", async () => {
		const posts: RecordedPost[] = [];
		const rows =
			resultRow(0, "1234567", "心理学概論") +
			resultRow(1, "7654321", "発達心理学");

		await fetchSyllabus(syllabusSite(posts, resultPage(rows)), credentials, {
			...query,
			code: "7654321",
		});

		const detail = posts.find(({ url }) => url.includes("Detail.do"));
		expect(detail?.body.get("selectBroadcastEducationIndex")).toBe("1");
	});

	it("該当がなければ USAGE で失敗する", async () => {
		await expect(
			fetchSyllabus(
				syllabusSite(
					[],
					`${searchForm}<div class="center">表示するデータがありません。</div>`,
				),
				credentials,
				query,
			),
		).rejects.toMatchObject({ code: "USAGE" });
	});

	it("科目コードの列がなければ SITE_CHANGED で失敗する", async () => {
		const html = resultPage(resultRow(0, "1234567", "心理学概論")).replace(
			"<th>科目コード</th>",
			"<th>番号</th>",
		);

		await expect(
			fetchSyllabus(syllabusSite([], html), credentials, query),
		).rejects.toMatchObject({ code: "SITE_CHANGED" });
	});

	it("結果の表も該当なしの案内もなければ SITE_CHANGED で失敗する", async () => {
		await expect(
			fetchSyllabus(
				syllabusSite([], "<title>エラー画面</title>"),
				credentials,
				query,
			),
		).rejects.toMatchObject({ code: "SITE_CHANGED" });
	});
});

describe("学内連絡", () => {
	const listPage = `<title>学内連絡</title>
	  <form name="commoncontact_commonContactActionForm"><input type="hidden" name="taglib.html.TOKEN" value="一覧トークン"></form>
	  <table id="tbl_commoncontact_rcv"><thead><tr><th>カテゴリ</th><th>タイトル</th></tr></thead>
	  <tbody>
	    <tr><td>学生生活</td><td><a onclick="dtlScreen('6155', '0', 'initializeRcv', '1');return dbClick();">図書館の休館</a><span class="red">（未読）</span></td></tr>
	    <tr><td>教務</td><td><a onclick="dtlScreen('6100', '1', 'initializeRcv', '2');return dbClick();">試験のお知らせ</a></td></tr>
	  </tbody></table>`;
	const detailPage = `<title>学内連絡詳細</title><div class="ttb_entry">
	  <div class="row"><div class="col-lg-3 th">カテゴリ</div><div class="col-lg-9 td">学生生活</div></div>
	  <div class="row"><div class="col-lg-3 th">タイトル</div><div class="col-lg-9 td">図書館の休館</div></div>
	  <div class="row"><div class="col-lg-3 th">連絡内容</div><div class="col-lg-9 td brkall"><div class="rich_area">
	    <p>在学生の皆さん</p><p>詳細は<a href="https://example.ouj.ac.jp/library">こちら</a>をご覧ください。<br/>以上</p>
	  </div></div></div>
	</div>`;

	function contactSite(posts: RecordedPost[], detail = detailPage) {
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
				if (url.includes("/cas/login")) {
					return new Response(null, {
						status: 302,
						headers: { location: HOME_URL },
					});
				}
				if (url.includes("/dtlEdit")) return new Response(detail);
				return new Response(listPage);
			}
			if (url === PORTAL_URL) return new Response(PORTAL_PAGE);
			return new Response(url.includes("/cas/login") ? CAS_PAGE : HOME_PAGE);
		});
	}

	it("一覧の各行に、本文の取得に使う連絡IDをつける", () => {
		expect(MENUS.contacts.parse(listPage)).toEqual({
			headers: ["カテゴリ", "タイトル", "連絡ID"],
			rows: [
				{
					カテゴリ: "学生生活",
					タイトル: "図書館の休館（未読）",
					連絡ID: "6155",
				},
				{ カテゴリ: "教務", タイトル: "試験のお知らせ", 連絡ID: "6100" },
			],
		});
	});

	it("一覧に詳細へのリンクがない行があれば SITE_CHANGED で失敗する", () => {
		const html = listPage.replace(/<a onclick="dtlScreen\('6100'[^>]*>/, "<a>");

		expect(() => MENUS.contacts.parse(html)).toThrow(
			expect.objectContaining({ code: "SITE_CHANGED" }),
		);
	});

	it("指定の1件だけを開き、行の引数を画面と同じ形で送る", async () => {
		const posts: RecordedPost[] = [];

		const table = await fetchContact(contactSite(posts), credentials, "6100");

		const detailPosts = posts.filter(({ url }) => url.includes("/dtlEdit"));
		expect(detailPosts).toHaveLength(1);
		expect(Object.fromEntries(detailPosts[0]?.body ?? [])).toEqual({
			"taglib.html.TOKEN": "一覧トークン",
			mode: "initializeRcv",
			selectIndex: "1",
			commonContactId: "6100",
			commonContactKindDivision: "2",
		});
		expect(table.headers).toEqual(["項目", "内容"]);
	});

	it("本文は段落を改行で分け、リンク先を残す", async () => {
		const table = await fetchContact(contactSite([]), credentials, "6155");

		expect(table.rows).toEqual([
			{ 項目: "カテゴリ", 内容: "学生生活" },
			{ 項目: "タイトル", 内容: "図書館の休館" },
			{
				項目: "連絡内容",
				内容: "在学生の皆さん\n詳細はこちら（https://example.ouj.ac.jp/library）をご覧ください。\n以上",
			},
		]);
	});

	it("表示文字列が URL そのもののリンクは URL を重ねない", async () => {
		const detail = detailPage.replace(
			"在学生の皆さん",
			'<a href="https://example.ouj.ac.jp/">https://example.ouj.ac.jp/</a>',
		);

		const table = await fetchContact(
			contactSite([], detail),
			credentials,
			"6155",
		);

		const body = JSON.stringify(table.rows[2]);
		expect(body).toContain("https://example.ouj.ac.jp/\\n");
		expect(body).not.toContain("（https://example.ouj.ac.jp/）");
	});

	it("詳細へのリンクの前に別のリンクがある行でも連絡IDを取り出す", () => {
		const html = listPage.replace(
			"<td>教務</td><td>",
			'<td>教務</td><td><a href="#添付">添付</a>',
		);

		expect(MENUS.contacts.parse(html).rows[1]).toMatchObject({
			連絡ID: "6100",
		});
	});

	it("一覧の画面にフォームがなければ詳細を開かず SITE_CHANGED で失敗する", async () => {
		const posts: RecordedPost[] = [];
		const client = new HttpClient(async (input, init) => {
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
				if (url.includes("/cas/login")) {
					return new Response(null, {
						status: 302,
						headers: { location: HOME_URL },
					});
				}
				return new Response(listPage.replace(/<form.*?<\/form>/s, ""));
			}
			if (url === PORTAL_URL) return new Response(PORTAL_PAGE);
			return new Response(url.includes("/cas/login") ? CAS_PAGE : HOME_PAGE);
		});

		await expect(
			fetchContact(client, credentials, "6155"),
		).rejects.toMatchObject({ code: "SITE_CHANGED" });
		expect(posts.some(({ url }) => url.includes("/dtlEdit"))).toBe(false);
	});

	it("解析に失敗したときは、既読になった可能性を伝える", async () => {
		await expect(
			fetchContact(
				contactSite([], "<title>エラー画面</title>"),
				credentials,
				"6155",
			),
		).rejects.toThrow("既読");
	});

	it("本文の外部リンクでないものは URL を足さず、表の欄は区切る", async () => {
		const detail = detailPage.replace(
			"在学生の皆さん",
			'<a href="javascript:void(0)">開く</a><table><tr><td>日付</td><td>場所</td></tr></table>',
		);

		const table = await fetchContact(
			contactSite([], detail),
			credentials,
			"6155",
		);

		const body = JSON.stringify(table.rows[2]);
		expect(body).not.toContain("javascript");
		expect(body).toContain("日付 場所");
	});

	it("本文の中の入れ子の行を項目として取り込まない", async () => {
		const detail = detailPage.replace(
			"在学生の皆さん",
			'<div class="row"><div class="th">偽の項目</div><div class="td">偽の値</div></div>',
		);

		const table = await fetchContact(
			contactSite([], detail),
			credentials,
			"6155",
		);

		expect(JSON.stringify(table.rows)).not.toContain('"偽の項目"');
		expect(table.rows).toHaveLength(3);
	});

	it("一覧にない連絡IDは詳細を開かず USAGE で失敗する", async () => {
		const posts: RecordedPost[] = [];

		await expect(
			fetchContact(contactSite(posts), credentials, "9999"),
		).rejects.toMatchObject({ code: "USAGE" });
		expect(posts.some(({ url }) => url.includes("/dtlEdit"))).toBe(false);
	});

	it("詳細画面の形式が違えば SITE_CHANGED で失敗する", async () => {
		await expect(
			fetchContact(
				contactSite([], "<title>エラー画面</title>"),
				credentials,
				"6155",
			),
		).rejects.toMatchObject({ code: "SITE_CHANGED" });
	});
});

describe("授業共有ファイル", () => {
	const row = (index: number, title: string) =>
		`<tr><td>科目</td><td><a onclick="return showClassFileDetail(${index});">${title}<input type="hidden" name="linkDetailIndex" value="${index}"/></a></td></tr>`;
	const listPage = `<title>授業共有ファイル</title>
	  <form name="classfile_classFileActionForm"><input type="hidden" name="taglib.html.TOKEN" value="一覧トークン">
	  <table id="tbl_classFile"><thead><tr><th>授業科目</th><th>タイトル</th></tr></thead>
	  <tbody>${row(0, "復習用スライド")}${row(1, "演習問題")}</tbody></table></form>`;
	const detailPage = `<title>授業共有ファイル詳細</title><div class="ttb_entry">
	  <div class="row"><div class="th">タイトル</div><div class="td">復習用スライド</div></div>
	  <div class="row"><div class="th">ファイル</div><div class="td">
	    <div id="fileList_CLASS_FILE_FILE"><div><a onclick="fileDownLoad('CLASS_FILE_FILE', '1', '第1回.pdf');">第1回.pdf</a>
	      (768.78 KB)</div></div><script>function refreshFileList() {}</script>
	    <div id="fileListAllDownload_CLASS_FILE_FILE"><a onclick="allFileDownload('CLASS_FILE_FILE');">一括ダウンロード</a></div>
	  </div></div>
	  <div class="row"><div class="th">公開期間</div><div class="td">2019/10/13 ～ 2038/12/31</div></div>
	</div>`;

	function fileSite(posts: RecordedPost[], detail = detailPage) {
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
				if (url.includes("/cas/login")) {
					return new Response(null, {
						status: 302,
						headers: { location: HOME_URL },
					});
				}
				if (url.includes("showClassFileDetail")) return new Response(detail);
				return new Response(listPage);
			}
			if (url === PORTAL_URL) return new Response(PORTAL_PAGE);
			return new Response(url.includes("/cas/login") ? CAS_PAGE : HOME_PAGE);
		});
	}

	it("一覧の各行に、詳細の取得に使う番号をつける", () => {
		expect(MENUS.files.parse(listPage).rows).toEqual([
			{ 授業科目: "科目", タイトル: "復習用スライド", 番号: "0" },
			{ 授業科目: "科目", タイトル: "演習問題", 番号: "1" },
		]);
	});

	it("指定の1件の詳細だけを開き、ファイルの一括ダウンロードの文言を除く", async () => {
		const posts: RecordedPost[] = [];

		const table = await fetchFileDetail(fileSite(posts), credentials, "1");

		const detailPosts = posts.filter(({ url }) =>
			url.includes("showClassFileDetail"),
		);
		expect(detailPosts).toHaveLength(1);
		expect(detailPosts[0]?.url).toBe(
			"https://www.wakaba.ouj.ac.jp/portal/classfile/classFile/showClassFileDetail/1",
		);
		expect(detailPosts[0]?.body.get("taglib.html.TOKEN")).toBe("一覧トークン");
		expect(table.rows).toEqual([
			{ 項目: "タイトル", 内容: "復習用スライド" },
			{ 項目: "ファイル", 内容: "第1回.pdf (768.78 KB)" },
			{ 項目: "公開期間", 内容: "2019/10/13 ～ 2038/12/31" },
		]);
	});

	it("添付のない詳細画面も正常に読む", async () => {
		const detail = detailPage.replace(
			/<div class="row"><div class="th">ファイル.*?<\/div><\/div>\s*<div class="row"><div class="th">公開期間/s,
			'<div class="row"><div class="th">公開期間',
		);

		const table = await fetchFileDetail(fileSite([], detail), credentials, "0");

		expect(table.rows).toHaveLength(2);
	});

	it("ファイル本体へは通信しない", async () => {
		const posts: RecordedPost[] = [];

		await fetchFileDetail(fileSite(posts), credentials, "0");

		expect(posts.some(({ url }) => /fileDownLoad/i.test(url))).toBe(false);
	});

	it("一覧にない番号は詳細を開かず USAGE で失敗する", async () => {
		const posts: RecordedPost[] = [];

		await expect(
			fetchFileDetail(fileSite(posts), credentials, "9"),
		).rejects.toMatchObject({ code: "USAGE" });
		expect(posts.some(({ url }) => url.includes("showClassFileDetail"))).toBe(
			false,
		);
	});

	it("詳細画面の形式が違えば SITE_CHANGED で失敗する", async () => {
		await expect(
			fetchFileDetail(
				fileSite([], "<title>エラー画面</title>"),
				credentials,
				"0",
			),
		).rejects.toMatchObject({ code: "SITE_CHANGED" });
	});
});
