# 项目约定文件（`ok-script-toolkit.json`）设计

> 状态：**部分实现**。配套产物：`schemas/ok-script-toolkit.schema.json`、
> `docs/ok-script-toolkit.example.json`。
>
> | 范围 | 状态 |
> |---|---|
> | 执行器侧（`load_project_config` / `executor.startupHooks`） | ✅ `13f754b` |
> | VS Code 侧加载器 + `labelEnum` 接入 | ✅ `df41a85` |
> | JetBrains 侧加载器 + `labelEnum` 接入 | ✅ `core/ProjectConventionConfig.kt` + `core/ProjectConvention.kt` |
> | 截图快捷键（§6.4） | ✅ 两端 |
> | `templates` / `i18n` / `characters` / `effects` 各组的取值链接入 | ⏳ **未实现**（schema 已声明，插件暂不读） |

## 1. 要解决的问题

插件目前把**描述"项目约定"的东西**放在 **IDE 用户设置**里。两端各有一份同名同义的
字段（VS Code 18 项 / JetBrains 19 项，17 项重合），但：

1. **不随项目走** —— 换机器、换同事就全丢，得重配一遍
2. **两端各存一份** —— 同一个人用两个 IDE 要填两遍，且可能不一致
3. **默认值靠猜** —— `assets/lang`、`i18n`、`ok_templates`、`src/data/effects.py`
   只对"标准布局"的项目成立
4. **有些事实插件根本不读** —— 项目 `config.py` 里明明声明了，插件却在按名字猜

第 4 条最要命：ok-end-field 的枚举路径、ok-infinity-nikki 的枚举路径，都在
`config.py` 里写着（或该写而没写），而插件只能靠 `featureAliases` 拼正则去代码里猜。

## 2. 设计原则

> **项目 `config.py` 里已经声明过的事实，插件优先去读；`ok-script-toolkit.json`
> 只承担 `config.py` 里没有或不一定有的东西。**

这条原则让配置文件的职责收得很小，也避免了同一事实两处维护。

### 依据：5 个 ok 系项目的 `config.py` 普查

| 项目 | `config_folder` | `screenshots_folder` | `template_tab.label_enum_relative_path` | `generate_label_enum` | `template_matching.coco_feature_json` |
|---|---|---|---|---|---|
| ok-end-field | ✓ | ✓ | ✓ | ✓ | ✓ |
| OK-AzurPromilia | ✓ | ✓ | ✓ | ✓ | ✓ |
| ok-gf2 | ✓ | ✓ | ✓ | ✓ | ✓ |
| ok-infinity-nikki | ✓ | ✓ | **✗** | **✗** | ✓ |
| ok-gm | ✓ | ✓ | **✗** | **✗** | ✓ |

结论分三档：

- **5/5 都有**（`config_folder`、`screenshots_folder`、`coco_feature_json`）
  → **不必写进配置文件**，读 `config.py` 即可（`config_folder` 已经这么做了）
- **3/5 有**（`label_enum_relative_path`）→ **不能依赖**
- **0/5 有**（枚举的类名、引用别名）→ **必须由配置文件声明**

后两项正是 `labelEnum` 这一组存在的理由。ok-infinity-nikki 与 ok-gm
**连 `template_tab` 段都没有**，但 `src/data/FeatureList.py` 确实存在。

## 3. 取值优先级

```
① 内置默认（兜底）
      ↑ 被覆盖
② 项目 config.py 已声明的事实
      ↑ 被覆盖
③ ok-script-toolkit.json（团队默认，提交进仓库）
      ↑ 被覆盖
④ 个人偏好（IDE 设置 / 上次保存）  ← 最高
```

**④ 最高**的定位：**项目文件给团队开箱默认值，我改过就用我的**。

⚠️ **副作用**：一旦某人手动改过，项目声明的那一项就对他**永久失效**，他看不到团队改了什么。
缓解办法（实现时要一起做）：

1. UI 标出「当前值来自：项目约定 / 我的覆盖」
2. 提供「恢复为项目约定」——清掉个人覆盖回到 ③

**每一层都可缺席**：缺席就往下取；全缺则退回现有行为。**文件不存在时，行为与今天
完全一致 —— 纯增量。**

### ⚠️ 实现陷阱：④ 层必须区分「用户设过」与「只是默认值」

**这是接线时踩到的真坑，两端都踩了，且症状完全静默。**

两端的 IDE 设置**都带非空默认值**：

- VS Code：`package.json` 里 `okScriptToolkit.featureAliases` 的 `default` 是 `["fL","FeatureList"]`
- JetBrains：`SettingsState.init` 里把 `featureAliases` 填成 `["fL","FeatureList"]`

于是"读一下 IDE 设置"这个动作**永远拿得到值** → ④ 层永远命中 → **③ 项目声明永远不生效**。
界面上一切正常，只是"项目里配的东西不生效" —— 等于这一层白接了。

