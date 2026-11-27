import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

type Pixel = (horizontal: number, vertical: number) => number[];
const width = 256;
const height = 180;

function uint32(value: number) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function chunk(name: string, payload: Buffer) {
  const body = Buffer.concat([Buffer.from(name), payload]);
  return Buffer.concat([uint32(payload.length), body, uint32(crc32(body))]);
}

function encodePng(pixel: Pixel) {
  const stride = width * 3 + 1;
  const scanlines = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const color = pixel(column - width / 2, row - height / 2);
      scanlines.set(color.map(Math.round), row * stride + 1 + column * 3);
    }
  }
  const header = Buffer.concat([uint32(width), uint32(height), Buffer.from([8, 2, 0, 0, 0])]);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const ellipse = (horizontal: number, vertical: number, radiusX: number, radiusY: number, centerX = 0, centerY = 0) =>
  ((horizontal - centerX) / radiusX) ** 2 + ((vertical - centerY) / radiusY) ** 2;

function chestFrame(slice: number): Pixel {
  return (horizontal, vertical) => {
    const grain = 5 * Math.sin(1.2 * horizontal + Math.cos(vertical * 0.37)) + 3 * Math.cos(horizontal * 0.2 - vertical);
    const anatomy = (radiusX: number, radiusY: number, centerX = 0, centerY = 0) => ellipse(horizontal, vertical, radiusX, radiusY, centerX, centerY);
    const body = anatomy(100, 70);
    let tone = body < 0.87 ? 148 : body < 1 ? 106 : 22;
    if (Math.min(anatomy(37, 49, -43, -3), anatomy(35, 48, 43, -3)) < 1) tone = 47 + grain;
    if (anatomy(17, 10, 0, 45) < 1) tone = 224;
    if (anatomy(19, 25, 3, 12) < 1) tone = 120;
    for (const side of [-1, 1]) {
      for (const level of [-1, 0, 1]) {
        if (anatomy(6, 4, side * (82 - 7 * level * level), level * 26) < 1) tone = 209;
        if (anatomy(3 + slice, 4, side * 40 + level * 5, level * 11) < 1) tone = 124;
      }
    }
    if (anatomy(12, 2, -42 + slice * 3, -54) < 1) tone = 209;
    const grey = Math.round(tone + grain);
    return [grey, grey, grey];
  };
}

function tissueFrame(): Pixel {
  const centers: [number, number][] = [];
  for (let row = -5; row < 6; row++) {
    for (let column = -7; column < 8; column++) centers.push([column * 21 + (row % 2) * 10 + 3 * Math.sin(3 * row + column), row * 18 + 3 * Math.sin(8 * column + row)]);
  }
  return (horizontal, vertical) => {
    let closest = Infinity;
    let next = Infinity;
    for (const [centerX, centerY] of centers) {
      const distance = (horizontal - centerX) ** 2 + (vertical - centerY) ** 2;
      if (distance < closest) { next = closest; closest = distance; }
      else next = Math.min(next, distance);
    }
    const membrane = Math.min(1, (next - closest) / 45);
    const ink = 3 * Math.cos(vertical * 1.37 + horizontal * 0.35);
    return [207 + 42 * membrane + ink, 133 + 105 * membrane + ink, 177 + 65 * membrane + ink];
  };
}

export function prepareTeachingFrames(publicDirectory: string) {
  const directory = join(publicDirectory, 'clinical-frames');
  mkdirSync(directory, { recursive: true });
  const frames = { 'phantom-a.png': chestFrame(0), 'phantom-b.png': chestFrame(1), 'phantom-c.png': tissueFrame() };
  for (const [name, pixel] of Object.entries(frames)) writeFileSync(join(directory, name), encodePng(pixel));
  return publicDirectory;
}
