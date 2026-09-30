# VS Code 与 JetBrains 的共用核心（v1.15）

主仓库存放协议与 Python 运行核心；`jetbrains/` 是独立 Git 子仓库，通过构建任务把主仓的 Python 脚本和 JSON Schema 打入插件。两个安装包应携带**字节相同**的运行脚本。

| 职责 | 唯一维护位置 | 两端如何使用 |
|---|---|---|
| 任务注册表快速解析 | `python/parse_config_tasks.py` | 宿主启动 Python，先展示 AST 任务列表 |
| 任务参数、全局配置、多账户概要 | `python/probe_task_schemas.py` | 宿主读取同一 JSON 协议并缓存；完整探针结果决定最终任务集合 |
| 项目配置目录、账号 store 定位、沙箱环境变量 | `python/project_runtime.py` | 探针、账号网关、执行器共用；账号 store 改路径时只改这里 |
| 项目自建全局配置 store 定位 | `python/project_store.py` | 探针和执行器共用项目声明的模块定位逻辑 |
| 账号读写 | `python/account_store.py` | 两端经项目自己的 store 操作，宿主不直接改账号文件 |
| 常驻执行、任务可见性与参数覆盖 | `python/run_executor.py`、`python/executor_runtime.py`、`python/executor_input.py`、`python/task_visibility.py` | 两端使用相同命令和状态协议 |
| 窗口探测、连接、截图、浮层 | `python/probe_window_config.py` 等脚本 | 两端调用相同脚本 |
| 项目约定文件结构 | `schemas/ok-script-toolkit.schema.json` | VS Code 直接注册；JetBrains 从 JAR 资源读取 |

宿主负责 IDE 生命周期、界面控件、Python 进程、缓存和用户数据位置。VS Code 使用 TypeScript/Webview 与 `.vscode/`；JetBrains 使用 Kotlin/Swing 与 `.idea/`。这两个目录是有意隔离的。三个运行入口（schema 探针、账号网关、执行器）均由宿主显式传 `OK_TOOLKIT_RUN_DIR`。账号网关仍接受旧的 `--run-dir` 参数，供已有调用方过渡。

任务键统一为 `module::Class`。快速首屏以新解析的 AST 列表决定任务成员，缓存只补名称和类型；探针成功后，以运行时 schema 键决定最终列表。探针失败必须向用户说明当前可能只有旧缓存或任务名，不能把降级结果显示成完整扫描成功。

配置快照仍由各宿主持久化；两端须维持同一语义：首次继承当前值、后续新键取默认值、保留旧键、按项目根隔离。跨语言的表单与 IDE 存储实现不能直接共用源码，修改规则时应同时验证 `src/consolePanel.ts` 与子仓的 `TaskConfigMerge.kt` / `GlobalSnapshotRules.kt`。素材与编辑器 UI 也仍是两个宿主实现；这部分没有假称为共用 Python 核心。

发布前运行主仓 `npm test`、`npm run package`，子仓 `gradlew test buildPlugin`，并检查 VSIX 与 JetBrains JAR 的 `python/*.py` 文件集合和内容一致。主仓的版本校验同时检查两个仓库的版本号。

执行器通过 `OK.start_runtime()` 初始化项目服务、浮层及设备发现，再由原生
`StartController.start()` 连接和启动任务。框架已按自动启动设置或命令行任务发起
连接时，适配层等待那次结果，不重复启动。启动失败或超时不会发送 READY；超时
会输出线程栈供排查。运行时启动 API 缺失时明确报错，要求更新 ok-script。
直接启动 Windows 游戏时，外层超时覆盖原生控制器分别等待窗口稳定和设备就绪的
两个阶段；由自定义任务启动游戏时沿用单阶段预算。

Windows 上的 stdin 命令管道先通过 `PeekNamedPipe` 检查已到达字节，再读取和
增量解码；空闲期间只等待取消事件，不阻塞在 CRT 的管道读取中。否则 NTE
初始化原生库时可能阻塞后续线程创建，让已入队的自定义启动任务和 READY
都等到下一条输入才继续。启动无需任何触发任务切换；拆包 UTF-8、CRLF、
多行命令及管道关闭仍按同一协议处理。

配置基线在导入项目之前复制到宿主沙箱；框架 Config 和项目通过
`get_relative_path` 获取的配置路径同时改道，含自定义配置目录和绝对路径。
环境准备钩子在首次框架导入前执行。运行时计算的目录在 Config 首次打开文件前
复制并注册，导入结束后的目录核对不会覆盖已产生的沙箱写入。
沙箱创建／复制失败、目录与项目配置重叠时终止启动。项目配置字典中的容器也复制
后再适配，窗口、交互、截图后端和任务注册等声明沿用项目值。启动期间收到的
任务命令排队，连接完成后由主循环统一处理。
