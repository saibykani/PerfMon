import { describe, expect, it } from 'vitest';
import { classifyError } from './aggregator.js';

describe('classifyError', () => {
  it.each([
    ['Non HTTP response code: java.net.UnknownHostException', null, null, 'DNS'],
    [null, 'Name or service not known', null, 'DNS'],
    ['Non HTTP response code: javax.net.ssl.SSLHandshakeException', null, null, 'SSL'],
    [null, 'PKIX path building failed: certificate', null, 'SSL'],
    ['Non HTTP response code: java.net.SocketTimeoutException', 'Read timed out', null, 'TIMEOUT'],
    [null, null, 'The operation lasted too long: request timeout', 'TIMEOUT'],
    ['Non HTTP response code: org.apache.http.conn.HttpHostConnectException', 'Connection refused', null, 'CONNECTION'],
    [null, 'Connection reset', null, 'CONNECTION'],
    [null, 'org.apache.http.NoHttpResponseException', null, 'CONNECTION'],
    [null, 'ECONNRESET', null, 'CONNECTION'],
    ['500', 'Internal Server Error', null, 'HTTP'],
    ['404', 'Not Found', 'Test failed: code expected to equal 200', 'HTTP'],
    ['200', 'OK', 'Test failed: text expected to contain /Welcome/', 'ASSERTION'],
    [null, null, 'JSON path $.id not found', 'ASSERTION'],
    ['Non HTTP response code: java.lang.IllegalStateException', null, null, 'EXCEPTION'],
    [null, 'something failed with error', null, 'EXCEPTION'],
    ['302', 'Found', null, 'OTHER'],
    [undefined, undefined, undefined, 'OTHER'],
  ] as const)('code=%s message=%s failure=%s → %s', (code, message, failure, expected) => {
    expect(classifyError(code, message, failure)).toBe(expected);
  });

  it('prefers network classes over the HTTP status', () => {
    expect(classifyError('504', 'Gateway timeout')).toBe('TIMEOUT');
  });

  it('is case-insensitive', () => {
    expect(classifyError(null, 'SSL HANDSHAKE ABORTED')).toBe('SSL');
  });
});
