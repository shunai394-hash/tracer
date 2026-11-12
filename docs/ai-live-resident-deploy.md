# AIライブ常駐ワーカーの配備

この手順は常駐プロセス用です。Vercel Functions の中では長時間処理も FFmpeg も動かしません。この文書を置いただけでは本番配備にも実配信にもなっていません。

## 動かす場所

- 常駐先は別の仮想マシン、またはこのリポジトリの `worker/Dockerfile` から作ったコンテナです。
- プロセスは `127.0.0.1` だけを待ち受けます。YouTube と TikTok は、未承認でも承認済みでも、この改訂では外部ソケットを開きません。
- 状態ディレクトリは `/var/lib/tracer-ai-live` です。Dockerfile はこの場所を `node` ユーザーが書き込めるように作成し、`TRACER_AI_LIVE_STATE_DIR` の既定値に設定します。
- 永続ボリュームを `/var/lib/tracer-ai-live` にマウントしてください。ホストの bind mount を使う場合は、ホスト側ディレクトリを UID/GID `1000:1000`（コンテナ内 `node`）所有にしてから起動します。状態ディレクトリを一時領域に置くと、再起動後の状態・ロック管理が不安定になります。

## イメージ

リポジトリのルートで実行します。

```bash
docker build -f worker/Dockerfile -t tracer-ai-live-worker .
```

イメージには FFmpeg を入れます。Next.js のビルド成果物は入れません。コンテナは非 root の `node` ユーザーで起動します。

## メディア素材

アバター動画と BGM はイメージに焼き込まず、読み取り専用ボリュームとしてコンテナにマウントします。コンテナ内の例は `/opt/tracer-ai-live/media/avatar.mp4` と `/opt/tracer-ai-live/media/bgm.mp3` です。`node` ユーザーが読み取れる権限を付けてください。

- `TRACER_AI_LIVE_AVATAR_VIDEO=/opt/tracer-ai-live/media/avatar.mp4`
- `TRACER_AI_LIVE_BGM_PATH=/opt/tracer-ai-live/media/bgm.mp3`
- Fish Audio の登録済み音声IDを使う場合は `FISH_AUDIO_API_KEY` をシークレット注入し、セッションの `voiceId` を指定します。
- 音声ファイルを使う場合は `TRACER_AI_LIVE_SPEECH_PATH` にコンテナ内の読み取り可能なファイルパスを指定します。

素材ファイルはこのリポジトリには含まれません。実際のファイルをマウントし、存在と読み取り権限を確認してから開始してください。

## 秘密情報

制御用トークンは次のどちらかです。両方あるときは環境変数を使います。

- 環境変数 `TRACER_AI_LIVE_ADMIN_TOKEN`
- Secret Manager のリソース名 `TRACER_AI_LIVE_ADMIN_SECRET`（`projects/<project>/secrets/<name>/versions/latest`）。取得用のアクセストークンは `TRACER_AI_LIVE_SECRET_ACCESS_TOKEN`、または同一VMのメタデータサーバ（`TRACER_AI_LIVE_SECRET_METADATA=1`）です。

商品事実の読み取り先は `TRACER_AI_LIVE_PRODUCTS_URL`（`GET /api/admin/ai-live/products`）と、その読み取り専用トークン `TRACER_AI_LIVE_PRODUCTS_TOKEN` です。ワーカーはこのURLへ GET 以外を送りません。

`FISH_AUDIO_API_KEY`、管理トークン、商品APIトークンは Secret Manager などから実行時に注入します。値を Dockerfile、イメージ、Git、起動引数に書かないでください。トークン、ストリームキー、RTMP URL、Fish Audio の API キーは、ログ、`state.json`、`/health`、`/ready`、エラー応答に出してはいけません。

## 起動例

```bash
export TRACER_AI_LIVE_PORT=8787
export TRACER_AI_LIVE_PRODUCTS_URL=https://<tracer-host>/api/admin/ai-live/products
export TRACER_AI_LIVE_PRODUCTS_TOKEN
export TRACER_AI_LIVE_ADMIN_TOKEN
export TRACER_AI_LIVE_AVATAR_VIDEO=/opt/tracer-ai-live/media/avatar.mp4
export TRACER_AI_LIVE_BGM_PATH=/opt/tracer-ai-live/media/bgm.mp3
export FISH_AUDIO_API_KEY
node --experimental-strip-types --no-warnings worker/ai-live-resident.mjs
```

コンテナでは環境変数をシークレット機構から渡し、状態ディレクトリを永続ボリュームにします。メディア素材は読み取り専用でマウントします。待受はコンテナ内の `127.0.0.1` です。公開ポートへは出しません。Docker の `-p` でポートを公開しないでください。監視プロセスを置く場合もコンテナ内から loopback にアクセスさせます。

## 監視

- `GET /health` はプロセスが応答できるかを見ます。セッションが停止していても 200 です。応答にはプロセス、セッション状態、商品事実、配信先の承認状態を分けて入れます。
- `GET /ready` は、loopback セッションで商品事実が有効かつメディアが実際に稼働中のときだけ 200 です。待機中、開始処理中、素材不足、FFmpeg 未稼働、事実の不一致、セッション失敗では 503 です。プロセスの生存確認には `/health` を使います。
- 商品確認URLが未設定なら開始は拒否されます。検証を省略して成功にする設定はありません。
- `POST /start`、`POST /stop`、`POST /reconnect`、`POST /shutdown` は `Authorization: Bearer` が一致しないと動きません。

## 配信先

`TRACER_AI_LIVE_PRODUCTS_URL` が無い、商品 API の認証失敗、タイムアウト、取得失敗、価格・在庫・仕入先指紋の不一致、更新日時の期限切れでは `/start` を拒否します。検証できない状態では Fish Audio も FFmpeg も起動しません。

YouTube と TikTok は、承認フラグと Secret が揃っていても、配信アダプターの実装と明示的な開始条件が揃うまでソケットを開きません。この改訂ではそのアダプターは未実装です。`publicBroadcast` は false のままです。実配信は行っていません。

## 音声と映像

BGM の基準音量は 35%、ダッキング比率は 0.18 のままです。商品検証が終わるまでセッションは live になりません。登録済みの Fish Audio 音声か音声ファイル、BGM、アバター映像が揃い、FFmpeg が出力を始めて稼働しているときだけ live かつ ready です。素材が無い開始は `media_unavailable` で拒否します。最大稼働時間、停止、再起動では、その子プロセスを終了します。

## 停止

`POST /stop` または `SIGTERM` でセッションと子プロセスを止め、ロックを消します。最大稼働時間に達したときも状態を変えるだけで終わらせず、処理と子プロセスを止めます。
