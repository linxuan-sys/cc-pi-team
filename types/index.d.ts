export type PiLine = string

declare module 'claude-code' {
  interface PluginState {
    'pi': { lines: Shaped<PiLine[]> }
  }
}
