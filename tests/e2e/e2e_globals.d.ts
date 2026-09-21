declare global {
  interface Window {
    __workbenchLoadStore?: (skipSync?: boolean) => Promise<void>;
    __geminiExporterSyncOnce?: () => Promise<void>;
    __takeoutClicked?: boolean;
    _WIZ_global_data?: Record<string, any>;
  }
}
export {};
