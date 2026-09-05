# ok-script Toolkit

VS Code 扩展，为 ok-script 项目的 Python 开发提供语言键、OCR 修正、模板和技能效果的数据提示，同时内置模板浏览、任务启动和角色技能管理面板，让 ok-script 的语言、OCR、模板、技能和任务数据直接进入开发流程。

## 功能

### 代码开发辅助

在编辑 Python 代码时，扩展自动识别 ok-script 特有的 API 上下文，提供精准的数据提示和补全：

- **`self.lang` 语言键**：输入 `self.lang.` 补全语言模块和语言键，补全详情和行内幽灵注释显示当前语言的值（`string` 类型用 `「值」`、`pattern` 类型用 `~值~` 标记），悬停可查看 `zh_CN`、`zh_TW`、`en_US`、`ja_JP`、`ko_KR`、`es_ES` 全部语言的值。
- **OCR 修正**：在 `ocr`、`wait_ocr`、`wait_click_ocr`、`find_boxes` 等函数的 `match` 参数处，悬停可查看正则 pattern 在 `ocr.po` 中的全部语言修正映射，行内显示修正后的值（如 `→ 体力[0-9]+`），引号内输入可补全 `ocr.po` 中的 key。
- **技能效果 ID**：悬停 `EffectType.XXX` 或 `"effect_id": "XXX"` 显示效果 ID、分类和中文描述，行内幽灵注释显示中文说明（如 `「敌人被施加寒冷元素」`），在 `effect_id: "` 的引号内输入可补全全部效果 ID，按分类展示。数据从 `src/data/effects.py` 自动解析，无需手动维护。

### 模板管理

- **模板面板**：通过侧边栏图标或 `Ctrl+Alt+T` 快捷键（需聚焦 Python 编辑器时生效）打开，网格展示工作区全部模板的缩略图，支持按名称实时搜索和过滤。
- **快速插入**：单击卡片将 `fL.<模板名>` 插入编辑器光标处，双击复制到剪贴板，点击缩略图打开来源原图。
- **模板代码提示**：输入 `fL.` 或 `FeatureList.` 补全模板名称并显示尺寸，悬停显示缩略图预览、尺寸和来源信息。
- 也可通过命令 **ok-script 工具箱: 在编辑器中打开模板面板** 在编辑器区打开更大的网格视图。
- 支持侧边栏（包含模板面板和模板素材两个视图）和编辑器大窗口两种浏览方式。

### 任务启动

- 从目标项目的 `src/config.py` / `config.py` 自动解析所有一次性任务和触发任务，生成完整的参数配置表单。
- 支持布尔、数字、文本、多行文本、下拉、多选、列表、项目级联下拉和结构化条件序列等多种参数类型。
- 任务名、说明、参数名和选项标签自动读取目标项目 i18n 翻译显示；支持递归可折叠的子任务配置树。
- 每个项目、每个任务独立保存参数覆盖，参数修改后自动保存，覆盖仅对启动的子进程生效，不写回目标项目配置文件。
- 可为单个任务设置自动停止超时，运行日志输出到专属输出频道。
- 任务运行中可随时暂停/恢复：卡片按钮在 ⏸ 暂停与 ▶ 恢复间切换，走 ok-script 框架的 executor 暂停机制（与 GUI 暂停按钮语义一致，任务可安全恢复，不影响计时统计）。

### 角色技能管理

执行命令 **ok-script 工具箱: 打开角色技能管理面板**，在编辑器区打开角色数据库总览：

- 按星级、元素、职业、技能类型、强化组和诊断状态筛选角色，查看角色基础信息、多语言名称、技能说明、倍率、失衡、冷却和技力等数据。
- 管理技能和强化组：添加、修改、删除自定义技能；为任意技能配置强化组的基础效果、触发条件和产出效果，均从效果定义中按类别多选。
- 效果索引：按效果分类汇总，并反向列出每个效果被哪些角色、技能和强化组引用；支持添加新的效果类别和效果定义。
- 名称本地化矩阵：横向比较全部 locale 的角色名称，突出显示缺失翻译。
- 数据诊断：检查角色主表与技能文件覆盖、重复技能 ID、未知效果 ID、强化声明不一致和缺失语言等问题，诊断结果可一键跳转到对应文件。
- 写入前自动生成备份，通过临时文件校验后原子替换源文件；源文件保存后面板自动刷新。

