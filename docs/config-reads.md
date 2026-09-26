# 运行时配置读取全景

> **一句话**：插件运行时读的配置有**四类入口**，其中只有**甲类**走四层取值链。  
> 本文件逐项写清 **「这一项是干什么的」**、按什么规则取值、改了会在哪里生效。
>
> 相关文档：
>
> - [`docs/project-config.md`](project-config.md) —— 项目约定文件 `ok-script-toolkit.json` 的设计说明与字段清单
> - [`docs/ok-script-toolkit.example.json`](ok-script-toolkit.example.json) —— 可直接复制的示例
> - [`schemas/ok-script-toolkit.schema.json`](../schemas/ok-script-toolkit.schema.json) —— 编辑器里的补全与校验
> - 源码入口：父仓 `src/projectConfig.ts` / `src/projectConfigPure.ts`，子仓 `core/ProjectConvention.kt` / `settings/OkScriptToolkitSettings.kt`



---


## 0. 六型 · 按「实际经过哪几层」分类

⚠️ **四层是"池子"，不是每一项都经过。** 按**实际经过的层组合**分类，一共**六型** ——  
这样每一型的边界都能用"有没有某层"来判定，不会出现"某一型里混着不同层组合"的情况。

| 型     | 实际经过的层                              | 有哪些                                                                                                                                                   | 数量                     | 一句话                                           | 代码入口                                                                   |
| ----- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------- | ---------------------------------------------------------------------- |
| **甲** | **① ② ④**                           | 枚举 3 项 + 模板目录 1 项 + i18n 4 项 + 角色 5 项 + 效果 1 项                                                                                                        | **14**                 | 能被团队约定，也能被我覆盖；**不碰 `config.py`**              | `projectConfig.ts` 的 `xxxSetting()`；子仓 `OkScriptToolkitSettings.xxx()` |
| **乙** | **② ③ ④**                           | `templates.cocoAnnotations`                                                                                                                           | **1**                  | 由**项目**决定（约定文件 或 `config.py`）；**没有个人偏好层**     | `cocoFeaturePath.ts` / `core/CocoFeaturePath.kt`                       |
| **丙** | **③**                               | `windows.{exe, title, hwnd_class, args}`                                                                                                              | **4**（另有 2 项是死字段，见 §9） | 只有 `config.py` 这一层；探不到时**交互式兜底**（让用户手输窗口标题正则） | `python/probe_window_config.py`                                        |
| **丁** | **① ④**                             | `displayLocale` / `enableInlayHints` / `annotationKeybindings` / `enableTemplateGallery` / `okScriptProjectPath` / `okScriptPython` / `captureMethod` | **7**（任一端 6）           | 只属于**我这台机器 / 我个人**；**不碰项目文件**                 | `getConfiguration().get()`；子仓直接读 `SettingsState`                       |
| **戊** | 独立探测链（`okScriptProjectPath` → 自动探测） | 项目根解析                                                                                                                                                 | **2 条**                | "到哪儿去找这个项目"                                   | 父仓 `resolveProjectDir()`；子仓 `core/ProjectDirResolution.kt`             |
| **己** | **② ④**                             | `executor.startupHooks.{before,after}ConfigImport`                                                                                                    | **2**                  | 约定文件 + 内置兜底；**没有 IDE 设置**，且**只由执行器读**（插件不读）   | `python/run_executor.py`                                               |

**顺序就是"离项目有多近"**：甲（约定 + 我）→ 乙（只由项目定）→ 丙（只由 `config.py` 定）→  
丁（只由我定）→ 戊（找项目本身）→ 己（连插件都不读，只有执行器读）。

> **⚠️ 当前没有任何一项走满四层。** ① 层（"我这台机器要不要读它"）与 ③ 层（"项目 `config.py`  
> 声明的真话"）**至今没有交集** —— 唯一"本可以走满"的是 `labelEnum.path`，见 §9 第 4 条。



---


### 2.1 枚举 `labelEnum`（3 项）

