
export type AssetKind = 'image' | 'file' | 'audio' | 'video' | 'other';

export type AssetStatus =
    | 'available'
    | 'remote'
    | 'missing'
    | 'failed'
    | 'notFetched';

export interface AssetDimensions {
    widthPx: number;
    heightPx: number;
}

export interface Asset {
    id: string;
    kind: AssetKind;

    name?: string;
    mimeType?: string;
    sizeBytes?: number;
    sha256?: string;
    dimensions?: AssetDimensions;

    sourceUrl?: string;

    /** Archive-relative logical path; must never be an absolute OS path. */
    storageRef?: string;

    /** 'available' requires verified stored bytes, never metadata alone. */
    status: AssetStatus;
    failureReason?: string;

}
