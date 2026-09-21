/**
 * 「保存到 assets」这一步的**纯逻辑**：目标列表怎么排、枚举的路径与类名怎么给入口。
 *
 * 为什么单独抽一个不 import `vscode` 的模块：这段是**看起来像 UI、其实是数据约定**
 * 的东西（与 `projectConfigPure.ts` 同一个理由）。几条不变量改错都很难发现：
 *
 * 1. **保存目标永远在，且顺序不变** —— 它们是这个对话框存在的理由。
 * 2. **「枚举路径」「枚举类名」两行永远在，且都没有 `target`** ——
 *    用户要能在**点保存的这一步**就把这两项设好，不必先去设置界面找
 *    （设置界面里确实有，但要先知道有它、还要找到它）。
 *    用 `target` 的有无当"能不能保存"的判别式，于是"点错就误保存"在类型上就不可能：
 *    没有 `target` 的项没有目标可写。
 * 3. **首次仍然会先问一次路径**（见 [needsEnumPathPrompt]）——
 *    "不问"会让从没配过的用户**静默拿不到枚举文件**，而唯一的入口藏在一个可点的行里。
 *    这两件事（问了 + 也有行）并存是**刻意的**：问一次保证不会漏，行保证之后随时能改。
 *
 * 而面板流程本身（QuickPick + InputBox + webview）在普通 Node 测试里跑不起来，
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

/** 点一行之后要改哪个字段。 */
export type EnumEditField = 'enumPath' | 'enumName';

/**
 * QuickPick 的一项。
 *
 * 三类，互斥：
 * - **保存目标**：有 `target`（绝对目录）。选中它 = 按这个目录保存。
 * - **改枚举字段**：有 `edit`，没有 `target`。选中它 = 弹输入框，改完**回到列表**。
 * - **分隔线**：`separator: true`。VS Code 里不可选中，只用来把两组分开。
 */
export interface SaveTargetItem {
  label: string;
  description?: string;
  /** 保存目标的绝对目录。**只有保存目标才有** */
  target?: string;
  /** 点它去改这个字段（与 `target` 互斥） */
  edit?: EnumEditField;
  /** 分组分隔线 */
  separator?: boolean;
}

/** 本模块不依赖 i18n，文案由调用方传入。 */
export interface EnumFieldLabels {
  /** 「枚举文件路径」 */
  path: string;
  /** 「枚举类名」 */
  name: string;
  /** 路径还没定过时的说明：「未设置 —— 点这里设置」 */
  notSet: string;
  /** 类名还没设过时的说明：「由文件名推导」 */
  derived: string;
}

export interface SaveToAssetsItemsInput {
  targets: SaveTarget[];
  /** 当前**生效**的枚举文件路径（相对工作区根）。空串 = 还没定过 */
  enumPath: string;
  /** 我设过的枚举类名。空串 = 没设过（跟随项目约定 / 由文件名推导） */
  enumName: string;
  labels: EnumFieldLabels;
}

/** 一行「改枚举字段」的项。 */
export function enumFieldItem(field: EnumEditField, label: string, current: string, empty: string): SaveTargetItem {
  return { label, description: current || empty, edit: field };
}

/** 分组分隔线。 */
export function separatorItem(): SaveTargetItem {
  return { label: '', separator: true };
}

/**
 * 构造「保存到 assets」的 QuickPick 列表。
 *
 * 顺序固定：**保存目标 → 分隔线 → 枚举路径 → 枚举类名**。
 * 目标在前是因为"保存"才是这一步的主意图；两项枚举设置放末尾，扫一眼就知道有、又不会
 * 挡在目标前面。值直接写在 `description` 里 —— 用户得知道现在用的是什么，才知道要不要改。
 */
export function saveToAssetsItems(input: SaveToAssetsItemsInput): SaveTargetItem[] {
  const items: SaveTargetItem[] = input.targets.map((t) => ({
    label: t.label,
    description: t.description,
    target: t.folder,
  }));
  items.push(separatorItem());
  items.push(enumFieldItem('enumPath', input.labels.path, input.enumPath, input.labels.notSet));
  items.push(enumFieldItem('enumName', input.labels.name, input.enumName, input.labels.derived));
  return items;
}

/**
 * 首次保存时给路径输入框预填的**推导值**：`<目标目录>/LabelEnum.py`。
 *
 * 为什么需要一个推导值：从没配过的用户按回车就得到这个路径，而不是拿到一个空输入框
 * （空输入框的语义是"这次不生成枚举"，不该是默认选项）。
 * 它是个**推导**出来的值、不是谁设过的值，所以只用来预填，不直接写进设置 ——
 * 用户回车确认之后才由调用方落盘。
 */
export function derivedEnumPath(targetLabel: string): string {
  const dir = targetLabel.replace(/\\/g, '/').replace(/\/+$/, '');
  return dir ? `${dir}/LabelEnum.py` : 'LabelEnum.py';
}

/**
 * 是否需要**先问一次**枚举路径。
 *
 * - 已经有生效路径（个人偏好 / 项目约定）→ **不问**。每次保存都要按一次回车是纯噪音，
 *   而且那个值是用户自己定的、或团队约定好的，本来就不该反复确认。
 * - 用户在「改路径」里**显式清空**了它 → **不问**。那表达的是"这次不生成枚举"；
 *   再问一遍会变成"清空了还被追着问"，用户只能按 Esc 取消整个保存（`decided` 参数）。
 * - 其余（从没定过）→ **必须问**：留空即"不生成枚举"，这是唯一的跳过入口。
 */
export function needsEnumPathPrompt(enumPath: string, decided = false): boolean {
  return !decided && enumPath.trim().length === 0;
}
