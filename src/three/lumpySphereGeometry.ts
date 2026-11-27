import * as THREE from 'three';

function hash3(ix: number, iy: number, iz: number): number {
  let h =
    Math.imul(ix, 374761393) +
    Math.imul(iy, 668265263) +
    Math.imul(iz, 1274126177) +
    1442695041;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function valueNoise3D(x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const sz = fz * fz * (3 - 2 * fz);

  const n000 = hash3(ix, iy, iz);
  const n100 = hash3(ix + 1, iy, iz);
  const n010 = hash3(ix, iy + 1, iz);
  const n110 = hash3(ix + 1, iy + 1, iz);
  const n001 = hash3(ix, iy, iz + 1);
  const n101 = hash3(ix + 1, iy, iz + 1);
  const n011 = hash3(ix, iy + 1, iz + 1);
  const n111 = hash3(ix + 1, iy + 1, iz + 1);

  const nx00 = n000 + sx * (n100 - n000);
  const nx10 = n010 + sx * (n110 - n010);
  const nx01 = n001 + sx * (n101 - n001);
  const nx11 = n011 + sx * (n111 - n011);

  const nxy0 = nx00 + sy * (nx10 - nx00);
  const nxy1 = nx01 + sy * (nx11 - nx01);

  return (nxy0 + sz * (nxy1 - nxy0)) * 2 - 1;
}

/**
 * Low-frequency lumpy papier-mâché heightfield (~2.6% amplitude of radius).
 * Continuous across the entire unit sphere.
 */
export function lumpyRadiusScale(dir: THREE.Vector3): number {
  const n1 = valueNoise3D(dir.x * 2.4 + 3.1, dir.y * 2.4 + 1.7, dir.z * 2.4 + 5.3);
  const n2 = valueNoise3D(dir.x * 4.9 + 9.2, dir.y * 4.9 + 4.4, dir.z * 4.9 + 2.8);
  const n3 = valueNoise3D(dir.x * 9.5 + 1.3, dir.y * 9.5 + 7.6, dir.z * 9.5 + 8.1);
  return 1.0 + n1 * 0.02 + n2 * 0.0085 + n3 * 0.0035;
}

const _tmpUp = new THREE.Vector3(0, 1, 0);
const _tmpRight = new THREE.Vector3(1, 0, 0);
const _tVec = new THREE.Vector3();
const _bVec = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _p3 = new THREE.Vector3();
const _p4 = new THREE.Vector3();
const _dT = new THREE.Vector3();
const _dB = new THREE.Vector3();

/**
 * Computes exact smooth analytical/finite-difference normal of the lumpy sphere
 * at unit direction `dir` so cube-sphere seams share identical vertex normals.
 */
function computeLumpyNormal(
  dir: THREE.Vector3,
  radius: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const eps = 0.016;
  const ref = Math.abs(dir.y) < 0.92 ? _tmpUp : _tmpRight;
  _tVec.crossVectors(ref, dir).normalize();
  _bVec.crossVectors(dir, _tVec).normalize();

  _p1.copy(dir).addScaledVector(_tVec, eps).normalize();
  _p2.copy(dir).addScaledVector(_tVec, -eps).normalize();
  _p3.copy(dir).addScaledVector(_bVec, eps).normalize();
  _p4.copy(dir).addScaledVector(_bVec, -eps).normalize();

  const rT1 = radius * lumpyRadiusScale(_p1);
  const rT2 = radius * lumpyRadiusScale(_p2);
  const rB1 = radius * lumpyRadiusScale(_p3);
  const rB2 = radius * lumpyRadiusScale(_p4);

  _p1.multiplyScalar(rT1);
  _p2.multiplyScalar(rT2);
  _p3.multiplyScalar(rB1);
  _p4.multiplyScalar(rB2);

  _dT.subVectors(_p1, _p2);
  _dB.subVectors(_p3, _p4);
  return out.crossVectors(_dT, _dB).normalize();
}

/**
 * Builds a high-resolution uniform spherified cube mesh (zero polar pinching)
 * with smooth lumpy displacement and an `aObjDir` attribute for seamless
 * cube-map collage sampling and triplanar normal mapping.
 */
export function buildLumpyCubeSphereGeometry(
  radius: number,
  segmentsPerFace = 64,
): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(1, 1, 1, segmentsPerFace, segmentsPerFace, segmentsPerFace);
  const pos = geo.attributes.position;
  const norm = geo.attributes.normal;
  const objDirs = new Float32Array(pos.count * 3);

  const dir = new THREE.Vector3();
  const smoothN = new THREE.Vector3();

  for (let i = 0; i < pos.count; i++) {
    dir.fromBufferAttribute(pos, i).normalize();

    objDirs[i * 3] = dir.x;
    objDirs[i * 3 + 1] = dir.y;
    objDirs[i * 3 + 2] = dir.z;

    const r = radius * lumpyRadiusScale(dir);
    pos.setXYZ(i, dir.x * r, dir.y * r, dir.z * r);

    computeLumpyNormal(dir, radius, smoothN);
    norm.setXYZ(i, smoothN.x, smoothN.y, smoothN.z);
  }

  pos.needsUpdate = true;
  norm.needsUpdate = true;
  geo.setAttribute('aObjDir', new THREE.BufferAttribute(objDirs, 3));
  geo.computeBoundingSphere();
  return geo;
}

