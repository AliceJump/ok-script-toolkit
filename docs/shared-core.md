# VS Code 与 JetBrains 的共用核心（v1.15）

主仓库存放协议与 Python 运行核心；`jetbrains/` 是独立 Git 子仓库，通过构建任务把主仓的 Python 脚本和 JSON Schema 打入插件。两个安装包应携带**字节相同**的运行脚本。

| 职责 | 唯一维护位置 | 两端如何使用 |
|---|---|---|
| 任务注册表快速解析 | `python/parse_config_tasks.py` | 宿主启动 Python，先展示 AST 任务列表 |
| 任务参数、全局配置、多账户概要 | `python/probe_task_schemas.py` | 宿主读取同一 JSON 协议并缓存；完整探针结果决定最终任务集合 |
| 项目配置目录、账号 store 定位、沙箱环境变量 | `python/project_runtime.py` | 探针、账号网关、执行器共用；账号 store 改路径时只改这里 |
| 项目自建全局配置 store 定位 | `python/project_store.py` | 探针和执行器共用项目声明的模块定位逻辑 |
| 账号读写 | `python/account_store.py` | 两端经项目自己的 store 操作，宿主不直接改账号文件 |
| 常驻执行、任务可见性与参数覆盖 | `python/run_executor.py`、`python/task_visibility.py` | 两端使用相同命令和状态协议 |
| 窗口探测、连接、截图、浮层 | `python/probe_window_config.py` 等脚本 | 两端调用相同脚本 |
| 项目约定文件结构 | `schemas/ok-script-toolkit.schema.json` | VS Code 直接注册；JetBrains 从 JAR 资源读取 |

宿主负责 IDE 生命周期、界面控件、Python 进程、缓存和用户数据位置。VS Code 使用 TypeScript/Webview 与 `.vscode/`；JetBrains 使用 Kotlin/Swing 与 `.idea/`。这两个目录是有意隔离的。三个运行入口（schema 探针、账号网关、执行器）均由宿主显式传 `OK_TOOLKIT_RUN_DIR`。账号网关仍接受旧的 `--run-dir` 参数，供已有调用方过渡。

任务键统一为 `module::Class`。快速首屏以新解析的 AST 列表决定任务成员，缓存只补名称和类型；探针成功后，以运行时 schema 键决定最终列表。探针失败必须向用户说明当前可能只有旧缓存或任务名，不能把降级结果显示成完整扫描成功。

配置快照仍由各宿主持久化；两端须维持同一语义：首次继承当前值、后续新键取默认值、保留旧键、按项目根隔离。跨语言的表单与 IDE 存储实现不能直接共用源码，修改规则时应同时验证 `src/consolePanel.ts` 与子仓的 `TaskConfigMerge.kt` / `GlobalSnapshotRules.kt`。素材与编辑器 UI 也仍是两个宿主实现；这部分没有假称为共用 Python 核心。

发布前运行主仓 `npm test`、`npm run package`，子仓 `gradlew test buildPlugin`，并检查 VSIX 与 JetBrains JAR 的 `python/*.py` 文件集合和内容一致。主仓的版本校验同时检查两个仓库的版本号。
