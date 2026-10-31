# ouj-cli

放送大学システムWAKABAの情報を、読み取り専用で取得するCLIです。申請や投稿などの送信操作は実装していません。

## 注意事項

本ツールは非公式のツールです。放送大学および放送大学学園とは関係がなく、両者の承認を受けたものでもありません。

- 利用は自己責任でお願いします。本ツールの利用によって生じた損害や、学則・規程上の不利益について、作者は責任を負いません。
- 利用前に、学則、放送大学学園情報セキュリティポリシーなどの規定をご自身で確認してください。本ツールの公開は、規定に適合することを保証するものではありません。
- 自分のアカウントだけで使ってください。IDとパスワードを他者に教えることや、他者に利用させることは、学生用ガイドラインで禁止されています。
- 連続実行や定期実行など、システムに負荷をかける使い方はしないでください。

## 使い方

```bash
npm install
npm run build

export OUJ_USERNAME="ログインID"
export OUJ_PASSWORD="$(op item get 項目名 --vault 保管庫名 --fields password --reveal)"
```

次のうち必要なコマンドを1つだけ実行してください。

```bash
node dist/cli.js grades       # 履修成績
node dist/cli.js contacts     # 未読の学内連絡の一覧
node dist/cli.js files        # 授業共有ファイルの一覧
node dist/cli.js schedule     # 今週のスケジュール（9:00〜21:00）
node dist/cli.js class-contacts                           # 今学期の授業連絡の一覧
node dist/cli.js class-contacts --year 2026 --term 1      # 指定した学期の授業連絡の一覧
node dist/cli.js exam-timetable --year 2026 --term 2      # 単位認定試験時間割（--type all|broadcast|online）
node dist/cli.js syllabus --year 2026 --term 2 --name 心理学  # シラバスを1科目（複数該当時は --code で指定）
node dist/cli.js contact --id 1234  # 学内連絡の本文を1件（--id は contacts の連絡ID。開くと既読になり、contacts の一覧から消えます）
node dist/cli.js file --id 0   # 授業共有ファイルの詳細を1件（--id は files の番号。ファイル本体は取得しません）
node dist/cli.js doctor       # 接続と学内連絡の表の形式だけを確認（個人情報は出力しない）
node dist/cli.js doctor grades  # 確認する1画面を指定する
node dist/cli.js --help       # コマンド、出力形式、終了コードを表示（通信しない）
node dist/cli.js cache-clear  # 保存した一覧を消す（通信しない）
```

一覧のコマンドには次のオプションを指定できます。

```bash
node dist/cli.js contacts --limit 5
node dist/cli.js grades --fields 科目名,評語  # 列名は結果の fields で確認できます
node dist/cli.js grades --refresh             # キャッシュを使わず取得します
```

結果は `{ source, fetchedAt, fields, total, rows }` のJSONで標準出力へ書き出します。失敗時は `{ error: { code, message, hint } }` のJSONを標準エラーへ書き出し、種類ごとの終了コードを返します。

## 保存するデータ

サーバーへのログイン回数を減らすため、次のファイルを `$XDG_CACHE_HOME/ouj`（未設定の場合は `~/.cache/ouj`）に保存します。ファイルは暗号化しませんが、所有者だけが読める権限で作成します。

| ファイル     | 内容                                         | 用途                                                                                |
| ------------ | -------------------------------------------- | ----------------------------------------------------------------------------------- |
| `data/`      | 取得した一覧（成績などの個人情報を含みます） | 1時間以内の同じ一覧の取得では通信しません。期限切れの一覧は次回の実行時に削除します |
| `last-login` | 最後にログインを始めた時刻                   | 60秒以内の再ログインを通信前に拒否します                                            |

パスワードとセッションは保存しません。期限切れの一覧は `ouj` を実行するまで残ります。共有のコンピュータでは、使用後に `cache-clear` を実行してください。ログアウトは行いません。

## エージェントからの利用

[skills/ouj/SKILL.md](skills/ouj/SKILL.md) に、エージェント向けの手順と守るべき制限を記載しています。

## ライセンス

[MIT License](LICENSE)
