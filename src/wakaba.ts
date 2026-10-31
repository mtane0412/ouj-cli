/**
 * システムWAKABA へのログイン、画面遷移、一覧表の解析を行う。
 * 読み取り専用のメニューだけを定義し、申請や投稿などの送信操作は扱わない。
 */
import * as cheerio from "cheerio";
import { OujError } from "./errors.js";
import {
	type HttpClient,
	type Page,
	pathWithoutSession,
} from "./http-client.js";

const PORTAL_ORIGIN = "https://www.wakaba.ouj.ac.jp";
const CAS_ORIGIN = "https://sso.ouj.ac.jp";
const LOGIN_FORM_SELECTOR = 'form[name="login_loginActionForm"]';
const MENU_FORM_SELECTOR = 'form[name="common_generalPurposeActionForm"]';
const NO_DATA_MESSAGE = "表示するデータがありません";

export interface Credentials {
	username: string;
	password: string;
}

interface Menu {
	/** --help で示す説明 */
	description: string;
	menuCode: string;
	nextPath: string;
	/** 教務側のアプリへ移動する画面かどうか */
	external: boolean;
	/** 画面の HTML を行データへ変換する */
	parse: (html: string) => Table;
	/** 画面の検索フォーム。検索条件を指定できる画面だけが持つ */
	search?: MenuSearch;
}

/** 画面の検索フォームの送信先と、検索条件を入れる項目の名前 */
interface MenuSearch {
	formSelector: string;
	action: string;
	yearField: string;
	termField: string;
	lectureClassField?: string;
	/** 既定の画面に結果が出ないため、検索条件の指定が必須かどうか */
	required: boolean;
	/** 検索条件のほかに、常に上書きする項目 */
	overrides?: Record<string, string>;
}

export interface SearchQuery {
	year: string;
	term: string;
	lectureClass?: string;
}

/** --type の値と、試験時間割の授業区分の値の対応 */
export const LECTURE_CLASSES: Record<string, string> = {
	all: "0",
	broadcast: "1",
	online: "3",
};

export const MENUS = {
	contacts: {
		description: "学内連絡の一覧を取得します",
		menuCode: "B0201",
		nextPath: "/commoncontact/commonContact/initialize",
		external: false,
		parse: (html) => parseTable(html, "#tbl_commoncontact_rcv"),
	},
	files: {
		description: "授業共有ファイルの一覧を取得します",
		menuCode: "A0204",
		nextPath: "/classfile/classFile/initialize",
		external: false,
		parse: (html) => parseTable(html, "#tbl_classFile"),
	},
	grades: {
		description: "履修成績を取得します",
		menuCode: "N0213",
		nextPath: "/SC02080301003/initialize",
		external: true,
		parse: (html) => parseTable(html, "#searchResultList_SC02080301003"),
	},
	schedule: {
		description: "今週のスケジュールのうち、9:00〜21:00の予定を取得します",
		menuCode: "B0101",
		nextPath: "/schedule/weeklySchedule/initialize",
		external: false,
		parse: parseWeeklySchedule,
	},
	"class-contacts": {
		description:
			"授業連絡の一覧を取得します。条件を省略すると今学期の一覧を返します",
		menuCode: "A0201",
		nextPath: "/classcontact/classContactList/initialize",
		external: false,
		parse: (html) => parseSearchResult(html, "#tbl_A01_01"),
		search: {
			formSelector: 'form[name="classcontact_classContactActionForm"]',
			action: "/portal/classcontact/classContactList/selectClassContactList",
			yearField: "schoolYear",
			termField: "semesterCode",
			required: false,
			// 既定の連絡日の開始日が残ると、過去の学期の連絡が絞られてしまう
			overrides: { reportDateStart: "" },
		},
	},
	"exam-timetable": {
		description: "単位認定試験時間割を検索します。--year と --term が必須です",
		menuCode: "P0101",
		nextPath: "/SC02020100101/initialize",
		external: true,
		parse: (html) => parseSearchResult(html, "#searchResultList"),
		search: {
			formSelector: 'form[name="SC02020100101F01Form"]',
			action: "/kyoumu/SC02020100101/search.do",
			yearField: "searchCondVo.registerYear",
			termField: "searchCondVo.registerSemesterCode",
			lectureClassField: "searchCondVo.lectureClas",
			required: true,
		},
	},
} as const satisfies Record<string, Menu>;

