/** Browser directory capability shared by filesystem writers and UI controllers. */
export interface DirectoryHandle extends FileSystemDirectoryHandle {
    queryPermission(options?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
    requestPermission(options?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}

/** Restore the browser permission capability before any caller relies on it. */
export function isDirectoryHandle(handle: FileSystemDirectoryHandle): handle is DirectoryHandle {
    return 'queryPermission' in handle && typeof handle.queryPermission === 'function'
        && 'requestPermission' in handle && typeof handle.requestPermission === 'function';
}
