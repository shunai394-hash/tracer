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

BGM の基準音量は 35% です。発話が聞こえている間だけ 0.18 の比率まで約 400ms で滑らかに下げ、発話が終わると同じ速さで 35% に戻します。発話が複数回あるときはその都度繰り返します。固定の下げっぱなしは使いません。商品検証が終わるまでセッションは live になりません。登録済みの Fish Audio 音声か音声ファイル、BGM、アバター映像が揃い、FFmpeg が出力を始めて稼働しているときだけ live かつ ready です。素材が無い開始は `media_unavailable` で拒否します。最大稼働時間、停止、再起動では、その子プロセスを終了します。

ローカルの MP4 は残します。`TRACER_AI_LIVE_OBS_LOOPBACK_URL` があるときだけ、同じ映像と音声をもう一本、127.0.0.1 または localhost の RTMP に出します。OBS Studio 自体はその URL の待受にはなりません。再生手順は `docs/ai-live-obs-studio-local.md` です。それ以外のホスト、ユーザー情報付きの URL、YouTube、TikTok は拒否し、FFmpeg を起動しません。外部公開はこの設定では行いません。

## 停止

`POST /stop` または `SIGTERM` でセッションと子プロセスを止め、ロックを消します。最大稼働時間に達したときも状態を変えるだけで終わらせず、処理と子プロセスを止めます。


### 実装済みのローカル連続出力と検証範囲

- resident worker はアバター映像をループし、BGM を常時ミックスしながら、音声の発話区間に合わせてサイドチェインで BGM を下げ、発話後に戻します。音声入力は `apad` で継続するため、FFmpeg は短い紹介音声の終了だけでは停止しません。
- `TRACER_AI_LIVE_OBS_LOOPBACK_URL` を指定すると、ローカル MP4 の生成と並行して、同じ映像・音声を localhost/127.0.0.1 の RTMP 受信先へ送ります。URL はループバック以外を拒否します。
- CI の `Test OBS loopback ingest and speech ducking` は、実際の resident worker を起動し、localhost RTMP 受信、音声のダッキングと復帰、異常終了時の fail-closed を検証します。受信側は FFmpeg です。
- CI の `Test actual loopback RTMP publish and receive` は別途、合成テスト素材による FFmpeg の RTMP 往復を検証します。
- これらはローカル統合テストです。FFmpeg 同士の受信テストは OBS Studio の再生確認にはしないでください。OBS の手順と未確認項目は `docs/ai-live-obs-studio-local.md` にあります。Docker イメージを永続ホストへ配備した結果や、YouTube/TikTok への外部配信を証明するものではありません。

YouTube/TikTok の外部配信アダプターは引き続き未実装で、外部ソケットは開きません。`publicBroadcast` は false のままです。Docker build と永続ホストでの起動・監視、OBS 実機での受信確認は別途必要です。
