# 框资源设计

框管理对标现有模板管理，分成两份资源。标注工作副本只给插件编辑。运行时副本是发布后的位置表：插件的框管理和 `self.pos` 补全读它。游戏进程要等业务项目的 `ScreenPosition` 加载这份文件之后才会用到它；ok 框架现在的模板匹配仍然只读 `template_matching.coco_feature_json`。图片、画布和显隐不另起一套。

本文是实现依据。ok-neverness-to-everness（下称 ok-nte）里的真实调用是 `self.pos.screen.main_viewport.to_box()`，不是 `self.pos.main_viewport`，也没有 `screen_pos`。

## 1. 现有能力

工具箱有两条已经分开的模板线。

| | 标注资源 | 运行时资源 |
|---|---|---|
| 文件 | `<templates.directory>/coco_annotations.json`，默认目录 `ok_templates` | `config.py` 的 `template_matching.coco_feature_json`，缺省探测 `assets/coco_annotations.json` 与 `ok_tasks/assets/coco_annotations.json` |
| 谁读写 | 标注管理（素材面板） | 模板画廊、补全、Hover；ok 框架做模板匹配 |
| 如何过去 | 显式「导出到 assets」。编辑不会自动写运行时文件 | |

标注编辑器（`AnnotationDialog` / `media/annotationPanel`）已有选择、拖动、八向缩放、增删、缩放、平移、撤销、复制粘贴和跨图导航。内存模型是像素 `xywh`。落盘是 COCO `bbox`。`NormalizedBox` 只服务坐标复制，不落盘，也不是 ok-script 的 `Box`。

编辑器此前没有标注列表，也没有显隐。隐藏和删除是同一件事。

模板画廊只读运行时 COCO。单击插入 `fL.<名称>`。区域预览是原图加像素 bbox 的动态裁剪，缓存键是图片内容哈希加 bbox。Quick Documentation 和 Hover 使用同一张裁剪图。JetBrains 查找项右侧是尺寸；VS Code 在补全项 resolve 时把图放进 documentation。

本仓库没有业务上的 Point 资源，也没有位置表。

## 2. ok-nte 的 pos / Box

位置表在 `src/scene/`，手写 Python。

- `self.pos` 是 `PositionMap`，在 `BaseNTETask` 里创建。
- `self.pos.screen` 是矩形。目前有 `center`、`dialog_icon`、`main_viewport`，四个数是相对整屏的 `(left, top, right, bottom)`。
- `self.pos.panels.*` 是点击点，两个数，用 `*self.pos.panels.esc.mail` 解包。两点调用 `to_box()` 会抛错。
- `ScreenRatio.to_box()` 调用 `box_of_screen(..., hcenter=True)`，按当前采集帧换成像素 `ok.Box`。`hcenter` 发生在调用时，不能写进资源。
- `Box.name` 由描述符写成 `ScreenPosition.<字段>`，只用于调试。查找区域不按这个名字匹配。
- 约 73 处任务私有 `box_of_screen(...)` 明确不进位置表。框资源不收编它们。
- 运行时不依赖 IDE 插件。

## 3. 两份框资源

| | 模板 | 框 |
|---|---|---|
| 标注资源 | `<模板目录>/coco_annotations.json` | `<模板目录>/boxes.json` |
| 运行时资源 | `templates.cocoAnnotations` → `config.py` → 探测 | `boxes.runtime` → `config.py` 的 `boxes_json` → 探测 `src/scene/boxes.json` |
| 编辑入口 | 标注管理 | 框资源管理 |
| 浏览 / 补全 | 模板管理 | 框管理 |
| 从标注到运行时 | 显式导出 | 显式发布 |

游戏加载器不读 `ok-script-toolkit.json`。插件索引运行时文件时，约定优先于 `config.py`，与模板相同。ok-nte 两处都不写时，两边都用 `src/scene/boxes.json`。

`panels` 前缀留给现有点击点。框路径不得占用。

## 4. 数据模型

标注资源带着原图与尺寸（version 2，与模板标注同一套 Pixel 模型）：

```json
{
  "version": 2,
  "images": [
    { "file": "12.png", "width": 1920, "height": 1080 }
  ],
  "boxes": [
    { "path": "screen.main_viewport", "image": "12.png", "bbox": [184, 112, 1544, 853] }
  ]
}
```

运行时资源只有归一化几何（version 1 不变）。`to_box()` 不需要图片：

```json
{
  "version": 1,
  "boxes": [
    {
      "path": "screen.main_viewport",
      "rect": [0.095833, 0.103704, 0.900000, 0.893519]
    }
  ]
}
```

约定：

- `path` 是 `self.pos.` 后面的属性路径。至少两段，每段是 Python 标识符。`screen.main_viewport` 对应 `self.pos.screen.main_viewport`。路径规则只有一份（`boxResourcePure.boxPathError`），webview 的即时校验用它随 `config` 下发的同一份文法。
- `bbox` 是 `[x, y, w, h]` 像素框，与模板 COCO 的 `bbox` 同形：整数、宽高 ≥ 1、完整落在原图 `width × height` 内。编辑、保存、校验全程 Pixel，不出现 normalized。
- `images` 登记每张被引用原图的尺寸；保存框时按图片头登记 / 刷新，发布和预览都从这张表取尺寸。
- 序列化：authoring 整数像素、按 `path` 排序；runtime 按矩形 6 位小数输出。改一个框时 diff 停在那个对象。
- `image` 是模板目录下的文件名，用现有文件名归一化规则对齐。不复制图片，不把裁剪 PNG 写进仓库。
- 参照图必须是整屏截图。`assets/images` 里的打包裁切块不能当框的原图。
- `to_box()` 的调试名由 path 推导：`screen` 下的叶子写成 `ScreenPosition.<叶子>`。它不是主键。

