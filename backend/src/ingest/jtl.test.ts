import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { parseCsvLine, parseJtlStream } from './jtl.js';
import type { RawSample } from './aggregator.js';

async function parse(text: string, batchSize?: number) {
  const batches: RawSample[][] = [];
  const result = await parseJtlStream(Readable.from([text]), async (b) => { batches.push(b); }, batchSize);
  return { result, batches, samples: batches.flat() };
}

const HEADER = 'timeStamp,elapsed,label,responseCode,responseMessage,threadName,dataType,success,failureMessage,bytes,sentBytes,grpThreads,allThreads,URL,Latency,IdleTime,Connect';

describe('parseCsvLine', () => {
  it('splits plain and quoted fields, unescaping doubled quotes', () => {
    const st = { buf: [] as string[], field: '', inQuote: false };
    expect(parseCsvLine('a,"b,c","say ""hi""",', st)).toEqual(['a', 'b,c', 'say "hi"', '']);
  });

  it('carries a quoted field across lines', () => {
    const st = { buf: [] as string[], field: '', inQuote: false };
    expect(parseCsvLine('1,"first line', st)).toBeNull();
    expect(parseCsvLine('second line",3', st)).toEqual(['1', 'first line\nsecond line', '3']);
    expect(st.inQuote).toBe(false);
  });
});

describe('parseJtlStream (CSV)', () => {
  it('parses a standard JMeter CSV with header', async () => {
    const text = [
      HEADER,
      '1700000000000,120,Login,200,OK,Thread 1-1,text,true,,512,128,1,5,https://shop.test/login,100,0,20',
      '1700000001000,300,Checkout,500,Internal Server Error,Thread 1-2,text,false,Expected 200,256,64,2,6,https://shop.test/checkout,250,0,30',
    ].join('\n');
    const { result, samples } = await parse(text);
    expect(result).toEqual({ total: 2, skipped: 0, startTs: 1700000000000, endTs: 1700000001300, format: 'csv' });
    expect(samples[0]).toMatchObject({ ts: 1700000000000, elapsed: 120, label: 'Login', success: true, responseCode: '200', bytes: 512, sentBytes: 128, latency: 100, connect: 20, url: 'https://shop.test/login', allThreads: 5, failureMessage: null });
    expect(samples[1]).toMatchObject({ label: 'Checkout', success: false, responseCode: '500', failureMessage: 'Expected 200' });
  });

  it('handles quoted labels with commas and messages spanning multiple lines', async () => {
    const text = [
      'timeStamp,elapsed,label,responseCode,responseMessage,success,failureMessage',
      '1700000000000,10,"Search, filtered",200,OK,true,',
      '1700000000500,20,Pay,500,"multi',
      'line ""message""",false,"assertion, failed"',
    ].join('\n');
    const { samples } = await parse(text);
    expect(samples).toHaveLength(2);
    expect(samples[0].label).toBe('Search, filtered');
    expect(samples[1].responseMessage).toBe('multi\nline "message"');
    expect(samples[1].failureMessage).toBe('assertion, failed');
    expect(samples[1].success).toBe(false);
  });

  it('accepts a reordered / reduced header and CRLF line endings', async () => {
    const text = 'label,success,elapsed,timeStamp\r\nHome,TRUE,42,1700000000000\r\n';
    const { samples } = await parse(text);
    expect(samples).toEqual([expect.objectContaining({ label: 'Home', success: true, elapsed: 42, ts: 1700000000000, bytes: null, url: null })]);
  });

  it('defaults success to true when the column is missing', async () => {
    const { samples } = await parse('timeStamp,elapsed,label\n1700000000000,5,A\n');
    expect(samples[0].success).toBe(true);
  });

  it('parses formatted date timestamps', async () => {
    const { samples } = await parse('timeStamp,elapsed,label\n2024-01-02 03:04:05.678,5,A\n');
    expect(samples[0].ts).toBe(new Date('2024-01-02T03:04:05.678').getTime());
  });

  it('uses the default JMeter column order when the file has no header', async () => {
    const { samples, result } = await parse('1700000000000,77,NoHeader,200,OK,T1,text,true,,10,5,1,1,http://x/y,60,0,3\n');
    expect(result.total).toBe(1);
    expect(samples[0]).toMatchObject({ label: 'NoHeader', elapsed: 77, latency: 60, connect: 3, url: 'http://x/y' });
  });

  it('skips rows without a label, timestamp or elapsed and counts them', async () => {
    const text = ['timeStamp,elapsed,label', '1700000000000,5,', 'bad,5,A', '1700000000000,x,A', '1700000000000,5,B'].join('\n');
    const { result, samples } = await parse(text);
    expect(samples.map((s) => s.label)).toEqual(['B']);
    expect(result.skipped).toBe(3);
  });

  it('emits batches of the requested size', async () => {
    const rows = Array.from({ length: 7 }, (_, i) => `${1700000000000 + i},1,T${i}`);
    const { batches, result } = await parse(['timeStamp,elapsed,label', ...rows].join('\n'), 3);
    expect(batches.map((b) => b.length)).toEqual([3, 3, 1]);
    expect(result.total).toBe(7);
  });

  it('returns null start/end for an empty file', async () => {
    const { result } = await parse('\n\n');
    expect(result).toMatchObject({ total: 0, startTs: null, endTs: null });
  });
});

describe('parseJtlStream (XML)', () => {
  it('parses httpSample and sample elements with entity decoding', async () => {
    const text = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<testResults version="1.2">',
      '<httpSample t="150" lt="120" ct="10" ts="1700000000000" s="true" lb="Get &amp; list" rc="200" rm="OK" by="1000" sby="200" na="3"/>',
      '<sample t="40" ts="1700000002000" s="false" lb="Txn" rc="500" rm="&quot;boom&quot;">',
      '</sample>',
      '<httpSample t="x" ts="1700000000000" lb="bad"/>',
      '</testResults>',
    ].join('\n');
    const { result, samples } = await parse(text);
    expect(result.format).toBe('xml');
    expect(result.total).toBe(2);
    expect(result.skipped).toBe(1);
    expect(samples[0]).toMatchObject({ label: 'Get & list', elapsed: 150, latency: 120, connect: 10, success: true, bytes: 1000, sentBytes: 200, allThreads: 3 });
    expect(samples[1]).toMatchObject({ label: 'Txn', success: false, responseCode: '500', responseMessage: '"boom"', bytes: null });
    expect(result.endTs).toBe(1700000002040);
  });
});
