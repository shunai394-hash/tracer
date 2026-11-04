# MoneyPrinterTurbo ローカル動画スタジオ

TRACER本体の24時間AIライブ販売機能とは独立した、Windows向けのローカル動画編集ワーカーです。公式MoneyPrinterTurbo 1.3.9のCLIを呼び出します。

## できること

- 日本語台本を使ったEdge TTSナレーション（APIキー不要）
- アップロードした動画・画像の順番どおりの編集（ローカル素材モード）
- Pexelsの無料ストック映像を検索キーワード順に取得して編集（Pexelsモード）
- 9:16 / 16:9 / 1:1 のMP4出力
- 日本語字幕、手持ちBGM、画像のズーム演出
- 完成MP4のプレビューと保存
- 制作履歴と失敗状態をローカルに保存

## この版では行わないこと

- 文章から新しい動画クリップを生成すること
- Pixabay / Coverr などのオンライン素材検索
- Seedance / MiniMax / WaveSpeed / OFox / MuAPI 等の外部動画生成API
- 有料音楽・効果音APIの呼び出し
- TikTok / Instagram / YouTubeへの自動投稿

Pexelsモードは、無料のストック映像を検索して台本に合わせて編集します。文章から新しい映像を生成する機能ではありません。Pexelsモードには既存のPexels APIキーが必要です。キーはチャットに貼らず、ローカル画面へ入力してください。キーはこのPCの専用 `config.toml` に保存されます。Pexelsの素材・APIは無料ですが、デフォルトで1時間200リクエスト、月20,000リクエストの制限があります。Pexelsと撮影者のクレジット表示も確認してください。

手持ち素材モードは外部素材APIを使いません。どちらのモードも、台本だけからAI映像を生成するものではありません。新規のAI映像クリップには別の動画生成モデルと、それを実行できるGPUまたは計算環境が必要です。MoneyPrinterTurbo本体は動画生成モデルそのものではありません。

Edge TTSはAPIキー不要ですが、音声を作るときはインターネット接続が必要です。完全オフラインではありません。

## PCを重くせずにクラウドで1本作る

このリポジトリには、GitHub ActionsでMPTを1回だけ起動し、完成MP4を短期間の成果物として受け取る手動ワークフローもあります。

1. GitHubのリポジトリ設定で `Settings → Secrets and variables → Actions → New repository secret` を開き、名前を `PEXELS_API_KEY` にして既存のPexels APIキーを保存します。キーはチャットやソースコードに貼りません。
2. GitHubの `Actions → MoneyPrinterTurbo cloud video → Run workflow` を開き、タイトル、台本、シーン検索キーワード、比率、カット秒数を入力して実行します。
3. 成功したら同じ実行画面の `Artifacts` から `moneyprinterturbo-video` を取得します。成果物は3日で期限切れになります。

この方法はGitHubの標準クラウド実行環境で動画を編集するので、PCにはMPTのPython環境やFFmpegを常駐させません。実行時だけPexelsから素材を取得し、Edge TTSでナレーションを作ります。常時サーバーは作りません。

Pexels APIは無料ですが、既定の上限は1時間200リクエスト・月20,000リクエストです。新規APIキー発行は現在一時停止中のため、既存キーが必要です。<Link>などを使わず、公式案内を直接確認してください: https://help.pexels.com/hc/en-us/articles/47677890260761-Is-the-Pexels-API-free-to-use 、 https://help.pexels.com/hc/en-us/articles/900004904026-How-do-I-get-an-API-key

GitHubの標準ランナーは公開リポジトリでは無料ですが、Freeアカウントの成果物ストレージは500MBです。成果物を3日で削除する設定にしているのは、その容量を圧迫しないためです。大きなMP4を何本も連続保存する用途には向きません。

## Windowsでの起動

このリポジトリをPCにクローンし、リポジトリのルートでPowerShellを開きます。

\`\`\`powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-mpt-local-studio.ps1
\`\`\`

初回はPython 3.11以上の専用仮想環境を作り、公式PyPIパッケージ \`mpt==1.3.9\` をインストールします。インストール済みなら同じ仮想環境を再利用します。MoneyPrinterTurboの設定・生成物は次の専用フォルダに置き、別のMPTインストール設定は上書きしません。

- 実行環境: \`%LOCALAPPDATA%\TRACER\MoneyPrinterTurbo\`
- 設定・生成物: \`%LOCALAPPDATA%\TRACER\MPTStudioData\`

起動後、ブラウザで \`http://127.0.0.1:8765\` が開きます。停止はPowerShellで \`Ctrl+C\` です。別ポートを使う場合：

\`\`\`powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-mpt-local-studio.ps1 -Port 8766
\`\`\`

## 素材と完成ファイル

ローカル素材モードはMP4 / MOV / AVI / MKV / WEBM、画像はJPG / PNG / BMP / WEBPに対応します。Pexelsモードは1〜12個のシーン検索キーワードを受け取り、順番にストック映像を検索します。BGMはMP3 / WAV / M4A / AAC / FLAC / OGGです。

- 素材: 1〜8ファイル、1ファイル60MB以下、アップロード合計180MB以下
- 台本: 12,000文字以下
- 同時制作: 1件
- 1カットの最大長: 1〜15秒
- 完成MP4: \`%LOCALAPPDATA%\TRACER\MPTStudioData\storage\tasks\<task-id>\`

## 安全設定

- サーバーは \`127.0.0.1\` だけで待ち受けます。LANやインターネットには公開しません。
- UIの送信元OriginとHostを検査し、外部サイトからのPOSTを拒否します。
- \`MPT_HOME\` を専用ディレクトリに固定します。
- 起動時にMPT自動投稿が有効なら停止します。
- CLIには常に \`--video-source local\` を渡し、環境変数に残った外部動画APIキーも子プロセスから除外します。
- SNS自動投稿は無効です。完成動画は人が確認してから投稿してください。

## トラブルシューティング

- Pythonが見つからない: Python 3.11以上をインストールして、PowerShellを開き直します。
- CLIセルフチェック失敗: インストール先の \`.venv\` を削除する前に、エラー全文を確認します。既存のMPTデータフォルダは削除しないでください。
- 素材が小さすぎる: MPTの素材処理に通る解像度の動画・画像に差し替えます。
- Pexels検索に失敗する: 保存済みAPIキーの有効性とPexelsの利用制限を確認します。キーワードは英語の短い場面描写も試してください。
- 音声が生成できない: Edge TTSへのネットワーク接続を確認します。APIキーは不要です。
- MP4ができない: ローカル制作画面のエラーと \`%LOCALAPPDATA%\TRACER\MPTStudioData\studio\logs\` の該当タスクログを確認します。

## ライセンス

MoneyPrinterTurboはMITライセンスです。使用する映像・画像・BGM・音声の権利と各プラットフォームのAIコンテンツ表示ルールは、投稿前に別途確認してください。
