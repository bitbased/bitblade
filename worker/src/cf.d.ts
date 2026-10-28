// Minimal Cloudflare Workers type declarations (avoids a @cloudflare/workers-types dependency).
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
