/**
 * Random access to a scan's bytes without holding the whole file.
 *
 * Reading a file with `arrayBuffer()` puts every byte of it in memory at once,
 * next to the point arrays being built from it, which roughly doubles the
 * memory a load needs and puts multi-gigabyte scans out of reach. Readers work
 * through this interface instead and ask only for the slice they are about to
 * decode - a header, a block of records - so a file is never in memory whole.
 */
export interface ByteSource {
  readonly size: number;
  /** Up to `length` bytes starting at `offset`; fewer when the source ends first. */
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** A `File` or other `Blob`, read slice by slice. Slicing a blob copies nothing until the slice is read. */
export function blobSource(blob: Blob): ByteSource {
  return {
    size: blob.size,
    read: async (offset, length) => {
      const start = clamp(offset, blob.size);
      const end = clamp(offset + length, blob.size);
      return new Uint8Array(await blob.slice(start, end).arrayBuffer());
    },
  };
}

/** Bytes already in memory, for tests and for data that arrives as a buffer. */
export function bufferSource(buffer: ArrayBuffer): ByteSource {
  return {
    size: buffer.byteLength,
    read: async (offset, length) => {
      const start = clamp(offset, buffer.byteLength);
      return new Uint8Array(buffer, start, clamp(offset + length, buffer.byteLength) - start);
    },
  };
}

function clamp(offset: number, size: number): number {
  return Math.min(Math.max(0, offset), size);
}