| 端 | 正确判据 |
|---|---|
| VS Code | `getConfiguration().inspect('featureAliases')`，取 `workspaceFolderValue ?? workspaceValue ?? globalValue`；三者都为 `undefined` 才算"没设过" |
| JetBrains | **state 默认值留空**（空列表 = 没设过）。旧版本填过默认值，用 `featureAliasesTouched` 标记区分"init 自动写的"与"用户手填的同样值"，做一次性迁移 |

**通用规则**：凡是"默认值非空"的设置项，接取值链时都必须先找到"用户是否真的改过"这个信号 ——
否则 ④ 层会把 ③ 层永久屏蔽。**动手接线前先看该设置的默认值是不是空的。**

## 4. 文件形态

- 名称：**`ok-script-toolkit.json`**（不带点，可见，本来就该被提交）
- 位置：**被调试项目的根目录**
- 格式：**纯 JSON**（不用 JSONC）
  - 好处：两端**都不需要改解析器**（子仓现用裸 `ObjectMapper()`，默认不允许注释）
  - 文档交给 schema 的 `description`，编辑器悬浮可见 —— 改一次全项目同步
- 通过 `contributes.jsonValidation` 关联 schema，拿到补全与校验

**红线**：插件**只读**本文件，永不静默写入。

## 5. 字段清单

### 进配置文件的

| 分组 | 字段 | config.py 是否声明 | 缺席时 |
|---|---|---|---|
| `labelEnum` | `path` | 3/5 有 | config.py → 个人偏好 → `<目标目录>/LabelEnum.py` |
| | `name` | **0/5** | `path` 的 basename（今天的行为） |
| | `aliases` | **0/5** | `["fL","FeatureList"]` |
| `executor.startupHooks` | `beforeConfigImport` | **无此信息** | 空（整段跳过 —— 现状） |
| | `afterConfigImport` | **无此信息** | 按约定试 `src.patches.startup_patches:install_startup_patches` |
| `templates` | `directory` | 无（插件侧约定） | IDE 设置 → `ok_templates` |
| | `cocoAnnotations` | 5/5 有 | config.py → 依次探测两个候选 |
| `i18n` | `enabled` / `langDirectory` / `poDirectory` / `poDomains` | 无 | IDE 设置 → 内置默认 |
| `characters` | `projectPath` / `masterFile` / `skillsDirectory` / `localeFile` / `avatarTemplateRegex` | 无 | IDE 设置 → 内置默认 |
| `effects` | `file` | 无 | IDE 设置 → `src/data/effects.py` |

### ⚠️ `labelEnum.path` 是**模块路径**（不带 `.py`），消费端必须补后缀

`labelEnum.path` 与项目 `config.py` 的 `label_enum_relative_path` **同形** —— 都是
点分模块路径（`src/data/FeatureList`）。这不是推测：ok 框架的
`_normalize_label_enum_relative_path()`（`ok/ui/qt/tasks/TemplateTab.py`）会把用户输入的
`.py` **主动剥掉**再存盘，三个真实项目（ok-end-field / OK-AzurPromilia / ok-gf2）的值
也都是 `src/data/FeatureList`。

而消费端（生成枚举文件、拼绝对路径）要的是**文件路径**。拿模块路径直接去写，会产出一个
叫 `FeatureList`、**没有扩展名**的文件 —— Python 根本 import 不到，等于把项目弄坏。

→ 两端各提供一次显式转换（`labelEnumFile()` / `LabelEnumConvention.filePathOr()`），
**不要在消费点手工拼字符串**；已带 `.py` 的写法要容忍、不重复补。

### **不**进配置文件的

- **用户偏好**：`displayLocale`、`enableInlayHints`、`enableTemplateGallery`、`annotationKeybindings`、
  **截图快捷键**（见 §6.4）
- **机器相关**：`okScriptPython`、`captureMethod`、`okScriptProjectPath`

理由：这些是"我这台机器 / 我这个人"的偏好，提交进仓库会强加给同事。

## 6. 两端改动点清单

### 新增（两端各一份，逻辑对应）

| 端 | 文件 | 职责 |
|---|---|---|
| VS Code | `src/projectConfig.ts` | 定位 + 解析 `ok-script-toolkit.json`，暴露带默认值的访问器 |
| JetBrains | `core/ProjectConventionConfig.kt` | 同上 |

### 取值链改造（现有设置访问器加一层）

| 端 | 文件 | 涉及字段 |
|---|---|---|
| VS Code | `src/langData.ts` | `langDirectory`、`poDirectory`、`poDomains`、`enablePoData` |
| | `src/characterPanel.ts` | `characterMasterFile`、`characterSkillsDirectory`、`characterLocaleFile`、`characterAvatarTemplateRegex` |
| | `src/characterData.ts`、`src/effectData.ts`、`src/extension.ts`、`src/taskLauncher.ts` | `effectsFile`、`poDirectory` |
| JetBrains | `settings/OkScriptToolkitSettings.kt` | 全部访问器（`ifBlank { 默认 }` 之前插入项目层） |
| | `core/OkProjectDataService.kt`、`core/OkDataChangeService.kt`、`core/CharacterDataService.kt`、`core/EffectDataMutations.kt`、`ui/*` | 各消费点 |

