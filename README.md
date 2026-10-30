# ouj-cli

放送大学システムWAKABAの情報を、読み取り専用で取得するCLIです。申請や投稿などの送信操作は実装していません。

## 使い方

```bash
npm install
npm run build

export OUJ_USERNAME="ログインID"
export OUJ_PASSWORD="$(op item get 項目名 --vault 保管庫名 --fields password --reveal)"

node dist/cli.js doctor    # 接続と表の形式だけを確認（個人情報は出力しない）
node dist/cli.js grades    # 履修成績
node dist/cli.js contacts  # 学内連絡の一覧
node dist/cli.js files     # 授業共有ファイルの一覧
```

結果はJSONで標準出力へ書き出します。実行のたびにログインし、セッションの保存とログアウトは行いません。