| IDE 键            | 约定字段                | 这个配置是干什么的                                                                                              | 兜底                     | 归一化                |
| ---------------- | ------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------- | ------------------ |
| `featureAliases` | `labelEnum.aliases` | **代码里怎么引用这个枚举**。插件用它拼 `(fL\|FeatureList)\.成员名` 的正则，去识别代码里的 `fL.account_switch` 这类写法，从而提供补全、hover 与幽灵注释 | `["fL","FeatureList"]` | 列表（空数组 = 没声明）      |
| `labelEnumPath`  | `labelEnum.path`    | **生成 `LabelEnum.py` 写到哪里**。「保存到 assets」时按它落盘；留空 = 这次不生成                                                | `''`（不生成）              | 相对路径 + **补 `.py`** |
| `labelEnumName`  | `labelEnum.name`    | **生成枚举的类名**。项目的代码按名字 import（`from src.data.feature_list import FeatureList`），所以这项是**代码契约**             | 文件名 basename           | 纯文本                |

**备注**

- `featureAliases` 为什么值得配：项目 `config.py` **从不声明它**，所以此前只能靠 `fL`/`FeatureList` 硬猜；  
  项目把枚举导入成别的名字（如 `from ... import FeatureList as PL`）时，插件就完全失效。
- `labelEnum.path` 在项目文件里是**模块路径**（`src/data/FeatureList`，不带 `.py` —— 与 `config.py` 的  
  `label_enum_relative_path` 同形，ok 框架会主动剥掉 `.py`），而 IDE 设置那个输入框要的是**文件路径**。  
  **两层共用同一个归一化**（有 `.py` 就用、没有就补），别在消费点手工拼字符串。
- ⚠️ `labelEnumPath` / `labelEnumName` **决定往哪写文件、类叫什么**，个人覆盖改错就是全项目 `ImportError`。  
  所以两端都在**覆盖已有文件前**做一次类名变更校验：文件不存在不问、新旧类名相同不问、  
  但**类名会变时**先扫一遍项目里按旧类名 import 的文件、把"会炸多少处"报给用户确认  
  （父仓 `src/labelEnumGuard.ts`，子仓 `core/LabelEnumGuard.kt`）。
- ⚠️ 「修改路径…」对话框填的值会**写进设置**（存相对项目根的写法），所以"填过一次就记住"两端一致；  
  **留空 = 撤销覆盖、回到项目约定**。

### 2.2 模板素材 `templates.directory`（1 项）

| IDE 键                  | 约定字段                  | 这个配置是干什么的                                                                                | 兜底             | 归一化  |
| ---------------------- | --------------------- | ---------------------------------------------------------------------------------------- | -------------- | ---- |
| `okTemplatesDirectory` | `templates.directory` | **素材面板的工作目录名**（相对项目根）。里面放 png 切图 + 面板自己的 `coco_annotations.json`；同时决定缩略图缓存来源判定与文件监听 glob | `ok_templates` | 相对路径 |

共 **9 处调用点**，横跨：

| 位置                         | 用途                                                                 |
| -------------------------- | ------------------------------------------------------------------ |
| `extension.ts` ×5          | 拼**文件监听 glob**、变更归属比较（`rel.startsWith(...)`）、把目录名**注入**给 `pngCrop` |
| `featureData.ts`           | 建立模板索引（扫描该目录下的 png 与 `coco_annotations.json`）                      |
| `templateAssetData.ts`     | 面板数据根目录                                                            |
| `templateAssetPanel.ts` ×2 | 「保存到 assets」的输出目录、导入对话框的标题文案                                       |

`pngCrop.ts` **不自己读**配置（它有测试契约钉着：在纯 Node 沙箱里 require，`vscode` 只有空壳桩），  
目录名由宿主通过 `setTemplatesDirName()` 注入 —— 与 `setCropLogger` 同一套路。

**⚠️ 目录名会被拼进 glob**，所以消费前必须先归一化并按段转义（目录名可能含 `[`、`*`）。  
不转义时 watcher **静默失配** —— 界面一切正常，只是改了模板文件不刷新。

### 2.3 i18n（4 项）

