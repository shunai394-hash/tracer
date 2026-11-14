# OBS Studio でのローカル受信手順

この手順は、常駐ワーカーの映像と音声を自分の PC の中だけで OBS Studio に表示するためのものです。YouTube と TikTok には接続しません。公開配信、PR のマージ、本番デプロイは行いません。`publicBroadcast` は false のままです。

FFmpeg 同士の受信テストは OBS Studio の再生確認にはしないでください。`scripts/test-ai-live-loopback-rtmp.mjs` と `scripts/test-ai-live-obs-loopback.mjs` は、どちらも FFmpeg が受けたファイルの検査です。

## ワーカーが出すもの

| 出力 | 内容 |
| --- | --- |
| `introduction.mp4` | 常に書く。H.264、AAC 48 kHz、fragmented MP4 |
| `TRACER_AI_LIVE_OBS_LOOPBACK_URL` | 任意。`rtmp://127.0.0.1:<port>/<path>` または `localhost` だけ。同じ映像と音声を FLV で送る |

ポートは URL に明示します。ユーザー名、パスワード、クエリは拒否します。すべてのネットワークインターフェース、YouTube、TikTok、その他のホストは拒否し、そのときは FFmpeg を起動しません。

BGM の基準は 35% です。発話が続いている間だけ約 400 ms で比率 0.18 まで下がり、発話が終わると 35% に戻ります。フルスケールより小さい実音声では、下がり方が 0.18 より浅くなることがあります。

## OBS 側の受け方

OBS Studio は配信先へ送り出す側であり、RTMP の待受サーバーではありません。ワーカーが `rtmp://127.0.0.1` へ送っても、OBS の「配信」設定では受け取れません。

受け方は次の順です。

1. このリポジトリの中継を `127.0.0.1` だけで起動する。中継はワーカーからの RTMP を受け、同じマシンの HTTP で HLS を配る。
2. OBS のソースに「メディアソース」を追加する。
3. 「ローカルファイル」のチェックを外す。
4. 入力に中継が表示した `http://127.0.0.1:<http-port>/index.m3u8` を入れる。
5. 「ソースがアクティブになったときに再生を再開する」をオンにする。
6. ハードウェアデコードで映らないときは、それをオフにして再度確認する。

入力欄に YouTube や TikTok の URL は入れません。OBS の配信設定も触りません。

## Windows での手順

PowerShell で、リポジトリのルートをカレントにします。トークンの値は画面やログに残さないでください。

1. OBS Studio の起動確認。次のファイルが無ければ、ここで止めて映像と音声は未確認とします。

```powershell
Test-Path "$env:ProgramFiles\obs-studio\bin\64bit\obs64.exe"
```

2. 見つかったときだけ OBS Studio を起動します。配信ボタンは押しません。

3. 中継を起動します。表示された `rtmpUrl` と `hlsUrl` のホストが `127.0.0.1` であることを確認します。

```powershell
node scripts/ai-live-obs-local-relay.mjs --rtmp-port 1935 --http-port 8788 --directory $env:TEMP\tracer-obs-relay
```

4. 別の PowerShell でワーカーを起動します。商品事実はローカルの読み取り専用スタブを使い、本番の商品・注文・販売データは変更しません。`TRACER_AI_LIVE_OBS_LOOPBACK_URL` は手順 3 の `rtmpUrl` と同じにします。

```powershell
$env:TRACER_AI_LIVE_STATE_DIR = "$env:TEMP\tracer-ai-live-obs"
$env:TRACER_AI_LIVE_PORT = "8787"
$env:TRACER_AI_LIVE_ADMIN_TOKEN = "<local-admin-token>"
$env:TRACER_AI_LIVE_PRODUCTS_URL = "http://127.0.0.1:<catalog-port>/products"
$env:TRACER_AI_LIVE_PRODUCTS_TOKEN = "<local-products-token>"
$env:TRACER_AI_LIVE_AVATAR_VIDEO = "<avatar.mp4>"
$env:TRACER_AI_LIVE_BGM_PATH = "<bgm.wav>"
$env:TRACER_AI_LIVE_SPEECH_PATH = "<speech.wav>"
$env:TRACER_AI_LIVE_OBS_LOOPBACK_URL = "rtmp://127.0.0.1:1935/live/obs"
node --experimental-strip-types --no-warnings worker/ai-live-resident.mjs
```

