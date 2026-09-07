export type TimelineActivity = 'work' | 'idle' | 'break' | 'offline';
export type ActivitySegment = { type: Exclude<TimelineActivity, 'offline'>; startMinute: number; endMinute: number };

// Resolve overlapping attendance and sampled idle evidence before counting.
// Each minute contributes once; breaks take precedence over idle, then work.
export function activityMinutes(segments: ActivitySegment[], start = 0, end = 900) {
  const result = { work: 0, idle: 0, break: 0, offline: 0 };
  const cuts = [...new Set([start, end, ...segments.flatMap(s => [s.startMinute, s.endMinute])])]
    .filter(n => Number.isFinite(n) && n >= start && n <= end).sort((a, b) => a - b);
  for (let i = 1; i < cuts.length; i++) {
    const a = cuts[i - 1], b = cuts[i];
    const matching = segments.filter(s => s.startMinute < b && s.endMinute > a);
    const kind = (['break', 'idle', 'work'] as const).find(type => matching.some(s => s.type === type)) || 'offline';
    result[kind] += b - a;
  }
  return result;
}

export function hourlyHeatmap(segments: ActivitySegment[]) {
  return Array.from({ length: 15 }, (_, hour) => {
    const totals = activityMinutes(segments, hour * 60, (hour + 1) * 60);
    return (['offline', 'break', 'idle', 'work'] as TimelineActivity[])
      .reduce((best, type) => totals[type] > totals[best] ? type : best, 'offline');
  });
}

export function csvCell(value: unknown) {
  const text = String(value ?? '');
  return `"${(/^[\s]*[=+@-]/.test(text) ? "'" : '') + text.replace(/"/g, '""')}"`;
}
