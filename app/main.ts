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
    return `-1\r\n`;
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

// console.log("Logs from your program will appear here!");

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
      }
      
      connection.write(writeRESPSimpleString("OK"));

    } else if (command === "GET") {
      const key = parts[1] ? parts[1] : "";
      const value = GETFunction(key);
      connection.write(writeRESPBulkString(value));

    } else {
      connection.write(`-ERR unknown command '${command}'\r\n`);

    }
  })
});

server.listen(6379, "127.0.0.1", () => {
  console.log("Server is listening on port 6379");
});
