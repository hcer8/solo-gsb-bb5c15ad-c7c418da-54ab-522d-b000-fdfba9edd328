import type { AudioDataLike } from './types';

export interface SeamSearchOptions {
  /** 在每个边界两侧搜索的半径（采样点） */
  radiusSamples: number;
  /** 短窗斜率估计窗口长度（采样点），默认 32 */
  slopeWindow?: number;
  /** 斜率差相对幅值差的权重，默认 1 */
  slopeWeight?: number;
  /** 允许的最短循环长度（采样点），默认 64 */
  minLoopSamples?: number;
}

export interface SeamCandidateOptions extends SeamSearchOptions {
  /** 返回的候选数量上限，默认 5 */
  maxCandidates?: number;
  /**
   * 去重阈值（采样点）：两个候选的起点与终点相距均不足该值时视为同一接缝，
   * 只保留代价更低者，避免同一局部极小值占满列表。默认 0（不去重）。
   */
  dedupeSamples?: number;
}

export interface SeamResult {
  /** 优化后的循环起点（采样点，含） */
  startSample: number;
  /** 优化后的循环终点（采样点，不含） */
  endSample: number;
  /** 归一化代价值，越小接缝越平滑 */
  cost: number;
}

/**
 * 在用户粗选的两个边界附近搜索代价最低的若干接缝点对（按代价升序）。
 *
 * 接缝代价 = Σ声道 ( |x[s] − x[e−1]| / RMS幅值
 *                  + w · |前向斜率(s) − 后向斜率(e)| / RMS斜率 )
 *
 * 其中前向斜率取 s 之后 W 个采样点的平均变化率，
 * 后向斜率取 e 之前 W 个采样点的平均变化率。
 * 搜索采用「粗网格 + 局部细化」两级策略，半径很大时也能在毫秒内完成。
 *
 * 粗网格阶段维护一份按「起止点均相距不足 dedupeSamples」去重的优选列表，
 * 使进入细化阶段的候选分布在不同的局部极小值上；细化后再次去重，
 * 最终返回代价最低的前 maxCandidates 个。
 */
