# 开发规范：资源外置与插件打包 / Development Standards: External Resources & Plugin Packaging

## 中文

### 资源外置

* **i18n 文案必须外置**，禁止在业务代码中硬编码可翻译文本。
* **任何代码内使用的 HTML 资源必须外置**，禁止将 HTML 模板、HTML 片段直接嵌入 Python/JS/TS 等代码中。
* 外置资源应放在项目约定的资源目录中，并通过统一的资源加载机制读取。
* 新增功能时，如果涉及 i18n 或 HTML，必须同步新增对应的外部资源文件，不得为了方便直接写入代码。
* 修改现有功能时，如发现已有代码内嵌 i18n 或 HTML，应优先一并迁移到外部资源。

### 插件打包

以下属于**仅开发使用的文件**，不得进入插件最终打包产物：

* `AGENTS.md`
* `AGENT.md`
* 其他 `agent.md` / `agents.md` 文件
* 项目开发说明、AI Agent 指令及相关开发辅助文件
* 测试文件及其他明确标记为开发用途的资源

插件打包配置必须显式忽略上述文件，避免将开发文件随插件发布。

### 检查要求

提交代码前应检查：

1. 是否存在新增的代码内嵌 i18n 文案。
2. 是否存在新增的代码内嵌 HTML。
3. 新增的 HTML/i18n 是否已经外置到规定目录。
4. 插件打包产物中不得包含 `AGENT.md`、`AGENTS.md` 等 Agent 开发文件。
5. 修改打包忽略规则后，应验证最终插件压缩包/产物中确实不存在这些文件。

---

## English

### External Resources

* **i18n strings must be externalized** — hardcoding translatable text in business code is prohibited.
* **Any HTML resources used in code must be externalized** — embedding HTML templates or HTML fragments directly into Python/JS/TS code is prohibited.
* Externalized resources should be placed in the project's designated resource directories and loaded through a unified resource loading mechanism.
* When adding new features that involve i18n or HTML, corresponding external resource files must be added simultaneously — do not embed them directly in code for convenience.
* When modifying existing features, if inline i18n or HTML is found, it should be migrated to external resources as a priority.

### Plugin Packaging

The following are **development-only files** and must not be included in the final plugin package:

* `AGENTS.md`
* `AGENT.md`
* Other `agent.md` / `agents.md` files
* Project development documentation, AI Agent instructions, and related development auxiliary files
* Test files and other resources explicitly marked as development-purpose

The plugin packaging configuration must explicitly ignore the above files to prevent development files from being shipped with the plugin.

### Checklist

Before committing code, verify:

1. No new inline i18n strings have been added to code.
2. No new inline HTML has been added to code.
3. New HTML/i18n has been externalized to the designated directories.
4. The plugin package does not contain `AGENT.md`, `AGENTS.md`, or other Agent development files.
5. After modifying packaging ignore rules, verify the final plugin archive/products do not contain these files.
