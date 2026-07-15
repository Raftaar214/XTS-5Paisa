const assert = require('assert');
const { parseQuote, getLivePrices } = require('./Marketsocket');

function run() {
  const sample = {
    ExchangeInstrumentID: 12345,
    BidInfo: { Price: 101.25 },
    AskInfo: { Price: 101.5 },
    LastTradedPrice: 101.4
  };

  const result = parseQuote(sample);
  assert.strictEqual(result?.token, '12345');
  assert.strictEqual(result?.bid, 101.25);
  assert.strictEqual(result?.ask, 101.5);
  assert.strictEqual(result?.ltp, 101.4);

  const emptyResult = parseQuote({
    ExchangeInstrumentID: 99999,
    BidInfo: { Price: 0 },
    AskInfo: { Price: 0 },
    LastTradedPrice: 0
  });

  assert.strictEqual(emptyResult?.token, '99999');
  assert.strictEqual(getLivePrices()['99999']?.hasData, false);
  console.log('parseQuote test passed');
}

run();
