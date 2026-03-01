import { useRef, useEffect, useCallback, useState, memo } from 'react';
import type { SegmentState } from '@/types/queue';

const STATUS_COLORS: Record<string, string> = {
  pending: 'var(--color-segment-pending)',
  downloading: 'var(--color-segment-downloading)',
  completed: 'var(--color-segment-completed)',
  retrying: 'var(--color-segment-retrying)',
  failed: 'var(--color-segment-failed)',
};

function resolveCssColor(cssValue: string): string {
  if (!resolveCssColor.cache) resolveCssColor.cache = new Map<string, string>();
  const cached = resolveCssColor.cache.get(cssValue);
  if (cached) return cached;

  const el = document.createElement('div');
  el.style.color = cssValue;
  document.body.appendChild(el);
  const resolved = getComputedStyle(el).color;
  document.body.removeChild(el);
  resolveCssColor.cache.set(cssValue, resolved);
  return resolved;
}
resolveCssColor.cache = null as Map<string, string> | null;

interface SegmentHeatmapProps {
  totalSegments: number;
  segmentStates: Record<string, SegmentState> | undefined;
}

export const SegmentHeatmap = memo(function SegmentHeatmap({ totalSegments, segmentStates }: SegmentHeatmapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);
  const layoutRef = useRef<{ cellW: number; cellH: number; cols: number; gap: number } | null>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || totalSegments <= 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const containerWidth = container.clientWidth;

    // Fixed cell size with gap — always visible as individual cells
    const cellSize = 4;
    const gap = 1;
    const step = cellSize + gap;
    const cols = Math.floor((containerWidth + gap) / step) || 1;
    const rows = Math.ceil(totalSegments / cols);
    // Allow up to 80px of height so the grid is visually distinct
    const maxRows = Math.max(3, Math.ceil(80 / step));
    const visibleRows = Math.min(rows, maxRows);
    const canvasHeight = visibleRows * step - gap;

    layoutRef.current = { cellW: cellSize, cellH: cellSize, cols, gap };

    canvas.width = containerWidth * dpr;
    canvas.height = canvasHeight * dpr;
    canvas.style.width = `${containerWidth}px`;
    canvas.style.height = `${canvasHeight}px`;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, containerWidth, canvasHeight);

    // Resolve CSS variable colors once
    const resolvedColors: Record<string, string> = {};
    for (const [status, cssVar] of Object.entries(STATUS_COLORS)) {
      resolvedColors[status] = resolveCssColor(cssVar);
    }

    // Batch draw by status
    const byColor = new Map<string, number[]>();
    for (let i = 0; i < totalSegments; i++) {
      const state = segmentStates?.[String(i)];
      const status = state?.status || 'pending';
      const color = resolvedColors[status] || resolvedColors.pending;
      if (!byColor.has(color)) byColor.set(color, []);
      byColor.get(color)!.push(i);
    }

    for (const [color, indices] of byColor) {
      ctx.fillStyle = color;
      for (const i of indices) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        if (row >= visibleRows) continue;
        const x = col * step;
        const y = row * step;
        ctx.beginPath();
        ctx.roundRect(x, y, cellSize, cellSize, 1);
        ctx.fill();
      }
    }
  }, [totalSegments, segmentStates]);

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => draw());
    observer.observe(container);
    return () => observer.disconnect();
  }, [draw]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const layout = layoutRef.current;
    if (!canvas || !layout) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const step = layout.cellW + layout.gap;
    const col = Math.floor(x / step);
    const row = Math.floor(y / step);
    const idx = row * layout.cols + col;

    if (idx < 0 || idx >= totalSegments) {
      setTooltip(null);
      return;
    }

    const state = segmentStates?.[String(idx)];
    const status = state?.status || 'pending';
    const attempt = state?.attempt || 0;
    const text = `Segment ${idx}: ${status}${attempt > 1 ? ` (attempt ${attempt})` : ''}`;

    const containerRect = containerRef.current?.getBoundingClientRect();
    const tooltipX = containerRect ? e.clientX - containerRect.left : x;
    setTooltip({ x: tooltipX, y: -24, text });
  }, [totalSegments, segmentStates]);

  const handleMouseLeave = useCallback(() => setTooltip(null), []);

  if (totalSegments <= 0) return null;

  return (
    <div ref={containerRef} className="relative w-full">
      <canvas
        ref={canvasRef}
        className="w-full cursor-crosshair rounded"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      />
      {tooltip && (
        <div
          className="absolute pointer-events-none bg-popover text-popover-foreground text-[10px] px-1.5 py-0.5 rounded shadow-md whitespace-nowrap z-10"
          style={{ left: Math.min(tooltip.x, (containerRef.current?.clientWidth || 200) - 120), top: tooltip.y }}
        >
          {tooltip.text}
        </div>
      )}
    </div>
  );
});
