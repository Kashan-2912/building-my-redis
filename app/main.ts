import * as net from "net";

// ============================================ HELPERS ============================================

// In-memory storage for key-value pairs
const mem = new Map<string, any>();

// waiting clients for BLPOP
const waiting = new Map<string, { connection: net.Socket }[]>();

type StreamEntry = {
  id: string;
  fields: Record<string, string>;
};

// streams
type Stream = Map<string, StreamEntry[]>;

const stream: Stream = new Map();

function parseRESP (data : Buffer) : string[] {
  const input = data.toString();
  const lines = input.split("\r\n").filter((line: string) => line.length > 0);

  const result: string[] = [];

  for(let i = 0; i<lines.length; i++) {
    const line = lines[i];
    if(line.startsWith("$")) {
      const value = lines[i+1];
      result.push(value);
      i++; // Skip the next line since it's the value
    }
  }
  return result;
}

function writeRESPSimpleString (data: string) {
  return `+${data}\r\n`;
}

function writeRESPError (data: string) {
  return `-${data}\r\n`;
}

function writeRESPBulkString (data: string | null) {
  if(data === null) {
    return "$-1\r\n";
  }
  return `$${data.length}\r\n${data}\r\n`;
}

function writeRESPArray (data: string[]) {
  if(data.length === 0) {
    return `*0\r\n`;
  }

  return `*${data.length}\r\n` + data.map(item => writeRESPBulkString(item)).join("");
}

function SETFunction (key: string, value: string, EX?: number, PX?: number) {
  mem.set(key, value);

  let ttl: number | undefined;

  if(EX !== undefined) {
    ttl = EX * 1000; // milli seconds
  }

  if(PX !== undefined) {
    ttl = PX; // milliseconds 
  }

  if(ttl !== undefined) {
    setTimeout(() => {
      mem.delete(key);
    }, ttl)
  }
}

function GETFunction (key: string) {
  const value = mem.get(key);
  if (value === undefined) {
    return null;
  }

  return value;
}

function generateSequence(currMs: number, streamName: string): number {
  if (!stream.has(streamName)) {
    stream.set(streamName, []);
  }

  const streamEntries = stream.get(streamName)!;

  // Special case: ms = 0 → start from 1
  if (currMs === 0) {
    if (streamEntries.length === 0) return 1;

    let maxSeq = 0;
    for (const entry of streamEntries) {
      const [msStr, seqStr] = entry.id.split("-");
      if (Number(msStr) === 0) {
        maxSeq = Math.max(maxSeq, Number(seqStr));
      }
    }
    return maxSeq + 1;
  }

  // Normal case
  let maxSeq = -1;

  for (const entry of streamEntries) {
    const [msStr, seqStr] = entry.id.split("-");
    if (Number(msStr) === currMs) {
      maxSeq = Math.max(maxSeq, Number(seqStr));
    }
  }

  return maxSeq === -1 ? 0 : maxSeq + 1;
}

function validateExplicitID(
  currMs: number,
  currSeq: number,
  streamName: string,
  connection: net.Socket
): boolean {

  if (currMs === 0 && currSeq === 0) {
    connection.write(writeRESPError("ERR The ID specified in XADD must be greater than 0-0"));
    return false;
  }

  if (!stream.has(streamName)) return true;

  const entries = stream.get(streamName)!;

  if (entries.length === 0) return true;

  const last = entries[entries.length - 1];
  const [lastMsStr, lastSeqStr] = last.id.split("-");
  const lastMs = Number(lastMsStr);
  const lastSeq = Number(lastSeqStr);

  if (
    currMs < lastMs ||
    (currMs === lastMs && currSeq <= lastSeq)
  ) {
    connection.write(writeRESPError("ERR The ID specified in XADD is equal or smaller than the target stream top item"));
    return false;
  }

  return true;
}

// ============================================ SERVER ============================================

