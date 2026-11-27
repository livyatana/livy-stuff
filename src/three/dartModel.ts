import * as THREE from 'three';

// Dart dimensions in world units (ball diameter = 3.30)
// Local origin (0, 0, 0) is at the barrel grip / center of mass.
// Forward direction is -Z (tip at z = -0.36, tail end at z = +0.34).
export const DART_TIP_Z = -0.36;
export const DART_TAIL_Z = 0.34;

export interface DartInstance {
  group: THREE.Group;
  dispose: () => void;
}

export interface XRayDartOverlay {
  group: THREE.Group;
  setOpacity: (opacity: number) => void;
  dispose: () => void;
}

export interface StylisedHandRig {
  group: THREE.Group;
  dartSocket: THREE.Group;
  dispose: () => void;
}

export interface AimArcVisual {
  points: THREE.Points;
  updateArc: (positions: THREE.Vector3[], count: number) => void;
  setVisible: (visible: boolean) => void;
  dispose: () => void;
}

/**
 * Builds a realistic multi-part 3D dart:
 * - Tapered steel needle point
 * - Knurled lathe metal barrel with machined grip rings
 * - Thin anodized shaft + collar ring
 * - Three shaped flights spaced 120 degrees apart
 */
export function createRealisticDartGroup(): DartInstance {
  const group = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  const steelMat = new THREE.MeshStandardMaterial({
    color: 0xd9dde2,
    metalness: 0.92,
    roughness: 0.2,
    envMapIntensity: 0.5,
  });
  const barrelMat = new THREE.MeshStandardMaterial({
    color: 0x9aa1aa,
    metalness: 0.88,
    roughness: 0.28,
    envMapIntensity: 0.5,
  });
  const grooveRingMat = new THREE.MeshStandardMaterial({
    color: 0x22252b,
    metalness: 0.45,
    roughness: 0.55,
    envMapIntensity: 0.3,
  });
  const shaftMat = new THREE.MeshStandardMaterial({
    color: 0x1c1e24,
    metalness: 0.35,
    roughness: 0.42,
    envMapIntensity: 0.3,
  });
  const flightMat = new THREE.MeshStandardMaterial({
    color: 0xe11d48,
    metalness: 0.05,
    roughness: 0.58,
    side: THREE.DoubleSide,
    envMapIntensity: 0.2,
  });
  materials.push(steelMat, barrelMat, grooveRingMat, shaftMat, flightMat);

  // 1. Steel needle tip: z from -0.36 (sharp point) to -0.22 (collar)
  const tipGeo = new THREE.CylinderGeometry(0.0018, 0.0115, 0.14, 16);
  tipGeo.rotateX(-Math.PI / 2); // +Y cylinder axis -> -Z forward
  geometries.push(tipGeo);
  const tipMesh = new THREE.Mesh(tipGeo, steelMat);
  tipMesh.position.z = -0.29;
  tipMesh.castShadow = true;
  group.add(tipMesh);

  // 2. Machined lathe metal barrel: z from -0.22 to +0.04
  // LatheGeometry revolves around +Y; after rotateX(-PI/2), +Y maps to -Z.
  // So latheY = -z: +0.22 (front) down to -0.04 (rear).
  const barrelPts: THREE.Vector2[] = [
    new THREE.Vector2(0.0115, 0.22),
    new THREE.Vector2(0.022, 0.205),
    new THREE.Vector2(0.0265, 0.175),
    new THREE.Vector2(0.027, 0.145),
    new THREE.Vector2(0.024, 0.141),
    new THREE.Vector2(0.027, 0.137),
    new THREE.Vector2(0.027, 0.112),
    new THREE.Vector2(0.024, 0.108),
    new THREE.Vector2(0.027, 0.104),
    new THREE.Vector2(0.0268, 0.079),
    new THREE.Vector2(0.0238, 0.075),
    new THREE.Vector2(0.0265, 0.071),
    new THREE.Vector2(0.0255, 0.046),
    new THREE.Vector2(0.0225, 0.042),
    new THREE.Vector2(0.0245, 0.038),
    new THREE.Vector2(0.021, 0.005),
    new THREE.Vector2(0.0155, -0.04),
  ];
  const barrelGeo = new THREE.LatheGeometry(barrelPts, 24);
  barrelGeo.rotateX(-Math.PI / 2);
  geometries.push(barrelGeo);
  const barrelMesh = new THREE.Mesh(barrelGeo, barrelMat);
  barrelMesh.castShadow = true;
  barrelMesh.receiveShadow = true;
  group.add(barrelMesh);

  // Subtle dark grip accent rings recessed around barrel
  const ringGeo = new THREE.TorusGeometry(0.0255, 0.0022, 8, 22);
  geometries.push(ringGeo);
  for (const ringZ of [-0.141, -0.108, -0.075, -0.042]) {
    const ring = new THREE.Mesh(ringGeo, grooveRingMat);
    ring.position.z = ringZ;
    group.add(ring);
  }

  // 3. Thin shaft + metallic collar: z from +0.04 to +0.26
  const collarGeo = new THREE.CylinderGeometry(0.0165, 0.0155, 0.025, 16);
  collarGeo.rotateX(-Math.PI / 2);
  geometries.push(collarGeo);
  const collarMesh = new THREE.Mesh(collarGeo, steelMat);
  collarMesh.position.z = 0.052;
  group.add(collarMesh);

  const shaftGeo = new THREE.CylinderGeometry(0.0138, 0.0095, 0.21, 14);
  shaftGeo.rotateX(-Math.PI / 2);
  geometries.push(shaftGeo);
  const shaftMesh = new THREE.Mesh(shaftGeo, shaftMat);
  shaftMesh.position.z = 0.16;
  shaftMesh.castShadow = true;
  group.add(shaftMesh);

  // Tail cap nut
  const capGeo = new THREE.SphereGeometry(0.0105, 10, 8);
  geometries.push(capGeo);
  const capMesh = new THREE.Mesh(capGeo, shaftMat);
  capMesh.position.z = 0.27;
  group.add(capMesh);

  // 4. Three shaped flights spaced 120 degrees apart (z from +0.18 to +0.34)
  const flightShape = new THREE.Shape();
  flightShape.moveTo(0.008, -0.02);
  flightShape.lineTo(0.052, 0.022);
  flightShape.quadraticCurveTo(0.064, 0.045, 0.058, 0.105);
  flightShape.lineTo(0.044, 0.145);
  flightShape.lineTo(0.008, 0.132);
  flightShape.closePath();

  const flightGeo = new THREE.ExtrudeGeometry(flightShape, {
    depth: 0.004,
    bevelEnabled: true,
    bevelThickness: 0.001,
    bevelSize: 0.001,
    bevelSegments: 1,
    curveSegments: 8,
  });
  // Map shape X -> radial +X, shape Y -> +Z (backward), extrude Z centered on 0
  flightGeo.translate(0, 0, -0.002);
  flightGeo.rotateX(Math.PI / 2);
  geometries.push(flightGeo);

  for (let i = 0; i < 3; i++) {
    const fin = new THREE.Mesh(flightGeo, flightMat);
    fin.position.z = 0.195;
    fin.rotation.z = (i * Math.PI * 2) / 3 + Math.PI / 6;
    fin.castShadow = true;
    group.add(fin);
  }

  return {
    group,
    dispose: () => {
      geometries.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
    },
  };
}

