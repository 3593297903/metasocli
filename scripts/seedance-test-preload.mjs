// Test-only. The formal CLI still constructs its ordinary provider client.
import { syncBuiltinESMExports } from 'node:module';
import timers from 'node:timers/promises';

const actualFetch = globalThis.fetch;
const fixture = new URL(process.env.METASO_TEST_LOOPBACK);
if (fixture.protocol !== 'http:' || fixture.hostname !== '127.0.0.1') throw Error('Expected loopback fixture');
const origins = new Map([
  ['https://api.yiciyuang.com', 'api'],
  ['https://seedance-cdn.example', 'cdn'],
]);
const wallDate = Date;
let offset = 0;
class FixtureDate extends wallDate {
  constructor(...args) { super(...(args.length ? args : [FixtureDate.now()])); }
  static now() { return wallDate.now() + offset; }
}
globalThis.Date = FixtureDate;
const originalTimer = globalThis.setTimeout;
function accelerated(ms) { return ms >= 1000 && ms <= 60000; }
globalThis.setTimeout = (callback, ms, ...args) => {
  if (!accelerated(ms)) return originalTimer(callback, ms, ...args);
  return originalTimer(() => { offset += ms; callback(...args); }, 5);
};
const originalDelay = timers.setTimeout;
timers.setTimeout = async (ms, ...args) => {
  if (!accelerated(ms)) return originalDelay(ms, ...args);
  await originalDelay(5, ...args);
  offset += ms;
  return args[0];
};
syncBuiltinESMExports();
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : input);
  const origin = origins.get(url.origin);
  if (!origin) throw Error('Unexpected external destination in offline acceptance');
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set('x-fixture-scenario', process.env.METASO_TEST_SCENARIO);
  headers.set('x-fixture-now', String(FixtureDate.now()));
  const reply = await actualFetch(new URL('/' + origin + url.pathname + url.search, fixture), {
    ...init, headers, redirect: 'manual',
  });
  const jump = reply.headers.get('x-fixture-advance-ms');
  if (jump) offset += Number(jump);
  return reply;
};
