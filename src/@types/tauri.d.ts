declare module '@tauri-apps/api/core' {
  export function invoke<T>(command: string, args?: any): Promise<T>;
}
declare module '@tauri-apps/api/event' {
  export function listen(event: string, handler: (event: any) => void): Promise<() => void>;
}
declare module '@tauri-apps/plugin-log' {
  export function info(message: string): void;
  export function error(message: string): void;
  export function debug(message: string): void;
}
declare module '@tauri-apps/api/path' {
  export function appDir(): Promise<string>;
}
declare module '@tauri-apps/plugin-fs' {
  export function readTextFile(path: string): Promise<string>;
  export function writeFile(path: string, contents: string): Promise<void>;
}
