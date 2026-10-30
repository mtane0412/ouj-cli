/**
 * Cookie を保持してリダイレクトを追跡する最小限の HTTP クライアント。
 * WAKABA は Cookie でセッションを管理し、リダイレクトの途中でも Cookie を発行するため、
 * fetch の自動リダイレクトを使わず 1 段ずつ処理する。
 */
import { CookieJar } from "tough-cookie";

const MAX_REDIRECTS = 10;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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
				headers: {
					...init.headers,
					...(cookie ? { cookie } : {}),
					...(referer ? { referer } : {}),
				},
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
				url = new URL(location, url).toString();
				init = { method: "GET" };
				continue;
			}
			if (!response.ok) {
				// URL にはチケットやトークンが含まれるため、エラーにはパスだけを出す
				throw new Error(
					`HTTP ${response.status}: ${new URL(url).pathname.split(";")[0]}`,
				);
			}
			return { url, body: await response.text() };
		}
		throw new Error(`リダイレクトが ${MAX_REDIRECTS} 回を超えました`);
	}
}