### `labelEnum` 落地

| 端 | 文件 | 改什么 |
|---|---|---|
| VS Code | `src/providers.ts:25` | `featureAliases()` 改读 `labelEnum.aliases` |
| | `src/templatePanel.ts:23` | 同上 |
| | `src/templateAssetData.ts:50,519,573` | `TEMPLATE_FOLDER` 常量改为可配；`enumFile` 默认取 `labelEnum.path`；类名改取 `labelEnum.name`（**不再从文件名反推**） |
| | `src/templateAssetPanel.ts:202` | 输入框默认值由 `lastEnumFilePath` 改为 `labelEnum.path`；有值时不再弹框 |
| JetBrains | `settings/OkScriptToolkitSettings.kt:65` | `featureAliases()` 同上 |
| | `editor/OkEditorSupport.kt:76,120`、`ui/TemplatesToolWindowFactory.kt` | 同上 |
| | `core/TemplateAssetDataService.kt:495,510` | `enumPath` 默认、类名来源，同上 |

> **实际落地的范围（以代码为准，别照上表逐项核对）：**
>
> - **`aliases`**：两端都接了。入口各只有一处 —— VS Code `providers.featureAliases()`、
>   子仓 `OkScriptToolkitSettings.featureAliases()` —— 所以 `templatePanel` /
>   `OkEditorSupport` 等消费点自动受益，不需要各自改。
> - **`name`**：两端生成枚举时取 `labelEnum.name`，缺席才退回文件名。
> - **`path`**：两端生成枚举时的默认值取它（经"模块路径 → 文件路径"转换，见 §5）。
> - **未做**：`TEMPLATE_FOLDER`（`ok_templates` 目录名）仍不可配；
>   "有值时不再弹框"未做 —— 仍会弹输入框，只是默认值变了。

### 执行器（`python/run_executor.py`）

| 改什么 | 位置 |
|---|---|
| 读 `executor.startupHooks.beforeConfigImport`，在 `import config` **之前**依次调用 | `main()` 中 `config_module = __import__(...)` 之前 |
| 读 `executor.startupHooks.afterConfigImport`；缺席时保持现有的约定探测 | 现有 `install_project_startup_patches()` 调用点 |

> 这一项**直接补上已确认的缺口**：ok-end-field 的 `pre_config_patch` /
> `qfluent_mute_promo_patch` 必须在 `import config` 之前跑，而执行器**至今整段跳过**
> （它们的名字没有通用约定，插件无从推断）。

### 6.4 截图快捷键（新增，**不进项目配置**）

**要什么**：一个"截图 → 进标注模板管理"的快捷键。默认目标是**标注模板管理**
（`openTemplateAssets` / `ShowTemplateAssetsAction`，其面板自带截图动作：
截图落盘后登记进 COCO），而**不是**临时截图（`showTempScreenshots` /
`ShowTempShotsAction`）。

**为什么是 IDE 级**：键位是个人偏好。放进项目配置会强加给同事，而且 VS Code 与
IntelliJ 各有原生 keymap 编辑器，用户改键位本来就该走那里 —— 插件不该自造一套。

| 端 | 做法 |
|---|---|
| VS Code | `contributes.commands` 新增 `okScriptToolkit.screenshotToTemplate`；`contributes.keybindings` 给它一个默认键位（不加 `when` 限制，任何文件都能按）。用户可在「键盘快捷方式」里改 |
| JetBrains | 新增 `AnAction`（放在 `plugin.xml` 的 `actions` 里给默认键位）；用户可在「设置 → 按键映射」里改 |

行为：打开标注模板管理面板并触发它的截图动作。**不新增截图实现** —— 复用面板已有的
`handleScreenshot`。

## 7. 迁移与兼容

- **文件缺席 → 行为完全不变**，不需要一次性迁移
- IDE 设置**全部保留**，语义从"唯一来源"变成"个人覆盖"
- 建议在文档里给两个形态的示例：完整版（ok-end-field）与最小版（ok-infinity-nikki）

## 8. 顺带发现（与本设计无关，但实现时会碰到）

1. **`okScriptToolkit.okTemplatesDirectory` 在 VS Code 侧是死设置** ——
   `templateAssetData.ts:50` 把 `ok_templates` 写成常量，**没有任何代码读这个设置**；
   子仓则**会读**（4 个文件）。属反向不对等。要么接线，要么删设置。
2. **`label_enum_relative_path` 插件完全没读** —— 即便项目声明了，插件也在按名字猜。
3. **VS Code 侧无 jsonc 解析器** —— 这是本设计选纯 JSON 的原因之一（见 §4）。

## 9. 未决事项

1. `captureMethod` 归"项目约定"还是"机器相关"？取决于它是否随机器/驱动变化
2. 是否提供「生成项目配置文件」命令？（当前设计为**只读**，需显式操作才写）
3. `characters.projectPath` 指向另一个仓库时，那边的 `ok-script-toolkit.json` 是否也参与取值？