| IDE 键           | 约定字段                 | 这个配置是干什么的                                                                                              | 兜底            | 归一化      |
| --------------- | -------------------- | ------------------------------------------------------------------------------------------------------ | ------------- | -------- |
| `langDirectory` | `i18n.langDirectory` | **语言 JSON 目录**（角色名等）。插件读它做语言值的 hover / 补全 / 幽灵注释                                                       | `assets/lang` | 相对路径     |
| `poDirectory`   | `i18n.poDirectory`   | **gettext `.po` 目录**，按 `<locale>/LC_MESSAGES/*.po` 组织。与 lang JSON 合并成同一份语言数据；任务启动器也用它给任务 schema 取本地化文案 | `i18n`        | 相对路径     |
| `enablePoData`  | `i18n.enabled`       | **要不要把 `.po` 当成一路数据源**（关掉就只用 lang JSON）                                                                | `true`        | 布尔（严格类型） |
| `poDomains`     | `i18n.poDomains`     | **只加载哪些 domain 的 `.po`**。默认只 `ocr`，把 `ok.po` 之类的 UI / 任务通用文案排除掉                                        | `["ocr"]`     | 列表       |

**备注**

- `enablePoData` ↔ `i18n.enabled` **名字不同是刻意的**：前者是"我这台机器要不要读它"，  
  后者是"这个项目的 i18n 长什么样"。
- ⚠️ `enablePoData` 必须做**严格类型判断**：手写文件里 `"enabled": "false"` 是**字符串真值**，  
  不做守卫会把开关反向锁死（关不掉）。
- 这三项都会拼进文件监听 glob（lang JSON / PO / 效果文件各一条），同样要按段转义。


### 2.4 角色与技能 `characters`（5 项）

| IDE 键                          | 约定字段                             | 这个配置是干什么的                                                   | 兜底                             | 归一化                             |
| ------------------------------ | -------------------------------- | ----------------------------------------------------------- | ------------------------------ | ------------------------------- |
| `characterProjectPath`         | `characters.projectPath`         | **角色 / 技能数据所在的项目根** —— 可以和当前项目**不是同一个仓库**                   | `''`（= 与当前项目相同）                | **纯文本（绝对路径，绝不归一化）**             |
| `characterMasterFile`          | `characters.masterFile`          | **角色主表 JSON**（角色 ID、英文 slug 等）                              | `assets/data/characters.json`  | 相对路径（相对 `characterProjectPath`） |
| `characterSkillsDirectory`     | `characters.skillsDirectory`     | **技能 JSON 目录**                                              | `assets/data/character_skills` | 相对路径                            |
| `characterLocaleFile`          | `characters.localeFile`          | **角色名多语言 JSON**                                             | `assets/lang/characters.json`  | 相对路径                            |
| `characterAvatarTemplateRegex` | `characters.avatarTemplateRegex` | **把模板名关联到角色**：从模板名（如 `battle_icon_1011`）里剥出角色标识，用来把素材归到角色名下 | `^battle[_-]?icon[_-]?`        | **纯文本（正则，绝不归一化）**               |

**备注**

- `characterProjectPath` 的兜底是**空串**，含义是"与当前项目相同" —— 空串是**合法声明值**，  
  不是"缺省忘了填"。所以它走**纯文本**链而不是相对路径链（后者会吃掉 POSIX 绝对路径的开头斜杠）。
- `characterAvatarTemplateRegex` **绝不能归一化**：`normalizeRelPath` 会把 `\d` 的反斜杠换成 `/`、  
  把尾部 `/` 吃掉 → 正则语法仍然合法但**永不匹配**。
- 手写正则写错时**退回内置默认**（`new RegExp` 包在 try 里），不能让一条正则把整个面板打挂。
- ⚠️ 这五项都读**当前工作区**的约定文件（`loadProjectConfig()` 不接根），  
  而 `characters.projectPath` 只决定**数据在哪**、不决定**配置从哪读**。  
  详见 [`docs/project-config.md`](project-config.md) 的「未决事项」。

### 2.5 效果 `effects`（1 项）

| IDE 键         | 约定字段           | 这个配置是干什么的                                                                                                                    | 兜底                    | 归一化  |
| ------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------- | ---- |
| `effectsFile` | `effects.file` | **效果 ID 定义文件**（`EffectType` 枚举 + `EFFECT_DESCRIPTIONS` 描述表）。插件解析它，给 `EffectType.XXX` / `"effect_id": "XXX"` 提供 hover、补全与幽灵注释 | `src/data/effects.py` | 相对路径 |

