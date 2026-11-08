/** Upgrade harness failure carrying per-conversation export diagnostics. */
export class NativeExportFailure extends Error {
  constructor(failedChats) {
    super('Native export failure: ' + JSON.stringify(failedChats));
    this.failedChats = failedChats;
  }
}
