# BEAUTY FORMULA チョコレート風味 15秒広告 — 制作メモ

## 1. 納品ファイル

| ファイル | 内容 | 仕様 |
|---|---|---|
| beauty_formula_protein_ad_9x16.mp4 | 縦型・字幕あり・ナレーション＋BGM | 1080×1920 / 30fps / H.264 / AAC 48kHz ステレオ / 15.000秒 |
| beauty_formula_protein_ad_16x9.mp4 | 横型・字幕あり・ナレーション＋BGM | 1920×1080 / 30fps / H.264 / AAC 48kHz ステレオ / 15.000秒 |
| beauty_formula_protein_master.mp4 | 縦型・字幕やテキストなしのマスター（音声はナレーション＋BGM） | 1080×1920 / 30fps / 15.000秒 |
| audio/beauty_formula_narration_jp.wav | ナレーションのみ（タイミング配置済み・15秒） | 48kHz ステレオ / -16 LUFS |
| audio/narration_line1〜4.wav | ナレーション各行の単体ファイル | 24kHz モノラル |
| audio/beauty_formula_bgm.wav | BGMのみ（15秒） | 48kHz ステレオ |
| audio/beauty_formula_final_mix.wav | 最終ミックス（BGMダッキング済み） | 48kHz ステレオ / -14.3 LUFS / ピーク -3.0 dBFS |

## 2. ナレーション台本と配置

| 区間 | 台本 | 音声の位置（実測） | 画面の字幕 |
|---|---|---|---|
| 0〜3秒 | 自分をいたわる、毎日の新習慣。 | 0.25〜2.99秒 | 自分をいたわる、／毎日の新習慣。 |
| 3〜7秒 | BEAUTY FORMULA、チョコレート風味。 | 3.68〜6.12秒 | BEAUTY FORMULA ／ チョコレート風味 |
| 7〜11秒 | おいしく楽しむ、私のためのひととき。 | 7.68〜10.67秒 | おいしく楽しむ、／私のためのひととき。 |
| 11〜15秒 | 毎日に、心地よい一杯を。 | 11.64〜13.83秒 | 毎日に、心地よい一杯を。→ エンドカード |

- 音声合成エンジン：Kokoro-82M（ONNX版 `kokoro-onnx`、`kokoro-v1.0.onnx`）。日本語の女性音声 `jf_alpha` を0.87倍速で使用。読みの変換には `misaki[ja]` を使用。
- 誤読を防ぐため、TTSにはかなで入力した：「私」→「わたし」（初期設定では「わたくし」と読んだ）、「一杯」→「いっぱい」（初期設定では「いちばい」と読んだ）、「BEAUTY FORMULA」→「ビューティーフォーミュラ」。
- 音声処理：80Hzハイパス、3.5kHz付近を+2dBして明瞭度を補正、軽いコンプレッション、-16 LUFSに正規化。
- BGMとのバランス：BGMを-9dBに下げたうえで、ナレーションをキーにしたサイドチェインコンプでダッキング（ratio 6）。最終的にリミッターをかけ、-14 LUFSにラウドネスを正規化。

## 3. 構成（タイムライン）

| 時間 | 映像 | 素材 |
|---|---|---|
| 0.0〜1.9秒 | 割れたチョコレートのクローズアップ（ゆっくり寄る） | 画像1の一部を切り出し |
| 1.6〜3.5秒 | チョコレートドリンクのクローズアップ（ゆっくりパン） | 画像1の一部を切り出し |
| 3.2〜7.6秒 | パッケージを中央に配置。アイボリー〜ピンクのグラデーション背景、柔らかい光の反射が横切る、ゆっくり寄る | 画像2の背景を切り抜き（パッケージ本体は無加工） |
| 7.3〜11.7秒 | パッケージとドリンクのライフスタイルカット（パッケージからドリンクへパン） | 画像1 |
| 11.4〜13.2秒 | パッケージ・ドリンク・チョコを1枚に収めた写真カード | 画像1全体 |
| 12.9〜15.0秒 | エンドカード：パッケージ、「BEAUTY FORMULA」「チョコレート風味｜300g」「商品詳細はこちら」 | 画像2の切り抜き |

