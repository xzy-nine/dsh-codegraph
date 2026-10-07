import React from 'react';
import { CheckCircle2, Loader2, AlertTriangle } from 'lucide-react';
import type { ScanProgress, ScanStage } from '../../../core/src/types/index.js';

/**
 * 扫描进度面板。
 *
 * 背景：AST 解析在多端大仓 (数千文件) 上要跑数十秒，此前界面只有一个无限旋转的
 * 转圈图标，用户无法判断"是在工作还是卡死了"。这里把 /api/progress 的阶段、
 * 百分比、已处理/总数、耗时与 ETA 显式呈现出来。
 */

interface ScanProgressPanelProps {
  progress: ScanProgress | null;
  /** 是否仍在扫描中 (用于决定是否显示活动态)。 */
  active: boolean;
}

/** 阶段的中文标签与展示顺序 (用于顶部的步骤条)。 */
const STAGE_ORDER: ScanStage[] = [
  'discovering',
  'hashing',
  'parsing',
  'resolving',
  'compiling',
  'layout',
  'saving',
];

const STAGE_LABEL: Record<ScanStage, string> = {
  idle: '待命',
  discovering: '嗅探工程',
  hashing: '建立基准',
  parsing: '解析 AST',
  resolving: '解析依赖',
  compiling: '编译图谱',
  layout: '计算布局',
  saving: '保存缓存',
  done: '完成',
  error: '失败',
};

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

export const ScanProgressPanel: React.FC<ScanProgressPanelProps> = ({ progress, active }) => {
  if (!progress || progress.stage === 'idle') return null;

  const isError = progress.stage === 'error';
  const isDone = progress.stage === 'done';
  const percent = Math.max(0, Math.min(100, progress.percent));

  // 当前阶段在步骤条中的位置
  const currentIdx = STAGE_ORDER.indexOf(progress.stage);

  return (
    <div className="mb-5 p-3.5 rounded-md bg-dsh-platform border border-dsh-border2">
      {/* 标题行：状态 + 耗时 + ETA */}
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2 min-w-0">
          {isError ? (
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
          ) : isDone ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          ) : (
            <Loader2 className="w-4 h-4 text-dsh-blue animate-spin shrink-0" />
          )}
          <span className="text-[13px] font-semibold text-dsh-primary truncate">
            {isError ? '扫描失败' : isDone ? '扫描完成' : STAGE_LABEL[progress.stage]}
          </span>
          {!isError && !isDone && active && (
            <span className="text-[11px] text-dsh-tertiary shrink-0">
              已用 {formatDuration(progress.elapsedMs)}
              {progress.etaMs && progress.etaMs > 0 ? ` · 预计剩余 ${formatDuration(progress.etaMs)}` : ''}
            </span>
          )}
          {(isDone || isError) && (
            <span className="text-[11px] text-dsh-tertiary shrink-0">用时 {formatDuration(progress.elapsedMs)}</span>
          )}
        </div>
        <span
          className={`text-[12px] font-mono shrink-0 ${
            isError ? 'text-red-400' : isDone ? 'text-emerald-400' : 'text-dsh-blue'
          }`}
        >
          {percent}%
        </span>
      </div>

      {/* 进度条 */}
      <div className="h-1.5 w-full rounded-full bg-dsh-layer3 overflow-hidden mb-2.5">
        <div
          className={`h-full rounded-full transition-all duration-300 ease-out ${
            isError ? 'bg-red-500' : isDone ? 'bg-emerald-500' : 'bg-dsh-blue'
          }`}
          style={{ width: `${percent}%` }}
        />
      </div>

      {/* 当前动作 + 计数 */}
      <div className="flex items-center justify-between text-[11px] text-dsh-secondary mb-2">
        <span className="truncate">{progress.message}</span>
        {progress.total > 0 && (
          <span className="font-mono shrink-0 ml-2">
            {progress.current} / {progress.total}
          </span>
        )}
      </div>

      {/* 阶段步骤条 */}
      {!isError && (
        <div className="flex items-center gap-1 flex-wrap mb-2">
          {STAGE_ORDER.map((s, i) => {
            const passed = isDone || (currentIdx >= 0 && i < currentIdx);
            const isCurrent = !isDone && i === currentIdx;
            return (
              <span
                key={s}
                className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
                  passed
                    ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                    : isCurrent
                    ? 'bg-dsh-blue-tint text-dsh-blue border-dsh-blue-border'
                    : 'bg-dsh-layer2 text-dsh-dimmed border-dsh-border1'
                }`}
              >
                {STAGE_LABEL[s]}
              </span>
            );
          })}
        </div>
      )}

      {/* 失败原因 */}
      {isError && progress.error && (
        <p className="text-[11px] text-red-400 leading-relaxed break-words">{progress.error}</p>
      )}

      {/* 滚动日志 (最近若干条) */}
      {progress.logs && progress.logs.length > 0 && (
        <div className="mt-2 max-h-24 overflow-y-auto rounded bg-dsh-base border border-dsh-border1 p-2 space-y-0.5">
          {progress.logs.slice(-8).map((line, i) => (
            <div key={i} className="text-[10px] font-mono text-dsh-tertiary leading-relaxed truncate">
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