export function findSeamCandidates(
  audio: AudioDataLike,
  roughStart: number,
  roughEnd: number,
  options: SeamCandidateOptions,
): SeamResult[] {
  const W = Math.max(4, Math.round(options.slopeWindow ?? 32));
  const slopeWeight = options.slopeWeight ?? 1;
  const minLoop = Math.max(2, Math.round(options.minLoopSamples ?? 64));
  const maxCandidates = Math.max(1, Math.round(options.maxCandidates ?? 5));
  const dedupe = Math.max(0, Math.round(options.dedupeSamples ?? 0));
  const len = audio.length;
  const nCh = audio.numberOfChannels;
  const data: Float32Array[] = [];
  for (let c = 0; c < nCh; c++) data.push(audio.getChannelData(c));

  // ---- 归一化尺度：全信号幅值 RMS 与一阶差分 RMS（抽样估计）----
  let sumV = 0;
  let sumD = 0;
  let cnt = 0;
  const probeStep = Math.max(1, Math.floor(len / 65536));
  for (let i = probeStep; i < len; i += probeStep) {
    for (let c = 0; c < nCh; c++) {
      const x = data[c][i];
      sumV += x * x;
      const d = x - data[c][i - 1];
      sumD += d * d;
    }
    cnt += nCh;
  }
  const rmsV = Math.sqrt(sumV / Math.max(1, cnt)) || 1;
  const rmsD = Math.sqrt(sumD / Math.max(1, cnt)) || 1;

  // ---- 候选范围（保证斜率窗口不越界）----
  const r = Math.max(0, Math.round(options.radiusSamples));
  const lo = W + 1;
  const hi = len - W - 2;
  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(v, b));
  const sLo = clamp(Math.round(roughStart) - r, lo, hi);
  const sHi = clamp(Math.round(roughStart) + r, lo, hi);
  const eLo = clamp(Math.round(roughEnd) - r, lo + 1, len - 1);
  const eHi = clamp(Math.round(roughEnd) + r, lo + 1, len - 1);

  const sCount = sHi - sLo + 1;
  const eCount = eHi - eLo + 1;
  if (sCount <= 0 || eCount <= 0) return [];

  // ---- 预计算候选点特征（归一化后的幅值与短窗斜率）----
  const sVal: Float32Array[] = [];
  const sSlope: Float32Array[] = [];
  const eVal: Float32Array[] = [];
  const eSlope: Float32Array[] = [];
  for (let c = 0; c < nCh; c++) {
    const x = data[c];
    const sv = new Float32Array(sCount);
    const ss = new Float32Array(sCount);
    for (let i = 0; i < sCount; i++) {
      const idx = sLo + i;
      sv[i] = x[idx] / rmsV;
      ss[i] = (x[idx + W] - x[idx]) / W / rmsD;
    }
    const ev = new Float32Array(eCount);
    const es = new Float32Array(eCount);
    for (let j = 0; j < eCount; j++) {
      const idx = eLo + j;
      ev[j] = x[idx - 1] / rmsV;
      es[j] = (x[idx - 1] - x[idx - 1 - W]) / W / rmsD;
    }
    sVal.push(sv);
    sSlope.push(ss);
    eVal.push(ev);
    eSlope.push(es);
  }

  const pairCost = (si: number, ei: number): number => {
    let c = 0;
    for (let ch = 0; ch < nCh; ch++) {
      c += Math.abs(sVal[ch][si] - eVal[ch][ei]);
      c += slopeWeight * Math.abs(sSlope[ch][si] - eSlope[ch][ei]);
    }
    return c;
  };

  // ---- 去重 + 按代价升序的有界列表 ----
  const isDup = (a: SeamResult, b: SeamResult): boolean =>
    Math.abs(a.startSample - b.startSample) < dedupe &&
    Math.abs(a.endSample - b.endSample) < dedupe;

  /** 向按代价升序的列表插入候选；与既有项重复时只保留更优者，超出容量截断 */
  const insertSorted = (list: SeamResult[], cand: SeamResult, cap: number): void => {
    // 去重关系不具备传递性，需扫描整个列表：移除所有比新候选差的重复项；
    // 若存在不劣于新候选的重复项则直接丢弃
    for (let k = list.length - 1; k >= 0; k--) {
      if (isDup(list[k], cand)) {
        if (cand.cost < list[k].cost - 1e-12) {
          list.splice(k, 1);
        } else {
          return;
        }
      }
    }
    let pos = list.length;
    while (pos > 0 && list[pos - 1].cost > cand.cost) pos--;
    list.splice(pos, 0, cand);
    if (list.length > cap) list.length = cap;
  };

  // ---- 第一级：粗网格搜索（总评估数控制在 ~30 万以内）----
  // 优选列表容量放宽到候选数的数倍，让不同局部极小值都有机会进入细化
  const totalPairs = sCount * eCount;
  const stride = Math.max(1, Math.round(Math.sqrt(totalPairs / 300_000)));
  const coarseCap = Math.max(maxCandidates * 3, 12);
  const coarse: SeamResult[] = [];
  for (let i = 0; i < sCount; i += stride) {
    const sIdx = sLo + i;
    for (let j = 0; j < eCount; j += stride) {
      if (eLo + j - sIdx < minLoop) continue;
      const c = pairCost(i, j);
      if (coarse.length >= coarseCap && c >= coarse[coarse.length - 1].cost) continue;
      insertSorted(coarse, { startSample: sIdx, endSample: eLo + j, cost: c }, coarseCap);
    }
  }

  // ---- 第二级：每个粗候选在 ±stride 内逐采样点细化，汇总后再去重 ----
  const refined: SeamResult[] = [];
  for (const seed of coarse) {
    const bi = seed.startSample - sLo;
    const bj = seed.endSample - eLo;
    let best = seed.cost;
    let bestI = bi;
    let bestJ = bj;
    if (stride > 1) {
      const iFrom = Math.max(0, bi - stride);
      const iTo = Math.min(sCount - 1, bi + stride);
      const jFrom = Math.max(0, bj - stride);
      const jTo = Math.min(eCount - 1, bj + stride);
      for (let i = iFrom; i <= iTo; i++) {
        const sIdx = sLo + i;
        for (let j = jFrom; j <= jTo; j++) {
          if (eLo + j - sIdx < minLoop) continue;
          const c = pairCost(i, j);
          if (c < best) {
            best = c;
            bestI = i;
            bestJ = j;
          }
        }
      }
    }
    insertSorted(refined, { startSample: sLo + bestI, endSample: eLo + bestJ, cost: best }, maxCandidates);
  }

  return refined;
}

/**
 * 只取最优接缝的便捷入口（等价于 findSeamCandidates 的第一名）。
 * 搜索空间无效或未找到满足最短循环长度的点对时，回退为粗选边界且代价为 NaN。
 */
export function findBestSeam(
  audio: AudioDataLike,
  roughStart: number,
  roughEnd: number,
  options: SeamSearchOptions,
): SeamResult {
  const results = findSeamCandidates(audio, roughStart, roughEnd, { ...options, maxCandidates: 1 });
  if (results.length > 0) return results[0];
  const len = audio.length;
  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(v, b));
  return { startSample: clamp(Math.round(roughStart), 0, len - 2), endSample: clamp(Math.round(roughEnd), 1, len), cost: NaN };
}
