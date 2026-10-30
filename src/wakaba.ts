/**
 * システムWAKABA へのログイン、画面遷移、一覧表の解析を行う。
 * 読み取り専用のメニューだけを定義し、申請や投稿などの送信操作は扱わない。
 */
import * as cheerio from "cheerio";
import {
	type HttpClient,
	type Page,
	pathWithoutSession,
} from "./http-client.js";

const PORTAL_ORIGIN = "https://www.wakaba.ouj.ac.jp";
const LOGIN_FORM_SELECTOR = 'form[name="login_loginActionForm"]';
const MENU_FORM_SELECTOR = 'form[name="common_generalPurposeActionForm"]';

export interface Credentials {
	username: string;
	password: string;
}

interface Menu {
	menuCode: string;
	nextPath: string;
	/** 教務側のアプリへ移動する画面かどうか */
	external: boolean;
	tableSelector: string;
}

/** 教務側の画面にはメニューフォームがなく次の画面へ進めないため、続けて開く doctor のために最後に置く */
export const MENUS = {
	contacts: {
		menuCode: "B0201",
		nextPath: "/commoncontact/commonContact/initialize",
		external: false,
		tableSelector: "#tbl_commoncontact_rcv",
	},
	files: {
		menuCode: "A0204",
		nextPath: "/classfile/classFile/initialize",
		external: false,
		tableSelector: "#tbl_classFile",
	},
	grades: {
		menuCode: "N0213",
		nextPath: "/SC02080301003/initialize",
		external: true,
		tableSelector: "#searchResultList_SC02080301003",
	},
} as const satisfies Record<string, Menu>;

export type MenuName = keyof typeof MENUS;

export interface Table {
	headers: string[];
	rows: Record<string, string>[];
}

/** フォーム内の hidden 項目を名前と値の組にする */
function hiddenFields(
	$: cheerio.CheerioAPI,
	formSelector: string,
): Record<string, string> {
	const fields: Record<string, string> = {};
	$(`${formSelector} input[type="hidden"]`).each((_, element) => {
		const name = $(element).attr("name");
		if (name) fields[name] = $(element).attr("value") ?? "";
	});
	return fields;
}

/**
 * ログインボタンと同じ手順で CAS の認証画面へ進む。
 * この手順を省いて CAS へ直行すると、ログインはできても教務側の画面が内部エラーになる。
 */
async function startCasLogin(client: HttpClient): Promise<Page> {
	const portal = await client.get(`${PORTAL_ORIGIN}/portal/`);
	const hidden = hiddenFields(cheerio.load(portal.body), LOGIN_FORM_SELECTOR);
	if (hidden.mistakeChecker === undefined) {
		throw new Error("ポータルにログインフォームが見つかりません");
	}
	await client.post(`${PORTAL_ORIGIN}/portal/login/preLogin/preLogin`, {
		mistakeChecker: hidden.mistakeChecker,
		clientLocationUrl: `${PORTAL_ORIGIN}/`,
	});
	// 認証情報は CAS にだけ送るため、ポータルの入力欄は空のまま送信する
	return client.post(`${PORTAL_ORIGIN}/portal/sso/`, {
		...hidden,
		userID: "",
		password: "",
	});
}

/** CAS で認証し、ログイン後のホーム画面を返す */
export async function login(
	client: HttpClient,
	credentials: Credentials,
): Promise<Page> {
	const casPage = await startCasLogin(client);
	const $ = cheerio.load(casPage.body);
	const hidden = hiddenFields($, 'form:has(input[name="execution"])');
	if (!hidden.execution) {
		throw new Error(
			"認証画面の形式が想定と異なります（execution が見つかりません）",
		);
	}

	const home = await client.post(casPage.url, { ...hidden, ...credentials });
	const $home = cheerio.load(home.body);
	if (!$home(MENU_FORM_SELECTOR).length) {
		// URL にはチケットやセッション ID が含まれる場合があるため、取り除いて出す
		const { host } = new URL(home.url);
		throw new Error(
			`ログインに失敗しました（到達先: ${host}${pathWithoutSession(home.url)}、画面: ${$home("title").text().trim()}）。ログインIDとパスワード、またはメンテナンス状況を確認してください`,
		);
	}
	return home;
}

/** 現在の画面のメニューフォームを使って指定の画面を開く。トークンは遷移で変わるため最新の画面を渡す */
export async function openMenu(
	client: HttpClient,
	currentPage: Page,
	name: MenuName,
): Promise<Page> {
	const menu = MENUS[name];
	const hidden = hiddenFields(
		cheerio.load(currentPage.body),
		MENU_FORM_SELECTOR,
	);
	if (!hidden["taglib.html.TOKEN"]) {
		throw new Error("メニューのフォームが見つかりません");
	}
	const purpose = menu.external ? "externalPurpose" : "generalPurpose";
	return client.post(`${PORTAL_ORIGIN}/portal/common/${purpose}/`, {
		...hidden,
		headTitle: "ホーム",
		menuCode: menu.menuCode,
		nextPath: menu.nextPath,
	});
}

/** 一覧表を、見出しをキーにした行データへ変換する */
export function parseTable(html: string, selector: string): Table {
	const $ = cheerio.load(html);
	const table = $(selector);
	if (!table.length) {
		throw new Error(
			`一覧表 ${selector} が見つかりません（画面: ${$("title").text().trim()}）`,
		);
	}
	const text = (element: Parameters<typeof $>[0]) =>
		$(element).text().replace(/\s+/g, " ").trim();
	const headers = table.find("thead tr").first().find("th").toArray().map(text);
	const rows = table
		.find("tbody tr")
		.toArray()
		.map((row) => {
			const cells = $(row).find("td").toArray().map(text);
			if (cells.length !== headers.length) {
				throw new Error(
					`一覧表 ${selector} の列数が見出しと一致しません（見出し ${headers.length}、行 ${cells.length}）`,
				);
			}
			// 見出しが空の列は操作用などで意味を持たないため、結果から除く
			return Object.fromEntries(
				headers
					.map((header, index) => [header, cells[index] ?? ""])
					.filter(([header]) => header),
			);
		});
	return { headers: headers.filter(Boolean), rows };
}
