// Access to the Electron preload bridge (null when running in a plain browser).

export interface HostInfo {
  port: number;
  lanUrls: string[];
}

export interface BitBladePlatform {
  isElectron: true;
  platform: string;
  startHost(): Promise<HostInfo>;
  stopHost(): Promise<void>;
  startTunnel(): Promise<{ url: string } | { error: string }>;
  stopTunnel(): Promise<void>;
  toggleFullscreen(): Promise<void>;
}

declare global {
  interface Window {
    bitblade?: BitBladePlatform;
  }
}

export function getPlatform(): BitBladePlatform | null {
  return (typeof window !== "undefined" && window.bitblade) || null;
}
