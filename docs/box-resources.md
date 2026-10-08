# 位置资源契约（Rect / Point）

[简体中文](box-resources.md) | [English](box-resources.en.md)

2026-10-08 按当前本地实现复核。两端使用统一标注管理和资源预览，本文说明当前数据与操作契约。完整入口及验证状态见 [功能对齐表](feature-parity.md)。

## 工作文件与发布文件

| 资源 | 工作文件 | 发布结果 | 预览与引用来源 |
|---|---|---|---|
| Template | `<templates.directory>/coco_annotations.json` | `assets` 或 `ok_tasks/assets` 的图片与 COCO 库，可生成枚举 | `templates.cocoAnnotations` 解析的运行时模板库 |
| Rect | `<templates.directory>/boxes.json` | 统一 Position JSON 或 Python 输出 | 当前 Rect 工作标注 |
| Point | `<templates.directory>/points.json` | 与 Rect 合并为同一份 Position 输出 | 当前 Point 工作标注 |

工作目录默认 `ok_templates`。三类标注共用原图；导入、截图和临时截图发送只增加图片，不为未编辑图片创建标注记录。图片编号同时避开三份工作文件中已登记的名称，包括原图已丢失的记录。

当前 Schema 不包含旧的 `boxes.runtime`，发布链不读取 `config.py` 的 `boxes_json`。业务项目负责加载发布文件并建立 `self.pos`；插件不修改业务加载器、不迁移旧业务位置表。

## COCO 标注与名称

三份工作文件均使用 `images`、`annotations`、`categories` 三表。名称存于 `categories.name`，标注通过 `image_id`、`category_id` 关联原图与名称。

| 类型 | `annotations.bbox` | 校验 |
|---|---|---|
| Template / Rect | `[x, y, w, h]` 像素矩形 | 正宽高，完整位于原图内 |
| Point | `[x, y, 0, 0]` 像素点 | 零宽高，点位于原图边界内 |

Rect / Point 名称至少包含两个由句点分隔的 Python 标识符，例如 `screen.main_viewport`、`panels.esc.mail`。拒绝 Python 关键字、生成器保留成员和双下划线成员；不为某个业务项目保留 `panels` 或其他普通前缀。

名称在各资源类型内唯一。Rect 与 Point 可以在编辑阶段各有同名标注；发布到一份 Position 表时会报告重名和父子路径冲突，避免一个属性同时承载两种值。

旧的 `version` / `boxes`、`version` / `points` 工作格式不是当前资源契约，不在读取时自动迁移。损坏的当前源文件会显示错误并阻止发布和删除；显式编辑的恢复行为以标注器自己的保存语义为准。

## 标注管理

统一入口提供导入、截图、临时截图拖入、按文件名或 Template 分类搜索、编辑、查看原图、交换 Template 标注、删除和发布。交换保持两端现有 Template 操作范围；Rect / Point 可在统一编辑器中修改。

交换不同尺寸原图的 Template 标注时按比例映射并钳制边界，确认前显示尺寸和标注数量；保存前核对源标注与图片尺寸是否变化。

删除原图时清理该图在三份工作文件中的记录和标注，保留其他图片及同名不同扩展名的记录。读取失败停止删除；后续写入失败时恢复图片和已修改的工作文件。此操作不删除已发布的运行时资源，后续显式发布才更新运行时库。

内部保存、导入和外部文件变更进入统一刷新通道。打开的编辑会话保留当前编辑，核对外部修改与冲突；冲突未解决时不覆盖源文件。管理列表和缩略图刷新使用同一份当前模型，并拒绝过期的异步回调。

两端标注均在编辑器页签内操作，完成创建、编辑、拖动、删除、撤销或重做后立即保存工作文件；保存不等于发布。JetBrains 保存失败时显示错误与重试入口，并保留插件草稿供重新打开后恢复及合并外部修改。

## 资源预览与代码引用

侧栏和宽屏预览均可切换 Template / Rect / Point，并按名称或表达式搜索。卡片使用当前实际图片和 bbox；Point 显示点附近的有限上下文。

| 模式 | 插入和复制的表达式 |
|---|---|
| Template | `<当前模板别名>.<模板名>`，未配置时默认 `fL` |
| Rect | `self.pos.<路径>.to_box()` |
| Point | `self.pos.<路径>` |

单击插入，双击复制；按钮提供相同动作和带位置提示的原图查看。没有 Python 编辑器时复制引用并说明原因。Template 预览不会用尚未发布的工作标注填充运行时库；Rect / Point 提示跟随当前工作标注，编辑后不需要先发布才能得到代码提示。

两端 `Ctrl+Alt+T` 打开资源预览，`Ctrl+Alt+S` 截图到标注管理；macOS 使用相应的 `Cmd+Alt` 组合。发布入口位于标注管理，资源预览不提供另一个发布链。

## 统一发布

先选择 Template / Rect / Point，再完成所选资源的配置。全部配置与取消决定发生在写盘前；位置拒绝覆盖或发布失败后不继续写模板。模板仍使用已有打包与枚举生成链，覆盖已有枚举前核对类名变化和项目引用。

Position JSON 默认 `src/scene/positions.json`；Python 默认目录 `src/scene`，生成 `ScreenRatio.py` 和 `PositionMap.py`。路径优先级为个人 IDE 偏好 → `ok-script-toolkit.json` 的 `position.jsonPath` / `position.pythonDirectory` → 默认值。发布配置可查看来源、修改路径及清除个人覆盖；留空表示恢复项目约定。

拒绝绝对路径、越界路径、项目根目录本身及越界符号链接。已有手写 Python 文件和自定义 JSON 目标需要明确覆盖确认；生成文件的再次发布沿用既有覆盖规则。空位置集合和无效源文件不覆盖已有发布结果。一次发布所选 Rect / Point 的完整快照；只选其中一种时，在写入前说明未选类型将从该 Position 输出移除。

JSON 输出契约：

```json
{
  "version": 2,
  "positions": [
    { "path": "panels.esc.mail", "coordinates": [0.25, 0.5] },
    { "path": "screen.main_viewport", "coordinates": [0.1, 0.2, 0.9, 0.8] }
  ]
}
```

点归一化为 `[x / width, y / height]`；矩形归一化为 `[x / width, y / height, (x+w) / width, (y+h) / height]`。按路径排序，保留六位小数；工作文件仍存像素。应使用实际采集的整屏作为位置参照图，运行时屏幕适配由业务项目执行。

## 实现与验证入口

| 职责 | VS Code | JetBrains |
|---|---|---|
| 标注与会话同步 | `annotationPanel.ts`、`annotationMerge.ts` | `UnifiedAnnotationUi.kt`、`AnnotationSessionSync.kt` |
| Rect / Point 工作数据 | `boxResourceStore.ts`、`pointResourceStore.ts` | `BoxCatalogService.kt`、`PointCatalogService.kt` |
| 原图管理和统一发布 | `templateAssetPanel.ts`、`templateAssetData.ts` | `UnifiedPublishToolWindows.kt`、`TemplatePublishFlow.kt` |
| 资源卡片 | `templatePanel.ts` | `PreviewCardToolWindows.kt` |
| Position 契约与发布 | `positionResourcePure.ts`、`positionPublishStore.ts` | `PositionResource.kt`、`PositionPublisherService.kt`、`PositionPublishTargets.kt` |

几何、坐标、冲突合并、覆盖保护、写入回滚、图片名预留、删除与界面引用契约均有自动测试。真实 IDE、截图与业务项目运行验收状态单独记录在功能对齐表，自动测试不代表游戏已加载发布文件。
