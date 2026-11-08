/** Header facts shared by DOCX rendering and companion-file planning.
 * Unreadable dimensions keep the original image as a companion file. */
export interface DocxImageInfo {
    type: 'png' | 'jpg' | 'gif';
    width: number;
    height: number;
}

export function docxImageInfo(mediaType: string | undefined, bytes: Uint8Array): DocxImageInfo | undefined {
    const type = mediaType?.split(';', 1)[0].trim().toLowerCase();
    if (type === 'image/png' && bytes.length >= 24
        && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71
        && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) {
        const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const width = data.getUint32(16);
        const height = data.getUint32(20);
        return width > 0 && height > 0 ? { type: 'png', width, height } : undefined;
    }
    if (type === 'image/gif' && bytes.length >= 10
        && bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 56
        && (bytes[4] === 55 || bytes[4] === 57) && bytes[5] === 97) {
        const width = bytes[6] + bytes[7] * 256;
        const height = bytes[8] + bytes[9] * 256;
        return width > 0 && height > 0 ? { type: 'gif', width, height } : undefined;
    }
    if (type !== 'image/jpeg' || bytes[0] !== 255 || bytes[1] !== 216) return undefined;
    // JPEG stores intrinsic dimensions in a variable-position Start Of Frame
    // segment. Skip metadata segments by their lengths, never scan their payload.
    let offset = 2;
    while (offset < bytes.length) {
        if (bytes[offset] !== 255) return undefined;
        while (bytes[offset] === 255) offset++;
        if (offset >= bytes.length) return undefined;
        const marker = bytes[offset++];
        if (marker === 0 || marker === 0xD8) return undefined;
        if (marker === 0xD9 || marker === 0xDA) return undefined; // EOI or scan data before a frame
        if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) continue; // standalone markers
        if (offset + 2 > bytes.length) return undefined;
        const length = bytes[offset] * 256 + bytes[offset + 1];
        if (length < 2 || offset + length > bytes.length) return undefined;
        const isFrame = marker >= 0xC0 && marker <= 0xCF
            && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
        if (isFrame) {
            if (length < 8 || bytes[offset + 7] === 0 || length !== 8 + 3 * bytes[offset + 7]) return undefined;
            const height = bytes[offset + 3] * 256 + bytes[offset + 4];
            const width = bytes[offset + 5] * 256 + bytes[offset + 6];
            return width > 0 && height > 0 ? { type: 'jpg', width, height } : undefined;
        }
        offset += length;
    }
    return undefined;
}
