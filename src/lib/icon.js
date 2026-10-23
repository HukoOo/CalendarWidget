'use strict';

// 별도 이미지 파일 없이 달력 아이콘을 그린다. 도형은 32x32 기준 좌표로 정의하고 원하는 크기로 샘플링한다.
const HEADER = [37, 99, 235];
const BODY = [255, 255, 255];
const DOT = [96, 165, 250];

function inRoundRect(u, v, x0, y0, x1, y1, r) {
  if (u < x0 || u > x1 || v < y0 || v > y1) return false;
  const cx = Math.min(Math.max(u, x0 + r), x1 - r);
  const cy = Math.min(Math.max(v, y0 + r), y1 - r);
  return (u - cx) ** 2 + (v - cy) ** 2 <= r * r;
}

function colorAt(u, v) {
  if (!inRoundRect(u, v, 2, 3, 30, 30, 4)) return null;
  if (!inRoundRect(u, v, 3.5, 4.5, 28.5, 28.5, 2.5)) return HEADER; // 테두리: 밝은 배경에서도 윤곽이 보이게
  for (const row of [14, 20]) {
    for (const col of [6, 12, 18, 24]) {
      if (u >= col && u < col + 3 && v >= row && v < row + 3) return DOT;
    }
  }
  return v < 11 ? HEADER : BODY;
}

/** size x size RGBA 픽셀 버퍼를 돌려준다. */
function drawIconRgba(size) {
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const color = colorAt(((x + 0.5) / size) * 32, ((y + 0.5) / size) * 32);
      if (!color) continue;
      const i = (y * size + x) * 4;
      buf[i] = color[0];
      buf[i + 1] = color[1];
      buf[i + 2] = color[2];
      buf[i + 3] = 255;
    }
  }
  return buf;
}

/** Electron 트레이/알림용 nativeImage (createFromBitmap은 BGRA 순서를 받는다). */
function makeIcon(nativeImage, size = 32) {
  const buf = drawIconRgba(size);
  for (let i = 0; i < buf.length; i += 4) [buf[i], buf[i + 2]] = [buf[i + 2], buf[i]];
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

module.exports = { drawIconRgba, makeIcon };
