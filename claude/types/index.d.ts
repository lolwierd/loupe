export type LoupeLink = { root: string; url: string; left?: number; files?: number }

declare module 'claude-code' {
  interface PluginState {
    loupe: { repos: string[]; live: boolean; hidden: boolean; links: LoupeLink[] }
  }
}