发布把 Pixel authoring 投影成 normalized runtime —— 这是唯一的归一化入口：

```text
left   = x / width
top    = y / height
right  = (x + w) / width
bottom = (y + h) / height
```

发布是整份快照：标注里删掉的框，发布后从运行时消失；若会删掉运行时已有 path，先确认。读不出尺寸的框不发布并明确报告。编辑器保存只写标注资源。

旧 normalized `boxes.json`（version 1）只允许作为迁移入口存在：读取时按图片尺寸（COCO 记录 → 图片头）转成 Pixel 并写回 version 2；读不出尺寸的框被丢弃并报告，半迁移不写回。迁移逻辑不进编辑、保存与读取主流程。

## 5. 图片与编辑器

框引用标注管理正在用的同一批原图。框资源管理不导入图片、不截图入库、不打包导出。

不新写画布。编辑器会话只认识图片和 `id + 标签 + 像素 xywh`。模板适配器的标签是分类名，保存仍写 COCO。框适配器的标签是 path，打开时直接用 authoring 的 Pixel bbox，写回时仍按像素保存 —— 打开后直接保存不会改文件。

从标注生成框：选中的像素标注直接做 Pixel union（最小包围矩形）写入 authoring，中途不做归一化；合法性（是否越界）按图片头尺寸校验。

图片交换：同尺寸只换所属图片；尺寸不同按比例映射（复用模板标注交换的 `annotationSwapPure`，映射后钳制进目标边界），确认框里说明缩放。

## 6. 显隐

显隐是编辑器会话状态，按条目标记记在隐藏集合里。不进 COCO，不进两份框文件，不进撤销栈。

标注列表始终列出全部条目。画布和命中测试只使用未隐藏的条目。

| 操作 | 行为 |
|---|---|
| 显示全部 | 清空隐藏集合 |
| 隐藏全部 | 隐藏当前图上每一条 |
| 只显示当前 | 只留选中项 |
| 勾选 | 逐条改隐藏集合 |

每张图一份隐藏集合，留在本次编辑会话里。关掉对话框就丢。新图默认全部显示。模板、框、点共用这一个过滤。

## 7. 预览、补全、生成

框管理对标模板管理：每个 box path 一张**bbox 裁剪后的资源缩略图**（标注管理 ↔ 框资源管理是原图缩略图；模板管理 ↔ 框管理是裁剪缩略图）。裁剪、内容哈希缓存、异步批量生成与失败处理复用模板那条管线，不另造预览系统。补全只索引运行时资源。插入文本是 `self.pos.screen.main_viewport.to_box()`。另给一个只复制属性路径的动作。

预览图不进运行时文件。用 path 回查标注资源拿 `image` 和 Pixel bbox；运行时独有的 path 才退回 normalized → Pixel（Runtime Preview 转换层）。复用模板的裁剪缓存，缓存键仍然是内容哈希加像素 bbox，框一改就自然失效。对不上原图时，文档只显示 path。

文档内容沿用模板：裁剪图、表达式、path、归一化 rect、原图相对路径。JetBrains 可以加一行短坐标 inlay；VS Code 不加，与「模板不做幽灵注释」一致。

单个模板生成框：选中的像素标注直接做 Pixel union，默认 path 建议 `screen.<分类名>`，已存在（任何图占用）则要求换名。多个模板生成包围框只允许同一张原图：

```text
left   = min(x)
top    = min(y)
right  = max(x + w)
bottom = max(y + h)

bbox = [left, top, right - left, bottom - top]
```

生成结果是普通框，进入标注资源，发布后才进入运行时。

## 8. 运行时加载

加载放在业务项目的 `ScreenPosition`，不放进插件，也不改 `ok.Box`。

`ScreenRatio` 只有 `__get__`。实例上的同名属性会盖住类描述符。JSON 里有的名字用 JSON；没有的名字仍走手写类属性。`to_box()` 继续调用 `box_of_screen(..., hcenter=True)`。

现有三个矩形可以一次性导入标注资源并绑定整屏原图。发布前手写属性继续有效，插件的框管理和补全只认运行时 JSON。

## 9. 模块

| 位置 | 职责 |
|---|---|
| `src/boxResourcePure.ts` 与 `core/BoxResource.kt` | 路径、矩形、发布、显隐。两端语义一致 |
| `core/BoxRuntimePath.kt` 与纯模块中的路径函数 | 运行时文件取值链，对标 `CocoFeaturePath` |
| `schemas/ok-script-toolkit.schema.json` 的 `boxes.runtime` | 约定文件。没有个人偏好层 |
| `python/probe_window_config.py` 的 `boxes_json` | 从 `config.py` 顶层读出运行时路径 |
| 标注编辑器两侧 | 标注列表和显隐 |
| 后续：框资源管理、框管理、补全、从模板生成 | 按第 10 节往下接，复用上面的契约 |

## 10. 实施顺序

1. 数据契约、路径解析、编辑器显隐。
2. 框资源管理：按原图浏览，用现有编辑器改标注资源。
3. 发布到运行时文件。
4. 框管理卡片和文档预览。
5. `self.pos` 的补全与 Hover。
6. 单模板生成框、同图多模板包围框。
7. ok-nte 的 `ScreenPosition` 加载器。三个矩形确认无误后，再手工去掉对应类属性。

## 11. 风险

- 编辑器改造不能改变模板标注的保存结果。显隐默认全显，撤销不含显隐。
- 打开即保存不得改写未移动框的浮点。
- 框若标在裁切块上，归一化结果不是屏幕比例。
- JSON 与类属性同名时以 JSON 为准。导入并发布后，应在业务项目里删掉对应手写属性，避免两处各改各的。
- 插件不得把 `hcenter` 算进 `rect`。
