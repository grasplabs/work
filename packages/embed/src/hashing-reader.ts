/**
 * Reads a stream in blocks of exactly the size asked for (the last may be
 * shorter), hashing every byte with SHA-256 as it comes: how the embedder
 * reads a model file of up to hundreds of megabytes without holding it.
 */
export class HashingReader {
  private readonly reader: ReadableStreamDefaultReader;
  private readonly digest = new crypto.DigestStream("SHA-256");
  private readonly hash = this.digest.getWriter();
  private readonly pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private ended = false;
  /** How many bytes the stream has given so far. */
  total = 0;

  constructor(stream: ReadableStream) {
    this.reader = stream.getReader();
  }

  /** The next `size` bytes, fewer at the end, or null when nothing is left. */
  async read(size: number): Promise<Uint8Array | null> {
    while (this.pendingBytes < size && !this.ended) {
      // oxlint-disable-next-line no-await-in-loop -- a stream is read in order
      const chunk = await this.reader.read();
      if (chunk.done) {
        this.ended = true;
      } else {
        const value: unknown = chunk.value;
        if (!(value instanceof Uint8Array)) {
          throw new TypeError(
            "A model file's stream gave something other than bytes."
          );
        }
        // oxlint-disable-next-line no-await-in-loop -- hashed in order
        await this.hash.write(value);
        this.pending.push(value);
        this.pendingBytes += value.byteLength;
        this.total += value.byteLength;
      }
    }
    if (this.pendingBytes === 0) {
      return null;
    }
    const take = Math.min(size, this.pendingBytes);
    const out = new Uint8Array(take);
    let filled = 0;
    while (filled < take) {
      const [head] = this.pending;
      if (head === undefined) {
        break;
      }
      const used = Math.min(head.byteLength, take - filled);
      out.set(head.subarray(0, used), filled);
      filled += used;
      if (used === head.byteLength) {
        this.pending.shift();
      } else {
        this.pending[0] = head.subarray(used);
      }
    }
    this.pendingBytes -= take;
    return out;
  }

  /** The SHA-256 (hex) of everything read; call once the stream is read to its end. */
  async sha256(): Promise<string> {
    await this.hash.close();
    const bytes = new Uint8Array(await this.digest.digest);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
}