const server: net.Server = net.createServer((connection: net.Socket) => {
  connection.on("data", (data: Buffer) => {
    const parts = parseRESP(data);

    if(parts.length === 0) { return }

    const command = parts[0].toUpperCase();

    const listName = parts[1] ? parts[1] : "";
    const values = parts.slice(2);

    let list = mem.get(listName);

    if(command === "PING") {
      connection.write(writeRESPSimpleString("PONG"));

    } else if (command === "ECHO") {
      const message = parts[1] ? parts[1] : "";
      connection.write(writeRESPBulkString(message));

    } else if (command === "SET") {
      const key = parts[1] ? parts[1] : "";
      const value = parts[2] ? parts[2] : "";

      const optionName = parts[3] ? parts[3] : "";
      const optionValue = parts[4] ? parts[4] : "";

      if(optionName === "EX") {
        SETFunction(key, value, parseInt(optionValue))
      } else if (optionName === "PX") {
        SETFunction(key, value, undefined, parseInt(optionValue))
      } else if (optionName === "") {
        SETFunction(key, value);
      }
      
      connection.write(writeRESPSimpleString("OK"));

    } else if (command === "GET") {
      const key = parts[1] ? parts[1] : "";
      const value = GETFunction(key);
      connection.write(writeRESPBulkString(value));

    } else if (command === "RPUSH") {
      if(!list) {
        list = [];
      }
      
      if (Array.isArray(list)) {
        list.push(...values);
        mem.set(listName, list);
        connection.write(`:${list.length}\r\n`);

        // wake up waiting BLPOP clients
        if (waiting.has(listName)) {
          const queue = waiting.get(listName)!;

          while (queue.length > 0 && list.length > 0) {
            const { connection } = queue.shift()!;
            const value = list.shift();

            connection.write(writeRESPArray([listName, value]));
          }

          mem.set(listName, list);
        }
      }

    } else if (command === "LPUSH") {
      if(!list) {
        list = [];
      }

      if(Array.isArray(list)) {
        list.push(...values);
        list.reverse();
        mem.set(listName, list);
        connection.write(`:${list.length}\r\n`);
      }

    } else if (command === "LRANGE") {
      if (!Array.isArray(list)) {
        connection.write(`*0\r\n`);
        return;
      }

      let start = parts[2] ? parseInt(parts[2]) : 0; 
      let stop = parts[3] ? parseInt(parts[3]) : -1;

      const len = list.length;

      // Step 1: Convert negatives to positives
      if (start < 0) start = len + start;
      if (stop < 0) stop = len + stop;

      // Step 2: Check if out of bounds and adjust
      if (start < 0) start = 0;
      if (stop < 0) stop = 0;
      if (stop >= len) stop = len - 1;

      // Step 3: Validate
      if (start > stop || start >= len) {
        connection.write(`*0\r\n`);
        return;
      }

      const sliced = list.slice(start, stop + 1);

      connection.write(`*${sliced.length}\r\n`);
      sliced.forEach((item: string) => {
        connection.write(writeRESPBulkString(item));
      });

    } else if (command === "LLEN") {
      if(!list) {
        connection.write(`:0\r\n`);
        return;
      }

      if(Array.isArray(list)) {
        connection.write(`:${list.length}\r\n`);
      }

    } else if (command === "LPOP") {
      let removedElements: string[] | null = [];
      let optionalCount: number = parseInt(values[0]);

      if(!list) {
        connection.write(writeRESPBulkString(null));
      }

      if(optionalCount > list.length) {
        optionalCount = list.length;
      }

      if(Array.isArray(list)) {
        if(!optionalCount) {
          const firstElement = list.shift();
          removedElements.push(firstElement);
          mem.set(listName, list);
          connection.write(writeRESPBulkString(firstElement));
          return;
        }
        
        if(optionalCount === 1) {
          const firstElement = list.shift();
          if (firstElement !== undefined) {
            removedElements.push(firstElement);
          }
        } else {
          const removed = list.splice(0, optionalCount)
          removedElements = [...removedElements, ...removed];
        }
      
        mem.set(listName, list);
        connection.write(writeRESPArray(removedElements));
      }

    } else if (command === "BLPOP") {
      const timeout = parseFloat(values[0] ?? "0");

      // immediate return if data exists
      if (Array.isArray(list) && list.length > 0) {
        const value = list.shift();
        mem.set(listName, list);

        connection.write(writeRESPArray([listName, value]));
        return;
      }

      // otherwise block
      if (!waiting.has(listName)) {
        waiting.set(listName, []);
      }

      const queue = waiting.get(listName)!;
      const entry = { connection };

      queue.push(entry);

      // timeout handling
      if (timeout > 0) {
        setTimeout(() => {
          const q = waiting.get(listName);
          if (!q) return;

          const index = q.indexOf(entry);
          if (index !== -1) {
            q.splice(index, 1);
            connection.write(`*-1\r\n`);
          }
        }, timeout * 1000);
      }

    } else if (command === "TYPE") {
      if(mem.has(listName)) {
        const value = mem.get(listName);

        if (typeof value === "string") {
          connection.write(writeRESPSimpleString("string"));
          return;
        } else if (Array.isArray(value)) {
          connection.write(writeRESPSimpleString("list"));
          return;
        }
      }

      if(stream.has(listName)) {
        connection.write(writeRESPSimpleString("stream"));
        return;
      }

      connection.write(writeRESPSimpleString("none"));

    } else if (command === "XADD") {
      const streamName = parts[1] ?? "";
      let id = parts[2] ?? "";
      const [msStr, seqStr] = id.split("-");
      let currMs = Number(msStr);

      let currSeq: number;

      if (seqStr === "*") {
        currSeq = generateSequence(currMs, streamName);
      } else {
        currSeq = Number(seqStr);

        const isValid = validateExplicitID(currMs, currSeq, streamName, connection);
        if (!isValid) {
          return;
        }
      }

      id = `${currMs}-${currSeq}`;

      // making fields map
      const normalizedFields = values.slice(1); // Skip the stream name
      const fields: Record<string, string> = {};
      for(let i = 0; i < normalizedFields.length; i += 2) {
        const field = normalizedFields[i];
        const value = normalizedFields[i + 1] ?? "";
        fields[field] = value;
      }

      if (!stream.has(streamName)) {
        stream.set(streamName, []);
      }

      const streamEntries = stream.get(streamName)!;

      streamEntries.push({ id, fields });
      connection.write(writeRESPBulkString(id));

    } else {
      connection.write(writeRESPError(`unknown command '${command}'`));

    }
  })
});

server.listen(6379, "127.0.0.1", () => {
  console.log("Server is listening on port 6379");
});
