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

export interface SeamResult {
  /** 优化后的循环起点（采样点，含） */
  startSample: number;
  /** 优化后的循环终点（采样点，不含） */
  endSample: number;
  /** 归一化代价值，越小接缝越平滑 */
  cost: number;
}

/**
 * 在用户粗选的两个边界附近搜索最佳接缝点对。
 *
 * 接缝代价 = Σ声道 ( |x[s] − x[e−1]| / RMS幅值
 *                  + w · |前向斜率(s) − 后向斜率(e)| / RMS斜率 )
 *
 * 其中前向斜率取 s 之后 W 个采样点的平均变化率，
 * 后向斜率取 e 之前 W 个采样点的平均变化率。
 * 搜索采用「粗网格 + 局部细化」两级策略，半径很大时也能在毫秒内完成。
 */
export function findBestSeam(
  audio: AudioDataLike,
  roughStart: number,
  roughEnd: number,
  options: SeamSearchOptions,
): SeamResult {
  const W = Math.max(4, Math.round(options.slopeWindow ?? 32));
  const slopeWeight = options.slopeWeight ?? 1;
  const minLoop = Math.max(2, Math.round(options.minLoopSamples ?? 64));
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
  if (sCount <= 0 || eCount <= 0) {
    return { startSample: clamp(Math.round(roughStart), 0, len - 2), endSample: clamp(Math.round(roughEnd), 1, len), cost: NaN };
  }

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

  // ---- 第一级：粗网格搜索（总评估数控制在 ~30 万以内）----
  const totalPairs = sCount * eCount;
  const stride = Math.max(1, Math.round(Math.sqrt(totalPairs / 300_000)));
  let best = Infinity;
  let bi = 0;
  let bj = 0;
  let found = false;
  for (let i = 0; i < sCount; i += stride) {
    const sIdx = sLo + i;
    for (let j = 0; j < eCount; j += stride) {
      if (eLo + j - sIdx < minLoop) continue;
      const c = pairCost(i, j);
      if (c < best) {
        best = c;
        bi = i;
        bj = j;
        found = true;
      }
    }
  }

  // ---- 第二级：在最优点 ±stride 内逐采样点细化 ----
  if (found && stride > 1) {
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
          bi = i;
          bj = j;
        }
      }
    }
  }

  if (!found) {
    return { startSample: clamp(Math.round(roughStart), 0, len - 2), endSample: clamp(Math.round(roughEnd), 1, len), cost: NaN };
  }
  return { startSample: sLo + bi, endSample: eLo + bj, cost: best };
}
