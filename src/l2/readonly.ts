/** Read-only view of JSON-shaped Domain data; does not clone or freeze the value. */
export type DeepReadonly<T> = T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;
