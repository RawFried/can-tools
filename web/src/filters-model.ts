/**
 * 滤波器推导（纯函数、零 DOM、零 state）：区间 → 最小对齐块 → SJA1000 验收滤波。
 * 只依赖 types，可独立测试。
 */
import type { AcceptanceFilterDto, SoftwareFilterDto } from './types';

/**
 * 区间列表可用单一前缀掩码表达时的公共信息。
 */
export interface RangeBlock {
  /** 是否扩展帧（决定位布局）。 */
  extended: boolean;
  /** 最小覆盖块下界（含）。 */
  blockStart: number;
  /** 最小覆盖块上界（含）。 */
  blockEnd: number;
}

/**
 * 求覆盖全部区间的最小 2 的幂对齐块（区间并集的超集）。
 *
 * 空列表或混合标准/扩展帧时返回 null：单滤波器无法同时表达两种帧类型。
 */
export function rangeBlock(ranges: SoftwareFilterDto[]): RangeBlock | null {
  if (ranges.length === 0) return null;
  const hasStd = ranges.some((r) => !r.extended);
  const hasExt = ranges.some((r) => r.extended);
  if (hasStd && hasExt) return null;

  let lo = ranges[0].start;
  let hi = ranges[0].end;
  for (const r of ranges) {
    if (r.start < lo) lo = r.start;
    if (r.end > hi) hi = r.end;
  }

  /* span 的位宽决定 blockSize；blockStart 为 blockSize 对齐下界，则
   * [blockStart, blockStart+blockSize-1] ⊇ [lo, hi]。
   * 自检（标准帧 0x100–0x1FF）：span = 0x0FF → blockSize = 0x100 → blockStart = 0x100。 */
  const span = lo ^ hi;
  const blockSize = span === 0 ? 1 : 2 ** (32 - Math.clz32(span));
  const blockStart = lo - (lo % blockSize);
  return {
    extended: hasExt,
    blockStart,
    blockEnd: blockStart + blockSize - 1,
  };
}

/**
 * 由区间列表推导硬件验收滤波。
 *
 * 超集安全：硬件滤波只是接收前的粗筛，多放行的帧没有副作用——软件滤波随后
 * 按「帧类型一致且 start ≤ id ≤ end」精筛，任一区间命中才保留。因此这里只需
 * 推导出一个覆盖全部区间的对齐块，不必与区间完全一致；无法用单个前缀掩码
 * 表达（如混合标准/扩展帧）时退化为接收全部，同样交给软件精筛。
 */
export function deriveAcceptanceFilter(ranges: SoftwareFilterDto[]): AcceptanceFilterDto {
  const block = rangeBlock(ranges);
  if (block === null) {
    /* 空列表 = 接收全部；混合帧类型也无法用单滤波器表达。acc_mask 全 1 时
     * 任何帧都能通过，与 mode 0 等价。 */
    return { acc_code: 0, acc_mask: 0xffffffff, mode: 0 };
  }

  /* SJA1000 单滤波器位布局：标准帧 ID 占高 11 位（<<21），扩展帧占高 29 位（<<3）；
   * 其余低位（RTR/数据位等）经 baseMask 全部设为不关心。只有块内位是不关心位：
   * acc_mask = (blockSize-1) << shift | baseMask。
   * 自检（标准帧 0x100–0x1FF）：acc_code = 0x20000000、acc_mask = 0x1FFFFFFF，
   * 硬件恰好放行 [0x100, 0x1FF]。 */
  const shift = block.extended ? 3 : 21;
  const baseMask = block.extended ? 0x00000007 : 0x001fffff;
  const blockSize = block.blockEnd - block.blockStart + 1;

  /* 32 位无符号运算：扩展帧大块的 (blockSize-1)<<3 可能越过符号位，>>> 0 归一化 */
  return {
    acc_code: (block.blockStart << shift) >>> 0,
    acc_mask: (((blockSize - 1) << shift) | baseMask) >>> 0,
    mode: 1,
  };
}
