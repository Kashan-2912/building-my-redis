import * as net from "net";

// ============================================ HELPERS ============================================

// In-memory storage for key-value pairs
const mem = new Map<string, any>();

function parseRESP (data : Buffer) : string[] {
  const input = data.toString();
  const lines = input.split("\r\n").filter(line => line.length > 0);

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

function writeRESPBulkString (data: string) {
  return `$${data.length}\r\n${data}\r\n`;
}

function SETFunction (key: string, value: string) {
  mem.set(key, value);
}

function GETFunction (key: string) {
  const value = mem.get(key);
  if (value === undefined) {
    return "-1\r\n";
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

      SETFunction(key, value)
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
