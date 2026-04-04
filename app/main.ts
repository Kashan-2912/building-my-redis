import * as net from "net";

// You can use print statements as follows for debugging, they'll be visible when running tests.
console.log("Logs from your program will appear here!");

// Uncomment the code below to pass the first stage
const server: net.Server = net.createServer((connection: net.Socket) => {
  // Handle connection\
  connection.on("data", (data: Buffer) => {
    const input = data.toString();
    
    const match = input.match("/\*2\r\n\$\d+\r\n([Ee][Cc][Hh][Oo])\r\n\$(\d+)\r\n(.*)\r\n/");

    if(match) {
      const arg = match[3];
      connection.write(`$${arg.length}\r\n${arg}\r\n`);
      return;
    }

    connection.write(`+PONG\r\n`);
  })

});
//
server.listen(6379, "127.0.0.1");
