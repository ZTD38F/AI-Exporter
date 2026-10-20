import { loadFonts } from '@myriaddreamin/typst.ts';
import type { InitOptions } from '@myriaddreamin/typst.ts';

// typst.ts fetches ~17 font files from jsdelivr by default; `loadFonts([], { assets: false })`
// disables remote font fetching so the sandbox runs strictly offline with host-provided fonts.
export function createOfflineInitOptions(
    getModule: () => Uint8Array | Promise<Uint8Array>,
): Partial<InitOptions> {
    return {
        getModule,
        beforeBuild: [loadFonts([], { assets: false })],
    };
}