export type MenuName = keyof typeof MENUS;

/** 画面の検索フォームの定義を返す。検索のない画面は undefined */
export function menuSearch(name: MenuName): MenuSearch | undefined {
	const menu: Menu = MENUS[name];
	return menu.search;
}

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
		throw new OujError(
			"SITE_CHANGED",
			"ポータルにログインフォームが見つかりません",
		);
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
		throw new OujError(
			"SITE_CHANGED",
			"認証画面の形式が想定と異なります（execution が見つかりません）",
		);
	}

	// 認証情報を渡す前に、リダイレクト先が正規の CAS であることを確かめる
	if (new URL(casPage.url).origin !== CAS_ORIGIN) {
		throw new OujError(
			"SITE_CHANGED",
			`認証画面の接続先が想定と異なります（${new URL(casPage.url).origin}）`,
		);
	}
	const home = await client.post(casPage.url, { ...hidden, ...credentials });
	const $home = cheerio.load(home.body);
	if (!$home(MENU_FORM_SELECTOR).length) {
		// URL にはチケットやセッション ID が含まれる場合があるため、取り除いて出す
		const { host } = new URL(home.url);
		throw new OujError(
			"AUTH",
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
		throw new OujError("SITE_CHANGED", "メニューのフォームが見つかりません");
	}
	const purpose = menu.external ? "externalPurpose" : "generalPurpose";
	return client.post(`${PORTAL_ORIGIN}/portal/common/${purpose}/`, {
		...hidden,
		headTitle: "ホーム",
		menuCode: menu.menuCode,
		nextPath: menu.nextPath,
	});
}

/**
 * 開いた画面の検索フォームを、画面の入力値に検索条件を重ねて1回だけ送信する。
 * ブラウザと同じく、無効な入力欄と未選択のチェックボックス、ラジオボタンは送らない。
 */
export async function searchMenu(
	client: HttpClient,
	page: Page,
	name: MenuName,
	query: SearchQuery,
): Promise<Page> {
	const search = menuSearch(name);
	if (!search) {
		throw new OujError("USAGE", `${name} には検索条件を指定できません`);
	}
	const $ = cheerio.load(page.body);
	const form = $(search.formSelector);
	if (!form.length) {
		throw new OujError(
			"SITE_CHANGED",
			`検索フォームが見つかりません（画面: ${$("title").text().trim()}）`,
		);
	}
	const fields: Record<string, string> = {};
	form.find("input[name], select[name]").each((_, element) => {
		const input = $(element);
		const fieldName = input.attr("name");
		const type = input.attr("type");
		if (!fieldName || input.is("[disabled]")) return;
		if ((type === "checkbox" || type === "radio") && !input.is("[checked]")) {
			return;
		}
		fields[fieldName] = input.is("select")
			? (input.find("option[selected]").attr("value") ??
				input.find("option").first().attr("value") ??
				"")
			: (input.attr("value") ?? "");
	});
	return client.post(`${PORTAL_ORIGIN}${search.action}`, {
		...fields,
		...search.overrides,
		[search.yearField]: query.year,
		[search.termField]: query.term,
		...(search.lectureClassField && query.lectureClass
			? { [search.lectureClassField]: query.lectureClass }
			: {}),
	});
}

/**
 * ログインして指定の1画面だけを開き、取得可否と表の形式を返す。
 * 画面が増えても通信量が増えないよう、複数の画面は開かない。個人情報を出さないよう、行の中身は返さない。
 */
export async function checkMenu(
	client: HttpClient,
	credentials: Credentials,
	name: MenuName,
) {
	const home = await login(client, credentials);
	const page = await openMenu(client, home, name);
	const { headers, rows } = MENUS[name].parse(page.body);
	return {
		login: "ok",
		menu: name,
		path: pathWithoutSession(page.url),
		headers,
		rowCount: rows.length,
	};
}

