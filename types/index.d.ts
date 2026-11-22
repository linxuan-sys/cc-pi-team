export type PiLine = string

declare module 'claude-code' {
  interface PluginState {
    'pi': { lines: Shaped<PiLine[]>; binds: Shaped<{ files: string[]; idx: number }> }
  }
}

declare module 'claude-code' {
  interface EngineInterface {
    pi: { open: () => Promise<void> }
  }
}
