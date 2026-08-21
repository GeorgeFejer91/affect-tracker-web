export class RingBuffer {
  constructor(capacity = 10_000) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("capacity must be a positive integer");
    }
    this.capacity = capacity;
    this.items = new Array(capacity);
    this.writeIndex = 0;
    this.length = 0;
  }

  push(value) {
    this.items[this.writeIndex] = value;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    this.length = Math.min(this.length + 1, this.capacity);
  }

  clear() {
    this.items.fill(undefined);
    this.writeIndex = 0;
    this.length = 0;
  }

  toArray() {
    const output = new Array(this.length);
    const start = (this.writeIndex - this.length + this.capacity) % this.capacity;
    for (let index = 0; index < this.length; index += 1) {
      output[index] = this.items[(start + index) % this.capacity];
    }
    return output;
  }
}
