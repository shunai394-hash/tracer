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

7. 発話の前、発話中、発話の後、2 回目の発話で、BGM が下がり、また戻ることを耳で確認します。

8. ワーカーへ `/stop` を送ります。OBS の映像と音声が止まることを確認します。中継は Ctrl+C で止めます。

9. FFmpeg が異常終了したときは `/health` の `state` が `live` でないことを確認します。OBS に映像が残り続けないことも見ます。

YouTube の URL を `TRACER_AI_LIVE_OBS_LOOPBACK_URL` に入れた開始は `media_output_rejected` になり、セッションは `failed` です。

## この環境での結果（2026-11-13）

`C:\Program Files\obs-studio\bin\64bit\obs64.exe`（OBS Studio 33.0.1）を起動し、配信ボタンは押していません。メディアソースのローカルファイルはオフ、入力は `http://127.0.0.1` の HLS、再接続の待ち時間は 0 です。`publicBroadcast` は false でした。YouTube と TikTok には接続していません。

シーンの取り込みでは、色帯のテストパターンが表示されました。ワーカー停止のあと、メディア状態は `OBS_MEDIA_STATE_ENDED` になり、シーンは黒になりました。中継は、送り元が切れるとプレイリストを終端にして待受を閉じます。

OBS が録画したプログラム出力を測ると、発話前の BGM は -18.3 dB でした。1 回目の発話中は -33.5 dB まで下がり、発話後は -18.3 dB に戻りました。2 回目も -33.5 dB まで下がり、再び -18.3 dB に戻りました。発話帯域は発話中だけ -6.6 dB で、それ以外は出ていません。低下の比率は約 0.17 です。スピーカーの前で耳を使った確認は未確認です。

| 項目 | 結果 |
| --- | --- |
| OBS Studio の起動 | 確認。33.0.1 を起動した |
| OBS に映像が表示される | 確認。シーンにテストパターンが出た |
| OBS で音声が再生される | 確認。OBS の録画に BGM と発話がある。耳での確認は未確認 |
| 発話前の BGM、発話中の低下、終了後の復帰、2 回目 | 確認。-18.3 dB から -33.5 dB へ下がり、2 回とも -18.3 dB に戻った |
| 停止後に OBS の再生が止まる | 確認。メディアは ENDED、シーンは黒 |
| 異常終了の瞬間に OBS へ映像が残るか | 未確認。別の中継先で試し、見ていたソースは切り替えていない |
| ワーカーが異常終了後も `live` のまま残らない | 確認。状態は failed、`media_exited` |
| 商品事実の失敗で出力を始めない | 確認。`product_facts_mismatch` で映像ファイルは作られなかった |
| 127.0.0.1 の中継が HLS を配る | 中継の自動試験は OBS の再生ではない。上の行は OBS の画面と録画で見ている |

CI の実行環境に OBS Studio は無いため、そこでの実機表示は未確認です。FFmpeg 同士の受信テストは、この表の OBS の行には使いません。