### 多语言支持

- 扩展界面（通知、输出频道、hover、模板面板、任务启动器、工具箱和角色技能管理面板）支持简体中文、繁体中文、英文、日文、韩文和西班牙文，默认跟随 VS Code 显示语言。
- 侧边栏分为 **ok-script 工具**（工具箱 + 任务启动）和 **ok-script 模板**（模板面板 + 模板素材）两个独立容器。
- 代码提示中的语言数据始终使用目标项目自身的 locale 和原始协议值，不受插件界面语言影响。

语言与模板提示只针对 `python` 文件生效；效果 ID 提示（hover、补全、幽灵注释）额外覆盖 `json` 和 `jsonc` 文件。扩展不修改源代码，也不生成存根文件。

## 数据来源

默认从当前工作区读取：

- `assets/lang/*.json`：语言数据，节点格式为 `{ "string": "..." }` 或 `{ "pattern": "..." }`。
- `i18n/<locale>/LC_MESSAGES/*.po`：gettext PO 数据（`okScriptToolkit.enablePoData` 控制，默认开启）。仅加载 `okScriptToolkit.poDomains` 白名单内的 domain（默认 `ocr`，排除 `ok.po` 等 UI 通用文案）。`msgid`（如 `借 款 金 额`、`体力.*`）作为 key，`msgstr` 作为对应语言的 `string` 值；含空格的 `msgid` 会自动生成去空格副本（`借款金额`）。该数据用于 OCR 函数 `match` 参数的提示，不作为 `self.lang` 模块。
- `assets/coco_annotations.json`：模板名称、原图和 `bbox`。
- `assets/images/*.png`：模板预览使用的原图。
- 如果存在，也会读取 `ok_tasks/assets/coco_annotations.json` 与 `ok_tasks/assets/images/*.png`。
- `src/data/effects.py`：技能效果 ID 数据源（`EffectType` 枚举 + `EFFECT_DESCRIPTIONS` 中文描述），用于 `EffectType.XXX` / `"effect_id": "XXX"` 的提示。
- `assets/lang/effect_names.json`：角色技能管理面板中的效果本地化名称；缺失时回退到效果描述和原始 ID。

保存 JSON（包括效果名称）、COCO 标注、PNG 或 `effects.py` 后，扩展会自动刷新，无需重启项目。

## 构建、安装与发布

项目结构、JetBrains 版本、本地安装和 CI/CD 发布流程详见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 配置

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `okScriptToolkit.langDirectory` | `assets/lang` | lang JSON 目录（相对工作区根） |
| `okScriptToolkit.poDirectory` | `i18n` | gettext PO 目录（相对工作区根），按 `<locale>/LC_MESSAGES/*.po` 扫描 |
| `okScriptToolkit.enablePoData` | `true` | 是否启用 gettext PO 数据源，与 lang JSON 合并 |
| `okScriptToolkit.poDomains` | `["ocr"]` | 要加载的 PO domain 白名单（默认只加载 ocr，排除 ok 等 UI 文案） |
| `okScriptToolkit.displayLocale` | `auto` | 幽灵注释显示的语言；`auto` 跟随 VS Code UI 语言 |
| `okScriptToolkit.enableInlayHints` | `true` | 是否启用幽灵注释 |
| `okScriptToolkit.featureAliases` | `["fL", "FeatureList"]` | 模板别名列表；别名会用于模板补全和 hover 识别 |
| `okScriptToolkit.effectsFile` | `src/data/effects.py` | 技能效果 ID 定义文件（`EffectType` 枚举与 `EFFECT_DESCRIPTIONS`），相对工作区根目录 |
| `okScriptToolkit.okScriptProjectPath` | 空 | 任务启动器使用的 ok-script 项目根目录；为空时尝试使用当前工作区 |
| `okScriptToolkit.okScriptPython` | 空 | 任务启动器使用的 Python；为空时优先使用目标项目 `.venv/Scripts/python.exe` |
| `okScriptToolkit.characterProjectPath` | 空 | 角色技能管理面板的数据项目；为空时使用 `okScriptProjectPath` 或当前工作区 |
| `okScriptToolkit.characterMasterFile` | `assets/data/characters.json` | 角色主表 JSON |
| `okScriptToolkit.characterSkillsDirectory` | `assets/data/character_skills` | 角色技能 JSON 目录 |
| `okScriptToolkit.characterLocaleFile` | `assets/lang/characters.json` | 角色名称多语言 JSON |
| `okScriptToolkit.characterAvatarTemplateRegex` | `^battle[_-]?icon[_-]?` | 角色头像模板名正则；有捕获组时使用第一组，否则使用匹配前缀后的剩余名称，与角色主表英文 slug 匹配；默认兼容 `battleicon`、`battle_icon` 和 `battle-icon` 前缀 |
| `okScriptToolkit.okTemplatesDirectory` | `ok_templates` | ok_templates 文件夹名（相对工作区根），供模板素材管理器使用 |
| `okScriptToolkit.annotationKeybindings` | 见默认值 | 标注编辑器的键盘快捷键；值为按键名，支持 `ctrl+z` 等修饰符前缀 |