解析出的数据是 `效果 ID → { 描述, 分类 }`，描述与分类都来自那个文件，所以**加一个效果只需要改项目文件、不用改插件**。

### 2.6 只由执行器读的 `executor.startupHooks`

| 约定字段                                       | 这个配置是干什么的                                                                                       | 谁读                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------- |
| `executor.startupHooks.beforeConfigImport` | **在 `import config` 之前**依次调用的 `模块:函数` 列表                                                        | **只有共用的执行器** `python/run_executor.py` |
| `executor.startupHooks.afterConfigImport`  | **在 `import config` 之后**调用的；缺席时退回现有的约定探测（`src.patches.startup_patches:install_startup_patches`） | 同上                                    |

⚠️ **两端插件都"不读"这一项是正常的**，别当成不对等 —— 它由执行器读。  
钩子的名字没有通用约定，插件无从推断，所以必须显式声明（ok-end-field 的  
`pre_config_patch` / `qfluent_mute_promo_patch` 就属于"必须在 import config 之前跑"的那类）。  
钩子执行失败**只记日志、不阻断启动**（可选补丁装不上不能让执行器起不来）。

---

## 3. 乙型 · ② ③ ④：由项目决定（1 项）

| 约定字段                        | 这个配置是干什么的                                      | 取值链                                                                                                                                      |
| --------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `templates.cocoAnnotations` | **ok 框架加载的「运行时模板库」**（那份 COCO）在哪。插件用它做模板匹配提示与索引 | 约定文件 → `config.py` 的 `template_matching.coco_feature_json` → 依次探测 `assets/coco_annotations.json`、`ok_tasks/assets/coco_annotations.json` |

**它没有"个人偏好"层**（不进溯源面板）—— 这是刻意的：它是"项目自己的真话"，不是"我这台机器的偏好"。

**两条不变量**

1. **首选可用时只用首选**，不把探测候选也带上 —— 否则项目把库搬到别处之后，同名 feature 会出现两份、  
   先到者胜出（静默）。
2. `config.py` 的值**不归一化**（原样绝对化），项目约定那侧**要先归一化**。

> 🔥 这项修掉过一个真 bug：`ok-infinity-nikki` 声明的是 `assets/coco_detection.json`，  
> 而旧代码硬编码探测 `coco_annotations.json` → 那个项目的模板库**一直是空的**。

**⚠️ 两个同名的 `coco_annotations.json` 不是一回事**：

| 文件                                               | 是什么                | 路径由谁决定                                             |
| ------------------------------------------------ | ------------------ | -------------------------------------------------- |
| `assets/coco_annotations.json`（或 config.py 指的别处） | ok 框架加载的**运行时模板库** | `templates.cocoAnnotations`                        |
| `<模板目录>/coco_annotations.json`                   | 素材面板自己的**标注工作文件**  | `templates.directory`（**不受** `cocoAnnotations` 影响） |

---

## 4. 丙型 · ③：只有 `config.py` 这一层（窗口匹配，4 项）

**层组合 = ③**：**没有 ①（没有 IDE 设置）、没有 ②（约定文件里没有对应字段）**，  
兜底也不是常量而是**交互式**的 —— 探不到可用配置时，让用户手输窗口标题正则。

⚠️ 本节表格 7 个输出里，`coco_feature_json` **不是终点**，它是 §3（乙型）那条链的**中间层**；  
`top_hwnd_class` / `capture_method` 是**没人读的死字段**（见 §9）。

**脚本**：`python/probe_window_config.py`（用 AST 安全解析，**不导入项目代码**）  
**调用方**：父仓 `src/screenshotCapture.ts` 的 `probeWindowConfig()`、子仓 `core/ScreenshotCapture.kt`，  
以及 Python 侧 `connect_game.py` / `capture_game_window.py`（它们 import 探针的辅助函数）。  
子仓那条 `templates.cocoAnnotations` 链是经 `core/OkProjectDataService` 调它的（探针实例方法在  
`ScreenshotCapture` 上，`detectPythonPath` / `detectProjectDir` 才是服务自己的）。

**为什么窗口匹配与模板匹配共用一个探针**：每次调用都要**拉起一个 Python 进程**（百毫秒级），  
拆成两个脚本就要付两次启动成本，而它们读的是同一个文件、同一棵 AST。

