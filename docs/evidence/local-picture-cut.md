# 两张本地图片 → 手写字幕片 → 只换第二幕

这次用 `test/harbour.mjs` 绘制的普通 PNG：清晨的港口、黄昏的港口，以及用于替换的夜渡图。它们是测试脚本落盘的独立图片，不是画布生成的标题卡，也没有使用私人照片。

## 从画布复跑

1. 从空画布点 **+ File**，分别选 `harbour-dawn.png` 和 `harbour-dusk.png`。两张新卡都能直接点到；旧版在这一步会把第二张卡叠在第一张下方。也可以一次多选。
2. 在 `plain` 文字卡写两行并点 **Make**。把文字卡和两张图依序拖到 `firstcut` 视频卡的标题栏连线，不连音频。影片卡显示 **Captions only (no audio)**。
3. 点 **Make**，用影片卡上的播放键看完。把 `night-ferry.png` 放到第二张图片卡上。影片卡的 `next` 会显示换过的图；这时旧片还没变。
4. 再点影片卡 **Make**，播放新版。点 **kept** 选回旧片；图片卡和连线仍留在原位。

在项目根目录，用已有的本机 Chromium 运行：

```bash
HYPERMAKER_CHROME=/path/to/chromium node test/story-captions-only.mjs --local-files
```

脚本会自己创建图片和隔离的空工作区。证据默认写入 `.tmp/story-local-pictures/`，可用 `STORY_OUT` 改位置。不带 `--local-files` 则复跑[本机标题卡流程](captions-only.md)。

## 验收结果

- 另从空画布通过文件选择器分别导入两张图。1440×970 与 800×720 下，上一发布版的卡片重叠，只有一张的标题栏能直接点到。新版的两张卡都在视口内、互不重叠，标题栏都能直接点到。整条制片路径在 1440×970 复验。

- 两次文件选择和一次换图都只向本机回环地址发请求；测试阻止非本地浏览器请求。未调用模型，没有可用语音引擎，也未访问真实视觉发现服务。
- 两版都是 1280×720、6 秒的 H.264 MP4，`ffprobe` 查到零音轨。两次都用画布播放器的播放键启动，浏览器报告 `ended: true`。
- 第一幕 0–3 秒，字幕为 “The harbour wakes before the sun.”；第二幕 3–6 秒，字幕为 “The last boat crosses as the lights come on.”。已逐字核对初版两幕和重切后的第二幕抽帧。
- 换图后，旧图成为保留版本，原片在重切前字节不变；重切后第一幕中点抽帧字节一致，第二幕抽帧不同，字幕和连线不变。恢复旧片后，哈希与初版一致，且新版仍可找回。
- `receipt.json` 记录画面匹配、播放和文件哈希；`first.mp4` 和 `recut.mp4` 可直接看，`canvas-first.png` 和 `canvas-restored.png` 展示实际画布。

有声流程另跑 `HYPERMAKER_CHROME=/path/to/chromium node test/story-own-materials.mjs`，从本地多选图片走到 8.04 秒 H.264/AAC MP4，Chromium 能播放；本轮没有由听众评估旁白可懂度。此轮图片实测用的是 PNG，不代表已验证 EXIF 旋转、HEIC 或画面十分相似的两张照片。