**命令**（命令分类随界面语言显示为"ok-script 工具箱" / "ok-script Toolkit"）：

| 命令 | 快捷键 | 说明 |
|---|---|---|
| `ok-script 工具箱: 打开模板面板` | `Ctrl+Alt+T`（macOS `Cmd+Alt+T`，需聚焦 Python 编辑器） | 聚焦活动栏中的模板侧边栏视图 |
| `ok-script 工具箱: 在编辑器中打开模板面板` | — | 在编辑器区打开大窗口网格视图 |
| `ok-script 工具箱: 打开任务启动` | — | 聚焦活动栏中的任务启动器视图 |
| `ok-script 工具箱: 打开角色技能管理面板` | — | 打开角色、技能、效果、强化组和名称本地化管理页 |
| `ok-script 工具箱: 打开模板素材` | — | 在编辑器区打开模板素材管理大窗口面板 |
| `ok-script 工具箱: 打开标注编辑器` | — | 提示在模板素材面板中点击图片以进入 COCO 标注编辑器（命令本身不直接打开编辑器） |

### 配置示例

在工作区的 `.vscode/settings.json` 中：

```json
{
	"okScriptToolkit.langDirectory": "assets/lang",
	"okScriptToolkit.poDirectory": "i18n",
	"okScriptToolkit.poDomains": ["ocr"],
	"okScriptToolkit.displayLocale": "zh_CN",
	"okScriptToolkit.enableInlayHints": true,
	"okScriptToolkit.featureAliases": ["fL", "FeatureList"]
}
```

`displayLocale` 支持 `auto`、`zh_CN`、`zh_TW`、`en_US`、`ja_JP`、`ko_KR` 和 `es_ES`。hover 仍会显示完整语言表格；该设置只影响行内提示和语言补全详情。

如果项目使用了其他变量名，例如 `featureList`，可以配置：

```json
{
	"okScriptToolkit.featureAliases": ["fL", "FeatureList", "featureList"]
}
```

示例效果：在代码中

```python
self.wait_click_ocr(match=self.lang.zip_line_mixin.k_2f4f4a2f, ...)
```

幽灵注释会在 `k_2f4f4a2f` 后面显示 `「向目标移动」`；hover 会弹出包含 zh_CN / zh_TW / en_US / ja_JP / ko_KR / es_ES 全部值的表格。

模板示例：

```python
self.wait_click_feature(feature=fL.give_gift, time_out=10)
```

悬停 `fL.give_gift` 可查看对应模板裁剪图；输入 `fL.` 可从模板名称列表中选择。

## 更新后不生效

安装或直接覆盖扩展文件后执行：

`Ctrl+Shift+P` → **Developer: Reload Window**

如果刚修改了扩展的 `package.json` 配置声明，必须 reload 窗口后设置项才会出现在设置界面中。
