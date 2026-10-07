import type { EChartsOption } from 'echarts';
import { cssVar } from '@/components/events/meta';
import { categoryLabel, type Insight } from './InsightCard';

const SEVS = [['CRITICAL', 'Critical', '--fail'], ['WARNING', 'Warning', '--warn'], ['INFO', 'Info', '--text-3']] as const;

/** Horizontal stacked bars: insights per category, split by severity (status tokens). */
export function categoryOption(items: Insight[], opts: { theme: string; active: string[] }): EChartsOption {
  void opts.theme;
  const cats = [...new Set(items.map((i) => i.category))];
  const count = (c: string, s: string) => items.filter((i) => i.category === c && i.severity === s).length;
  cats.sort((a, b) => items.filter((i) => i.category === b).length - items.filter((i) => i.category === a).length);
  const surface = cssVar('--surface');
  const dim = (c: string) => (opts.active.length && !opts.active.includes(c) ? 0.3 : 1);
  return {
    legend: { show: true, data: SEVS.map(([, l]) => l), itemWidth: 10, itemHeight: 10 },
    grid: { left: 8, right: 16, top: 28, bottom: 4, containLabel: true },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    xAxis: { type: 'value', minInterval: 1, splitNumber: 4 },
    yAxis: { type: 'category', inverse: true, data: cats.map(categoryLabel), axisLabel: { width: 120, overflow: 'truncate' } },
    series: SEVS.map(([key, label, token]) => ({
      type: 'bar', name: label, stack: 'sev', barMaxWidth: 16, cursor: 'pointer',
      itemStyle: { color: cssVar(token), borderColor: surface, borderWidth: 1 },
      data: cats.map((c) => ({ value: count(c, key) || null, category: c, itemStyle: { opacity: dim(c) } })),
    })) as any,
  };
}
