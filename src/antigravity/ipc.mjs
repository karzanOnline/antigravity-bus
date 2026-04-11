import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const MAIN_IPC_SUFFIX = "-main.sock";
const MAIN_IPC_INIT_TIMEOUT_MS = 3000;
const IPC_FRAME_TYPE_REGULAR = 1;
const IPC_RESPONSE = {
  initialize: 200,
  success: 201,
  promiseError: 202,
  error: 203,
  eventFire: 204,
};
const IPC_VALUE_TYPE = {
  undefined: 0,
  string: 1,
  buffer: 2,
  vsBuffer: 3,
  array: 4,
  object: 5,
  int: 6,
};

export class VSBufferWriter {
  constructor() {
    this.parts = [];
  }

  write(buffer) {
    this.parts.push(Buffer.from(buffer));
  }

  toBuffer() {
    return Buffer.concat(this.parts);
  }
}

export function writeVarint(writer, value) {
  if (value === 0) {
    writer.write(Buffer.from([0]));
    return;
  }

  const bytes = [];
  let current = value >>> 0;
  while (current !== 0) {
    let nextByte = current & 0x7f;
    current >>>= 7;
    if (current > 0) {
      nextByte |= 0x80;
    }
    bytes.push(nextByte);
  }

  writer.write(Buffer.from(bytes));
}

export function readVarint(buffer, state) {
  let value = 0;
  let shift = 0;

  for (;;) {
    const byte = buffer[state.offset];
    state.offset += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return value;
    }
    shift += 7;
  }
}

export function encodeIpcValue(writer, value) {
  if (value === undefined) {
    writer.write(Buffer.from([IPC_VALUE_TYPE.undefined]));
    return;
  }

  if (typeof value === "string") {
    const encoded = Buffer.from(value);
    writer.write(Buffer.from([IPC_VALUE_TYPE.string]));
    writeVarint(writer, encoded.length);
    writer.write(encoded);
    return;
  }

  if (Array.isArray(value)) {
    writer.write(Buffer.from([IPC_VALUE_TYPE.array]));
    writeVarint(writer, value.length);
    for (const item of value) {
      encodeIpcValue(writer, item);
    }
    return;
  }

  if (typeof value === "number" && Number.isInteger(value)) {
    writer.write(Buffer.from([IPC_VALUE_TYPE.int]));
    writeVarint(writer, value >>> 0);
    return;
  }

  if (Buffer.isBuffer(value)) {
    writer.write(Buffer.from([IPC_VALUE_TYPE.buffer]));
    writeVarint(writer, value.length);
    writer.write(value);
    return;
  }

  const encoded = Buffer.from(JSON.stringify(value));
  writer.write(Buffer.from([IPC_VALUE_TYPE.object]));
  writeVarint(writer, encoded.length);
  writer.write(encoded);
}

export function decodeIpcValue(buffer, state) {
  const valueType = buffer[state.offset];
  state.offset += 1;

  switch (valueType) {
    case IPC_VALUE_TYPE.undefined:
      return undefined;
    case IPC_VALUE_TYPE.string: {
      const length = readVarint(buffer, state);
      const value = buffer.slice(state.offset, state.offset + length).toString("utf8");
      state.offset += length;
      return value;
    }
    case IPC_VALUE_TYPE.array: {
      const count = readVarint(buffer, state);
      const value = [];
      for (let index = 0; index < count; index += 1) {
        value.push(decodeIpcValue(buffer, state));
      }
      return value;
    }
    case IPC_VALUE_TYPE.object: {
      const length = readVarint(buffer, state);
      const value = JSON.parse(buffer.slice(state.offset, state.offset + length).toString("utf8"));
      state.offset += length;
      return value;
    }
    case IPC_VALUE_TYPE.int:
      return readVarint(buffer, state);
    case IPC_VALUE_TYPE.buffer:
    case IPC_VALUE_TYPE.vsBuffer: {
      const length = readVarint(buffer, state);
      const value = buffer.slice(state.offset, state.offset + length);
      state.offset += length;
      return value;
    }
    default:
      throw new Error(`Unknown IPC value type: ${valueType}`);
  }
}

export function encodeIpcParts(first, second = undefined) {
  const writer = new VSBufferWriter();
  encodeIpcValue(writer, first);
  if (arguments.length > 1) {
    encodeIpcValue(writer, second);
  }
  return writer.toBuffer();
}

