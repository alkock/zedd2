export interface PlatformOptions {
  headless?: boolean
  executablePath?: string
  /**
   * Persistent Chrome profile directory. If set, Chrome keeps its extensions (e.g. Microsoft
   * Single Sign On) and logins between runs; otherwise every run starts with a fresh profile.
   */
  userDataDir?: string
}