**查找 `config.py` 的策略**：先解析 `main.py` / `run.py` / `run_task.py` 里的 import 定位实际路径，  
再回退到 `src/config.py` / `config.py`。

**输出**（最后一行 JSON）：

| 键                      | 这个配置是干什么的                           | 谁消费                                                                                                                                                              |
| ---------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exe`                  | 游戏进程名（可多个），用于**找游戏窗口**              | 父仓 / 子仓截图；`connect_game.py`                                                                                                                                      |
| `title`                | 窗口标题**正则**                          | 同上                                                                                                                                                               |
| `hwnd_class`           | 窗口类名                                | 同上                                                                                                                                                               |
| `top_hwnd_class`       | **顶层**窗口类名（游戏被嵌在别的窗口里时用）            | ⚠️ 见 §9                                                                                                                                                          |
| `args`（`windows.args`） | **游戏启动参数**（如 `-start=xxx_launcher`） | **只有 `connect_game.py`** —— 框架 `start_device()` 拼启动命令时只认全局配置 "Launch with DX11"，**没有读 `windows.args` 的入口**；项目以往靠 `main.py` 里的猴子补丁补这一步，而插件不走 `main.py`，所以必须自己读自己传 |
| `capture_method`       | 项目声明的截图方式                           | ⚠️ 见 §9                                                                                                                                                          |
| `coco_feature_json`    | **运行时模板库路径**                        | 作为 §3 那条链的**中间层**                                                                                                                                                |

**解析能力的边界**（`_extract_value`）：

- 认 `os.path.join("assets", "coco_annotations.json")`、`pathlib` 的 `Path("a") / "b"`、`re.compile("...")`
- **掺了变量就返回 `None`**（AST 里无从静态求值）→ 交给调用方走兜底
- 只认 `func.value.attr == "path"` 的 `join`（否则 `str.join` 也会命中）

**懒探测 + 后台补齐**（可复用的模式）：值来自 Python 子进程（百毫秒级），而消费点却是同步的 ——  
所以**没探到之前一律按"没声明"返回**（= 引入这项之前的行为），同时后台拉起探测；  
探到后作废快照 / 重建监听 / 广播。`config.py` 变化时要**先重探 → 再刷新数据 → 再重建监听**  
（顺序反了会拿着旧路径白读）。

---


## 5. 丁型 · ① ④：只属于我这台机器（7 项，任一端 6）

**层组合 = ① ④**：只读 IDE 设置，兜底是设置项自己的 `default`。  
**既没有 ②（约定文件里没有对应字段）、也没有 ③（`config.py` 不管这些）** —— 这是刻意的，理由见"为什么"列。  
下表 7 项里，`annotationKeybindings` 只在父仓、`enableTemplateGallery` 只在子仓  
（见本节末尾的差异表），所以**任一端实际是 6 项**。

| IDE 键                   | 这个配置是干什么的                                                                                                                                  | 为什么不该进链                        | 默认                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ | ------------------------------------ |
| `displayLocale`         | **幽灵注释用哪种语言**；`auto` 跟随 IDE 显示语言                                                                                                           | 纯 UI 偏好                        | `auto`                               |
| `enableInlayHints`      | **要不要显示幽灵注释**（语言值、效果描述的行内提示）                                                                                                               | 纯 UI 偏好                        | `true`                               |
| `annotationKeybindings` | **标注编辑器的键位**（`drawBbox` / `copyCoords` / `deleteMode` / `undo` / `redo` / `copy` / `paste` / `deleteSelected` / `prevImage` / `nextImage`） | 纯 UI 偏好                        | 见 `package.json`                     |
| `enableTemplateGallery` | 模板素材面板的**画廊视图开关**                                                                                                                          | 纯 UI 偏好                        | `true`                               |
| `okScriptProjectPath`   | **ok-script 项目根在哪**（含 `src/config.py` 的那个目录）                                                                                               | **机器相关**：同一份仓库在不同人机器上路径不同      | 空（自动探测）                              |
| `okScriptPython`        | **用哪个 Python 跑任务 / 脚本**                                                                                                                    | **机器相关**                       | 空（优先目标项目 `.venv/Scripts/python.exe`） |
| `captureMethod`         | **游戏窗口截图方式**：`auto` / `wgc` / `bitblt` / `foreground`                                                                                      | **机器相关**：WGC 能不能用取决于这台机器的系统与显卡 | `auto`                               |

**两端的差异（都是刻意的）**

| 键                       | 父仓  | 子仓  | 原因                                |
| ----------------------- | --- | --- | --------------------------------- |
| `annotationKeybindings` | ✅ 有 | ❌ 无 | 子仓用 IntelliJ **原生 keymap**，不该自造一套 |
| `enableTemplateGallery` | ❌ 无 | ✅ 有 | 父仓的模板画廊恒开                         |

---

## 6. 戊型 · 独立探测链：项目根解析（2 条）

**层组合 = 独立的**：它不是"某个值从哪读"，而是"到哪儿去找这个项目"。  
起点是 ① 层的 `okScriptProjectPath`，之后是一段**文件系统探测**（看工作区里有没有 `src/config.py`），  
所以既不属于 ② 也不属于 ③。

### 6.1 主项目根：`resolveProjectDir()`

**唯一实现**（`taskLauncher` / `screenshotCapture` 原先各自复制了一份，现已统一，避免"界面与脚本看的不是同一目录"）：

```
okScriptProjectPath（去 ~、去尾斜杠）
  → 自动探测：工作区根目录本身就是 ok-script 项目？（有 src/config.py 或 config.py）
    → ''（空）
