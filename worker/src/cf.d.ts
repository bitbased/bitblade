// Minimal Cloudflare Workers type declarations (avoids a @cloudflare/workers-types dependency).
interface HTMLRewriterElement {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): HTMLRewriterElement;
}
declare class HTMLRewriter {
  on(selector: string, handlers: { element?(el: HTMLRewriterElement): void }): HTMLRewriter;
  transform(res: Response): Response;
}

declare class WebSocketPair {
  0: WebSocket;
  1: WebSocket;
}

interface WebSocket {
  accept(): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): any;
}

interface ResponseInit {
  webSocket?: WebSocket | null;
}

interface DurableObjectId {}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(opts?: { prefix?: string }): Promise<Map<string, T>>;
  deleteAll(): Promise<void>;
}

interface DurableObjectState {
  storage: DurableObjectStorage;
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
}

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

interface KVNamespace {
  get(key: string): Promise<string | null>;
  get<T = unknown>(key: string, type: "json"): Promise<T | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}
