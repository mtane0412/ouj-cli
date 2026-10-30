#!/usr/bin/env node
/**
 * ouj コマンドの入口。
 * 認証情報は環境変数 OUJ_USERNAME と OUJ_PASSWORD から受け取り、結果を JSON で標準出力へ書く。
 * OUJ_TRACE を設定すると、値を除いた通信経路を標準エラーへ書く。
 * doctor は個人情報を出さず、接続と一覧表の形式だけを確認する。
 */
import { HttpClient } from "./http-client.js";
import { login, MENUS, type MenuName, openMenu, parseTable } from "./wakaba.js";

const USAGE = "使い方: ouj <grades|contacts|files|doctor>";

function isMenuName(value: string): value is MenuName {
	return Object.hasOwn(MENUS, value);
}

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`環境変数 ${name} を設定してください`);
	return value;
}

/** 各画面の取得可否と表の形式だけを出力する */
async function doctor(
	client: HttpClient,
	home: Awaited<ReturnType<typeof login>>,
) {
	const results: Record<string, unknown> = { login: "ok" };
	let currentPage = home;
	for (const name of Object.keys(MENUS) as MenuName[]) {
		try {
			const page = await openMenu(client, currentPage, name);
			currentPage = page;
			const { headers, rows } = parseTable(
				page.body,
				MENUS[name].tableSelector,
			);
			results[name] = {
				path: new URL(page.url).pathname,
				headers,
				rowCount: rows.length,
			};
		} catch (error) {
			results[name] = {
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}
	return results;
}

async function main() {
	const command = process.argv[2];
	if (!command || (command !== "doctor" && !isMenuName(command))) {
		throw new Error(USAGE);
	}
	const client = new HttpClient(
		fetch,
		process.env.OUJ_TRACE ? (line) => console.error(line) : undefined,
	);
	const home = await login(client, {
		username: requireEnv("OUJ_USERNAME"),
		password: requireEnv("OUJ_PASSWORD"),
	});
	const result =
		command === "doctor"
			? await doctor(client, home)
			: parseTable(
					(await openMenu(client, home, command)).body,
					MENUS[command].tableSelector,
				).rows;
	console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