- 横型の冒頭は、チョコとドリンクを左右に並べた分割画面（ラベルの細かい文字を大きく映さないため）。
- 購入URLは確認できていないため、URLやQRコードは入れていない。縦型エンドカードの下部（約25%）と横型の右下は、後から追加できるよう空けてある。
- 各カットの切り替えは0.3秒のクロスフェード。冒頭は0.4秒でアイボリーからフェードイン。

## 4. 使用した素材と権利

| 素材 | 出典 | 利用条件 |
|---|---|---|
| 商品画像1（ライフスタイル）・画像2（白背景パッケージ） | 依頼者からの支給 | 依頼者の素材。利用権は依頼者側での確認が必要 |
| フォント：Shippori Mincho、Noto Serif JP、Cormorant Garamond | Google Fonts（npmパッケージ `@expo-google-fonts/*` から取得） | SIL Open Font License 1.1（商用可） |
| BGM | 本制作のために `bgm.py` でゼロから合成したオリジナル曲（Fメジャー、約72BPMのピアノ＋パッド） | 第三者のサンプルを使っていないため権利上の制約なし |
| ナレーション音声 | Kokoro-82M（hexgrad）のモデルとボイス | Apache License 2.0（商用可） |

## 5. 「生成プロンプト」について

Higgsfieldでの生成はできなかった（6章を参照）。そのため、AIの画像生成・動画生成プロンプトは使っていない。映像は支給された写真をプログラムで切り出し、ズーム・パン・合成して作った（`render.py`）。今後Higgsfieldで生成できるようになったときのために、用意したプロンプト案を以下に残す。

- **5秒テスト（Seedance 2.0 Mini, 9:16, 480p, 音声なし, 画像2をimage_reference）**
  "The exact pink stand-up pouch from the reference image, centered on a soft ivory background with gentle pink light. Slow subtle dolly-in, soft reflections gliding across the glossy pouch. Keep the package shape, colors, logo 'BEAUTY FORMULA' and every label element exactly as in the reference. No text changes, no redesign. Calm, premium beauty commercial lighting."
- **チョコレートの演出**
  "Macro close-up of broken dark chocolate pieces and a smooth chocolate protein drink being gently poured into a clear glass, soft window light, warm tones, shallow depth of field, slow camera motion, premium food commercial."
- **飲用シーン**
  "A Japanese woman in her 40s in a bright, clean kitchen, natural relaxed expression, calmly sipping a chocolate drink from a clear glass, soft morning light, realistic hands, subtle natural movement, premium lifestyle commercial, no exaggerated smile."

## 6. エラーと未解決事項

1. **Higgsfieldでの動画生成：実施できなかった**
   - 接続：Higgsfield MCPには接続できた（ワークスペースはprivate、Freeプラン、残高10クレジット）。
   - 画像のアップロード先 `upload.higgsfield.ai` へのPUTが、このクラウド環境のネットワークポリシーで拒否された（CONNECT 403）。
   - 生成結果の配信先 `d2ol7oe51mr4n9.cloudfront.net` も同じく拒否されたため、生成できたとしても動画を取り込んで編集できない。
   - 事前に確認したコスト（get_costで実測）：Seedance 2.0 Mini 5秒/480p＝2.5cr、Grok Video 1.5 Lite 5秒/480p＝5cr、Kling 3.0 Turbo 5秒/720p＝7.5cr、Seedance 2.5 5秒/480p＝15cr、5秒/720p＝35cr、Marketing Studio 15秒/720p＝75cr。10クレジットではテスト1〜2本が限度で、全カットの生成には足りない。課金・追加購入は行っていない。
   - 追記：その後、HiggsfieldをPlusアカウント（残高1210クレジット）に接続し直した。ネットワークはまだ許可されていないため、生成は次のセッションで行う（`RESUME.md` を参照）。
   - 解決するには、環境設定のNetwork accessで `upload.higgsfield.ai` と `d2ol7oe51mr4n9.cloudfront.net` を許可する必要がある。全カットをAIで生成するなら、クレジットの追加（有料）も必要。
