/**
 * 「保存到 assets」这一步的**纯逻辑**：目标列表怎么排、枚举路径要不要问。
 *
 * 为什么单独抽一个不 import `vscode` 的模块：这段是**看起来像 UI、其实是数据约定**
 * 的东西（与 `projectConfigPure.ts` 同一个理由）。两条不变量改错都很难发现：
 *
 * 1. **什么时候可以不问用户** —— 已经有默认路径时再问一遍是纯粹的噪音；
 * 2. **不问的时候必须留一个改的口子** —— 跳过输入框之后，QuickPick 里那一项就是
 *    用户**顺手**改路径的唯一入口（他当然也能去设置界面改 `labelEnumPath`，
 *    但那要自己知道有这个设置、还要自己找到它）。少了这一项，
 *    "不问"就从"省一步"变成"绕远路"。
 *
 * 而面板流程本身（QuickPick + webview + globalState）在普通 Node 测试里跑不起来，
 * 所以决策下沉到这里，由 `scripts/test_save_to_assets_flow.js` 直接断言。
 */

/** 一个可选的保存目标。 */
export interface SaveTarget {
  /** 展示名，同时也是目标目录的相对写法（`assets` / `ok_tasks/assets`） */
  label: string;
  /** 该目标的说明文案（已本地化） */
  description: string;
  /** 该目标的绝对目录 */
  folder: string;
}

/**
 * QuickPick 的一项。
 *
 * `target` 为 `undefined` 表示"改枚举路径"这个**特殊项** —— 点它不触发保存，
 * 而是先去改路径。用 `target` 的有无当判别式（而不是另加一个 `kind` 字段），
 * 这样"点错就误保存"在类型上就不可能：没有 `target` 的项没有目标可写。
 */
export interface SaveTargetItem {
  label: string;
  description?: string;
  target?: string;
}

/** 「修改 LabelEnum.py 路径…」这一项。 */
export function changeEnumPathItem(label: string, currentPath: string): SaveTargetItem {
  return { label, description: currentPath };
}

export interface SaveToAssetsItemsInput {
  targets: SaveTarget[];
  /** 当前生效的枚举文件路径（相对工作区根）。空串 = 还没定过 */
  enumPath: string;
  /** 「修改 LabelEnum.py 路径…」的本地化文案（本模块不依赖 i18n） */
  changePathLabel: string;
}

/**
 * 构造「保存到 assets」的 QuickPick 列表。
 *
 * 不变量（`test_save_to_assets_flow.js` 逐个钉住）：
 *
 * 1. 所有保存目标**永远**都在，且顺序不变；
 * 2. 「改枚举路径」这一项**当且仅当**已经有默认路径时出现 ——
 *    因为"跳过输入框"与"给个改的口子"必须同时成立或同时不成立，
 *    否则就是"问了还多一项"（噪音）或"不问也没法改"（功能丢失）；
 * 3. 它**没有 `target`**，所以点它不会误触发保存。
 */
export function saveToAssetsItems(input: SaveToAssetsItemsInput): SaveTargetItem[] {
  const items: SaveTargetItem[] = input.targets.map((t) => ({
    label: t.label,
    description: t.description,
    target: t.folder,
  }));
  if (!needsEnumPathPrompt(input.enumPath)) {
    items.push(changeEnumPathItem(input.changePathLabel, input.enumPath));
  }
  return items;
}

/**
 * 是否需要**先问一次**枚举路径。
 *
 * - 已经有默认路径（上次保存的 / 项目约定文件里的）→ **不问**。每次保存都要按一次
 *   回车是纯噪音，而且那个值是用户自己定的、或团队约定好的，本来就不该反复确认。
 * - 用户在「修改路径」里**显式清空**了它 → **不问**。那表达的是"这次不生成枚举"；
 *   再问一遍会变成"清空了还被追着问"，用户只能按 Esc 取消整个保存（`decided` 参数）。
 * - 其余（从没定过）→ **必须问**：留空即"不生成枚举"，这是唯一的跳过入口。
 */
export function needsEnumPathPrompt(enumPath: string, decided = false): boolean {
  return !decided && enumPath.trim().length === 0;
}
