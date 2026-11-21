export type PiLine = string

declare module 'claude-code' {
  interface PluginState {
    'pi': { lines: Shaped<PiLine[]> }
  }
}

declare module 'claude-code' {
  interface EngineInterface {
    pi: { open: () => Promise<void> }
  }
}
