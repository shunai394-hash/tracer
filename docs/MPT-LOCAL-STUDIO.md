# MoneyPrinterTurbo ローカル動画スタジオ

TRACER本体の24時間AIライブ販売機能とは独立した、Windows向けのローカル動画編集ワーカーです。公式MoneyPrinterTurbo 1.3.9のCLIを呼び出します。

## できること

- 日本語台本を使ったEdge TTSナレーション（APIキー不要）
- アップロードした動画・画像の順番どおりの編集
- 9:16 / 16:9 / 1:1 のMP4出力
- 日本語字幕、手持ちBGM、画像のズーム演出
- 完成MP4のプレビューと保存
- 制作履歴と失敗状態をローカルに保存

## この版では行わないこと

- 文章から新しい動画クリップを生成すること
- Pexels / Pixabay / Coverr などのオンライン素材検索
- Seedance / MiniMax / WaveSpeed / OFox / MuAPI 等の外部動画生成API
- 有料音楽・効果音APIの呼び出し
- TikTok / Instagram / YouTubeへの自動投稿

この版の「無料」は、外部の動画生成APIを呼ばず、ユーザーが用意した映像・画像をローカル編集する意味です。台本だけからAI映像を生成するには、別途ローカルで動かせる動画生成モデルと、それを実行できるGPUまたは計算環境が必要です。MoneyPrinterTurbo本体は動画生成モデルそのものではありません。

Edge TTSはAPIキー不要ですが、音声を作るときはインターネット接続が必要です。完全オフラインではありません。

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

映像素材はMP4 / MOV / AVI / MKV / WEBM、画像素材はJPG / PNG / BMP / WEBPに対応します。BGMはMP3 / WAV / M4A / AAC / FLAC / OGGです。

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
- 音声が生成できない: Edge TTSへのネットワーク接続を確認します。APIキーは不要です。
- MP4ができない: ローカル制作画面のエラーと \`%LOCALAPPDATA%\TRACER\MPTStudioData\studio\logs\` の該当タスクログを確認します。

## ライセンス

MoneyPrinterTurboはMITライセンスです。使用する映像・画像・BGM・音声の権利と各プラットフォームのAIコンテンツ表示ルールは、投稿前に別途確認してください。