```

### 6.2 角色数据项目根：`characterPanel` 自己的

**故意不复用上面那条** —— 它解析的是"**角色数据**所在项目"，与主项目可以不是同一个：

```
characterProjectPath（走取值链）
  → okScriptProjectPath
    → 探测含 assets/data/characters.json 或 assets/data/character_skills 的工作区文件夹
      → 第一个工作区
```

子仓对应 `core/ProjectDirResolution.kt`（"设置优先 + 校验 config.py"）。

---


## 7. 己型 · ② ④：只由**执行器**读（2 项）

**层组合 = ② ④**：约定文件字段（②）+ 内置兜底（④）。**没有 ①** —— 没有对应的 IDE 设置；  
**也没有 ③** —— 不来自 `config.py`。

> 单独放在最后一节，是因为**读它的不是插件，而是共用的执行器** `python/run_executor.py`。

| 约定字段                                       | 这个配置是干什么的                                                                                       | 谁读                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------- |
| `executor.startupHooks.beforeConfigImport` | **在 `import config` 之前**依次调用的 `模块:函数` 列表                                                        | **只有共用的执行器** `python/run_executor.py` |
| `executor.startupHooks.afterConfigImport`  | **在 `import config` 之后**调用的；缺席时退回现有的约定探测（`src.patches.startup_patches:install_startup_patches`） | 同上                                    |

⚠️ **两端插件都"不读"这一项是正常的**，别当成不对等 —— 它由执行器读。  
钩子的名字没有通用约定，插件无从推断，所以必须显式声明（ok-end-field 的  
`pre_config_patch` / `qfluent_mute_promo_patch` 就属于"必须在 import config 之前跑"的那类）。  
钩子执行失败**只记日志、不阻断启动**（可选补丁装不上不能让执行器起不来）。

---


## 8. 读取规则（不变量清单）

改任何一项配置读取前，先过一遍这 8 条。**违反任何一条的后果都是"静默"的**。

1. **个人偏好排最高是刻意的** —— 项目文件 = 团队开箱默认，我改过就用我的。
2. **必须区分"设过"与"只是默认值"** —— VS Code 用 `inspect()`，子仓用 `overriddenKeys` 记账。  
   用 `get()` 会让 ① 层永远命中、② 层永远不生效。
3. **归一化按字段类型选**：相对路径 → 归一化；**绝对路径 / 正则 → 绝不归一化**。  
   判据是"这个值最终怎么用"：`path.join` / 目录段比较 / 拼 glob ⇒ 归一化；  
   `new RegExp` / `path.resolve` / `File()` ⇒ 不归一化。
4. **空值 = 回到上一层**，不是"钉死为空"（空数组、空串、全空白都算没设）。  
   否则用户无法表达"回到项目约定"。
5. **来源层由取值链本身产出，UI 不复算** —— `resolveSetting()` 返回 `{ value, layer }`，  
   `overridden` 由 `layer === PERSONAL` 推出，**不比对值**。  
   面板上的 `declared`（"项目文件里写了什么"）也是**把个人偏好置空、再跑一遍同一条链**得出的。
6. **`config.py` 的值不归一化**（可能是 `os.path.join` 拼的、也可能是绝对路径）；  
   且**首选可用时只用首选**，不带上探测候选。
7. **懒探测：没探到之前按"没声明"返回**（= 引入这项之前的行为），探到后再作废快照 / 重建监听。
8. **消费点全部收敛到访问器**，不在消费点手工拼路径 / 手工判类型。  
   新增一项时，在溯源登记表里补一行（父仓 `conventionSources()`、子仓 `conventionSourceRows()`），  
   否则那一项**无法溯源、也无法一键恢复**。

**加一项接链设置的完整清单**（漏任何一处都会被守卫测试抓住）：

| 端         | 要改的地方                                                                                                                                                                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| VS Code   | ① `package.json` 的 `contributes.configuration` ② `package.nls*.json` ×6 文案 ③ `projectConfigPure.ts` 的 `xxxResolved()`（带 `{value, layer}`）④ `projectConfig.ts` 的 `xxxSetting()`（用 `ideSetting()`）⑤ `conventionSources()` 登记表补一行 ⑥ `l10n/bundle.l10n*.json` ×6 |
| JetBrains | ① `SettingsState` 字段 ② `KEY_*` 常量 ③ `personal(KEY_X)` 消费 ④ `OkScriptToolkitConfigurable` 的 `recordIfChanged` + UI + `reset()` ⑤ `ConventionPersonal` + `conventionSourceRows()` 登记表 ⑥ `OkScriptToolkitBundle*.properties` ×6                                 |

守卫测试：父仓 `scripts/test_convention_sources.js`（对着 `package.json` 核对键名，  
并反向检查"每个走 `ideSetting` 的键都在登记表里"）、子仓 `OverrideKeyParityTest`  
（声明集 == 消费集 == 记账集，含键数量断言）。

---


## 9. 已知不一致与待定事项

| # | 现象                                                                                                                                                                           | 性质   | 建议                                                                                                                                                                                                                                                                             |
| - | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 | 探针提取了 `windows.capture_method`，但**两端都没有消费点**                                                                                                                                 | 死提取  | 要么把它接成 `captureMethod` 的一层，要么把提取删掉。**倾向删掉** —— 截图方式确实是机器相关的（见 §5），项目声明的那个值不该压过我这台机器的设置                                                                                                                                                                                         |
| 2 | `player_id` 只出现在探针的 **docstring** 里（既没产出、也没消费）                                                                                                                               | 陈旧注释 | 改 docstring                                                                                                                                                                                                                                                                    |
| 3 | `top_hwnd_class` 被父仓解析进 `WindowConfig`，但 `captureGameWindow` 组装的 `windowConfigJson` **只发 3 个键**（exe / title / hwnd_class），所以这个字段**没人读**                                      | 死字段  | 真正用到 `top_hwnd_class` 的是 `connect_game.py`，而它是**自己重新探一遍** `config.py` 的。要么把它也传下去，要么从 `WindowConfig` 里删掉                                                                                                                                                                        |
| 4 | `labelEnum.path` 的 **③ 层没接**：`config.py` 的 `template_tab.label_enum_relative_path` 实测 **7 个项目里 4 个**声明了（ok-ap / ok-end-field / ok-gf2 / ok-neverness-to-everness），插件**完全不读** | 缺一层  | **这是唯一「本可以走满四层」的项** —— 它同时有 ①（`labelEnumPath` 设置）、②（`labelEnum.path`）、③（`template_tab.label_enum_relative_path`）和 ④（兜底）。要接的话注意这个值**两种写法都可能**：手写的是 `src/data/FeatureList`（斜杠），而框架自己的 `_normalize_label_enum_relative_path()` 会剥掉 `.py`、把 `/` 换成 `.` 再存盘（`src.data.FeatureList`） |
| 5 | `config.py` 的 `template_tab.generate_label_enum`（框架自带默认 `False`，实测 4/7 项目写 `True`）也没读                                                                                        | 缺一层  | 语义与「`labelEnumPath` 留空 = 不生成」**重叠**。接的话要先想清楚「项目说生成、我说不生成」谁赢 —— 按既有优先级应该是**我赢**                                                                                                                                                                                                 |
| 6 | 读约定文件用哪个根：**模板与角色不一致**                                                                                                                                                       | 待统一  | `templatesDirectory(projectDir?)` 接可选根（模板数据可能来自另一个仓库）；`characters*Setting()` 一律读当前工作区。两种解释都能自圆其说，见 [`docs/project-config.md`](project-config.md) 的「未决事项」                                                                                                                       |
| 7 | `featureAliases` 有两套历史机制并存（`state` 默认留空 + `featureAliasesTouched`，以及 `overriddenKeys`）                                                                                       | 历史包袱 | 改它时别混淆                                                                                                                                                                                                                                                                         |

---


## 10. 代码索引（两端对照）

| 职责                 | VS Code                                                              | JetBrains                                                                 |
| ------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 纯对象：解析 + 取值链 + 来源层 | `src/projectConfigPure.ts`                                           | `core/ProjectConvention.kt`                                               |
| 读盘 + 缓存 + 个人偏好归一   | `src/projectConfig.ts`（`ideSetting()` / `setIdeSetting()`）           | `core/ProjectConventionConfig.kt` + `settings/OkScriptToolkitSettings.kt` |
| 溯源行构造（纯）           | `src/conventionSources.ts` 的 `conventionSources()`                   | `core/ConventionSources.kt` 的 `conventionSourceRows()`                    |
| 溯源面板 UI            | 命令 `okScriptToolkit.showConventionSources`（QuickPick）                | `ui/ShowConventionSourcesAction.kt`（DialogWrapper）                        |
| 撤销个人覆盖             | `clearOverride()`（清三级作用域里有值的）                                        | `clearOverridden(key)`（撤销记账，可逆）                                           |
| 运行时模板库路径链          | `src/cocoFeaturePath.ts` + `cocoFeaturePathPure.ts`                  | `core/CocoFeaturePath.kt`                                                 |
| 枚举写入前的类名校验         | `src/labelEnumGuard.ts`                                              | `core/LabelEnumGuard.kt`                                                  |
| `config.py` AST 探针 | `python/probe_window_config.py`（两端共用）                                | 同左                                                                        |
| 约定文件字段 → 归一化助手     | `relPathResolved` / `textResolved` / `boolResolved` / `listResolved` | `normalizeRelPath` / `textOrNull` / 类型守卫 / 过滤 `isNotBlank`                |

**两端是对称的两套独立实现**：改一侧必须改另一侧，两边的归一化语义必须一致  
（同一份 JSON，两端要给出同样的结论）。

---

## 11. 排查：我改了配置为什么没生效

按这个顺序查，**每一步都能独立证伪**：

1. **这个值属于哪一型？** 对照 §0。丁型（`okScriptProjectPath` / `captureMethod` 等）**压根不看项目文件**；  
   丙型（窗口匹配）**只看 `config.py`**，改约定文件没用。
2. **看溯源面板。** 它会直接告诉你"当前生效值来自哪一层"。如果来源是「我的设置」，  
   说明 ① 层压住了 ② 层 —— 点「恢复为项目约定」即可。
3. **值真的被归一化了吗？** 声明里写 `assets\lang` / `./assets/lang` 时，  
   如果某一处没走归一化，就会出现"界面看着正常、匹配不上"。
4. **文件监听有没有触发？** 值会被拼进 glob，目录名没转义 / 没归一化 → watcher 静默失配。  
   表现是"改了模板或语言文件，界面不刷新"。
5. **是不是"没声明"被当成"空值"了？** 空数组 / 空串在本仓库的语义是"回到上一层"，  
   不是"钉死为空"。想表达"这里就是没有"，得换一种方式。
6. **`config.py` 那层探到了吗？** 探针是懒探测，第一次按"没声明"返回；  
   如果 `config.py` 里的值是 `os.path.join(变量, ...)` 这种掺了变量的写法，**静态解析不出来** → 走兜底。
7. **两端都改了吗？** 只改一端时，另一个 IDE 里的行为不会变。
