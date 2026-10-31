/**
 * 呼び出し元が分岐に使えるエラーの種類と終了コードを定める。
 * サーバー負荷を上げないため、どの種類も自動再試行を勧めず、次の行動を hint で示す。
 */

export const EXIT_CODES = {
	UNEXPECTED: 1,
	USAGE: 2,
	AUTH: 4,
	SITE_CHANGED: 5,
	NETWORK: 6,
	COOLDOWN: 7,
	CACHE_CORRUPT: 8,
} as const;

export type ErrorCode = keyof typeof EXIT_CODES;

const HINTS: Record<ErrorCode, string> = {
	UNEXPECTED: "再実行せず、エラー内容を利用者に報告してください。",
	USAGE: "`ouj --help` で正しいコマンドとオプションを確認してください。",
	AUTH: "再実行せず、OUJ_USERNAME と OUJ_PASSWORD の確認を利用者に依頼してください。",
	SITE_CHANGED:
		"メンテナンス中か、画面の形式が変わった可能性があります。再実行せず、利用者に報告してください。",
	NETWORK:
		"自動で再試行せず、利用者に報告してください。再実行は利用者の判断に任せてください。",
	COOLDOWN:
		"サーバー負荷を避けるための制限です。繰り返し実行せず、必要な場合だけ retryAfterSeconds 秒以上待ってから1回実行してください。",
	CACHE_CORRUPT:
		"`ouj cache-clear` で保存データを消してください。last-login または last-login.lock が原因の場合は、利用者にファイルの確認を依頼してください。",
};

export class OujError extends Error {
	/**
	 * @param code 呼び出し元が分岐に使う種類
	 * @param message 利用者向けの説明。パスワードや URL 内のセッション情報を含めないこと
	 * @param retryAfterSeconds COOLDOWN のときに、次に実行できるまでの秒数
	 */
	constructor(
		readonly code: ErrorCode,
		message: string,
		readonly retryAfterSeconds?: number,
	) {
		super(message);
		this.name = "OujError";
	}
}

/** エラーを、標準エラーへ書く JSON と終了コードに変換する */
export function describeFailure(error: unknown): {
	json: string;
	exitCode: number;
} {
	const failure =
		error instanceof OujError
			? error
			: new OujError(
					"UNEXPECTED",
					error instanceof Error ? error.message : String(error),
				);
	return {
		json: JSON.stringify({
			error: {
				code: failure.code,
				message: failure.message,
				hint: HINTS[failure.code],
				retryAfterSeconds: failure.retryAfterSeconds,
			},
		}),
		exitCode: EXIT_CODES[failure.code],
	};
}