/**
 * Creates a synchronized "x-ray" copy of a dart (reusing its geometries) rendered with
 * depthTest: false at 35% white opacity plus a soft neon-pink rim glow and outline,
 * so the dart remains clearly readable even while hidden behind the ball.
 */
export function createXRayDartOverlay(sourceDartGroup: THREE.Group): XRayDartOverlay {
  const group = new THREE.Group();
  const opacityUniform = { value: 0.0 };

  const xrayBodyMat = new THREE.ShaderMaterial({
    uniforms: {
      uOpacity: opacityUniform,
      uBaseColor: { value: new THREE.Color(0xffffff) },
      uRimColor: { value: new THREE.Color(0xff2e97) },
    },
    vertexShader: `
      varying vec3 vNormalView;
      varying vec3 vViewDir;
      void main() {
        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        vNormalView = normalize(normalMatrix * normal);
        vViewDir = normalize(-mvPos.xyz);
        gl_Position = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: `
      uniform float uOpacity;
      uniform vec3 uBaseColor;
      uniform vec3 uRimColor;
      varying vec3 vNormalView;
      varying vec3 vViewDir;
      void main() {
        float ndotv = abs(dot(normalize(vNormalView), normalize(vViewDir)));
        float rim = pow(clamp(1.0 - ndotv, 0.0, 1.0), 1.55);
        vec3 col = mix(uBaseColor, uRimColor, smoothstep(0.18, 0.85, rim));
        float alpha = mix(0.35, 0.85, rim) * uOpacity;
        if (alpha <= 0.002) discard;
        gl_FragColor = vec4(col, alpha);
      }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const outlineMat = new THREE.ShaderMaterial({
    uniforms: {
      uOpacity: opacityUniform,
      uOutlineColor: { value: new THREE.Color(0xff2e97) },
      uThickness: { value: 0.0045 },
    },
    vertexShader: `
      uniform float uThickness;
      void main() {
        vec3 expanded = position + normal * uThickness;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(expanded, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uOpacity;
      uniform vec3 uOutlineColor;
      void main() {
        float alpha = 0.48 * uOpacity;
        if (alpha <= 0.002) discard;
        gl_FragColor = vec4(uOutlineColor, alpha);
      }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.BackSide,
  });

  sourceDartGroup.children.forEach((child) => {
    if (!(child instanceof THREE.Mesh)) return;

    const outlineMesh = new THREE.Mesh(child.geometry, outlineMat);
    outlineMesh.position.copy(child.position);
    outlineMesh.rotation.copy(child.rotation);
    outlineMesh.scale.copy(child.scale);
    outlineMesh.castShadow = false;
    outlineMesh.receiveShadow = false;
    outlineMesh.renderOrder = 29;
    group.add(outlineMesh);

    const bodyMesh = new THREE.Mesh(child.geometry, xrayBodyMat);
    bodyMesh.position.copy(child.position);
    bodyMesh.rotation.copy(child.rotation);
    bodyMesh.scale.copy(child.scale);
    bodyMesh.castShadow = false;
    bodyMesh.receiveShadow = false;
    bodyMesh.renderOrder = 30;
    group.add(bodyMesh);
  });

  group.visible = false;

  return {
    group,
    setOpacity: (opacity: number) => {
      const clamped = THREE.MathUtils.clamp(opacity, 0, 1);
      opacityUniform.value = clamped;
      group.visible = clamped > 0.004;
    },
    dispose: () => {
      xrayBodyMat.dispose();
      outlineMat.dispose();
    },
  };
}

/**
 * Builds a clean, stylised, matte skin-tone 3D hand seen from behind / first-person,
 * holding a dart at its grip socket.
 */
export function createStylisedHandGroup(): StylisedHandRig {
  const group = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  const skinMat = new THREE.MeshStandardMaterial({
    color: 0xf1c2a0,
    roughness: 0.82,
    metalness: 0.0,
    envMapIntensity: 0,
  });
  const shadowCreaseMat = new THREE.MeshStandardMaterial({
    color: 0xe3af8a,
    roughness: 0.86,
    metalness: 0.0,
    envMapIntensity: 0,
  });
  materials.push(skinMat, shadowCreaseMat);

  // Dart socket positioned at the thumb + index pinch point
  const dartSocket = new THREE.Group();
  dartSocket.position.set(-0.025, 0.055, -0.05);
  // Slight natural inward tilt toward the screen center
  dartSocket.rotation.set(0.06, 0.04, 0);
  group.add(dartSocket);

  // Helper to add rounded capsule segments between two points
  const addSegment = (
    parent: THREE.Object3D,
    p0: THREE.Vector3,
    p1: THREE.Vector3,
    radius: number,
    mat: THREE.Material = skinMat,
  ) => {
    const dir = new THREE.Vector3().subVectors(p1, p0);
    const len = dir.length();
    const geo = new THREE.CapsuleGeometry(radius, len, 6, 12);
    geometries.push(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.addVectors(p0, p1).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    parent.add(mesh);
    return mesh;
  };

  // Sculpted hand sub-group angled naturally from bottom-right toward grip
  const handMeshGroup = new THREE.Group();
  group.add(handMeshGroup);

  // Forearm / Wrist extending downwards off bottom of frame
  const wristGeo = new THREE.CapsuleGeometry(0.068, 0.34, 8, 16);
  geometries.push(wristGeo);
  const wristMesh = new THREE.Mesh(wristGeo, skinMat);
  wristMesh.position.set(0.085, -0.25, 0.24);
  wristMesh.rotation.set(0.58, 0.0, 0.24);
  wristMesh.scale.set(1.06, 1, 0.78);
  handMeshGroup.add(wristMesh);

  // Rounded Palm (smooth squashed sphere/capsule)
  const palmGeo = new THREE.SphereGeometry(0.095, 18, 16);
  geometries.push(palmGeo);
  const palmMesh = new THREE.Mesh(palmGeo, skinMat);
  palmMesh.position.set(0.036, -0.065, 0.085);
  palmMesh.rotation.set(0.32, -0.15, 0.22);
  palmMesh.scale.set(1.02, 1.12, 0.62);
  handMeshGroup.add(palmMesh);

  // Thumb (left side of palm, reaching up & forward to pinch barrel left side)
  addSegment(
    handMeshGroup,
    new THREE.Vector3(-0.02, -0.085, 0.075),
    new THREE.Vector3(-0.056, -0.015, 0.01),
    0.025,
  );
  addSegment(
    handMeshGroup,
    new THREE.Vector3(-0.056, -0.015, 0.01),
    new THREE.Vector3(-0.044, 0.044, -0.042),
    0.022,
  );

  // Index finger (arching over top-right to press onto the barrel)
  addSegment(
    handMeshGroup,
    new THREE.Vector3(0.012, -0.005, 0.042),
    new THREE.Vector3(0.006, 0.062, -0.018),
    0.021,
  );
  addSegment(
    handMeshGroup,
    new THREE.Vector3(0.006, 0.062, -0.018),
    new THREE.Vector3(-0.014, 0.074, -0.062),
    0.0185,
  );

  // Middle finger (supporting from bottom-right under the barrel)
  addSegment(
    handMeshGroup,
    new THREE.Vector3(0.048, -0.018, 0.048),
    new THREE.Vector3(0.028, 0.036, -0.012),
    0.021,
  );
  addSegment(
    handMeshGroup,
    new THREE.Vector3(0.028, 0.036, -0.012),
    new THREE.Vector3(-0.004, 0.038, -0.056),
    0.018,
  );

  // Ring finger (softly curled inward into palm)
  addSegment(
    handMeshGroup,
    new THREE.Vector3(0.076, -0.042, 0.06),
    new THREE.Vector3(0.082, -0.012, 0.014),
    0.0195,
    shadowCreaseMat,
  );
  addSegment(
    handMeshGroup,
    new THREE.Vector3(0.082, -0.012, 0.014),
    new THREE.Vector3(0.046, -0.036, -0.006),
    0.0175,
    shadowCreaseMat,
  );

  // Pinky finger (tucked lower on outer right)
  addSegment(
    handMeshGroup,
    new THREE.Vector3(0.098, -0.076, 0.076),
    new THREE.Vector3(0.104, -0.052, 0.036),
    0.0175,
    shadowCreaseMat,
  );
  addSegment(
    handMeshGroup,
    new THREE.Vector3(0.104, -0.052, 0.036),
    new THREE.Vector3(0.07, -0.072, 0.018),
    0.0155,
    shadowCreaseMat,
  );

  return {
    group,
    dartSocket,
    dispose: () => {
      geometries.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
    },
  };
}

/**
 * Faint dotted trajectory aiming arc using crisp anti-aliased shader points.
 */
export function createAimArcVisual(maxPoints = 24): AimArcVisual {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(maxPoints * 3);
  const alphas = new Float32Array(maxPoints);
  const sizes = new Float32Array(maxPoints);

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setDrawRange(0, 0);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0x1b1d22) },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
    },
    vertexShader: `
      attribute float aAlpha;
      attribute float aSize;
      uniform float uPixelRatio;
      varying float vAlpha;
      void main() {
        vAlpha = aAlpha;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uPixelRatio * (18.0 / max(0.8, -mvPosition.z));
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      varying float vAlpha;
      void main() {
        vec2 c = gl_PointCoord - vec2(0.5);
        float r = length(c);
        if (r > 0.5) discard;
        float soft = 1.0 - smoothstep(0.32, 0.5, r);
        gl_FragColor = vec4(uColor, vAlpha * soft);
      }
    `,
    transparent: true,
    depthWrite: false,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 15;
  points.visible = false;

  return {
    points,
    updateArc: (pts: THREE.Vector3[], count: number) => {
      const n = Math.min(maxPoints, count);
      const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
      const alphaAttr = geometry.getAttribute('aAlpha') as THREE.BufferAttribute;
      const sizeAttr = geometry.getAttribute('aSize') as THREE.BufferAttribute;

      for (let i = 0; i < n; i++) {
        const p = pts[i];
        posAttr.setXYZ(i, p.x, p.y, p.z);
        const t = n > 1 ? i / (n - 1) : 0;
        // Fade gently along the arc
        alphaAttr.setX(i, 0.42 * (1 - t * 0.78));
        sizeAttr.setX(i, 4.2 * (1 - t * 0.25));
      }
      posAttr.needsUpdate = true;
      alphaAttr.needsUpdate = true;
      sizeAttr.needsUpdate = true;
      geometry.setDrawRange(0, n);
    },
    setVisible: (visible: boolean) => {
      points.visible = visible;
    },
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
}
