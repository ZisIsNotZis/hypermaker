# 关掉服务和浏览器，再接着剪

## 从画布操作

1. 做出两版影片后，关掉页面、停止服务。下次从同一项目目录启动服务，再打开平常用的画布地址。如果上次指定过 `HYPERMAKER_WORKDIR`，启动时沿用同一个值；默认工作区不必指定。
2. 影片卡显示当前版号。点 **compare**，每栏的 **made from** 是那一版当时用的素材，不是现在连进影片卡的素材。本例中 `v2` 的第二幕是 `night-ferry.png`，`v1` 的第二幕是 `harbour-dusk.png`；第一幕都是 `harbour-dawn.png`。
3. 用对应栏的播放键看片；**Download v1** 或 **Download v2** 直接下载该栏的版本，不改变当前片。想把旧片放回画布再点 **Use v1 on canvas**。
4. 选回 `v1` 只切换影片，保留图片卡、草稿和连线。卡上的 **made from** 仍描述旧片，**next Generate uses** 提示下一次会用当前连着的夜渡图。修改第二句，再依次点文字卡和影片卡的 **Make**，就会得到 `v3`；`v1` 和 `v2` 仍可选。

## 复跑

```bash
HYPERMAKER_CHROME=/path/to/chromium node test/story-captions-only.mjs --local-files --restart
```

脚本创建自制 PNG 和隔离工作区，从 `/` 建两版，关闭 Chromium，等待原服务进程退出，再在同一端口、用同一工作区、不重置数据重启服务。新 Chromium 无旧标签页状态，从 `/` 重新打开。证据默认在 `.tmp/story-reopen/`，可用 `STORY_OUT` 另指定目录：

- `canvas-reopened.png`：直接出现当前 `v2`；`compare-reopened.png`：两栏各自的素材与下载、选用按钮。
- `film-v1.mp4`、`film-v2.mp4`：点击比对窗实际下载的文件，SHA-256 各自等于原导出，不会偷偷切换当前片。旧片用比对窗原生播放键播到 6 秒。
- `canvas-restored.png`：选用 `v1` 后回到画布；`canvas-continued.png`、`continued.mp4`：更新第二句后做出的 `v3`，仍用夜渡图、保留连线与前两版，原生播放器也自然播完。
- `receipt.json`：版本、文件哈希、字幕、素材和播放记录。核对由脚本完成；使用者不需要翻工作区文件。

同伴先独立复开旧界面，确认当前片和两版素材已正确保存，但看片后只能关掉比对窗、另找 `kept v1` 才能切换和下载。改动后，同伴独立复验了两栏分别播完、直接下载哈希一致、只有点选用才切换，以及继续编辑。桌面 Chromium、本机回环、自制素材；未调用模型或访问真实视觉发现服务。字幕和[有声片](local-picture-cut.md)的旧入口另行复跑。