export interface WinningPatchBasis {
  center: THREE.Vector3;
  tangent: THREE.Vector3;
  bitangent: THREE.Vector3;
  halfW: number;
  halfH: number;
}

export interface WinningPosterPatchBuild {
  geometry: THREE.BufferGeometry;
  origin: THREE.Vector3;
}

/**
 * Builds a curved grid patch over the lumpy sphere centered around its spot origin,
 * so lifting and scaling the mesh keeps it centered directly over its spot.
 */
export function buildWinningPosterPatchGeometry(
  spec: WinningPatchBasis,
  radius: number,
  radialOffset: number,
): WinningPosterPatchBuild {
  const cols = 14;
  const rows = 20;
  const padScale = 1.15;

  const originRadius = radius * lumpyRadiusScale(spec.center) + radialOffset;
  const origin = spec.center.clone().multiplyScalar(originRadius);

  const vertCount = (cols + 1) * (rows + 1);
  const pos = new Float32Array(vertCount * 3);
  const norm = new Float32Array(vertCount * 3);
  const uv = new Float32Array(vertCount * 2);
  const objDirs = new Float32Array(vertCount * 3);
  const indices = new Uint16Array(cols * rows * 6);

  const dir = new THREE.Vector3();
  const smoothN = new THREE.Vector3();

  let vIdx = 0;
  for (let iy = 0; iy <= rows; iy++) {
    const v = iy / rows;
    const ny = v * 2 - 1;
    const ly = ny * spec.halfH * padScale;

    for (let ix = 0; ix <= cols; ix++) {
      const u = ix / cols;
      const nx = u * 2 - 1;
      const lx = nx * spec.halfW * padScale;

      dir
        .copy(spec.center)
        .addScaledVector(spec.tangent, lx)
        .addScaledVector(spec.bitangent, ly)
        .normalize();

      const r = radius * lumpyRadiusScale(dir) + radialOffset;
      pos[vIdx * 3] = dir.x * r - origin.x;
      pos[vIdx * 3 + 1] = dir.y * r - origin.y;
      pos[vIdx * 3 + 2] = dir.z * r - origin.z;

      computeLumpyNormal(dir, radius, smoothN);
      norm[vIdx * 3] = smoothN.x;
      norm[vIdx * 3 + 1] = smoothN.y;
      norm[vIdx * 3 + 2] = smoothN.z;

      objDirs[vIdx * 3] = dir.x;
      objDirs[vIdx * 3 + 1] = dir.y;
      objDirs[vIdx * 3 + 2] = dir.z;

      uv[vIdx * 2] = u;
      uv[vIdx * 2 + 1] = v;

      vIdx++;
    }
  }

  let tIdx = 0;
  const stride = cols + 1;
  for (let iy = 0; iy < rows; iy++) {
    for (let ix = 0; ix < cols; ix++) {
      const a = iy * stride + ix;
      const b = a + 1;
      const c = (iy + 1) * stride + ix;
      const d = c + 1;

      indices[tIdx++] = a;
      indices[tIdx++] = b;
      indices[tIdx++] = d;

      indices[tIdx++] = a;
      indices[tIdx++] = d;
      indices[tIdx++] = c;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('aObjDir', new THREE.BufferAttribute(objDirs, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeBoundingSphere();
  return { geometry: geo, origin };
}
