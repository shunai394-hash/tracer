# BEAUTY FORMULA 広告 — 新しいセッションで再開するための手順

このフォルダには、15秒広告の現行版（v1：支給写真ベース、ナレーション・BGM・字幕入り）と、
Higgsfieldで実写風のカットを生成して差し替える（v2）ための材料が入っている。

## 0. 再開前にユーザー側で設定すること

1. **Network access（環境設定 → Edit）** で、許可するドメインに次の2つを追加する。
   - `upload.higgsfield.ai`（商品画像・開始フレームのアップロード先）
   - `d2ol7oe51mr4n9.cloudfront.net`（生成した動画の取得元）
2. **Higgsfield の接続**（https://claude.ai/customize/connectors ）で、生成ができる「Higgsfield」コネクタに
   Plusアカウント（@mid_centuryraccoon2364）でログインした状態にする。
   前回のセッションでは、Plusプラン・1210クレジットであることを確認済み。
3. 上の設定を終えてから **新しいセッション** を開始し、このブランチ `claude/beautiful-mendel-0epj8v` で作業する。

## 1. 新しいセッションで最初に確認すること

```bash
for u in https://upload.higgsfield.ai https://d2ol7oe51mr4n9.cloudfront.net/; do curl -sS -o /dev/null -m 15 -w "$u %{http_code}\n" $u; done
```
- どちらも `000`（CONNECT 403）が返る場合は、まだ許可されていない。ユーザーに設定を依頼し、ここで止める。
- Higgsfield の `balance` でプランと残高を確認する（Plus、残高200クレジット以上あること）。

## 2. 予算と見積もり（上限 200クレジット・ユーザー承認済み）

見積もりは、前回のセッションで `get_cost` を実行して得た値（テキストのみ・9:16で見積もったもの）。
画像を入力すると価格が変わる可能性があるため、**各生成の直前に、同じ設定で `get_cost` を実行して再見積もりする**。
使用済みと予定の合計が200クレジットを超えそうな場合は、**生成を始めずにユーザーに確認する**。

| # | カット | モデル／設定 | 1回あたり | 最大試行 | 最大消費 |
|---|---|---|---|---|---|
| T | パッケージのテスト（合格すれば商品カットとしても使う） | `kling3_0` mode=pro, 5秒, 9:16, sound=off, start_image=`assets/higgsfield_start_frames/start_package_9x16.png` | 8.75 | 2 | 17.5 |
| 1 | チョコレートのシズル | `kling3_0` pro, 5秒, 9:16, sound=off, start_image=`start_chocolate_9x16.png` | 8.75 | 3 | 26.25 |
| 2 | 40代前後の女性の飲用シーン（パッケージは映さない） | `seedance_2_0` mode=std, 720p, 5秒, 9:16, generate_audio=false, テキストのみ | 22.5 | 3 | 67.5 |
| 3 | 商品パッケージの美しいカット（Tが合格すれば流用し、生成しない） | `kling3_0` pro, 5秒, start_image=`start_package_9x16.png` | 8.75 | 3 | 26.25 |
| | **合計** | 各1回で済んだ場合 48.75 ／ 撮り直しの上限まで使った場合 | | | **137.5** |

参考（実測）：Seedance 2.0 の1080p・5秒は60クレジット、Kling 3.0 Turbo の720p・5秒は7.5クレジット。

## 3. 生成プロンプト

- **T／3：パッケージ**
  "The exact pink stand-up pouch from the start frame stays perfectly still and unchanged on a soft ivory-to-blush background. Only the light moves: a slow, gentle glossy reflection glides across the pouch, very slow subtle camera push-in. Keep the pouch shape, colors, the 'BEAUTY FORMULA' logo and every label element exactly as in the start frame. No new text, no redesign, no deformation. Premium beauty commercial lighting."
- **1：チョコレート**
  "Macro close-up of broken dark chocolate pieces, slow cinematic camera glide, a few cocoa crumbs gently falling, soft warm window light, rich glossy texture, shallow depth of field, premium food commercial, smooth slow motion."
- **2：飲用シーン**
  "A Japanese woman in her mid-40s in a bright, clean modern kitchen with soft morning light, elegant natural look, calmly lifts a clear glass of smooth chocolate drink and takes a small sip, relaxed genuine expression, subtle natural movement, realistic hands and fingers, no exaggerated smile, no text, premium lifestyle commercial, 9:16 vertical."

## 4. 合格の基準（各カットを目視で確認する）

- パッケージ：形状・色・「BEAUTY FORMULA」のロゴ・ラベル文字が開始フレームと一致していること。変形・文字化け・再デザインがあれば不合格（`ffmpeg` で0.5秒ごとにフレームを抜き出して確認する）。
- 人物：手・指・口元・飲む動作が自然であること。商品パッケージが写り込んでいないこと。
- チョコレート：質感が自然でおいしそうであること。
- 合格したら `show_generation_by_ids` でユーザーに見せる。

## 5. 編集（v2の構成）

| 時間 | 映像 | 字幕・ナレーション（v1と同じ） |
|---|---|---|
| 0〜3秒 | カット1 チョコレート | 自分をいたわる、毎日の新習慣。 |
| 3〜7秒 | カットT／3 パッケージ | BEAUTY FORMULA ／ チョコレート風味 |
| 7〜11秒 | カット2 女性の飲用 | おいしく楽しむ、私のためのひととき。 |
| 11〜15秒 | `render.py` のエンドカード（パッケージ＋「チョコレート風味｜300g」＋「商品詳細はこちら」） | 毎日に、心地よい一杯を。 |

- 音声は `deliverables/audio/beauty_formula_final_mix.wav`（ナレーション・BGM・ダッキング済み、-14 LUFS）をそのまま使う。
- 字幕の描画は `work/render.py` の `draw_caption`／`cta_button` を流用する（フォントは `setup.sh` で取得）。
- 書き出し：1080×1920、30fps、H.264（crf 16）、AAC 192k。出力ファイル名は `beauty_formula_protein_ad_9x16_v2.mp4`。
- 確認：`ffmpeg -v error -i X -f null -` でデコードエラーがないこと、`ebur128` で音量、`work/asr_check.py` でナレーションの文字起こし、0.5秒ごとのフレームを目視。

## 6. ファイルの構成

- `deliverables/` — v1の完成品（9:16／16:9／字幕なしマスター）、音声の各ファイル、`PRODUCTION_NOTES.md`
- `assets/source_images/` — 支給された商品画像（元ファイル）
- `assets/higgsfield_start_frames/` — Higgsfieldの image-to-video に使う開始フレーム（1080×1920）
- `work/` — `render.py`（映像）、`bgm.py`（BGM）、`tts.py`（ナレーション）、`mix.sh`（ミックス）、`asr_check.py`（文字起こしでの照合）、`make_cutout.py`（パッケージの切り抜き）、元画像
- `setup.sh <scratch>` — コミットしていないもの（フォント・TTSモデル・ASRモデル）を取得し直す

APIキーなどの秘密情報は含めていない。Higgsfieldの認証はClaudeのコネクタ側で管理されている。