export function decodeIpcParts(buffer) {
  const state = { offset: 0 };
  const first = decodeIpcValue(buffer, state);
  const second = state.offset < buffer.length ? decodeIpcValue(buffer, state) : undefined;
  return { first, second };
}

export function frameIpcMessage(data, messageType = IPC_FRAME_TYPE_REGULAR, id = 0, ack = 0) {
  const header = Buffer.alloc(13);
  header.writeUInt8(messageType, 0);
  header.writeUInt32BE(id, 1);
  header.writeUInt32BE(ack, 5);
  header.writeUInt32BE(data.length, 9);
  return Buffer.concat([header, data]);
}

export function frameConnectJson(payload) {
  const json = Buffer.from(JSON.stringify(payload));
  const envelope = Buffer.alloc(5);
  envelope[0] = 0;
  envelope.writeUInt32BE(json.length, 1);
  return Buffer.concat([envelope, json]);
}

export function parseConnectJsonResponse(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 5) {
    return null;
  }

  const flag = buffer[0];
  const size = buffer.readUInt32BE(1);
  const body = buffer.subarray(5, 5 + size);
  if (flag !== 0 || body.length !== size) {
    return null;
  }

  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
}

export function findMainIpcHandle(appSupportDir, socketSuffix = MAIN_IPC_SUFFIX) {
  if (!fs.existsSync(appSupportDir)) {
    return null;
  }

  const entries = fs
    .readdirSync(appSupportDir, { withFileTypes: true })
    .filter((entry) => entry.isSocket?.() || entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(socketSuffix))
    .sort();

  const latest = entries.at(-1);
  return latest ? path.join(appSupportDir, latest) : null;
}

export async function createMainIpcClient(socketPath, context = "main", deps) {
  const socket = net.createConnection(socketPath);
  socket.setNoDelay(true);

  let initialized = false;
  let receiveBuffer = Buffer.alloc(0);
  let requestId = 1;
  const pending = new Map();

  const cleanupPending = (error) => {
    for (const entry of pending.values()) {
      entry.reject(error);
    }
    pending.clear();
  };

  const close = () =>
    new Promise((resolve) => {
      if (socket.destroyed) {
        resolve();
        return;
      }
      socket.once("close", resolve);
      socket.end();
    });

  socket.on("data", (chunk) => {
    receiveBuffer = Buffer.concat([receiveBuffer, chunk]);

    while (receiveBuffer.length >= 13) {
      const messageType = receiveBuffer.readUInt8(0);
      const bodyLength = receiveBuffer.readUInt32BE(9);
      if (receiveBuffer.length < 13 + bodyLength) {
        break;
      }

      const body = receiveBuffer.slice(13, 13 + bodyLength);
      receiveBuffer = receiveBuffer.slice(13 + bodyLength);
      if (messageType !== IPC_FRAME_TYPE_REGULAR) {
        continue;
      }

      const { first, second } = decodeIpcParts(body);
      if (!Array.isArray(first)) {
        continue;
      }

      const responseType = first[0];
      if (responseType === IPC_RESPONSE.initialize) {
        initialized = true;
        continue;
      }

      const pendingRequest = pending.get(first[1]);
      if (!pendingRequest) {
        continue;
      }

      if (responseType === IPC_RESPONSE.success) {
        pending.delete(first[1]);
        pendingRequest.resolve(second);
      } else if (
        responseType === IPC_RESPONSE.promiseError ||
        responseType === IPC_RESPONSE.error
      ) {
        pending.delete(first[1]);
        pendingRequest.reject(new Error(typeof second === "string" ? second : JSON.stringify(second)));
      }
    }
  });

  socket.on("error", (error) => cleanupPending(error));
  socket.on("close", () => cleanupPending(new Error("IPC socket closed")));

  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  socket.write(frameIpcMessage(encodeIpcParts(context)));
  const startedAt = Date.now();
  while (!initialized && Date.now() - startedAt < (deps.initTimeoutMs ?? MAIN_IPC_INIT_TIMEOUT_MS)) {
    await deps.sleep(25);
  }

  if (!initialized) {
    socket.destroy();
    throw new Error("IPC init timeout");
  }

  return {
    async call(channel, method, args = []) {
      const id = requestId;
      requestId += 1;
      socket.write(frameIpcMessage(encodeIpcParts([100, id, channel, method], args)));
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
    },
    close,
  };
}