/** 一覧表を、見出しをキーにした行データへ変換する */
export function parseTable(html: string, selector: string): Table {
	const $ = cheerio.load(html);
	const table = $(selector);
	if (!table.length) {
		throw new OujError(
			"SITE_CHANGED",
			`一覧表 ${selector} が見つかりません（画面: ${$("title").text().trim()}）`,
		);
	}
	const text = (element: Parameters<typeof $>[0]) =>
		$(element).text().replace(/\s+/g, " ").trim();
	// 画面が並べ替えのためだけに持つ「（非表示）」の列は、見出しが空の列と同じく結果から除く
	const headers = table
		.find("thead tr")
		.first()
		.find("th")
		.toArray()
		.map((th) => {
			const header = text(th);
			return header.includes("（非表示）") ? "" : header;
		});
	const rows = table
		.find("tbody tr")
		.toArray()
		.map((row) => {
			const cells = $(row).find("td").toArray().map(text);
			if (cells.length !== headers.length) {
				throw new OujError(
					"SITE_CHANGED",
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

/** 検索結果の表を変換する。該当なしの案内があれば0件として返し、どちらもなければ parseTable で失敗させる */
function parseSearchResult(html: string, selector: string): Table {
	const $ = cheerio.load(html);
	if (!$(selector).length && $.text().includes(NO_DATA_MESSAGE)) {
		return { headers: [], rows: [] };
	}
	return parseTable(html, selector);
}

const SCHEDULE_HEADERS = ["日付", "時間", "内容"];
const DAYS_PER_WEEK = 7;
const EVENT_TIME = /^\d{2}:\d{2}-\d{2}:\d{2}$/;

/**
 * 週間カレンダーの1欄を予定ごとの時間と内容に分ける。
 * 欄の中は br で区切られ、時刻の行が予定の始まりになる。時刻のない予定は行の見出しを時間にする。
 */
function parseScheduleCell(
	$: cheerio.CheerioAPI,
	content: ReturnType<cheerio.CheerioAPI>,
	rowLabel: string,
): { time: string; lines: string[] }[] {
	const lines = (content.html() ?? "")
		.split(/<br\b[^>]*>/i)
		.map((line) => $(`<div>${line}</div>`).text().replace(/\s+/g, " ").trim())
		.filter(Boolean);
	const events: { time: string; lines: string[] }[] = [];
	for (const line of lines) {
		const current = events.at(-1);
		if (EVENT_TIME.test(line)) events.push({ time: line, lines: [] });
		else if (current) current.lines.push(line);
		else events.push({ time: rowLabel, lines: [line] });
	}
	return events;
}

/**
 * 週間スケジュールのカレンダーを、日付、時間、内容の行データへ変換する。
 * 複数の時間帯にまたがる予定は各行に現れるため1件にまとめ、日付順に並べる。
 */
export function parseWeeklySchedule(html: string): Table {
	const $ = cheerio.load(html);
	const table = $("table.calendar-body");
	const dates = table
		.find("thead th")
		.toArray()
		.slice(1)
		.map((th) => $(th).text().trim());
	if (dates.length !== DAYS_PER_WEEK) {
		throw new OujError(
			"SITE_CHANGED",
			`週間カレンダーの形式が想定と異なります（画面: ${$("title").text().trim()}、日付の列: ${dates.length}）`,
		);
	}
	const rowsByDay: Map<string, Record<string, string>>[] = dates.map(
		() => new Map(),
	);
	for (const row of table.find("tbody tr").toArray()) {
		const rowLabel = $(row).find("th").first().text().replace("|", "").trim();
		const cells = $(row).find("td").toArray();
		if (cells.length !== DAYS_PER_WEEK) {
			throw new OujError(
				"SITE_CHANGED",
				`週間カレンダーの欄の数が日付と一致しません（${cells.length}）`,
			);
		}
		cells.forEach((cell, dayIndex) => {
			const content = $(cell).find(".div_content");
			if (!content.length) {
				throw new OujError(
					"SITE_CHANGED",
					"週間カレンダーの欄に予定の入れ物が見つかりません",
				);
			}
			for (const { time, lines } of parseScheduleCell($, content, rowLabel)) {
				const description = lines.join(" ");
				rowsByDay[dayIndex]?.set(`${time} ${description}`, {
					日付: dates[dayIndex] ?? "",
					時間: time,
					内容: description,
				});
			}
		});
	}
	return {
		headers: SCHEDULE_HEADERS,
		rows: rowsByDay.flatMap((events) => [...events.values()]),
	};
}
