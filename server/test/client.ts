import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import type { Diagnostic } from "vscode-languageserver-protocol";

const SERVER_JS = path.resolve(__dirname, "..", "dist", "server.js");

export interface Notif {
  method: string;
  params: unknown;
}

interface PublishedDiagnostics {
  uri: string;
  diagnostics: Diagnostic[];
}

/** Validate a publishDiagnostics RPC payload (boundary the compiler lost). */
function asPublished(params: unknown): PublishedDiagnostics | null {
  if (params === null || typeof params !== "object") return null;
  if (!("uri" in params) || !("diagnostics" in params)) return null;
  const { uri, diagnostics } = params;
  if (typeof uri !== "string" || !Array.isArray(diagnostics)) return null;
  return { uri, diagnostics }; // RPC payload; element shape checked by assertions
}

/** Minimal LSP client over stdio for integration tests. */
export class TestClient {
  readonly proc: ChildProcessWithoutNullStreams;
  readonly conn: MessageConnection;
  readonly notifications: Notif[] = [];
  readonly serverRequests: Notif[] = [];
  readonly stderr: string[] = [];
  private waiters: {
    method: string;
    pred: (params: unknown) => boolean;
    resolve: (params: unknown) => void;
  }[] = [];

  constructor(private rootDir: string) {
    this.proc = spawn(process.execPath, [SERVER_JS, "--stdio"], {
      cwd: rootDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stderr.on("data", (d) => this.stderr.push(String(d)));
    this.conn = createMessageConnection(
      new StreamMessageReader(this.proc.stdout),
      new StreamMessageWriter(this.proc.stdin),
    );
    this.conn.onNotification((method, params) => {
      if (method === "window/showMessage" || method === "window/logMessage") {
        console.log(`[server ${method}]`, JSON.stringify(params));
      }
      this.notifications.push({ method, params });
      for (const w of [...this.waiters]) {
        if (w.method === method && w.pred(params)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(params);
        }
      }
    });
    // Answer server-initiated requests harmlessly, but record them.
    this.conn.onRequest((method, params) => {
      this.serverRequests.push({ method: String(method), params });
      return null as unknown;
    });
    this.conn.listen();
  }

  async initialize(settings?: unknown): Promise<void> {
    await this.conn.sendRequest("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(this.rootDir).href,
      workspaceFolders: [{ uri: pathToFileURL(this.rootDir).href, name: "ws" }],
      capabilities: {},
      initializationOptions: settings === undefined ? undefined : { settings },
    });
    await this.conn.sendNotification("initialized", {});
  }

  openDoc(filePath: string, text: string, languageId = "typescript"): void {
    this.conn.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: pathToFileURL(filePath).href,
        languageId,
        version: 1,
        text,
      },
    });
  }

  saveDoc(filePath: string): void {
    this.conn.sendNotification("textDocument/didSave", {
      textDocument: { uri: pathToFileURL(filePath).href },
    });
  }

  changeDoc(filePath: string, text: string, version = 2): void {
    this.conn.sendNotification("textDocument/didChange", {
      textDocument: { uri: pathToFileURL(filePath).href, version },
      contentChanges: [{ text }],
    });
  }

  codeActions(
    filePath: string,
    range: { start: { line: number; character: number }; end: { line: number; character: number } },
  ) {
    return this.conn.sendRequest("textDocument/codeAction", {
      textDocument: { uri: pathToFileURL(filePath).href },
      range,
      context: { diagnostics: [] },
    });
  }

  hover(filePath: string, line: number) {
    return this.conn.sendRequest("textDocument/hover", {
      textDocument: { uri: pathToFileURL(filePath).href },
      position: { line, character: 0 },
    });
  }

  inlayHints(filePath: string) {
    return this.conn.sendRequest("textDocument/inlayHint", {
      textDocument: { uri: pathToFileURL(filePath).href },
      range: {
        start: { line: 0, character: 0 },
        end: { line: 1_000_000, character: 0 },
      },
    });
  }

  execCommand(command: string, args?: unknown[]) {
    return this.conn.sendRequest("workspace/executeCommand", { command, arguments: args ?? [] });
  }

  waitForNotification(
    method: string,
    pred: (params: unknown) => boolean = () => true,
    timeoutMs = 5_000,
  ): Promise<unknown> {
    const seen = this.notifications.find((n) => n.method === method && pred(n.params));
    if (seen) return Promise.resolve(seen.params);
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs);
    this.waiters.push({
      method,
      pred,
      resolve: (p) => {
        clearTimeout(timer);
        resolve(p);
      },
    });
    return promise;
  }

  /** Await the next publishDiagnostics for `uri`. */
  async waitForDiagnostics(uri: string, timeoutMs = 5_000): Promise<Diagnostic[]> {
    const params = await this.waitForNotification(
      "textDocument/publishDiagnostics",
      (p) => asPublished(p)?.uri === uri,
      timeoutMs,
    );
    return asPublished(params)?.diagnostics ?? [];
  }

  /** Latest collected publishDiagnostics payload for a uri. */
  diagnosticsFor(uri: string): Diagnostic[] {
    let last: Diagnostic[] = [];
    for (const n of this.notifications) {
      if (n.method !== "textDocument/publishDiagnostics") continue;
      const p = asPublished(n.params);
      if (p?.uri === uri) last = p.diagnostics;
    }
    return last;
  }

  async shutdown(): Promise<void> {
    await this.conn.sendRequest("shutdown");
    await this.conn.sendNotification("exit");
    const { promise, resolve } = Promise.withResolvers<void>();
    this.proc.on("exit", () => resolve());
    await promise;
  }
}
