// Loaded as raw strings via esbuild's 'text' loader in build.js.
declare module '*.typ' {
    const text: string;
    export default text;
}

declare module '*.tmTheme' {
    const text: string;
    export default text;
}
