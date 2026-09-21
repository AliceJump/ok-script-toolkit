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
> | `templates.directory`（§8.1 的死设置） | ✅ 两端 |
> | 「项目约定 vs 我的设置」溯源面板（§3） | ✅ 两端 |
> | `i18n` / `characters` / `effects` 各组 | ✅ 两端 |
> | `templates.cocoAnnotations`（含 `config.py` 事实层） | ✅ 两端 |

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
④ 个人偏好（IDE 设置）  ← 最高
```

**④ 最高**的定位：**项目文件给团队开箱默认值，我改过就用我的**。

⚠️ **副作用**：一旦某人手动改过，项目声明的那一项就对他**永久失效**，他看不到团队改了什么。
缓解办法（实现时要一起做）：

1. UI 标出「当前值来自：项目约定 / 我的覆盖」
2. 提供「恢复为项目约定」——清掉个人覆盖回到 ③

> ✅ **UI 缓冲已落地（VS Code 侧）**：`src/conventionSources.ts` + 命令
> `okScriptToolkit.showConventionSources`（QuickPick，被覆盖的行带 `discard` 图标按钮）。
> 两条硬约束：
>
> - **来源层由取值链本身产出**，不在 UI 里复算 —— `projectConfigPure.resolveSetting()`
>   返回 `{ value, layer }`。另写一套判断去复算迟早与实际生效值分叉，而那种分叉的表现是
>   「界面说来源是项目约定、实际生效的却是我的设置」，属最难查的一类不一致。
>   `overridden` 也由 `layer === 'personal'` 推出，不比对值。
> - **恢复要清掉三级作用域**（工作区文件夹 / 工作区 / 用户）中**有值的那些**。
>   只清一级会留下仍然生效的覆盖（用户点了"恢复"却发现没变）；无差别地往三级都写
>   `undefined` 则会在设置文件里留下空条目。所以先 `inspect()` 判断哪一级有值。
>
> 为什么是**命令**而不是把提示塞进设置界面：**VS Code 的设置界面不可扩展** ——
> `contributes.configuration` 只能给静态 `description`，加不了动态来源或按钮。
>
> 新接一组设置时，在 `conventionSources()` 的登记表里补一行；`scripts/test_convention_sources.js`
> 会对着 `package.json` 核对键名，拼错键名（会让"恢复"静默失效）跑测试就报错。
>
> 面板上的 `declared`（"项目文件里写了什么"）**也不是另读一遍配置对象得来的** ——
> 它把个人偏好置空、**再跑一次同一条链**，命中的是 `builtin` 层就说明没声明。
> 这样展示值与生效值走同一套归一化：声明写 `./lang` 时两处都显示 `lang`，
> 不会出现"面板显示一个样、实际匹配另一个样"。
>
> ✅ **JetBrains 侧对应实现已落地**：`core/ConventionSources.kt`（纯对象）+
> `ui/ShowConventionSourcesAction.kt`（`AnAction` + `DialogWrapper`），
> `ProjectConvention` 产出同样的 `{ value, layer }`，登记表在 `conventionSourceRows()`。

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
| JetBrains（标量设置） | `SettingsState` 里这些字段**默认值非空**（`ok_templates`、`assets/lang` …），"留空"这招用不了 → 用 `overriddenKeys` 记账：`OkScriptToolkitConfigurable.apply()` 只记录**值真的变了**的键，`init` 给老用户播种一次。取链时先问"这个键在不在 `overriddenKeys` 里" |

**通用规则**：凡是"默认值非空"的设置项，接取值链时都必须先找到"用户是否真的改过"这个信号 ——
否则 ④ 层会把 ③ 层永久屏蔽。**动手接线前先看该设置的默认值是不是空的。**

⚠️ **记账必须放在 `apply()` 里赋值之前**：赋值后 state 已是新值，比不出"变没变"。
不比较、无条件记账的后果是"打开一次设置面板点个「应用」就把所有项目约定永久压住"，
而且同样是静默的。

> **已知取舍**：JetBrains 侧 `overriddenKeys` 只由设置面板维护。用户直接手改
> `ok-script-toolkit.xml` 时不会被记账，那一项仍按"没设过"处理（让项目约定生效）。
> 这是可接受的 —— 手改 xml 不是受支持的操作路径。

> **UI 缓冲：两端都已完成**（见上面 §3 的引用块）。
> 接线的新分组越多，"我改过一次就再也看不到团队改了什么"这个副作用的面就越大 ——
> 所以**新增分组时必须一并在登记表里补行**：VS Code `conventionSources()`、
> JetBrains `conventionSourceRows()`。两边的测试都会拿键名去核对
> （VS Code 对着 `package.json`，JetBrains 对着登记表内容与顺序）。

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
| `labelEnum` | `path` | 3/5 有 | IDE 设置 `labelEnumPath` → 空（这次不生成枚举） |
| | `name` | **0/5** | IDE 设置 `labelEnumName` → `path` 的 basename（今天的行为） |
| | `aliases` | **0/5** | IDE 设置 `featureAliases` → `["fL","FeatureList"]` |
| `executor.startupHooks` | `beforeConfigImport` | **无此信息** | 空（整段跳过 —— 现状） |
| | `afterConfigImport` | **无此信息** | 按约定试 `src.patches.startup_patches:install_startup_patches` |
| `templates` | `directory` | 无（插件侧约定） | IDE 设置 → `ok_templates` |
| | `cocoAnnotations` | **6/6 有** | `config.py` 的 `template_matching.coco_feature_json` → 依次探测两个候选 |
| `i18n` | `enabled` / `langDirectory` / `poDirectory` / `poDomains` | 无 | IDE 设置 → 内置默认 |
| `characters` | `projectPath` / `masterFile` / `skillsDirectory` / `localeFile` / `avatarTemplateRegex` | 无 | IDE 设置 → 内置默认 |
| `effects` | `file` | 无 | IDE 设置 → `src/data/effects.py` |

**接线状态**：全部字段已接线（`templates.directory` / `templates.cocoAnnotations` /
`labelEnum.*` / `i18n` / `characters` / `effects`）。

**⚠️ 两个同名的 `coco_annotations.json` 不是一回事** —— 接错会静默指向错的文件：

| 文件 | 是什么 | 谁读写 | 路径由谁决定 |
|---|---|---|---|
| `assets/coco_annotations.json`（或 config.py 指的别处） | ok 框架加载的**运行时模板库** | `featureData` / `OkProjectDataService` 读，文件监听盯它 | `templates.cocoAnnotations` → config.py → 两个惯例位置 |
| `<模板目录>/coco_annotations.json` | 素材面板自己的**标注工作文件** | `templateAssetData` / `TemplateAssetDataService` 读写 | `templates.directory`（**不受** `cocoAnnotations` 影响） |

`cocoAnnotations` 是**唯一**一层"`config.py` 已声明的事实"真正落地的字段 ——
其余字段 `config.py` 要么不声明，要么（`labelEnum.path`）插件至今没读。
它也是唯一**没有 IDE 设置**的链（没有"个人偏好"层），所以不进溯源面板。

**按字段类型选归一化方式**（做错是**静默**的，所以这里写死）：

| 字段类型 | 用哪个 | 为什么 |
|---|---|---|
| 相对路径（目录名、数据文件） | `relPathResolved` | 会被拼进 glob / 做目录段匹配；声明写 `assets\lang` 或 `./assets/lang` 会静默失配 |
| 绝对路径（`characters.projectPath`） | `textResolved` | 归一化会吃掉 POSIX 绝对路径的开头斜杠 |
| 正则（`characters.avatarTemplateRegex`） | `textResolved` | 归一化会把 `\d` 的反斜杠换成 `/`、把尾部 `/` 吃掉，正则当场废掉 |
| 布尔 | `boolResolved` | 手写文件里 `"enabled": "false"` 是字符串**真值**，不守卫会把开关反向锁死 |
| 字符串数组 | `listResolved` | 空数组 = "没声明"，否则用户没法用空值表达"回到项目约定" |

### ⚠️ `labelEnum.path` 是**模块路径**（不带 `.py`），消费端必须补后缀

`labelEnum.path` 与项目 `config.py` 的 `label_enum_relative_path` **同形** —— 都是
点分模块路径（`src/data/FeatureList`）。这不是推测：ok 框架的
`_normalize_label_enum_relative_path()`（`ok/ui/qt/tasks/TemplateTab.py`）会把用户输入的
`.py` **主动剥掉**再存盘，三个真实项目（ok-end-field / OK-AzurPromilia / ok-gf2）的值
也都是 `src/data/FeatureList`。

而消费端（生成枚举文件、拼绝对路径）要的是**文件路径**。拿模块路径直接去写，会产出一个
叫 `FeatureList`、**没有扩展名**的文件 —— Python 根本 import 不到，等于把项目弄坏。

→ 两端各提供一次显式转换（VS Code：纯函数 `labelEnumPath()` / 读设置用的
`labelEnumPathSetting()`；子仓 `LabelEnumConvention.filePathOr()`），
**不要在消费点手工拼字符串**；已带 `.py` 的写法要容忍、不重复补。
两层**共用同一个归一化**（`normalizeLabelEnumFile`）—— 旧实现只给项目声明补后缀、
把个人偏好原样返回，于是从输入框里填模块路径会生成一个**没有扩展名**的文件。

### ⚠️ `labelEnum.name` 是**代码契约**，个人覆盖会让整个项目 `ImportError`

`labelEnum.path` / `name` 与其它字段性质不同：其它字段只影响**插件自己往哪读**，
改错只影响插件；而这两项决定**往哪写文件、类叫什么** —— 而项目的代码是按名字 import 的：

```python
from src.data.feature_list import FeatureList      # OK-AzurPromilia 里有 10 处这么写
```

所以"我在设置里把类名改成 `MyEnum`"的后果不是"我这边看着不一样"，而是**整个项目跑不起来**。
这类字段给个人覆盖层，等于给用户一把能把自己项目弄坏的钥匙。

**做法：允许改，但覆盖已有文件前先问一句。**（两端都要有）

| 环节 | 实现 |
|---|---|
| 判据（纯函数，可单测） | VS Code `src/labelEnumGuard.ts`；子仓 `core/LabelEnumGuard.kt` |
| IO 与弹窗 | VS Code `templateAssetPanel.confirmLabelEnumRename()`（编排层）；子仓 `ui/TemplateAssetToolWindowFactory` |
| 测试 | `scripts/test_label_enum_guard.js`（含 5 组破坏性对照） |

三条不变量：

1. **文件不存在 → 不问**（全新生成，没有旧名字可废）
2. **新旧类名相同 → 不问**（每次保存都会重新生成一遍，问了就是纯噪音）
3. **文件在、却认不出类名 → 也要问** —— 用户很可能把路径填到了**普通模块**上，
   覆盖会直接删掉里面的东西

提示里带上"会炸多少处"：扫一遍项目里的 `**/*.py`，找出按旧类名 import 的文件
（`importsName` 覆盖 `from a import X` / `(A, X)` / `X as fL` / `import a.X` 几种写法）。
**宁可多报不可漏报**（注释掉的 import 也算命中）—— 这是"问一句"的依据，不是自动决策。

**只校验类名、不校验路径**：换路径时旧文件原样留着，按旧模块路径 import 的代码仍然
import 得到（只是拿不到新标签），不会报错；而改类名是**同一个文件里名字变了**，
引用方当场全废。两者后果不对称，所以只给前者加闸。

### 🧹 顺带修掉：`globalState` 里的"上次保存"（全局串味）

`labelEnumPath` 的个人偏好层以前存在 `context.globalState['okScriptToolkit.lastEnumFilePath']`，
现在**废弃、改成正式 IDE 设置**。三个理由：

1. **它是全局的，而消费点按当前工作区拼绝对路径** —— 在 A 项目填过
   `src/data/feature_list.py`，去 B 项目导出时默认值还是它，一回车就按 B 的根拼出一个
   **不存在**的路径；而生成函数里有 `mkdirSync(dir, { recursive: true })`，
   于是**静默在项目里造出一层错误目录树**。
2. **界面上看不见** —— 它不在设置界面、不在溯源面板，用户改过一次就再也不知道当前值是什么。
3. **无法一键恢复** —— 溯源面板的「恢复为项目约定」清的是 IDE 设置的三级作用域，
   清不到 `globalState`。留着它就会造成"面板说来源是项目约定、实际生效的却是那个隐藏值"，
   正是 §3 明令禁止的**界面与实际生效值分叉**。

所以：链变成 `IDE 设置 > 项目约定 > 兜底`（与 `featureAliases` 完全同构）；
导出对话框的「修改路径…」改为**写 IDE 设置**（工作区文件夹级 → 天然按工作区隔离，
无工作区时才写全局）。"填过一次就记住"的体验保留，但从此**可见、可改、可溯源**。

> **不做迁移**：老用户 `globalState` 里的那个值很可能正是上面第 1 条那个错值，
> 搬进设置等于把 bug 一起搬过去。让它回落到项目约定（正确值），首次保存多问一次即可。

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
| JetBrains | `settings/OkScriptToolkitSettings.kt` | 全部访问器（`ifBlank { 默认 }` 之前插入项目层）；标量/布尔/列表靠 `overriddenKeys` 记账区分"设过"与"默认值" |
| | `core/OkProjectDataService.kt`、`core/OkDataChangeService.kt`、`ui/CharacterManagerPanel.kt`、`tasklauncher/TaskLauncherToolWindowFactory.kt` | 各消费点（都已收敛到设置访问器，接线时只改访问器本体） |

> **两端对称**：`projectConfigPure.ts` ↔ `core/ProjectConvention.kt`（纯对象 + 取值链）、
> `projectConfig.ts` ↔ `settings/OkScriptToolkitSettings.kt`（读盘 + 个人偏好归一）、
> `conventionSources.ts` ↔ `core/ConventionSources.kt`（登记表）。
> 改一侧记得改另一侧；两边的归一化语义必须一致（同一份 JSON，两端要给出同样的结论）。

### `labelEnum` 落地

| 端 | 文件 | 改什么 |
|---|---|---|
| VS Code | `src/providers.ts:25` | `featureAliases()` 改读 `labelEnum.aliases` |
| | `src/templatePanel.ts:23` | 同上 |
| | `src/templateAssetData.ts:50,519,573` | `TEMPLATE_FOLDER` 常量改为可配；`enumFile` 默认取 `labelEnum.path`；类名改取 `labelEnum.name`（**不再从文件名反推**） |
| | `src/templateAssetPanel.ts:202` | 输入框默认值改走取值链（`labelEnumPathSetting()`）；覆盖前做类名变更校验 |
| JetBrains | `settings/OkScriptToolkitSettings.kt:65` | `featureAliases()` 同上 |
| | `editor/OkEditorSupport.kt:76,120`、`ui/TemplatesToolWindowFactory.kt` | 同上 |
| | `core/TemplateAssetDataService.kt:495,510` | `enumPath` 默认、类名来源，同上 |

> **实际落地的范围（以代码为准，别照上表逐项核对）：**
>
> - **`aliases`**：两端都接了。入口各只有一处 —— VS Code `providers.featureAliases()`、
>   子仓 `OkScriptToolkitSettings.featureAliases()` —— 所以 `templatePanel` /
>   `OkEditorSupport` 等消费点自动受益，不需要各自改。
> - **`name`**：两端生成枚举时取 `labelEnum.name`，缺席才退回文件名；
>   **两层都有个人偏好层**（`labelEnumName` 设置），且覆盖已有文件前会先做类名变更校验
>   （见 §5 的「`labelEnum.name` 是代码契约」）。
> - **`path`**：两端生成枚举时的默认值取它（经"模块路径 → 文件路径"转换，见 §5）；
>   个人偏好层从 `globalState` 升级成 IDE 设置 `labelEnumPath`（见 §5 的「顺带修掉」）。
> - **`templates.directory`**：两端都接了。VS Code 侧同时修掉了 §8.1 那个**死设置**；
>   消费点全部改走 `projectConfig.templatesDirectory(projectDir)` /
>   `OkScriptToolkitSettings.okTemplatesDirectory()`，包括文件监听 glob 与
>   `thumbSourceSubdir()` 的来源判定（目录名要拼进 glob / 做目录段匹配，所以
>   两端都先归一化一次 —— 见 `normalizeRelPath`）。
> - **未做**：`templates.cocoAnnotations`（消费点散在 6 个文件，且要先读 `config.py`
>   的 `template_matching.coco_feature_json` —— 两端目前都**完全不读** `config.py` 的
>   这一项，只有执行器侧用 AST 读 `config_folder`）；`i18n` / `characters` / `effects`
>   各组；"有值时不再弹框"未做 —— 仍会弹输入框，只是默认值变了。

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

1. **`okScriptToolkit.okTemplatesDirectory` 在 VS Code 侧曾是死设置** ——
   `templateAssetData.ts` 把 `ok_templates` 写成常量，**没有任何代码读这个设置**；
   子仓则**会读**（10 处）。属反向不对等。
   **✅ 已修**：两端统一走 `templates.directory` 取值链，消费点全部改为读访问器；
   顺带把 `TemplateAssetDataService.load/cocoPath` 的 `templatesDir: String = "ok_templates"`
   默认值**去掉**了 —— 留一个默认值等于给调用方留一条绕过取值链的静默通道。
2. **`label_enum_relative_path` 插件完全没读** —— 即便项目声明了，插件也在按名字猜。
3. **VS Code 侧无 jsonc 解析器** —— 这是本设计选纯 JSON 的原因之一（见 §4）。

## 9. 未决事项

1. ~~`captureMethod` 归"项目约定"还是"机器相关"？~~
   → **已定**：归**机器相关**，不进配置文件（见 §5 的「不进配置文件的」清单，
   与 `okScriptPython` / `okScriptProjectPath` 同列）。它随机器/驱动/游戏窗口行为变化，
   提交进仓库会强加给同事。
2. 是否提供「生成项目配置文件」命令？（当前设计为**只读**，需显式操作才写）—— **仍未做**。
3. `characters.projectPath` 指向另一个仓库时，那边的 `ok-script-toolkit.json` 是否也参与取值？
   → **实测当前行为：不参与。** 两端 `characters.*`（含 `characters.projectPath` 本身）都从
   **当前工作区**的约定文件读（`charactersMasterFileSetting()` 等一律 `loadProjectConfig()`
   不传根）。`characters.projectPath` 只决定**数据在哪**，不决定**配置从哪读**。
   ⚠️ **但模板数据那边是反的**：`TemplateAssetData` **刻意传自己的根**
   （`templatesDirectory(this.rootDir)`，源码注释写着"模板数据可能来自另一个仓库，
   用错根会读到别人的约定文件"）。**两处不一致**，是"待统一"而不是"已定"：
   - 若认为 `characters.masterFile` 描述的是**那个仓库**的布局 → 应读那个仓库的文件（与模板一致）
   - 若认为它描述的是"调试当前项目时去哪找角色数据" → 读当前工作区是对的（现状）

   统一前先明确这条语义；两种解释都能自圆其说，别只改一边。
