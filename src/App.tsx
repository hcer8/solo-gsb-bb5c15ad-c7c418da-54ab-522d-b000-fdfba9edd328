import { useCallback, useEffect, useRef, useState } from 'react';
import { Waveform, type Region } from './components/Waveform';
import { LoopPlayer } from './audio/player';
import { decodeAudioFile } from './audio/decode';
import { findBestSeam, type SeamResult } from './audio/loopFinder';
import { buildLoopPcm } from './audio/loopBuffer';
import { encodeWav, wavFileSize } from './audio/wavExport';
import { fmtBytes, fmtTime } from './utils/format';

const SLOPE_WINDOW = 32;
const SLOPE_WEIGHT = 1;
const MIN_LOOP_SECONDS = 0.05;

type PlayTarget = 'original' | 'optimized';

export default function App() {
  const [fileName, setFileName] = useState('');
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [selection, setSelection] = useState<Region | null>(null);
  const [seam, setSeam] = useState<SeamResult | null>(null);
  const [seamRadiusMs, setSeamRadiusMs] = useState<number | null>(null);
  const [radiusMs, setRadiusMs] = useState(50);
  const [crossfadeMs, setCrossfadeMs] = useState(20);
  const [playing, setPlaying] = useState<PlayTarget | null>(null);
  const [status, setStatus] = useState('请导入 WAV / MP3 音频文件（音频仅在本地浏览器处理，不会上传）。');
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const playerRef = useRef<LoopPlayer | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const getPlayer = (): LoopPlayer => {
    if (!playerRef.current) playerRef.current = new LoopPlayer();
    return playerRef.current;
  };

  // 卸载时停止播放
  useEffect(() => {
    return () => {
      playerRef.current?.stop();
    };
  }, []);

  const handleFile = useCallback(async (file: File) => {
    setBusy(true);
    setStatus('解码中…');
    try {
      const player = getPlayer();
      const buf = await decodeAudioFile(file, player.getContext());
      player.stop();
      setPlaying(null);
      setBuffer(buf);
      setFileName(file.name);
      setSelection(null);
      setSeam(null);
      setSeamRadiusMs(null);
      setStatus(
        `已加载：${file.name} — ${buf.sampleRate} Hz / ${buf.numberOfChannels} 声道 / 时长 ${fmtTime(buf.duration)}。请在波形上框选大致循环区间。`,
      );
    } catch {
      setStatus('解码失败：请使用 WAV / MP3 等浏览器支持的音频格式。');
    } finally {
      setBusy(false);
    }
  }, []);

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
    e.target.value = '';
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  const onSelectionChange = useCallback((region: Region) => {
    setSelection(region);
    setSeam(null);
    setSeamRadiusMs(null);
  }, []);

  /** 执行接缝搜索；返回结果（失败返回 null） */
  const runSearch = useCallback((): SeamResult | null => {
    if (!buffer || !selection) {
      setStatus('请先在波形上框选大致循环区间。');
      return null;
    }
    const sr = buffer.sampleRate;
    const startS = selection.start * sr;
    const endS = selection.end * sr;
    if (endS - startS < MIN_LOOP_SECONDS * sr) {
      setStatus('选区太短，请框选更长的循环区间。');
      return null;
    }
    const maxRadius = Math.max(1, (endS - startS) / 2 - 64);
    const radius = Math.min((radiusMs / 1000) * sr, maxRadius);
    const result = findBestSeam(buffer, startS, endS, {
      radiusSamples: radius,
      slopeWindow: SLOPE_WINDOW,
      slopeWeight: SLOPE_WEIGHT,
    });
    setSeam(result);
    setSeamRadiusMs(radiusMs);
    const dStart = ((result.startSample - startS) / sr) * 1000;
    const dEnd = ((result.endSample - endS) / sr) * 1000;
    setStatus(
      `接缝搜索完成：起点移动 ${dStart >= 0 ? '+' : ''}${dStart.toFixed(1)} ms，终点移动 ${dEnd >= 0 ? '+' : ''}${dEnd.toFixed(1)} ms，代价 ${result.cost.toFixed(4)}。`,
    );
    return result;
  }, [buffer, selection, radiusMs]);

  const playOriginal = useCallback(async () => {
    if (!buffer || !selection) {
      setStatus('请先框选循环区间。');
      return;
    }
    const sr = buffer.sampleRate;
    const pcm = buildLoopPcm(buffer, selection.start * sr, selection.end * sr, 0);
    await getPlayer().play(pcm);
    setPlaying('original');
  }, [buffer, selection]);

  const playOptimized = useCallback(async () => {
    if (!buffer) return;
    let s = seam;
    if (!s || seamRadiusMs !== radiusMs) {
      s = runSearch();
    }
    if (!s) return;
    const pcm = buildLoopPcm(buffer, s.startSample, s.endSample, (crossfadeMs / 1000) * buffer.sampleRate);
    await getPlayer().play(pcm);
    setPlaying('optimized');
  }, [buffer, seam, seamRadiusMs, radiusMs, crossfadeMs, runSearch]);

  const stopPlayback = useCallback(() => {
    getPlayer().stop();
    setPlaying(null);
  }, []);

  // 交叉淡化时长变化时，若正在试听优化区间则实时重建并继续播放
  const crossfadeRef = useRef(crossfadeMs);
  useEffect(() => {
    if (crossfadeRef.current === crossfadeMs) return;
    crossfadeRef.current = crossfadeMs;
    if (playing === 'optimized') void playOptimized();
  }, [crossfadeMs, playing, playOptimized]);

  const exportJson = useCallback(() => {
    if (!buffer || !selection || !seam) return;
    const sr = buffer.sampleRate;
    const payload = {
      file: fileName,
      sampleRate: sr,
      channels: buffer.numberOfChannels,
      durationSec: buffer.duration,
      original: {
        startSec: selection.start,
        endSec: selection.end,
        startSample: Math.round(selection.start * sr),
        endSample: Math.round(selection.end * sr),
      },
      optimized: {
        startSec: seam.startSample / sr,
        endSec: seam.endSample / sr,
        startSample: seam.startSample,
        endSample: seam.endSample,
      },
      loopDurationSec: (seam.endSample - seam.startSample) / sr,
      parameters: {
        searchRadiusMs: radiusMs,
        crossfadeMs,
        slopeWindowSamples: SLOPE_WINDOW,
        slopeWeight: SLOPE_WEIGHT,
      },
      seamCost: seam.cost,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileName.replace(/\.[^.]+$/, '') || 'loop'}.loop.json`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus('已导出 JSON（包含最终起止时间与搜索参数）。');
  }, [buffer, selection, seam, fileName, radiusMs, crossfadeMs]);

  const exportWav = useCallback(() => {
    if (!buffer || !seam) return;
    const pcm = buildLoopPcm(buffer, seam.startSample, seam.endSample, (crossfadeMs / 1000) * buffer.sampleRate);
    const wav = encodeWav(pcm);
    const blob = new Blob([wav], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileName.replace(/\.[^.]+$/, '') || 'loop'}.loop.wav`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus(`已导出 WAV：16-bit PCM，含 smpl 循环区块（0 → 最后一帧），共 ${fmtBytes(wav.byteLength)}。`);
  }, [buffer, seam, crossfadeMs, fileName]);

  const seamStale = seam !== null && seamRadiusMs !== null && seamRadiusMs !== radiusMs;
  const sr = buffer?.sampleRate ?? 44100;

  // 导出 WAV 的帧数与预计大小（与 buildLoopPcm 的边界夹取逻辑保持一致；
  // 交叉淡化只改写接缝区域，不改变总帧数）
  let wavFrames = 0;
  let wavBytes = 0;
  if (buffer && seam) {
    const len = buffer.length;
    const s = Math.max(0, Math.min(Math.round(seam.startSample), len - 2));
    const e = Math.max(s + 2, Math.min(Math.round(seam.endSample), len));
    wavFrames = e - s;
    wavBytes = wavFileSize(wavFrames, buffer.numberOfChannels);
  }

  return (
    <div className="app">
      <header className="header">
        <h1>无缝循环接缝查找器</h1>
        <p>本地浏览器内分析音频，在粗选边界附近搜索幅值与短窗斜率最连续的接缝点，可 A/B 对比试听并导出参数。</p>
      </header>

      <section
        className={`dropzone${dragOver ? ' dragover' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*,.wav,.mp3"
          style={{ display: 'none' }}
          onChange={onInputChange}
        />
        <strong>{busy ? '解码中…' : fileName || '点击选择或拖入 WAV / MP3 文件'}</strong>
        <span>{fileName ? '点击可重新选择文件' : '音频不会上传，全部在本地处理'}</span>
      </section>

      {buffer && (
        <>
          <Waveform buffer={buffer} selection={selection} optimized={seam ? {
            start: seam.startSample / sr,
            end: seam.endSample / sr,
          } : null} onSelectionChange={onSelectionChange} />
          <div className="legend">
            <span><i className="swatch swatch-handle" /> 选区边界（可拖动）</span>
            <span><i className="swatch swatch-seam" /> 优化后的接缝位置</span>
          </div>

          <section className="panel">
            <div className="sliders">
              <label>
                <span>搜索半径：<b>{radiusMs} ms</b>{seamStale && <em className="stale">（已修改，请重新查找）</em>}</span>
                <input
                  type="range"
                  min={5}
                  max={500}
                  step={5}
                  value={radiusMs}
                  onChange={(e) => setRadiusMs(Number(e.target.value))}
                />
              </label>
              <label>
                <span>交叉淡化：<b>{crossfadeMs} ms</b></span>
                <input
                  type="range"
                  min={0}
                  max={500}
                  step={5}
                  value={crossfadeMs}
                  onChange={(e) => setCrossfadeMs(Number(e.target.value))}
                />
              </label>
            </div>

            <div className="transport">
              <button className="primary" onClick={() => runSearch()}>查找接缝</button>
              <button
                className={playing === 'original' ? 'active' : ''}
                onClick={() => (playing === 'original' ? stopPlayback() : void playOriginal())}
              >
                {playing === 'original' ? '■ 停止' : '▶ 试听原区间'}
              </button>
              <button
                className={playing === 'optimized' ? 'active' : ''}
                onClick={() => (playing === 'optimized' ? stopPlayback() : void playOptimized())}
              >
                {playing === 'optimized' ? '■ 停止' : '▶ 试听优化区间'}
              </button>
              <button onClick={stopPlayback} disabled={playing === null}>停止</button>
              <button onClick={exportJson} disabled={!seam || !selection}>下载 JSON</button>
              <button onClick={exportWav} disabled={!seam}>下载 WAV</button>
            </div>

            {seam && buffer && (
              <p className="export-info">
                WAV 导出：{buffer.sampleRate} Hz · {buffer.numberOfChannels} 声道 ·{' '}
                {wavFrames.toLocaleString()} 帧 · 预计 {fmtBytes(wavBytes)}
                （16-bit PCM，含 smpl 循环区块）
              </p>
            )}
          </section>

          <section className="panel info">
            <table>
              <thead>
                <tr>
                  <th></th>
                  <th>起点</th>
                  <th>终点</th>
                  <th>循环时长</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>原区间</td>
                  <td>{selection ? fmtTime(selection.start) : '—'}</td>
                  <td>{selection ? fmtTime(selection.end) : '—'}</td>
                  <td>{selection ? fmtTime(selection.end - selection.start) : '—'}</td>
                </tr>
                <tr className="optimized-row">
                  <td>优化区间</td>
                  <td>{seam ? fmtTime(seam.startSample / sr) : '—'}</td>
                  <td>{seam ? fmtTime(seam.endSample / sr) : '—'}</td>
                  <td>{seam ? fmtTime((seam.endSample - seam.startSample) / sr) : '—'}</td>
                </tr>
              </tbody>
            </table>
            {seam && (
              <p className="cost">接缝代价：{seam.cost.toFixed(4)}（越小越平滑） · 淡化 {crossfadeMs} ms · 半径 {seamRadiusMs} ms</p>
            )}
          </section>
        </>
      )}

      <p className="status">{status}</p>

      <footer className="footer">
        所有音频处理均在浏览器本地完成（Web Audio API），不会上传任何数据。
      </footer>
    </div>
  );
}
