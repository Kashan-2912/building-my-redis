import * as net from "net";

// ============================================ HELPERS ============================================

// In-memory storage for key-value pairs
const mem = new Map<string, any>();

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

function writeRESPBulkString (data: string | null) {
  if(data === null) {
    return "$-1\r\n";
  }
  return `$${data.length}\r\n${data}\r\n`;
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

// ============================================ HELPERS ============================================

const server: net.Server = net.createServer((connection: net.Socket) => {
  connection.on("data", (data: Buffer) => {
    const parts = parseRESP(data);

    if(parts.length === 0) { return }

    const command = parts[0].toUpperCase();

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
      const listName = parts[1] ? parts[1] : "";
      const values = parts.slice(2);

      let list = mem.get(listName);

      if(!list) {
        list = [];
      }
      
      if (Array.isArray(list)) {
        list.push(...values);
        mem.set(listName, list);
        connection.write(`:${list.length}\r\n`);
      }

    } else if (command === "LRANGE") {
      const listName = parts[1] ? parts[1] : "";
      let startIndex = parts[2] ? parseInt(parts[2]) : 0; 
      let stopIndex = parts[3] ? parseInt(parts[3]) : -1;

      if(!listName) {
        connection.write(`*0\r\n`);
        return;
      } else if (startIndex > listName.length - 1 || startIndex === listName.length) {
        connection.write(`*0\r\n`);
        return;
      } else if (stopIndex > listName.length - 1 || stopIndex === listName.length) {
        stopIndex = listName.length - 1;
      } else if (Math.abs(startIndex) > Math.abs(stopIndex)) {
        connection.write(`*0\r\n`);
        return;
      } else if (startIndex < 0 && stopIndex < 0) {
        startIndex = listName.length - 1 + startIndex;
        stopIndex = listName.length - 1 + stopIndex;
      } else if (startIndex < 0 && stopIndex >= 0) {
        startIndex = listName.length - 1 + startIndex;
      } else if (startIndex >= 0 && stopIndex < 0) {
        stopIndex = listName.length - 1 + stopIndex;
      } else if (Math.abs(startIndex) > listName.length) {
        startIndex = 0;
      }

      const list = mem.get(listName);

      if(Array.isArray(list)) {
        const slicedList = list.slice(startIndex, stopIndex + 1);
        connection.write(`*${slicedList.length}\r\n`);
        slicedList.forEach((item: string) => {
          connection.write(writeRESPBulkString(item));
        });
      } else {
        connection.write(`*0\r\n`);
      }

    } else {
      connection.write(`-ERR unknown command '${command}'\r\n`);

    }
  })
});

server.listen(6379, "127.0.0.1", () => {
  console.log("Server is listening on port 6379");
});
