const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

function encodeQuotePacket(quotes) {
  const entries = Object.entries(quotes || {});
  if (!entries.length) return Buffer.from([0]);

  const parts = [];
  let totalLength = 1;

  for (const [token, q] of entries) {
    const tokenBytes = Buffer.from(TEXT_ENCODER.encode(token));
    const payload = JSON.stringify(q);
    const payloadBytes = Buffer.from(TEXT_ENCODER.encode(payload));

    const header = Buffer.alloc(4 + tokenBytes.byteLength + 4 + 4);
    header.writeUInt8(1, 0);
    header.writeUInt16BE(tokenBytes.byteLength, 1);
    header.writeUInt32BE(payloadBytes.byteLength, 3 + tokenBytes.byteLength);
    parts.push(header, tokenBytes, payloadBytes);
    totalLength += header.length + tokenBytes.byteLength + payloadBytes.byteLength;
  }

  const out = Buffer.alloc(totalLength);
  out[0] = 1;
  let offset = 1;

  for (const [token, q] of entries) {
    const tokenBytes = Buffer.from(TEXT_ENCODER.encode(token));
    const payloadBytes = Buffer.from(TEXT_ENCODER.encode(JSON.stringify(q)));
    const tokenLength = tokenBytes.byteLength;
    const payloadLength = payloadBytes.byteLength;
    out.writeUInt16BE(tokenLength, offset);
    offset += 2;
    tokenBytes.copy(out, offset);
    offset += tokenLength;
    out.writeUInt32BE(payloadLength, offset);
    offset += 4;
    payloadBytes.copy(out, offset);
    offset += payloadLength;
  }

  return out;
}

function decodeQuotePacket(buffer) {
  if (!buffer || buffer.length === 0) return {};
  const out = {};
  let offset = 1;

  while (offset < buffer.length) {
    if (buffer.length - offset < 2) break;
    const tokenLength = buffer.readUInt16BE(offset);
    offset += 2;
    if (buffer.length - offset < tokenLength + 4) break;
    const token = TEXT_DECODER.decode(buffer.subarray(offset, offset + tokenLength));
    offset += tokenLength;
    const payloadLength = buffer.readUInt32BE(offset);
    offset += 4;
    if (buffer.length - offset < payloadLength) break;
    const payload = TEXT_DECODER.decode(buffer.subarray(offset, offset + payloadLength));
    offset += payloadLength;
    try {
      out[token] = JSON.parse(payload);
    } catch {
      out[token] = { bid: 0, ask: 0, ltp: 0, hasData: false };
    }
  }

  return out;
}

module.exports = { encodeQuotePacket, decodeQuotePacket };
