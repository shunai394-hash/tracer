# AIライブ常駐ワーカーの配備

この手順は常駐プロセス用です。Vercel Functions の中では長時間処理も FFmpeg も動かしません。この文書を置いただけでは本番配備にも実配信にもなっていません。

## 動かす場所

- 常駐先は別の仮想マシン、またはこのリポジトリの `worker/Dockerfile` から作ったコンテナです。
- プロセスは `127.0.0.1` だけを待ち受けます。YouTube と TikTok の未承認時に外部ソケットは開きません。
- `TRACER_AI_LIVE_STATE_DIR` はリポジトリの外に取り、ワーカーのユーザーだけが読み書きできるようにします。

## イメージ

リポジトリのルートで実行します。

```bash
docker build -f worker/Dockerfile -t tracer-ai-live-worker .
```

イメージには FFmpeg を入れます。Next.js のビルド成果物は入れません。

## 秘密情報

制御用トークンは次のどちらかです。両方あるときは環境変数を使います。

- 環境変数 `TRACER_AI_LIVE_ADMIN_TOKEN`
- Secret Manager のリソース名 `TRACER_AI_LIVE_ADMIN_SECRET`（`projects/<project>/secrets/<name>/versions/latest`）。取得用のアクセストークンは `TRACER_AI_LIVE_SECRET_ACCESS_TOKEN`、または同一VMのメタデータサーバ（`TRACER_AI_LIVE_SECRET_METADATA=1`）です。

商品事実の読み取り先は `TRACER_AI_LIVE_PRODUCTS_URL`（`GET /api/admin/ai-live/products`）と、その読み取り専用トークン `TRACER_AI_LIVE_PRODUCTS_TOKEN` です。ワーカーはこのURLへ GET 以外を送りません。

トークン、ストリームキー、RTMP URL、Fish Audio の API キーは、ログ、`state.json`、`/health`、`/ready`、エラー応答に出してはいけません。

## 起動例

```bash
export TRACER_AI_LIVE_STATE_DIR=/var/lib/tracer-ai-live
export TRACER_AI_LIVE_PORT=8787
export TRACER_AI_LIVE_ADMIN_TOKEN
node --experimental-strip-types --no-warnings worker/ai-live-resident.mjs
```

コンテナでは同じ環境変数を渡し、状態ディレクトリをボリュームにします。待受はコンテナ内の `127.0.0.1` です。公開ポートへは出しません。

## 監視

- `GET /health` はプロセスが応答できるかを見ます。セッションが停止していても 200 です。応答にはプロセス、セッション状態、商品事実、配信先の承認状態を分けて入れます。
- `GET /ready` は、待受中か、loopback で商品事実が有効なときだけ 200 です。事実が未設定・古い・不一致、配信先が未承認、セッションが失敗、のときは 503 です。
- 商品確認URLが未設定なら開始は拒否されます。`TRACER_AI_LIVE_ALLOW_UNVERIFIED_LOOPBACK=1` は隔離されたローカル試験専用で、本番環境には設定しないでください。
- `POST /start`、`POST /stop`、`POST /reconnect`、`POST /shutdown` は `Authorization: Bearer` が一致しないと動きません。

## 配信先

YouTube は `TRACER_AI_LIVE_YOUTUBE_APPROVED=approved` かつ有効な `YOUTUBE_RTMP_URL` と `YOUTUBE_STREAM_KEY` が揃うまで、TikTok は `TRACER_AI_LIVE_TIKTOK_APPROVED=approved` かつ有効な `TIKTOK_RTMP_URL` と `TIKTOK_STREAM_KEY` が揃うまで、ソケットを開きません。承認フラグだけでは足りません。このワーカーは、その条件を満たしても配信セッションを live にはしません。実配信は別途の承認後の作業です。

## 音声と映像

BGM の基準音量は 35%、ダッキング比率は 0.18 のままです。登録済みの Fish Audio 音声 ID、BGM、アバター映像がファイルとしてあるときだけ FFmpeg を起動します。最大稼働時間、停止、再起動では、その子プロセスを終了します。

## 停止

`POST /stop` または `SIGTERM` でセッションと子プロセスを止め、ロックを消します。最大稼働時間に達したときも状態を変えるだけで終わらせず、処理と子プロセスを止めます。
