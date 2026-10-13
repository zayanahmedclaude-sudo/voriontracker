import { timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getHealthReport, renderPrometheusMetrics } from '@/lib/health';

export const dynamic = 'force-dynamic';

// Prometheus scrape endpoint. Requires `Authorization: Bearer $METRICS_TOKEN`;
// disabled entirely when METRICS_TOKEN is not set.
export async function GET(req: NextRequest) {
  const secret = process.env.METRICS_TOKEN || '';
  const actual = Buffer.from(req.headers.get('authorization') || '');
  const expected = Buffer.from(`Bearer ${secret}`);
  if (!secret || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const report = await getHealthReport({ includePrometheus: false });
    return new NextResponse(renderPrometheusMetrics(report), {
      status: 200,
      headers: { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  } catch (e: any) {
    console.error('GET /api/metrics error:', e?.message || e);
    return new NextResponse('vorion_health_status 0\n', { status: 500, headers: { 'Content-Type': 'text/plain; version=0.0.4' } });
  }
}