2. **Scene 3の「40代前後の女性が飲む」シーン：入っていない**
   - 人物の映像は支給素材になく、AI生成もできなかった。代わりに、パッケージとドリンクのライフスタイルカットを使った。人物カットを入れるには、上記1を解決してHiggsfield等で生成するか、実写素材を用意する必要がある。
3. **画像1のラベルの細かい文字**
   - 画像1では、ラベルの細かい文字（アイコン下の説明や「8種類の〜」の行）が元画像の段階で崩れている。画像2は鮮明。主役のカットとエンドカードには画像2を使い、画像1は引きの構図で使った。ライフスタイルカットでは、画像1のラベルが約1.5倍に拡大されて映る（商品名・ロゴは正常）。
4. **栄養成分の表示**
   - 16g・104kcal・300mg・8PN配合などは、実際の販売商品と照合できていない。そのため字幕やナレーションでは触れていない（パッケージ写真に写っているものだけ）。効果効能を断定する表現も使っていない。
5. **ナレーションの声質**
   - ローカルで動くオープンソースのTTSで合成したもの。人のナレーターやクラウドの高品質TTSに比べると、抑揚がやや平板になる可能性がある。テレビCM並みの品質が必要な場合は、プロのナレーター収録への差し替えを推奨する（`audio/beauty_formula_narration_jp.wav` と同じタイミングで差し替えれば済む構成にしてある）。

## 7. 再生確認の結果

- 3本ともffprobe／ffmpegで全フレームをデコードし、エラーは0件。尺は15.000秒、解像度・fps・コーデックは仕様どおり。
- 1秒以上の静止フレームは検出されなかった（freezedetect）。
- 音声：最終ミックスは -14.3 LUFS、トゥルーピーク -3.0 dBFS（クリッピングなし）。ナレーションの間（声が途切れている部分）もBGMが流れ続け、不自然な無音はない。
- ナレーションの聞き取り：完成MP4から取り出したBGM込みの音声を、日本語音声認識（sherpa-onnx + ReazonSpeech zipformer）で文字起こしして台本と照合した（結果は8章）。なお、Whisperはモデルの配布元がネットワークでブロックされていたため使えなかった。
- 修正：パッケージの切り抜き下端に、元画像の床の影が白いギザギザとして残っていた。色で判定する方法に切り抜きを変えて除去し（`work/make_cutout.py`）、3本とも再レンダリングした。再レンダリング後もデコードエラーは0件、尺は15.000秒（音声は変更なし）。
- 映像：0.5秒ごとのフレームを抜き出して目視確認した。字幕の文字切れや文字化け（「｜」が豆腐になっていた問題は修正済み）がないこと、パッケージに変形や改変がないことを確認した。

## 8. ナレーションの文字起こし照合

完成MP4（BGM込み）を区間ごとに音声認識した結果（縦型・横型とも同じ）：

| 区間 | 台本 | 認識結果 | 判定 |
|---|---|---|---|
| 0〜3秒 | 自分をいたわる、毎日の新習慣。 | 自分をいたわる毎日の新習慣 | 一致 |
| 3〜7秒 | BEAUTY FORMULA、チョコレート風味。 | ビューティーフォーミュラチョコレート風味 | 一致 |
| 7〜11秒 | おいしく楽しむ、私のためのひととき。 | おいしく楽しむ私のためのひととき | 一致 |
| 11〜15秒 | 毎日に、心地よい一杯を。 | 毎日に心地よい一杯を | 一致 |

→ BGMが流れている状態でも、ナレーションは最後まで機械で正確に聞き取れた。各行は担当カットの区間内に収まっている。

※ 自動テストの環境では音を実際に耳で聞けない。最終的な声質やトーンの好みは、人が試聴して判断する必要がある。