5. 商品事実が一致する `/start` のあと、`/health` が `live` かつ `mediaReady: true`、`publicBroadcast: false` になることを確認します。不一致の開始は 409 で、`introduction.mp4` を新しく作ってはいけません。

6. OBS のメディアソースに `hlsUrl` を入れる。再接続の待ち時間は 0 にする。プレビューに映像が出ること、音声ミキサーが振れることを見ます。配信は入力の速度で進むため、発話の区間は早送りされません。

7. スピーカーから音が出る状態にして、発話の前、発話中、発話の後、2 回目の発話で、BGM が下がり、また戻ることを人が耳で確認します。録画の音量は自動測定です。その数値を、人が聞き取れたことの合否にはしません。

8. ワーカーへ `/stop` を送ります。OBS の映像と音声が止まることを確認します。中継は Ctrl+C で止めます。

9. FFmpeg が異常終了したときは `/health` の `state` が `live` でないことを確認します。OBS に映像が残り続けないことも見ます。

YouTube の URL を `TRACER_AI_LIVE_OBS_LOOPBACK_URL` に入れた開始は `media_output_rejected` になり、セッションは `failed` です。

## この環境での結果（2026-11-13）

`C:\Program Files\obs-studio\bin\64bit\obs64.exe`（OBS Studio 33.0.1）を起動し、配信ボタンは押していません。メディアソースのローカルファイルはオフ、入力は `http://127.0.0.1` の HLS、再接続の待ち時間は 0 です。`publicBroadcast` は false でした。YouTube と TikTok には接続していません。

実音声は、2026-11-09 に保存されていた Fish Audio の mp3 です。ffprobe のメタデータに fish.audio があり、長さは約 12.7 秒で、無音の区切りが複数あります。新しい合成リクエストは出していません。先頭に無音を足し、BGM は既存の楽曲ファイルを使いました。OBS の同じ `TRACER local HLS` を映したまま、映像出力のプロセスだけを終了させました。

OBS の録画の全帯域は、発話前が -22.1 dB から -25.1 dB、発話中が -13.5 dB、-15.7 dB、-15.0 dB、-16.7 dB、発話後が -22.7 dB から -24.8 dB でした。低域 70–140 Hz は、発話前 -28.0 dB、1 回目の発話中 -28.4 dB（比 約 0.95）、2 回目 -30.2 dB（比 約 0.78）、その後 -26.7 dB から -29.6 dB です。実音声と楽曲の帯域が重なるため、BGM だけを 0.18 として分離してはいません。0.35 と 0.18 は変更していません。

同じソースのまま映像出力を落とすと、ワーカーは `failed`、`media_exited` で、`live` ではありませんでした。中継プロセスはその後終了しました。OBS のウィンドウはプレビューが黒で、`TRACER local HLS` のミキサーは下端でした。API のメディア状態は `OBS_MEDIA_STATE_PLAYING` のままです。ウィンドウを見る直前のシーン画像にはテストパターンが残っていました。

| 項目 | 自動測定 | 人による確認 |
| --- | --- | --- |
| OBS Studio の起動 | 33.0.1 を起動した | 未確認 |
| 映像 | シーンにテストパターンが出た | 未確認 |
| 音声 | 録画に楽曲と実音声のレベル変化がある | 未確認 |
| BGM の低下と復帰 | 上の dB。低域の比は約 0.95 と約 0.78 | 未確認 |
| 異常終了後の画面 | ウィンドウのプレビューは黒。API は PLAYING | 未確認 |
| セッションが live のまま残るか | `failed` / `media_exited` | 未確認 |

CI の実行環境に OBS Studio は無いため、そこでの実機表示は未確認です。FFmpeg 同士の受信テストは、この表の OBS の行には使いません。
