#!/usr/bin/env node
/**
 * ouj コマンドの入口。実際の通信とファイル保存先を組み立てて run に渡す。
 * 認証情報は環境変数 OUJ_USERNAME と OUJ_PASSWORD から受け取る。
 * OUJ_TRACE を設定すると、値を除いた通信経路を標準エラーへ書く。
 * doctor は個人情報を出さず、接続と1画面の一覧表の形式だけを確認する。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { HttpClient } from "./http-client.js";
import { LocalStore } from "./local-store.js";
import { run } from "./run.js";
import {
	type Credentials,
	checkMenu,
	login,
	MENUS,
	type MenuName,
	openMenu,
	type SearchQuery,
	searchMenu,
} from "./wakaba.js";

function createClient(): HttpClient {
	return new HttpClient(
		fetch,
		process.env.OUJ_TRACE ? (line) => console.error(line) : undefined,
	);
}

async function fetchTable(
	credentials: Credentials,
	name: MenuName,
	query: SearchQuery | undefined,
) {
	const client = createClient();
	const home = await login(client, credentials);
	const menuPage = await openMenu(client, home, name);
	const page = query
		? await searchMenu(client, menuPage, name, query)
		: menuPage;
	return MENUS[name].parse(page.body);
}

const cacheHome = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");

process.exitCode = await run(process.argv.slice(2), {
	env: process.env,
	store: new LocalStore(join(cacheHome, "ouj")),
	fetchTable,
	doctor: (credentials, name) => checkMenu(createClient(), credentials, name),
	stdout: (text) => process.stdout.write(text),
	stderr: (text) => process.stderr.write(text),
});
