/**
 * 标注交换的纯逻辑：把一张图的标注框**按比例映射**到另一张图的坐标系。
 *
 * 背景：标注管理（`ok_templates/` + 同目录 `coco_annotations.json`）里
 * "哪个分类属于哪张图"是全项目唯一的对应关系，把两张图的标注整套互换是修正常见的
 * "标错了图 / 图片顺序反了"的手段。但标注框存的是**绝对像素坐标**，而
 * ok_templates 里的图片尺寸并不保证一致（截图、导入图混在一起），
 * 所以"把框换个宿主"必须回答一个问题：坐标怎么办。
 *
 * 这里定下的语义是**按比例映射**：`x' = x * W2 / W1`（y / w / h 同理）。
 * - 同尺寸时比值恰为 1，结果与原框逐字段相同 —— 最常见的用法（同分辨率截图互换）
 *   不会因为浮点运算而漂掉一格；
 * - 尺寸不同时保持"框在画面里的相对位置与相对大小"，而不是把框留在越界处；
 * - 映射后一律**钳制进目标图边界**（宽高至少 1px）：越界的框在画布上画不出来、
 *   点不到，只能手改 JSON 才能修 —— 那是最坏的一种"成功"。
 *
 * 为什么单独一个文件：这段逻辑两端各写一遍（VS Code 与 JetBrains），
 * 而它同时被宿主代码与单测消费。塞进 panel 文件就要连带把 `vscode` 拉进单测。
 * 本文件**不 import `vscode`**。
 */

export interface ImageSize {
  width: number;
  height: number;
}

/** 与 `TemplateAssetData.setAnnotationsForImage` 的入参同形：分类名 + 绝对像素框 */
export interface SwapBox {
  category: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 尺寸是否可用于映射。非正数意味着"读不出尺寸"，不能拿来当除数。 */
export function isUsableSize(size: ImageSize | undefined): size is ImageSize {
  return !!size && size.width > 0 && size.height > 0;
}

export function isSameSize(a: ImageSize | undefined, b: ImageSize | undefined): boolean {
  return isUsableSize(a) && isUsableSize(b) && a.width === b.width && a.height === b.height;
}

/**
 * 单轴比例。任一侧尺寸不可用时**退化成 1**，而不是 NaN / Infinity：
 * 读不出尺寸的图不该让整次交换变成一堆 NaN 坐标 —— 宁可原样搬运，也不能写坏数据。
 */
function axisRatio(from: number, to: number): number {
  return from > 0 && to > 0 ? to / from : 1;
}

/** 把框收进目标图边界：宽高至少 1px，左上角随之回退。目标尺寸不可用时原样返回。 */
export function clampBoxToSize(box: SwapBox, to: ImageSize | undefined): SwapBox {
  if (!isUsableSize(to)) return { ...box };
  const w = Math.min(Math.max(1, box.w), to.width);
  const h = Math.min(Math.max(1, box.h), to.height);
  return {
    category: box.category,
    w,
    h,
    x: Math.min(Math.max(0, box.x), to.width - w),
    y: Math.min(Math.max(0, box.y), to.height - h),
  };
}

/** 单个框：按 `from` → `to` 的比例映射，再钳制进 `to` 的边界。 */
export function scaleBox(box: SwapBox, from: ImageSize | undefined, to: ImageSize | undefined): SwapBox {
  const usable = isUsableSize(from);
  const rx = usable ? axisRatio(from.width, to?.width ?? 0) : 1;
  const ry = usable ? axisRatio(from.height, to?.height ?? 0) : 1;
  return clampBoxToSize(
    {
      category: box.category,
      x: Math.round(box.x * rx),
      y: Math.round(box.y * ry),
      w: Math.round(box.w * rx),
      h: Math.round(box.h * ry),
    },
    to,
  );
}

/** 一整张图的标注：逐框映射（分类名原样带走 —— 交换不产生新分类） */
export function scaleBoxes(
  boxes: readonly SwapBox[],
  from: ImageSize | undefined,
  to: ImageSize | undefined,
): SwapBox[] {
  return boxes.map((box) => scaleBox(box, from, to));
}
