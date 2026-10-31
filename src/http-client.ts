/**
 * Cookie を保持してリダイレクトを追跡する最小限の HTTP クライアント。
 * WAKABA は Cookie でセッションを管理し、リダイレクトの途中でも Cookie を発行するため、
 * fetch の自動リダイレクトを使わず 1 段ずつ処理する。
 */
import { CookieJar } from "tough-cookie";
import { OujError } from "./errors.js";

const MAX_REDIRECTS = 10;
/** 応答がないまま待ち続けないための、1 回の要求あたりの上限 */
const REQUEST_TIMEOUT_MS = 30_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const METHOD_PRESERVING_STATUSES = new Set([307, 308]);

/** 出力してよいパスを返す。URL に含まれるセッション ID とクエリを取り除く */
export function pathWithoutSession(url: string): string {
	return new URL(url).pathname.split(";")[0] ?? "";
}

/** 値を除いた URL の説明を作る（ホスト、パス、パス内パラメータ名、クエリ名） */
function describeUrl(url: string): string {
	const { host, pathname, searchParams } = new URL(url);
	const [path, ...pathParams] = pathname.split(";");
	const pathParamNames = pathParams.map((param) => param.split("=")[0]);
	return `${host}${path} pathParams=[${pathParamNames.join(",")}] query=[${[...searchParams.keys()].join(",")}]`;
}

/** ブラウザの既定動作と同じく、別ホストへはオリジンだけを渡して URL 内の値を漏らさない */
function refererFor(
	previousUrl: string | undefined,
	nextUrl: string,
): string | undefined {
	if (!previousUrl) return undefined;
	const previous = new URL(previousUrl);
	return previous.origin === new URL(nextUrl).origin
		? previousUrl
		: `${previous.origin}/`;
}

function cookieNames(cookieHeader: string): string {
	return cookieHeader
		.split("; ")
		.filter(Boolean)
		.map((cookie) => cookie.split("=")[0])
		.join(",");
}

/** URL にはチケットやトークンが含まれるため、エラーにはパスだけを出す */
function networkError(url: string, reason: unknown): OujError {
	const name = reason instanceof Error ? reason.name : String(reason);
	return new OujError(
		"NETWORK",
		`通信に失敗しました（${name}）: ${pathWithoutSession(url)}`,
	);
}

export interface Page {
	url: string;
	body: string;
}

export class HttpClient {
	private readonly jar = new CookieJar();
	/** 直前に要求した URL。次の要求の Referer に使う */
	private previousUrl: string | undefined;

	/**
	 * @param fetchImpl テストで差し替えるための fetch 実装
	 * @param trace 通信経路の記録先。URL や Cookie の値は渡さず、名前だけを渡す
	 */
	constructor(
		private readonly fetchImpl: typeof fetch = fetch,
		private readonly trace: (line: string) => void = () => {},
	) {}

	/** GET でページを取得する */
	get(url: string): Promise<Page> {
		return this.request(url, { method: "GET" });
	}

	/** フォーム形式で POST する。リダイレクト後は GET で追跡する */
	post(url: string, form: Record<string, string>): Promise<Page> {
		return this.request(url, {
			method: "POST",
			body: new URLSearchParams(form).toString(),
			headers: { "content-type": "application/x-www-form-urlencoded" },
		});
	}

	private async request(
		startUrl: string,
		startInit: RequestInit,
	): Promise<Page> {
		let url = startUrl;
		let init = startInit;
		for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
			const cookie = await this.jar.getCookieString(url);
			// WAKABA は Referer がないとホーム画面を「不正な操作」として拒否する
			const referer = refererFor(this.previousUrl, url);
			this.previousUrl = url;
			const response = await this.fetchImpl(url, {
				...init,
				redirect: "manual",
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				headers: {
					...init.headers,
					...(cookie ? { cookie } : {}),
					...(referer ? { referer } : {}),
				},
			}).catch((error: unknown) => {
				throw networkError(url, error);
			});
			this.trace(
				`${init.method} ${describeUrl(url)} -> ${response.status} cookie送信=[${cookieNames(cookie)}] cookie受信=[${response.headers
					.getSetCookie()
					.map((value) => value.replace(/=[^;]*/, ""))
					.join(" | ")}]`,
			);
			for (const setCookie of response.headers.getSetCookie()) {
				await this.jar.setCookie(setCookie, url);
			}

			const location = response.headers.get("location");
			if (REDIRECT_STATUSES.has(response.status) && location) {
				const next = new URL(location, url);
				// 別オリジンへフォーム値を渡さないよう、本文を保つのは同一オリジンの 307/308 だけにする
				const keepsRequest =
					METHOD_PRESERVING_STATUSES.has(response.status) &&
					next.origin === new URL(url).origin;
				url = next.toString();
				if (!keepsRequest) init = { method: "GET" };
				continue;
			}
			if (!response.ok) {
				throw networkError(url, `HTTP ${response.status}`);
			}
			const body = await response.text().catch((error: unknown) => {
				throw networkError(url, error);
			});
			return { url, body };
		}
		throw new OujError(
			"NETWORK",
			`リダイレクトが ${MAX_REDIRECTS} 回を超えました`,
		);
	}
}
