// Quiet by default: heavy console output can corrupt node --test reporting. TEST_VERBOSE=1 to see logs.
if (!process.env.TEST_VERBOSE) { console.log = console.info = console.warn = console.error = () => {}; }
const BACKEND = require("path").join(__dirname, "..", "backend");

const assert = require('assert');
const { encodeQuotePacket, decodeQuotePacket } = require(BACKEND + '/quotePacket');

const payload = {
  '12345': { bid: 101.25, ask: 101.5, ltp: 101.4, hasData: true },
  '67890': { bid: 0, ask: 0, ltp: 0, hasData: false },
};

const buffer = encodeQuotePacket(payload);
const decoded = decodeQuotePacket(buffer);

assert.deepStrictEqual(decoded['12345'], payload['12345']);
assert.deepStrictEqual(decoded['67890'], payload['67890']);
console.log('binary packet test passed');
