// The SMTP client against a local smtp-server: a notification reaches the server with its reply-to.
// Without TLS: STARTTLS and TLS from the start are not tested here.
import type { AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { smtpMailer } from "./links.ts";

let server: SMTPServer;
let port = 0;
const received: string[] = [];

beforeAll(async () => {
  server = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS"],
    onData(stream, _session, done) {
      let data = "";
      stream.on("data", (c: Buffer) => (data += c.toString("utf8")));
      stream.on("end", () => (received.push(data), done()));
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("SMTP", () => {
  it("sends a notification to everyone the form names", async () => {
    const m = smtpMailer({ host: "127.0.0.1", port, security: "none", user: null, password: "X", from: "Forms <forms@example.com>" }, undefined);
    await m.send({
      to: ["sales@example.com", "emily@example.com"],
      subject: "New answer to Demo request from Gizem Avcı",
      text: "Şirket: Avcı Lojistik",
      replyTo: "gizem@avci.example",
    });
    m.close();
    expect(received).toHaveLength(1);
    expect(received[0]).toContain("To: sales@example.com, emily@example.com");
    expect(received[0]).toContain("Reply-To: gizem@avci.example");
  });
});
