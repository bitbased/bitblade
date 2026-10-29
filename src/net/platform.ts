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
  quit?(): Promise<void>;
}

declare global {
  interface Window {
    bitblade?: BitBladePlatform;
  }
}

/** running as an installed app window (PWA standalone / fullscreen, iOS home-screen app) */
export function isInstalledApp() {
  if (typeof window === 'undefined') return false;
  return ['standalone', 'fullscreen', 'minimal-ui'].some((m) => matchMedia?.(`(display-mode: ${m})`).matches) || (navigator as unknown as { standalone?: boolean }).standalone === true;
}

/** close the whole game: Electron quits; an installed PWA closes its window where the OS allows it */
export function quitApp(onCantClose: () => void) {
  const p = getPlatform();
  if (p?.quit) { p.quit(); return; }
  try { window.close(); } catch { /* ignore */ }
  // mobile PWAs can't close themselves — tell the player how
  setTimeout(() => { if (!document.hidden) onCantClose(); }, 350);
}

export function getPlatform(): BitBladePlatform | null {
  return (typeof window !== "undefined" && window.bitblade) || null;
}
