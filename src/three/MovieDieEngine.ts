import * as CANNON from 'cannon-es';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { soundEffects } from '../services/audio';
import type { MovieRecord } from '../types/movie';
import {
  bakeCollageCubeMap,
  createWinningPosterTextures,
  type BakeProgress,
  type BakedCollageResult,
  type PosterLayoutSpec,
} from './collageBaker';
import {
  buildLumpyCubeSphereGeometry,
  buildWinningPosterPatchGeometry,
  lumpyRadiusScale,
} from './lumpySphereGeometry';
import {
  createPaperNormalTexture,
  createPaperRoughnessTexture,
} from './paperTextures';
import {
  createAimArcVisual,
  createRealisticDartGroup,
  createStylisedHandGroup,
  DART_TIP_Z,
  type AimArcVisual,
  type DartInstance,
  type StylisedHandRig,
} from './dartModel';

export type GameMode = 'dice' | 'darts';

export const DIE_RADIUS = 1.65;
const DARTS_FLOAT_HEIGHT = 0.42;
const DART_GRAVITY = 5.4;
const DART_AIR_DRAG = 0.22;
const ARENA_HALF_X = 2.75;
const ARENA_HALF_Z = 1.75;
const UP_VECTOR = new THREE.Vector3(0, 1, 0);
const FORWARD_Z = new THREE.Vector3(0, 0, -1);

// Pre-allocated math helpers (zero GC in animation loop)
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _invQuat = new THREE.Quaternion();
const _camForward = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _winnerCenterWorld = new THREE.Vector3();
const _winnerRightWorld = new THREE.Vector3();
const _winnerUpWorld = new THREE.Vector3();
const _basisMat = new THREE.Matrix4();

export interface FlingVector {
  vx: number;
  vz: number;
  strength: number;
}

export interface RevealScreenLayout {
  centerX: number;
  centerY: number;
  rightEdgeX: number;
  bottomEdgeY: number;
  posterLeft: number;
  posterTop: number;
  posterWidth: number;
  posterHeight: number;
  isNarrow: boolean;
}

export interface EngineCallbacks {
  onHoverMovie: (movieIndex: number | null, clientX: number, clientY: number) => void;
  onRollStarted: () => void;
  onDartActivityChange?: (busy: boolean) => void;
  onZoomStarted: () => void;
  onPosterLiftStarted: () => void;
  onPreloadWinner: (movieIndex: number) => void;
  onPosterSwapStarted: (
    movieIndex: number,
    layout: RevealScreenLayout,
    skipped?: boolean,
  ) => void;
  onPosterSettleStarted: () => void;
  onRevealReady: (
    movieIndex: number,
    layout: RevealScreenLayout,
    skipped?: boolean,
  ) => void;
  onRevealLayoutChange: (layout: RevealScreenLayout) => void;
  onReturnComplete: () => void;
  onFlingRollRequest: (fling: FlingVector) => void;
  onContextLostChange: (lost: boolean) => void;
}

type EnginePhase =
  | 'idle'
  | 'rolling'
  | 'revealPause'
  | 'pushIn'
  | 'liftUp'
  | 'swapCrossfade'
  | 'settle'
  | 'revealed'
  | 'returning';

type DartState = 'ready' | 'aiming' | 'throwing' | 'flying' | 'missed' | 'impactSlowdown';

function createLightBurstTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const half = size / 2;

  const grad = ctx.createRadialGradient(half, half, 4, half, half, half);
  grad.addColorStop(0, 'rgba(255, 255, 255, 0.98)');
  grad.addColorStop(0.28, 'rgba(255, 246, 252, 0.85)');
  grad.addColorStop(0.55, 'rgba(255, 224, 244, 0.34)');
  grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  // Subtle radial sunburst rays
  ctx.save();
  ctx.translate(half, half);
  const rayCount = 16;
  for (let i = 0; i < rayCount; i++) {
    const a = (i / rayCount) * Math.PI * 2;
    ctx.save();
    ctx.rotate(a);
    const rGrad = ctx.createLinearGradient(0, 0, half, 0);
    rGrad.addColorStop(0, 'rgba(255, 255, 255, 0.45)');
    rGrad.addColorStop(0.5, 'rgba(255, 238, 248, 0.16)');
    rGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = rGrad;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(half, -22);
    ctx.lineTo(half, 22);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function detectSoftwareGl(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param) || '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return true;
  }
}

function createContactShadowTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createRadialGradient(
    size / 2,
    size / 2,
    size * 0.04,
    size / 2,
    size / 2,
    size * 0.48,
  );
  grad.addColorStop(0, 'rgba(0, 0, 0, 0.24)');
  grad.addColorStop(0.45, 'rgba(0, 0, 0, 0.10)');
  grad.addColorStop(0.75, 'rgba(0, 0, 0, 0.025)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export class MovieDieEngine {
  private container: HTMLElement;
  private callbacks: EngineCallbacks;
  private isSoftwareGl: boolean;

  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer | null = null;
  private ssaoPass: SSAOPass | null = null;
  private outputPass: OutputPass | null = null;
  private controls: OrbitControls;

  // High-res lumpy sphere with baked cube-map paper collage
  private dieGroup: THREE.Group | null = null;
  private dieMesh: THREE.Mesh | null = null;
  private dieMaterial: THREE.MeshStandardMaterial | null = null;
  private bakedCollage: BakedCollageResult | null = null;
  private bakeAbortController: AbortController | null = null;

  // Blank paper patch on ball + flat single-sided torn paper scrap + subtle glow
  private winnerBlankMesh: THREE.Mesh | null = null;
  private winnerBlankMat: THREE.MeshStandardMaterial | null = null;
  private winnerShadowMesh: THREE.Mesh | null = null;
  private winnerShadowMat: THREE.MeshBasicMaterial | null = null;
  private winnerScrapMesh: THREE.Mesh | null = null;
  private winnerScrapMat: THREE.MeshStandardMaterial | null = null;
  private winnerFlashMesh: THREE.Mesh | null = null;
  private winnerFlashMat: THREE.MeshBasicMaterial | null = null;
  private lightBurstTex: THREE.CanvasTexture;

  private cardHalfW = 0.14 * DIE_RADIUS;
  private cardHalfH = 0.21 * DIE_RADIUS;
  private cardStartPos = new THREE.Vector3();
  private cardStartQuat = new THREE.Quaternion();
  private cardLandPos = new THREE.Vector3();
  private cardLandQuat = new THREE.Quaternion();
  private cardLandScale = 1.0;
  private camShakeRight = new THREE.Vector3(1, 0, 0);
  private camShakeUp = new THREE.Vector3(0, 0, -1);

  private winnerTexturesCleanup: (() => void) | null = null;
  private winnerPatchAbort: AbortController | null = null;

  private paperNormalTex: THREE.DataTexture;
  private paperRoughnessTex: THREE.DataTexture;

  private faceNormals: THREE.Vector3[] = [];
  private posterSpecs: PosterLayoutSpec[] = [];
  private movies: MovieRecord[] = [];

  private floorMesh: THREE.Mesh;
  private contactShadowMesh: THREE.Mesh;
  private keyLight: THREE.DirectionalLight;
  private fillLight: THREE.DirectionalLight;

  // Physics (perfect sphere collider)
  private world: CANNON.World;
  private dieBody: CANNON.Body;
  private tablePhysMat: CANNON.Material;
  private diePhysMat: CANNON.Material;

  // State & Choreography
  private mode: GameMode = 'dice';
  private phase: EnginePhase = 'idle';
  private muted = false;
  private frameId = 0;
  private disposed = false;
  private lastTime = performance.now();
  private renderPending = false;
  private elapsedClock = 0;

  // Mode transition smoothing
  private modeTransitioning = false;
  private diceReturnSettling = false;

  // Darts mode: autonomous chaotic wandering spin + secondary wobble + jolts + bobbing
  private spinAxisCurr = new THREE.Vector3(0.28, 0.92, 0.26).normalize();
  private spinAxisTarget = new THREE.Vector3(0.28, 0.92, 0.26).normalize();
  private spinSpeedCurr = 2.2;
  private spinSpeedTarget = 2.2;
  private spinWanderTimer = 1.1;

  private wobbleAxisCurr = new THREE.Vector3(0.84, -0.32, 0.44).normalize();
  private wobbleAxisTarget = new THREE.Vector3(0.84, -0.32, 0.44).normalize();
  private wobbleSpeedCurr = 0.6;
  private wobbleWanderTimer = 1.9;

  private joltCooldown = 4.5;
  private joltElapsed = -1;
  private joltDuration = 0.5;
  private joltStrength = 2.2;

  private handAnchor: THREE.Group;
  private handRig: StylisedHandRig;
  private heldDart: DartInstance;
  private handEnterAmount = 0; // 0 = hidden (dice/reveal), 1 = visible (darts ready/aiming)

  private aimArc: AimArcVisual;
  private arcScratchPts: THREE.Vector3[] = Array.from({ length: 24 }, () => new THREE.Vector3());

  private dartState: DartState = 'ready';
  private aimingPointerId = -1;
  private aimStartX = 0;
  private aimStartY = 0;
  private aimPull = 0;
  private aimYaw = 0;
  private aimSamples: { x: number; y: number; t: number }[] = [];

  private throwAnimElapsed = 0;
  private throwAnimDuration = 0.13;
  private throwReleased = false;
  private throwPendingPower = 0.6;
  private throwPendingYaw = 0;

  private flyingDart: DartInstance | null = null;
  private dartPos = new THREE.Vector3();
  private dartVel = new THREE.Vector3();
  private dartFlightTime = 0;
  private dartRollAngle = 0;
  private missCooldown = 0;
  private missFloorPlayed = false;

  private stuckDartPivot: THREE.Group | null = null;
  private stuckDartQuiverNode: THREE.Group | null = null;
  private stuckDartInstance: DartInstance | null = null;
  private quiverElapsed = 0;
  private impactElapsed = 0;
  private impactSlowdownDuration = 2.0;
  private impactSpinAxis = new THREE.Vector3(0, 1, 0);
  private impactStartAngSpeed = 0;

  // Shader dent/ripple uniforms on dieMaterial
  private dentDirUniform = { value: new THREE.Vector3(0, 1, 0) };
  private dentStrengthUniform = { value: 0.0 };
  private dentRippleTimeUniform = { value: 0.0 };

  private stoppedDuration = 0;
  private bounceCount = 0;
  private winnerMovieIndex = 0;
  private preloadedWinnerIndex = -1;
  private swapTriggered = false;
  private returnHadCleanImg = false;

  // 1. Held breath pause (0.8s)
  private pauseElapsed = 0;
  private pauseDuration = 0.8;

  // 2. Camera push-in flight (2.5s power2.inOut)
  private pushElapsed = 0;
  private pushDuration = 2.5;
  private pushBezierP0 = new THREE.Vector3();
  private pushBezierP1 = new THREE.Vector3();
  private pushBezierP2 = new THREE.Vector3();
  private pushBezierP3 = new THREE.Vector3();
  private pushStartCamTarget = new THREE.Vector3();
  private pushEndCamTarget = new THREE.Vector3();
  private pushStartCamUp = new THREE.Vector3(0, 1, 0);
  private pushEndCamUp = new THREE.Vector3(0, 0, -1);
  private pushOutwardNormal = new THREE.Vector3(0, 1, 0);
  private pushDistFromPoster = 1.4;

  // 3. Flat upright scrap lift & scale up (2.0s, power2.out)
  private liftElapsed = 0;
  private liftDuration = 2.0;

  // 4. Soft crossfade swap from torn scrap into clean original poster (0.4s)
  private swapElapsed = 0;
  private swapDuration = 0.4;

  // 5. Tiny settle (scale 1.03 -> 1.0, 0.5s) before dialog fades in
  private settleElapsed = 0;
  private settleDuration = 0.5;

  // Closing: crossfade back to scrap, shrink onto ball, camera returns (1.5s)
  private returnElapsed = 0;
  private returnDuration = 1.5;
  private returnCardStartPos = new THREE.Vector3();
  private returnCardStartQuat = new THREE.Quaternion();
  private returnCardStartScale = 1.0;
  private returnBezierP0 = new THREE.Vector3();
  private returnBezierP1 = new THREE.Vector3();
  private returnBezierP2 = new THREE.Vector3();
  private returnBezierP3 = new THREE.Vector3();
  private returnStartCamTarget = new THREE.Vector3();
  private returnEndCamTarget = new THREE.Vector3();
  private returnStartCamUp = new THREE.Vector3(0, 0, -1);
  private returnEndCamUp = new THREE.Vector3(0, 1, 0);

  // Normal view camera offset (~60% of viewport height, centered between title and hint)
  private camOffset = new THREE.Vector3(0, 3.15, 8.05);
  private camTargetY = 1.92;

  // Pointer & Fling interaction
  private raycaster = new THREE.Raycaster();
  private pointerNdc = new THREE.Vector2();
  private lastHoverCheck = 0;
  private draggingDie = false;
  private dragPointerId = -1;
  private dragSamples: { x: number; y: number; t: number }[] = [];

  constructor(container: HTMLElement, callbacks: EngineCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.isSoftwareGl = detectSoftwareGl();

    this.paperNormalTex = createPaperNormalTexture();
    this.paperRoughnessTex = createPaperRoughnessTexture();
    this.lightBurstTex = createLightBurstTexture();

    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    const pixelRatio = this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height);
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.style.touchAction = 'none';
    container.appendChild(this.renderer.domElement);

    // Pure white scene, zero environment reflections
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xffffff);
    this.scene.environment = null;

    this.camera = new THREE.PerspectiveCamera(38, width / height, 0.08, 35);
    this.updateResponsiveCamOffset(width / height);
    this.camera.position.copy(this.camOffset);
    this.scene.add(this.camera);

    // First-person hand + held dart attached to camera space
    this.handAnchor = new THREE.Group();
    this.handAnchor.position.set(0.04, -1.17, -2.18);
    this.handRig = createStylisedHandGroup();
    this.heldDart = createRealisticDartGroup();
    this.handRig.dartSocket.add(this.heldDart.group);
    this.handAnchor.add(this.handRig.group);
    this.handAnchor.visible = false;
    this.camera.add(this.handAnchor);

    // Dotted trajectory aiming arc
    this.aimArc = createAimArcVisual(24);
    this.scene.add(this.aimArc.points);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, this.camTargetY, 0);
    this.controls.enableDamping = !this.isSoftwareGl;
    this.controls.dampingFactor = 0.06;
    this.controls.enablePan = false;
    this.controls.minDistance = 5.2;
    this.controls.maxDistance = 12.5;
    this.controls.minPolarAngle = 0.22;
    this.controls.maxPolarAngle = Math.PI * 0.44;
    this.controls.update();

    this.controls.addEventListener('change', () => {
      if (this.phase === 'idle' && this.mode === 'dice' && !this.modeTransitioning) {
        this.scheduleOnDemandRender();
      }
    });

    // Neutral white lighting (#ffffff): upper-left key light + soft fill + hemisphere ambient
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0xe8e8ea, 0.85);
    this.scene.add(hemiLight);

    this.keyLight = new THREE.DirectionalLight(0xffffff, 2.55);
    this.keyLight.position.set(-6.0, 7.2, 6.2);
    this.keyLight.castShadow = !this.isSoftwareGl;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.camera.near = 2;
    this.keyLight.shadow.camera.far = 22;
    const shadowBound = 4.6;
    this.keyLight.shadow.camera.left = -shadowBound;
    this.keyLight.shadow.camera.right = shadowBound;
    this.keyLight.shadow.camera.top = shadowBound;
    this.keyLight.shadow.camera.bottom = -shadowBound;
    this.keyLight.shadow.bias = -0.0008;
    this.keyLight.shadow.normalBias = 0.018;
    this.keyLight.shadow.radius = 3.5;
    this.scene.add(this.keyLight);
    this.scene.add(this.keyLight.target);

    this.fillLight = new THREE.DirectionalLight(0xffffff, 0.30);
    this.fillLight.position.set(7.5, 2.2, -4.5);
    this.scene.add(this.fillLight);
    this.scene.add(this.fillLight.target);

    // Invisible ShadowMaterial floor (only soft shadow visible on pure white)
    const floorGeo = new THREE.PlaneGeometry(80, 80);
    floorGeo.rotateX(-Math.PI / 2);
    const floorMat = new THREE.ShadowMaterial({
      color: 0x000000,
      opacity: 0.11,
    });
    this.floorMesh = new THREE.Mesh(floorGeo, floorMat);
    this.floorMesh.receiveShadow = true;
    this.scene.add(this.floorMesh);

    // Soft contact shadow directly under the die
    const shadowTex = createContactShadowTexture();
    const shadowGeo = new THREE.PlaneGeometry(DIE_RADIUS * 2.8, DIE_RADIUS * 2.8);
    shadowGeo.rotateX(-Math.PI / 2);
    const shadowMat = new THREE.MeshBasicMaterial({
      map: shadowTex,
      transparent: true,
      depthWrite: false,
      opacity: 0.85,
    });
    this.contactShadowMesh = new THREE.Mesh(shadowGeo, shadowMat);
    this.contactShadowMesh.position.y = 0.012;
    this.scene.add(this.contactShadowMesh);

    // Post-processing SSAO (floorMesh & shadow planes excluded so background stays pure #ffffff)
    if (!this.isSoftwareGl) {
      const renderTarget = new THREE.WebGLRenderTarget(
        Math.max(1, Math.floor(width * pixelRatio)),
        Math.max(1, Math.floor(height * pixelRatio)),
        {
          type: THREE.HalfFloatType,
          samples: 4,
        },
      );
      this.composer = new EffectComposer(this.renderer, renderTarget);
      this.composer.setPixelRatio(pixelRatio);
      this.composer.setSize(width, height);

      const renderPass = new RenderPass(this.scene, this.camera);
      this.composer.addPass(renderPass);

      this.ssaoPass = new SSAOPass(
        this.scene,
        this.camera,
        Math.max(1, Math.floor(width * pixelRatio)),
        Math.max(1, Math.floor(height * pixelRatio)),
        24,
      );
      this.ssaoPass.kernelRadius = 0.24;
      this.ssaoPass.minDistance = 0.00022;
      this.ssaoPass.maxDistance = 0.015;

      const origSsaoRender = this.ssaoPass.render.bind(this.ssaoPass);
      this.ssaoPass.render = (renderer, writeBuffer, readBuffer, deltaTime, maskActive) => {
        const prevFloor = this.floorMesh.visible;
        const prevContact = this.contactShadowMesh.visible;
        const prevWinShadow = this.winnerShadowMesh ? this.winnerShadowMesh.visible : false;
        const prevFlash = this.winnerFlashMesh ? this.winnerFlashMesh.visible : false;
        const prevArc = this.aimArc.points.visible;
        this.floorMesh.visible = false;
        this.contactShadowMesh.visible = false;
        this.aimArc.points.visible = false;
        if (this.winnerShadowMesh) this.winnerShadowMesh.visible = false;
        if (this.winnerFlashMesh) this.winnerFlashMesh.visible = false;
        try {
          origSsaoRender(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
        } finally {
          this.floorMesh.visible = prevFloor;
          this.contactShadowMesh.visible = prevContact;
          this.aimArc.points.visible = prevArc;
          if (this.winnerShadowMesh) this.winnerShadowMesh.visible = prevWinShadow;
          if (this.winnerFlashMesh) this.winnerFlashMesh.visible = prevFlash;
        }
      };

      this.composer.addPass(this.ssaoPass);

      this.outputPass = new OutputPass();
      this.composer.addPass(this.outputPass);
    }

    // Cannon-es Physics World: pure natural rolling, zero steering
    this.world = new CANNON.World({
      gravity: new CANNON.Vec3(0, -24, 0),
    });
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);

    this.tablePhysMat = new CANNON.Material('table');
    this.diePhysMat = new CANNON.Material('die');
    const contactMat = new CANNON.ContactMaterial(this.tablePhysMat, this.diePhysMat, {
      friction: 0.55,
      restitution: 0.36,
    });
    this.world.addContactMaterial(contactMat);

    const tableBody = new CANNON.Body({
      type: CANNON.Body.STATIC,
      material: this.tablePhysMat,
    });
    tableBody.addShape(new CANNON.Plane());
    tableBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    this.world.addBody(tableBody);

    this.dieBody = new CANNON.Body({
      mass: 4.5,
      material: this.diePhysMat,
      shape: new CANNON.Sphere(DIE_RADIUS),
      position: new CANNON.Vec3(0, DIE_RADIUS, 0),
      linearDamping: 0.12,
      angularDamping: 0.12,
    });
    this.world.addBody(this.dieBody);

    this.dieBody.addEventListener(
      'collide',
      (event: { contact: CANNON.ContactEquation }) => {
        if (this.phase !== 'rolling') return;
        const impactVel = Math.abs(event.contact.getImpactVelocityAlongNormal());
        if (impactVel > 1.0) {
          this.bounceCount++;
          soundEffects.playBounce(impactVel, this.muted);

          if (this.bounceCount <= 2 && impactVel > 2.0) {
            this.dieBody.angularVelocity.x += (Math.random() - 0.5) * 1.4;
            this.dieBody.angularVelocity.z += (Math.random() - 0.5) * 1.4;
          }
        }
      },
    );

    this.bindEvents();
    this.scheduleOnDemandRender();
  }

  private renderScene(): void {
    if (this.composer && !this.isSoftwareGl) {
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  private updateResponsiveCamOffset(aspect: number): void {
    const portraitScale = aspect < 0.9 ? 0.9 / Math.max(0.45, aspect) : 1.0;
    this.camOffset.set(0, 3.32 * Math.pow(portraitScale, 0.52), 8.2 * portraitScale);
    this.camTargetY = 1.92 * Math.pow(portraitScale, 0.25);
  }

  private getDartsCameraPose(posOut: THREE.Vector3, targetOut: THREE.Vector3): void {
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    const aspect = width / Math.max(1, height);
    const portraitScale = aspect < 0.95 ? 0.95 / Math.max(0.45, aspect) : 1.0;
    const ballCenterY = DIE_RADIUS + DARTS_FLOAT_HEIGHT;
    posOut.set(
      0,
      ballCenterY + 0.65 * Math.pow(portraitScale, 0.35),
      8.25 * Math.pow(portraitScale, 0.68),
    );
    targetOut.set(0, ballCenterY + 0.22, 0);
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
  }

  public setMode(mode: GameMode): void {
    if (this.mode === mode) return;
    this.mode = mode;

    // Cancel active pointer drags
    this.draggingDie = false;
    this.dragPointerId = -1;
    this.aimingPointerId = -1;
    this.aimPull = 0;
    this.aimYaw = 0;
    this.aimArc.setVisible(false);
    this.callbacks.onHoverMovie(null, 0, 0);
    this.callbacks.onDartActivityChange?.(false);

    // Clean up any in-flight/stuck dart state if switching mid-flight
    this.disposeFlyingDart();
    this.disposeStuckDart();
    this.heldDart.group.visible = true;
    this.dentStrengthUniform.value = 0;

    if (this.phase === 'idle') {
      this.modeTransitioning = true;
      if (mode === 'darts') {
        this.controls.enabled = false;
        this.dartState = 'ready';
        this.diceReturnSettling = false;
        this.handAnchor.visible = true;
        this.dieBody.sleep();
        this.spinWanderTimer = 0.9 + Math.random() * 0.8;
        this.spinSpeedCurr = 2.1;
        this.spinSpeedTarget = 1.5 + Math.random() * 2.0;
        this.wobbleWanderTimer = 1.8;
        this.joltCooldown = 4.0 + Math.random() * 2.0;
        this.joltElapsed = -1;
      } else {
        this.dartState = 'ready';
        this.diceReturnSettling = true;
        this.dieBody.velocity.setZero();
        this.dieBody.angularVelocity.setZero();
        this.dieBody.wakeUp();
      }
      this.startLoop();
    }
  }

  public async setMovies(
    movies: MovieRecord[],
    onBakeProgress?: (progress: BakeProgress) => void,
  ): Promise<void> {
    this.bakeAbortController?.abort();
    const controller = new AbortController();
    this.bakeAbortController = controller;

    this.movies = movies;
    this.disposeDie();

    if (movies.length === 0) return;

    const maxCubemapSize = this.renderer.capabilities.maxCubemapSize || 2048;
    const maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();

    const baked = await bakeCollageCubeMap(
      movies,
      {
        maxTextureSize: maxCubemapSize,
        maxAnisotropy,
        isSoftwareGl: this.isSoftwareGl,
      },
      (prog) => onBakeProgress?.(prog),
      controller.signal,
    );

    if (this.disposed || controller.signal.aborted) {
      baked.dispose();
      return;
    }

    this.bakedCollage = baked;
    this.faceNormals = baked.faceNormals;
    this.posterSpecs = baked.posterSpecs;

    this.dieGroup = new THREE.Group();
    this.dieGroup.position.set(
      this.dieBody.position.x,
      this.dieBody.position.y,
      this.dieBody.position.z,
    );

    const geometry = buildLumpyCubeSphereGeometry(DIE_RADIUS, 64);

    // Matte paper material: roughness 0.95, metalness 0, normalScale 0.6, no envMap
    this.dieMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      normalMap: this.paperNormalTex,
      normalScale: new THREE.Vector2(0.6, 0.6),
      roughnessMap: this.paperRoughnessTex,
      roughness: 0.95,
      metalness: 0.0,
      envMapIntensity: 0,
    });

    this.dieMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uCollageCube = { value: baked.cubeTexture };
      shader.uniforms.uDentDir = this.dentDirUniform;
      shader.uniforms.uDentStrength = this.dentStrengthUniform;
      shader.uniforms.uDentRippleTime = this.dentRippleTimeUniform;

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
uniform vec3 uDentDir;
uniform float uDentStrength;
uniform float uDentRippleTime;
attribute vec3 aObjDir;
varying vec3 vObjDir;
varying float vDentDepth;
varying vec3 vViewAxisX;
varying vec3 vViewAxisY;
varying vec3 vViewAxisZ;
`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
vDentDepth = 0.0;
if (uDentStrength > 0.001) {
  vec3 dirUnit = normalize(aObjDir);
  float distD = length(dirUnit - uDentDir);
  float dimple = exp(-(distD * distD) / 0.0042) * 0.032 * uDentStrength;
  float rippleEnv = exp(-distD * 14.0) * exp(-uDentRippleTime * 6.5) * step(0.0, 0.6 - uDentRippleTime);
  float ripple = sin(distD * 58.0 - uDentRippleTime * 34.0) * rippleEnv * 0.014 * uDentStrength;
  float disp = dimple - ripple;
  transformed -= dirUnit * disp;
  vDentDepth = dimple;
}
`,
        )
        .replace(
          '#include <uv_vertex>',
          `#include <uv_vertex>
vObjDir = aObjDir;
vViewAxisX = normalize(normalMatrix * vec3(1.0, 0.0, 0.0));
vViewAxisY = normalize(normalMatrix * vec3(0.0, 1.0, 0.0));
vViewAxisZ = normalize(normalMatrix * vec3(0.0, 0.0, 1.0));
#ifdef USE_ROUGHNESSMAP
  vRoughnessMapUv = uv * 2.5;
#endif
`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform samplerCube uCollageCube;
varying vec3 vObjDir;
varying float vDentDepth;
varying vec3 vViewAxisX;
varying vec3 vViewAxisY;
varying vec3 vViewAxisZ;
`,
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
vec3 objDirN = normalize(vObjDir);
diffuseColor.rgb *= texture(uCollageCube, objDirN).rgb;
diffuseColor.rgb *= (1.0 - clamp(vDentDepth * 4.5, 0.0, 0.14));
`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#ifdef USE_NORMALMAP
  vec3 dirN = normalize(vObjDir);
  vec3 blendW = pow(abs(dirN), vec3(4.0));
  blendW /= max(0.0001, blendW.x + blendW.y + blendW.z);

  vec2 nX = (texture2D(normalMap, dirN.zy * 1.45).xy * 2.0 - 1.0) * normalScale;
  vec2 nY = (texture2D(normalMap, dirN.xz * 1.45).xy * 2.0 - 1.0) * normalScale;
  vec2 nZ = (texture2D(normalMap, dirN.xy * 1.45).xy * 2.0 - 1.0) * normalScale;

  vec3 objDelta =
    vec3(0.0, nX.y, nX.x) * blendW.x +
    vec3(nY.x, 0.0, nY.y) * blendW.y +
    vec3(nZ.x, nZ.y, 0.0) * blendW.z;

  vec3 viewDelta = vViewAxisX * objDelta.x + vViewAxisY * objDelta.y + vViewAxisZ * objDelta.z;
  normal = normalize(normal + viewDelta);
#endif
`,
        );
    };

    this.dieMesh = new THREE.Mesh(geometry, this.dieMaterial);
    this.dieMesh.castShadow = true;
    this.dieMesh.receiveShadow = true;
    this.dieGroup.add(this.dieMesh);

    if (this.faceNormals[0]) {
      _v1.copy(this.faceNormals[0]);
      this.dieGroup.quaternion.setFromUnitVectors(_v1, UP_VECTOR);
      this.dieBody.quaternion.set(
        this.dieGroup.quaternion.x,
        this.dieGroup.quaternion.y,
        this.dieGroup.quaternion.z,
        this.dieGroup.quaternion.w,
      );
    }

    if (this.mode === 'darts') {
      this.dieGroup.position.set(0, DIE_RADIUS + DARTS_FLOAT_HEIGHT, 0);
      this.dieBody.position.set(0, DIE_RADIUS + DARTS_FLOAT_HEIGHT, 0);
      this.dieBody.sleep();
      this.getDartsCameraPose(_v1, _v2);
      this.camera.position.copy(_v1);
      this.controls.target.copy(_v2);
      this.camera.lookAt(_v2);
      this.controls.enabled = false;
      this.handAnchor.visible = true;
      this.handEnterAmount = 1;
      this.updateLightsForDie(0, 0);
      this.updateContactShadow();
    }

    this.scene.add(this.dieGroup);

    if (!this.isSoftwareGl) {
      this.renderer.compile(this.scene, this.camera);
    }
    if (this.mode === 'darts') {
      this.startLoop();
    } else {
      this.scheduleOnDemandRender();
    }
  }

  public isBusy(): boolean {
    return this.phase !== 'idle' || (this.mode === 'darts' && this.dartState !== 'ready');
  }

  public roll(fling?: FlingVector): void {
    if (this.mode !== 'dice') return;
    if (!this.dieGroup || this.movies.length === 0) return;
    if (this.phase !== 'idle') return;

    this.disposeWinningPatch();
    soundEffects.unlock();
    this.callbacks.onHoverMovie(null, 0, 0);
    this.callbacks.onRollStarted();

    this.phase = 'rolling';
    this.stoppedDuration = 0;
    this.bounceCount = 0;
    this.preloadedWinnerIndex = -1;
    this.swapTriggered = false;
    this.returnHadCleanImg = false;
    this.controls.enabled = false;

    this.dieBody.wakeUp();

    const strength = fling ? Math.min(1.6, Math.max(0.55, fling.strength)) : 1.05;
    let vx: number;
    let vz: number;
    if (fling) {
      vx = fling.vx;
      vz = fling.vz;
      this.dieBody.velocity.set(vx, 2.2 + strength * 2.0, vz);
      soundEffects.playThrowWhoosh(strength, this.muted);
    } else {
      vx = (Math.random() - 0.5) * 6.5;
      vz = (Math.random() - 0.5) * 5.0;
      this.dieBody.velocity.set(vx, 3.4 + Math.random() * 1.4, vz);
      soundEffects.playThrowWhoosh(0.95, this.muted);
    }

    const sideSpin = (Math.random() - 0.5) * (4.2 + strength * 4.5);
    this.dieBody.angularVelocity.set(
      (vz / DIE_RADIUS) * 1.45 + (Math.random() - 0.5) * 2.8,
      sideSpin,
      (-vx / DIE_RADIUS) * 1.45 + (Math.random() - 0.5) * 2.8,
    );

    this.startLoop();
  }

  public closeRevealAndReturn(): void {
    if (
      this.phase !== 'revealed' &&
      this.phase !== 'liftUp' &&
      this.phase !== 'swapCrossfade' &&
      this.phase !== 'settle'
    ) {
      return;
    }
    if (!this.dieGroup) return;

    const dieX = this.dieGroup.position.x;
    const dieZ = this.dieGroup.position.z;

    if (this.winnerFlashMat) this.winnerFlashMat.opacity = 0;
    if (this.winnerFlashMesh) this.winnerFlashMesh.visible = false;

    this.returnBezierP0.copy(this.pushBezierP3);
    if (this.mode === 'darts') {
      this.getDartsCameraPose(this.returnBezierP3, this.returnEndCamTarget);
    } else {
      this.returnBezierP3.set(dieX + this.camOffset.x, this.camOffset.y, dieZ + this.camOffset.z);
      this.returnEndCamTarget.set(dieX, this.camTargetY, dieZ);
    }

    _v1.subVectors(this.returnEndCamTarget, this.returnBezierP3).setY(0);
    if (_v1.lengthSq() < 1e-4) _v1.set(0, 0, -1);
    _v1.normalize();

    const horizDist = Math.hypot(
      this.returnBezierP3.x - this.returnBezierP0.x,
      this.returnBezierP3.z - this.returnBezierP0.z,
    );
    const arcClearance = Math.max(1.8, horizDist * 0.28);

    this.returnBezierP1
      .copy(this.returnBezierP0)
      .addScaledVector(this.pushOutwardNormal, 2.2);
    this.returnBezierP2
      .copy(this.returnBezierP3)
      .addScaledVector(UP_VECTOR, arcClearance * 0.55)
      .addScaledVector(_v1, Math.min(1.6, horizDist * 0.22));

    this.returnStartCamTarget.copy(this.controls.target);
    this.returnStartCamUp.copy(this.pushEndCamUp).normalize();
    this.returnEndCamUp.copy(UP_VECTOR);

    this.returnHadCleanImg = this.phase === 'revealed' || this.swapTriggered;

    // Crossfade back to scrap if clean poster is visible, otherwise return from current scrap pose
    if (this.returnHadCleanImg) {
      if (this.winnerScrapMesh) {
        this.winnerScrapMesh.visible = true;
        this.winnerScrapMesh.position.copy(this.cardLandPos);
        this.winnerScrapMesh.quaternion.copy(this.cardLandQuat);
        this.winnerScrapMesh.scale.setScalar(this.cardLandScale);
      }
      if (this.winnerScrapMat) this.winnerScrapMat.opacity = 0;
      this.returnCardStartPos.copy(this.cardLandPos);
      this.returnCardStartQuat.copy(this.cardLandQuat);
      this.returnCardStartScale = this.cardLandScale;
    } else if (this.winnerScrapMesh) {
      if (!this.winnerScrapMesh.visible) this.winnerScrapMesh.visible = true;
      if (this.winnerScrapMat) this.winnerScrapMat.opacity = 1.0;
      this.returnCardStartPos.copy(this.winnerScrapMesh.position);
      this.returnCardStartQuat.copy(this.winnerScrapMesh.quaternion);
      this.returnCardStartScale = this.winnerScrapMesh.scale.x;
    } else {
      this.returnCardStartPos.copy(this.cardLandPos);
      this.returnCardStartQuat.copy(this.cardLandQuat);
      this.returnCardStartScale = this.cardLandScale;
    }

    this.returnElapsed = 0;
    this.phase = 'returning';
    this.controls.enabled = false;
    this.startLoop();
  }

  private computeWinningMovieFromIdMap(): number {
    if (!this.dieGroup || !this.bakedCollage) return 0;
    _invQuat.copy(this.dieGroup.quaternion).invert();
    _v1.copy(UP_VECTOR).applyQuaternion(_invQuat).normalize();
    return this.bakedCollage.sampleIdAtDirection(_v1);
  }

  private computePushInCurve(movieIdx: number): void {
    if (!this.dieGroup) return;
    const spec = this.posterSpecs[movieIdx];
    const diePos = this.dieGroup.position;
    const q = this.dieGroup.quaternion;

    if (spec) {
      _winnerCenterWorld.copy(spec.center).applyQuaternion(q).normalize();
      _winnerRightWorld.copy(spec.tangent).applyQuaternion(q).normalize();
      _winnerUpWorld.copy(spec.bitangent).applyQuaternion(q).normalize();
    } else {
      _winnerCenterWorld.copy(UP_VECTOR);
      _winnerRightWorld.set(1, 0, 0);
      _winnerUpWorld.set(0, 0, -1);
    }

    this.pushOutwardNormal.copy(_winnerCenterWorld);

    const rSurface = spec ? DIE_RADIUS * lumpyRadiusScale(spec.center) : DIE_RADIUS;

    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    const aspect = width / Math.max(1, height);
    const isNarrow = width < 768 || aspect < 0.95;

    const posterHalfH = spec ? spec.halfH * DIE_RADIUS : 0.14 * DIE_RADIUS;
    const posterWorldHeight = posterHalfH * 2;
    const targetHeightFrac = isNarrow ? 0.38 : 0.48;
    const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5));
    this.pushDistFromPoster = posterWorldHeight / targetHeightFrac / (2 * tanHalfFov);

    this.pushBezierP0.copy(this.camera.position);
    this.pushStartCamTarget.copy(this.controls.target);
    this.pushStartCamUp.copy(UP_VECTOR);

    // Compute camera up at end of push-in:
    // If poster faces nearly straight up (Dice mode), keep azimuth aligned to avoid spin;
    // otherwise orthogonalize world UP onto the poster's view plane so horizon stays upright!
    if (Math.abs(this.pushOutwardNormal.dot(UP_VECTOR)) > 0.9) {
      this.pushEndCamUp.set(
        this.pushStartCamTarget.x - this.pushBezierP0.x,
        0,
        this.pushStartCamTarget.z - this.pushBezierP0.z,
      );
      if (this.pushEndCamUp.lengthSq() < 1e-4) {
        this.pushEndCamUp.set(0, 0, -1);
      } else {
        this.pushEndCamUp.normalize();
      }
    } else {
      this.pushEndCamUp
        .copy(UP_VECTOR)
        .addScaledVector(this.pushOutwardNormal, -UP_VECTOR.dot(this.pushOutwardNormal));
      if (this.pushEndCamUp.lengthSq() < 1e-4) {
        this.pushEndCamUp.set(0, 1, 0);
      } else {
        this.pushEndCamUp.normalize();
      }
    }

    this.pushEndCamTarget.copy(diePos).addScaledVector(this.pushOutwardNormal, rSurface);

    this.pushBezierP3
      .copy(this.pushEndCamTarget)
      .addScaledVector(this.pushOutwardNormal, this.pushDistFromPoster);

    const horizDist = Math.hypot(
      this.pushBezierP0.x - this.pushBezierP3.x,
      this.pushBezierP0.z - this.pushBezierP3.z,
    );
    const arcClearance =
      this.mode === 'darts' ? Math.max(0.6, horizDist * 0.14) : Math.max(3.2, horizDist * 0.42);

    this.pushBezierP1
      .copy(this.pushBezierP0)
      .addScaledVector(UP_VECTOR, arcClearance * 0.75)
      .addScaledVector(this.pushEndCamUp, this.mode === 'darts' ? 0.25 : Math.min(2.2, horizDist * 0.28));

    this.pushBezierP2
      .copy(this.pushBezierP3)
      .addScaledVector(this.pushOutwardNormal, this.mode === 'darts' ? 1.5 : 2.5);

    // Compute exact start & landing poses for the detached flat paper scrap
    this.cardStartPos.copy(diePos).addScaledVector(this.pushOutwardNormal, rSurface + 0.008);
    _basisMat.makeBasis(_winnerRightWorld, _winnerUpWorld, this.pushOutwardNormal);
    this.cardStartQuat.setFromRotationMatrix(_basisMat);

    this.updateCardLandingPose(width, height);
  }

  private updateCardLandingPose(width: number, height: number): void {
    const aspect = width / Math.max(1, height);
    const isNarrow = width < 768 || aspect < 0.95;
    const spec = this.posterSpecs[this.winnerMovieIndex];

    const posterHalfH = spec ? spec.halfH * DIE_RADIUS : 0.14 * DIE_RADIUS;
    const posterArtHeight = posterHalfH * 2;
    const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5));

    // Update camera pushEnd position cleanly for current aspect/size
    const targetInitialFrac = isNarrow ? 0.38 : 0.48;
    this.pushDistFromPoster = posterArtHeight / targetInitialFrac / (2 * tanHalfFov);
    this.pushBezierP3
      .copy(this.pushEndCamTarget)
      .addScaledVector(this.pushOutwardNormal, this.pushDistFromPoster);

    // Card lifts closer to the camera, landing upright facing camera
    const dLand = Math.max(0.7, this.pushDistFromPoster * 0.58);
    const frustumH = 2 * dLand * tanHalfFov;
    const frustumW = frustumH * aspect;

    const finalHeightFrac = isNarrow ? 0.44 : 0.6;
    this.cardLandScale = (finalHeightFrac * frustumH) / posterArtHeight;

    // Screen-aligned camera basis looking along -pushOutwardNormal
    this.camShakeUp.copy(this.pushEndCamUp).normalize();
    _v1.copy(this.pushOutwardNormal).negate();
    this.camShakeRight.crossVectors(_v1, this.camShakeUp).normalize();

    const offsetRight = isNarrow ? 0 : -0.145 * frustumW;
    const offsetUp = isNarrow ? 0.13 * frustumH : 0;

    this.cardLandPos
      .copy(this.pushBezierP3)
      .addScaledVector(this.pushOutwardNormal, -dLand)
      .addScaledVector(this.camShakeRight, offsetRight)
      .addScaledVector(this.camShakeUp, offsetUp);

    // +X = screen right, +Y = camera.up (upright!), +Z = straight toward camera (+pushOutwardNormal)
    _basisMat.makeBasis(this.camShakeRight, this.camShakeUp, this.pushOutwardNormal);
    this.cardLandQuat.setFromRotationMatrix(_basisMat);

    if (this.winnerFlashMesh) {
      this.winnerFlashMesh.position
        .copy(this.cardLandPos)
        .addScaledVector(this.pushOutwardNormal, 0.02);
      this.winnerFlashMesh.quaternion.copy(this.cardLandQuat);
    }
  }

  private evalCubicBezier(
    t: number,
    p0: THREE.Vector3,
    p1: THREE.Vector3,
    p2: THREE.Vector3,
    p3: THREE.Vector3,
    out: THREE.Vector3,
  ): THREE.Vector3 {
    const u = 1 - t;
    const uu = u * u;
    const tt = t * t;
    const uuu = uu * u;
    const ttt = tt * t;

    out.set(
      uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
      uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
      uuu * p0.z + 3 * uu * t * p1.z + 3 * u * tt * p2.z + ttt * p3.z,
    );
    return out;
  }

  private projectCardMatrixToLayout(matrixWorld: THREE.Matrix4): RevealScreenLayout {
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    const aspect = width / Math.max(1, height);
    const isNarrow = width < 768 || aspect < 0.95;

    this.camera.updateMatrixWorld();

    const padScale = 1.15;
    const artHalfW = this.cardHalfW / padScale;
    const artHalfH = this.cardHalfH / padScale;

    const projectLocal = (lx: number, ly: number): { x: number; y: number } => {
      _v3.set(lx, ly, 0).applyMatrix4(matrixWorld);
      _v3.project(this.camera);
      return {
        x: (_v3.x * 0.5 + 0.5) * width,
        y: (-_v3.y * 0.5 + 0.5) * height,
      };
    };

    const cPt = projectLocal(0, 0);
    const tlPt = projectLocal(-artHalfW, artHalfH);
    const trPt = projectLocal(artHalfW, artHalfH);
    const brPt = projectLocal(artHalfW, -artHalfH);
    const blPt = projectLocal(-artHalfW, -artHalfH);

    const left = Math.min(tlPt.x, blPt.x);
    const right = Math.max(trPt.x, brPt.x);
    const top = Math.min(tlPt.y, trPt.y);
    const bottom = Math.max(blPt.y, brPt.y);

    return {
      centerX: cPt.x,
      centerY: cPt.y,
      rightEdgeX: right,
      bottomEdgeY: bottom,
      posterLeft: left,
      posterTop: top,
      posterWidth: Math.max(1, right - left),
      posterHeight: Math.max(1, bottom - top),
      isNarrow,
    };
  }

  private computeLandingScreenLayout(): RevealScreenLayout {
    _v2.setScalar(this.cardLandScale);
    _basisMat.compose(this.cardLandPos, this.cardLandQuat, _v2);
    return this.projectCardMatrixToLayout(_basisMat);
  }

  private mountWinningPosterPatch(movieIdx: number): void {
    this.disposeWinningPatch();
    if (!this.dieGroup) return;

    const movie = this.movies[movieIdx];
    const spec = this.posterSpecs[movieIdx];
    if (!movie || !spec) return;

    const abort = new AbortController();
    this.winnerPatchAbort = abort;

    const padScale = 1.15;
    this.cardHalfW = spec.halfW * padScale * DIE_RADIUS;
    this.cardHalfH = spec.halfH * padScale * DIE_RADIUS;

    const maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const textures = createWinningPosterTextures(
      movie,
      spec,
      maxAnisotropy,
      () => {
        if (this.disposed || abort.signal.aborted) return;
        this.scheduleOnDemandRender();
      },
      abort.signal,
    );
    this.winnerTexturesCleanup = textures.dispose;

    // 1. Blank off-white torn paper spot left behind on the ball when the copy peels off
    const blankBuild = buildWinningPosterPatchGeometry(spec, DIE_RADIUS, 0.003);
    this.winnerBlankMat = new THREE.MeshStandardMaterial({
      map: textures.blankTexture,
      normalMap: this.paperNormalTex,
      normalScale: new THREE.Vector2(0.55, 0.55),
      roughnessMap: this.paperRoughnessTex,
      roughness: 0.96,
      metalness: 0.0,
      envMapIntensity: 0,
      transparent: true,
      alphaTest: 0.04,
      opacity: 0.0,
    });
    this.winnerBlankMesh = new THREE.Mesh(blankBuild.geometry, this.winnerBlankMat);
    this.winnerBlankMesh.position.copy(blankBuild.origin);
    this.winnerBlankMesh.receiveShadow = true;
    this.winnerBlankMesh.renderOrder = 3;
    this.dieGroup.add(this.winnerBlankMesh);

    // 2. Soft drop-shadow on the ball surface as the card begins peeling away
    const shadowBuild = buildWinningPosterPatchGeometry(spec, DIE_RADIUS, 0.0018);
    this.winnerShadowMat = new THREE.MeshBasicMaterial({
      map: textures.shadowTexture,
      transparent: true,
      depthWrite: false,
      opacity: 0.0,
    });
    this.winnerShadowMesh = new THREE.Mesh(shadowBuild.geometry, this.winnerShadowMat);
    this.winnerShadowMesh.position.copy(shadowBuild.origin);
    this.winnerShadowMesh.renderOrder = 2;
    this.dieGroup.add(this.winnerShadowMesh);

    // 3. Flat single-sided torn paper scrap (no back face, no flip/curl)
    const planeW = this.cardHalfW * 2;
    const planeH = this.cardHalfH * 2;
    const scrapGeo = new THREE.PlaneGeometry(planeW, planeH);

    this.winnerScrapMat = new THREE.MeshStandardMaterial({
      map: textures.posterTexture,
      normalMap: this.paperNormalTex,
      normalScale: new THREE.Vector2(0.35, 0.35),
      roughnessMap: this.paperRoughnessTex,
      roughness: 0.94,
      metalness: 0.0,
      envMapIntensity: 0,
      transparent: true,
      alphaTest: 0.04,
      opacity: 1.0,
    });

    this.winnerScrapMesh = new THREE.Mesh(scrapGeo, this.winnerScrapMat);
    this.winnerScrapMesh.renderOrder = 20;
    this.winnerScrapMesh.visible = false;
    this.scene.add(this.winnerScrapMesh);

    // 4. Very subtle soft white radial glow for the crossfade transition
    const flashGeo = new THREE.PlaneGeometry(planeH * 2.2, planeH * 2.2);
    this.winnerFlashMat = new THREE.MeshBasicMaterial({
      map: this.lightBurstTex,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      opacity: 0.0,
    });
    this.winnerFlashMesh = new THREE.Mesh(flashGeo, this.winnerFlashMat);
    this.winnerFlashMesh.renderOrder = 25;
    this.winnerFlashMesh.visible = false;
    this.scene.add(this.winnerFlashMesh);
  }

  private disposeWinningPatch(): void {
    this.winnerPatchAbort?.abort();
    this.winnerPatchAbort = null;

    if (this.winnerBlankMesh) {
      this.dieGroup?.remove(this.winnerBlankMesh);
      this.winnerBlankMesh.geometry.dispose();
      this.winnerBlankMesh = null;
    }
    if (this.winnerBlankMat) {
      this.winnerBlankMat.dispose();
      this.winnerBlankMat = null;
    }
    if (this.winnerShadowMesh) {
      this.dieGroup?.remove(this.winnerShadowMesh);
      this.winnerShadowMesh.geometry.dispose();
      this.winnerShadowMesh = null;
    }
    if (this.winnerShadowMat) {
      this.winnerShadowMat.dispose();
      this.winnerShadowMat = null;
    }
    if (this.winnerScrapMesh) {
      this.scene.remove(this.winnerScrapMesh);
      this.winnerScrapMesh.geometry.dispose();
      this.winnerScrapMesh = null;
    }
    if (this.winnerScrapMat) {
      this.winnerScrapMat.dispose();
      this.winnerScrapMat = null;
    }
    if (this.winnerFlashMesh) {
      this.scene.remove(this.winnerFlashMesh);
      this.winnerFlashMesh.geometry.dispose();
      this.winnerFlashMesh = null;
    }
    if (this.winnerFlashMat) {
      this.winnerFlashMat.dispose();
      this.winnerFlashMat = null;
    }
    if (this.winnerTexturesCleanup) {
      this.winnerTexturesCleanup();
      this.winnerTexturesCleanup = null;
    }
  }

  private disposeFlyingDart(): void {
    if (this.flyingDart) {
      this.scene.remove(this.flyingDart.group);
      this.flyingDart.dispose();
      this.flyingDart = null;
    }
  }

  private disposeStuckDart(): void {
    if (this.stuckDartPivot) {
      this.dieGroup?.remove(this.stuckDartPivot);
      this.stuckDartPivot = null;
      this.stuckDartQuiverNode = null;
    }
    if (this.stuckDartInstance) {
      this.stuckDartInstance.dispose();
      this.stuckDartInstance = null;
    }
  }

  private needsContinuousLoop(): boolean {
    return this.phase !== 'idle' || this.mode === 'darts' || this.modeTransitioning;
  }

  private startLoop(): void {
    if (this.frameId) return;
    this.lastTime = performance.now();
    const tick = () => {
      if (this.disposed) return;
      this.frameId = 0;

      const now = performance.now();
      const dt = Math.min(0.05, Math.max(0.001, (now - this.lastTime) / 1000));
      this.lastTime = now;

      const keepRunning = this.stepSimulation(dt);
      this.renderScene();

      if (keepRunning && !this.disposed) {
        if (this.isSoftwareGl) {
          this.afterDraw(() => {
            if (!this.disposed && this.needsContinuousLoop()) {
              this.frameId = requestAnimationFrame(tick);
            }
          });
        } else {
          this.frameId = requestAnimationFrame(tick);
        }
      }
    };
    this.frameId = requestAnimationFrame(tick);
  }

  private afterDraw(cb: () => void): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (!gl || typeof gl.fenceSync !== 'function') {
      window.setTimeout(cb, 80);
      return;
    }
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const poll = () => {
      if (this.disposed) return;
      const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
      if (state === gl.UNSIGNALED) {
        window.setTimeout(poll, 5);
      } else {
        if (sync) gl.deleteSync(sync);
        window.setTimeout(cb, 80);
      }
    };
    window.setTimeout(poll, 5);
  }

  private scheduleOnDemandRender(): void {
    if (this.disposed || this.frameId || this.renderPending) return;
    this.renderPending = true;
    requestAnimationFrame(() => {
      this.renderPending = false;
      if (this.disposed || this.frameId) return;
      if (this.mode === 'dice') {
        this.controls.update();
      }
      this.renderScene();
    });
  }

  private updateLightsForDie(x: number, z: number): void {
    this.keyLight.position.set(x - 6.0, 7.2, z + 6.2);
    this.keyLight.target.position.set(x, 0.8, z);
    this.fillLight.position.set(x + 7.5, 2.2, z - 4.5);
    this.fillLight.target.position.set(x, 0.8, z);
  }

  private applySoftBoundaryWalls(dt: number): void {
    const softPad = 0.25;
    const maxSoftX = ARENA_HALF_X - softPad;
    const maxSoftZ = ARENA_HALF_Z - softPad;
    const springK = 26.0;

    if (this.dieBody.position.x > maxSoftX) {
      const pen = this.dieBody.position.x - maxSoftX;
      this.dieBody.velocity.x -= pen * springK * dt;
      if (this.dieBody.position.x > ARENA_HALF_X) {
        this.dieBody.position.x = ARENA_HALF_X;
        if (this.dieBody.velocity.x > 0) {
          this.dieBody.velocity.x *= -0.68;
          soundEffects.playBounce(Math.abs(this.dieBody.velocity.x), this.muted);
        }
      }
    } else if (this.dieBody.position.x < -maxSoftX) {
      const pen = -maxSoftX - this.dieBody.position.x;
      this.dieBody.velocity.x += pen * springK * dt;
      if (this.dieBody.position.x < -ARENA_HALF_X) {
        this.dieBody.position.x = -ARENA_HALF_X;
        if (this.dieBody.velocity.x < 0) {
          this.dieBody.velocity.x *= -0.68;
          soundEffects.playBounce(Math.abs(this.dieBody.velocity.x), this.muted);
        }
      }
    }

    if (this.dieBody.position.z > maxSoftZ) {
      const pen = this.dieBody.position.z - maxSoftZ;
      this.dieBody.velocity.z -= pen * springK * dt;
      if (this.dieBody.position.z > ARENA_HALF_Z) {
        this.dieBody.position.z = ARENA_HALF_Z;
        if (this.dieBody.velocity.z > 0) {
          this.dieBody.velocity.z *= -0.68;
          soundEffects.playBounce(Math.abs(this.dieBody.velocity.z), this.muted);
        }
      }
    } else if (this.dieBody.position.z < -maxSoftZ) {
      const pen = -maxSoftZ - this.dieBody.position.z;
      this.dieBody.velocity.z += pen * springK * dt;
      if (this.dieBody.position.z < -ARENA_HALF_Z) {
        this.dieBody.position.z = -ARENA_HALF_Z;
        if (this.dieBody.velocity.z < 0) {
          this.dieBody.velocity.z *= -0.68;
          soundEffects.playBounce(Math.abs(this.dieBody.velocity.z), this.muted);
        }
      }
    }
  }

  public skipRevealToFinal(): void {
    if (
      this.phase !== 'revealPause' &&
      this.phase !== 'pushIn' &&
      this.phase !== 'liftUp' &&
      this.phase !== 'swapCrossfade' &&
      this.phase !== 'settle'
    ) {
      return;
    }

    const wasInPause = this.phase === 'revealPause';

    this.camera.position.copy(this.pushBezierP3);
    this.controls.target.copy(this.pushEndCamTarget);
    this.camera.up.copy(this.pushEndCamUp);
    this.camera.lookAt(this.controls.target);

    if (this.stuckDartPivot) {
      this.stuckDartPivot.visible = false;
    }

    if (this.winnerScrapMesh) {
      this.winnerScrapMesh.position.copy(this.cardLandPos);
      this.winnerScrapMesh.quaternion.copy(this.cardLandQuat);
      this.winnerScrapMesh.scale.setScalar(this.cardLandScale);
      this.winnerScrapMesh.visible = false;
    }
    if (this.winnerScrapMat) {
      this.winnerScrapMat.opacity = 0;
    }
    if (this.winnerBlankMat) {
      this.winnerBlankMat.opacity = 1.0;
    }
    if (this.winnerShadowMat) {
      this.winnerShadowMat.opacity = 0;
    }
    if (this.winnerFlashMesh) {
      this.winnerFlashMesh.visible = false;
    }
    if (this.winnerFlashMat) {
      this.winnerFlashMat.opacity = 0;
    }

    if (wasInPause) {
      this.callbacks.onZoomStarted();
    }
    const finalLayout = this.computeLandingScreenLayout();
    this.swapTriggered = true;
    this.callbacks.onPosterSwapStarted(this.winnerMovieIndex, finalLayout, true);
    this.phase = 'revealed';
    this.callbacks.onRevealReady(this.winnerMovieIndex, finalLayout, true);
    this.startLoop();
  }

  private computeDartLaunchState(
    pull: number,
    yaw: number,
    flickBonus: number,
    posOut: THREE.Vector3,
    velOut: THREE.Vector3,
  ): void {
    // Compute world launch origin from current hand socket pose
    this.camera.updateMatrixWorld(true);
    this.handRig.dartSocket.getWorldPosition(posOut);

    const ballCenterY = DIE_RADIUS + DARTS_FLOAT_HEIGHT;
    const target = _v2.set(0, ballCenterY, 0);
    const dist = Math.max(3.5, posOut.distanceTo(target));
    const distScale = Math.sqrt(dist / 6.1);

    const power = Math.min(1.45, Math.max(0.18, pull * 0.98 + flickBonus));
    const speed = (5.4 + power * 8.4) * distScale;

    const dir = _v3.subVectors(target, posOut).normalize();
    // Apply horizontal aim yaw (right drag -> aims right)
    dir.applyAxisAngle(UP_VECTOR, -yaw);

    // Apply natural upward throw loft so medium pull arcs smoothly into the center
    const rightAxis = _v1.crossVectors(dir, UP_VECTOR).normalize();
    dir.applyAxisAngle(rightAxis, 0.118).normalize();

    velOut.copy(dir).multiplyScalar(speed);
  }

  private updateAimArcPrediction(): void {
    if (!this.dieGroup || this.dartState !== 'aiming' || this.aimPull < 0.06) {
      this.aimArc.setVisible(false);
      return;
    }

    const pos = _v1.clone();
    const vel = new THREE.Vector3();
    this.computeDartLaunchState(this.aimPull, this.aimYaw, 0, pos, vel);

    const ballCenter = this.dieGroup.position;
    const dtStep = 0.032;
    const maxSteps = this.arcScratchPts.length;
    let count = 0;

    for (let i = 0; i < maxSteps; i++) {
      vel.y -= DART_GRAVITY * dtStep;
      vel.multiplyScalar(Math.exp(-DART_AIR_DRAG * dtStep));
      pos.addScaledVector(vel, dtStep);

      this.arcScratchPts[count].copy(pos);
      count++;

      if (pos.distanceTo(ballCenter) <= DIE_RADIUS * 1.01) {
        break;
      }
      if (pos.y <= 0.1) break;
    }

    this.aimArc.updateArc(this.arcScratchPts, count);
    this.aimArc.setVisible(count > 1);
  }

  private launchDartProjectile(pull: number, yaw: number, flickBonus: number): void {
    this.disposeFlyingDart();
    this.flyingDart = createRealisticDartGroup();

    const startPos = new THREE.Vector3();
    const startVel = new THREE.Vector3();
    this.computeDartLaunchState(pull, yaw, flickBonus, startPos, startVel);

    this.dartPos.copy(startPos);
    this.dartVel.copy(startVel);
    this.dartFlightTime = 0;
    this.dartRollAngle = 0;

    this.flyingDart.group.position.copy(this.dartPos);
    _v1.copy(this.dartVel).normalize();
    this.flyingDart.group.quaternion.setFromUnitVectors(FORWARD_Z, _v1);
    this.scene.add(this.flyingDart.group);

    this.heldDart.group.visible = false;
    this.aimArc.setVisible(false);
    soundEffects.playDartThrow(Math.min(1.4, pull + flickBonus), this.muted);
  }

  private handleDartHit(hitPointWorld: THREE.Vector3, incomingDirWorld: THREE.Vector3): void {
    if (!this.dieGroup || !this.bakedCollage) return;

    const impactSpeed = this.dartVel.length();
    soundEffects.playDartThunk(impactSpeed, this.muted);

    // Sample poster ID at exact impact point on the ball
    const localHitPos = this.dieGroup.worldToLocal(hitPointWorld.clone());
    const localHitDir = localHitPos.clone().normalize();
    this.winnerMovieIndex = this.bakedCollage.sampleIdAtDirection(localHitDir);

    // Preload winner HD poster immediately so it's decoded by the time reveal arrives
    this.preloadedWinnerIndex = this.winnerMovieIndex;
    this.callbacks.onPreloadWinner(this.winnerMovieIndex);

    // Trigger paper dent + traveling ripple on die shader
    this.dentDirUniform.value.copy(localHitDir);
    this.dentStrengthUniform.value = 1.0;
    this.dentRippleTimeUniform.value = 0.0;

    // Parent stuck dart to the ball with tip buried slightly inside the paper
    this.disposeStuckDart();
    this.stuckDartPivot = new THREE.Group();
    this.stuckDartQuiverNode = new THREE.Group();
    this.stuckDartInstance = createRealisticDartGroup();

    _invQuat.copy(this.dieGroup.quaternion).invert();
    const localIncomingDir = incomingDirWorld.clone().applyQuaternion(_invQuat).normalize();

    this.stuckDartPivot.position
      .copy(localHitPos)
      .addScaledVector(localIncomingDir, 0.055);
    this.stuckDartPivot.quaternion.setFromUnitVectors(FORWARD_Z, localIncomingDir);

    // Offset dart inside quiver node so needle tip sits right at pivot (0,0,0)
    this.stuckDartInstance.group.position.set(0, 0, -DART_TIP_Z);
    this.stuckDartInstance.group.rotation.z = this.dartRollAngle;

    this.stuckDartQuiverNode.add(this.stuckDartInstance.group);
    this.stuckDartPivot.add(this.stuckDartQuiverNode);
    this.dieGroup.add(this.stuckDartPivot);

    this.disposeFlyingDart();

    // Transfer current combined angular velocity + off-center dart impact impulse, then slow smoothly over ~2s
    const joltExtra =
      this.joltElapsed >= 0 && this.joltElapsed < this.joltDuration
        ? Math.pow(Math.sin((this.joltElapsed / this.joltDuration) * Math.PI), 0.7) *
          this.joltStrength
        : 0;
    const currentAngVel = this.spinAxisCurr
      .clone()
      .multiplyScalar(this.spinSpeedCurr + joltExtra)
      .addScaledVector(this.wobbleAxisCurr, this.wobbleSpeedCurr);
    const rHitWorld = hitPointWorld.clone().sub(this.dieGroup.position);
    const impulse = new THREE.Vector3().crossVectors(rHitWorld, this.dartVel).multiplyScalar(0.055);
    currentAngVel.add(impulse);

    this.impactStartAngSpeed = Math.max(0.35, currentAngVel.length());
    if (currentAngVel.lengthSq() > 1e-6) {
      this.impactSpinAxis.copy(currentAngVel).normalize();
    } else {
      this.impactSpinAxis.copy(this.spinAxisCurr);
    }

    this.quiverElapsed = 0;
    this.impactElapsed = 0;
    this.joltElapsed = -1;
    this.dartState = 'impactSlowdown';
  }

  private stepDartsIdleAndFlight(dt: number): boolean {
    if (!this.dieGroup) return false;

    // 1. Keep ball centered with smooth random bobbing (±3% of radius up/down & sideways)
    const bobAmp = DIE_RADIUS * 0.03;
    const bobScale =
      this.dartState === 'impactSlowdown'
        ? Math.max(0, 1 - smoothstep(0, 1.4, this.impactElapsed))
        : 1.0;
    const bobX =
      (Math.sin(this.elapsedClock * 1.73) * 0.62 +
        Math.sin(this.elapsedClock * 2.91 + 1.1) * 0.38) *
      bobAmp *
      bobScale;
    const bobY =
      (Math.sin(this.elapsedClock * 2.17 + 0.4) * 0.65 +
        Math.cos(this.elapsedClock * 3.43 + 2.0) * 0.35) *
      bobAmp *
      bobScale;
    const bobZ =
      (Math.cos(this.elapsedClock * 1.51 + 0.8) * 0.6 +
        Math.sin(this.elapsedClock * 2.67 + 2.4) * 0.4) *
      bobAmp *
      bobScale;

    const floatTargetY = DIE_RADIUS + DARTS_FLOAT_HEIGHT + bobY;
    this.dieGroup.position.x = THREE.MathUtils.damp(this.dieGroup.position.x, bobX, 6.5, dt);
    this.dieGroup.position.y = THREE.MathUtils.damp(this.dieGroup.position.y, floatTargetY, 6.5, dt);
    this.dieGroup.position.z = THREE.MathUtils.damp(this.dieGroup.position.z, bobZ, 6.5, dt);
    this.dieBody.position.set(
      this.dieGroup.position.x,
      this.dieGroup.position.y,
      this.dieGroup.position.z,
    );

    // 2. Smoothly transition camera to Darts view if switching from Dice mode
    const desiredCamPos = _v1;
    const desiredCamTarget = _v2;
    this.getDartsCameraPose(desiredCamPos, desiredCamTarget);
    if (this.modeTransitioning) {
      const camLambda = 6.0;
      this.camera.position.x = THREE.MathUtils.damp(this.camera.position.x, desiredCamPos.x, camLambda, dt);
      this.camera.position.y = THREE.MathUtils.damp(this.camera.position.y, desiredCamPos.y, camLambda, dt);
      this.camera.position.z = THREE.MathUtils.damp(this.camera.position.z, desiredCamPos.z, camLambda, dt);
      this.controls.target.x = THREE.MathUtils.damp(this.controls.target.x, desiredCamTarget.x, camLambda, dt);
      this.controls.target.y = THREE.MathUtils.damp(this.controls.target.y, desiredCamTarget.y, camLambda, dt);
      this.controls.target.z = THREE.MathUtils.damp(this.controls.target.z, desiredCamTarget.z, camLambda, dt);
      this.camera.up.copy(UP_VECTOR);
      this.camera.lookAt(this.controls.target);

      if (
        this.camera.position.distanceToSquared(desiredCamPos) < 0.0004 &&
        this.dieGroup.position.distanceToSquared(_v3.set(0, floatTargetY, 0)) < 0.0004
      ) {
        this.camera.position.copy(desiredCamPos);
        this.controls.target.copy(desiredCamTarget);
        this.camera.lookAt(this.controls.target);
        this.modeTransitioning = false;
      }
    }

    this.updateLightsForDie(this.dieGroup.position.x, this.dieGroup.position.z);
    this.updateContactShadow();

    // 3. Autonomous wandering spin (or 2s impact slowdown)
    if (this.dartState === 'impactSlowdown') {
      this.impactElapsed += dt;
      this.quiverElapsed += dt;
      this.dentRippleTimeUniform.value += dt;

      const u = Math.min(1, this.impactElapsed / this.impactSlowdownDuration);
      const speedScale = Math.pow(1 - u, 2.0);
      const curSpeed = this.impactStartAngSpeed * speedScale;
      if (curSpeed > 1e-4) {
        _invQuat.setFromAxisAngle(this.impactSpinAxis, curSpeed * dt);
        this.dieGroup.quaternion.premultiply(_invQuat).normalize();
      }

      // Quiver stuck dart for ~0.4s
      if (this.stuckDartQuiverNode) {
        if (this.quiverElapsed < 0.45) {
          const qAmp = Math.exp(-this.quiverElapsed * 10.5) * 0.14;
          this.stuckDartQuiverNode.rotation.x = qAmp * Math.sin(this.quiverElapsed * 64);
          this.stuckDartQuiverNode.rotation.y = qAmp * 0.7 * Math.cos(this.quiverElapsed * 53);
        } else {
          this.stuckDartQuiverNode.rotation.set(0, 0, 0);
        }
      }

      // Settle dent strength from initial impact peak down to a lasting puncture dimple
      this.dentStrengthUniform.value = THREE.MathUtils.lerp(1.0, 0.48, smoothstep(0, 0.4, this.impactElapsed));

      if (u >= 1) {
        // Ball has stopped spinning — start the exact reveal choreography targeting the dart's poster
        this.dieBody.quaternion.set(
          this.dieGroup.quaternion.x,
          this.dieGroup.quaternion.y,
          this.dieGroup.quaternion.z,
          this.dieGroup.quaternion.w,
        );
        soundEffects.playSettleClick(this.muted);
        this.mountWinningPosterPatch(this.winnerMovieIndex);
        this.computePushInCurve(this.winnerMovieIndex);

        this.pauseElapsed = 0;
        this.phase = 'revealPause';
        this.dartState = 'ready';
      }
    } else {
      // Main spin: fast & unpredictable (1.5–3.5 rad/s, new axis every 0.8–1.8s, ~0.4s ease)
      this.spinWanderTimer -= dt;
      if (this.spinWanderTimer <= 0) {
        const theta = Math.random() * Math.PI * 2;
        const z = Math.random() * 2 - 1;
        const r = Math.sqrt(Math.max(0, 1 - z * z));
        _v1.set(Math.cos(theta) * r, z, Math.sin(theta) * r).normalize();
        // Avoid exact 180-deg midpoint singularity during lerp
        if (_v1.dot(this.spinAxisCurr) < -0.92) {
          _v1.set(-this.spinAxisCurr.z, this.spinAxisCurr.x, this.spinAxisCurr.y).normalize();
        }
        this.spinAxisTarget.copy(_v1);
        this.spinSpeedTarget = 1.5 + Math.random() * 2.0; // 1.5 to 3.5 rad/s
        this.spinWanderTimer = 0.8 + Math.random() * 1.0; // every 0.8-1.8s
      }

      const mainAxisAlpha = 1 - Math.exp(-6.5 * dt); // ~0.4s smooth blend
      this.spinAxisCurr.lerp(this.spinAxisTarget, mainAxisAlpha);
      if (this.spinAxisCurr.lengthSq() > 1e-6) {
        this.spinAxisCurr.normalize();
      } else {
        this.spinAxisCurr.copy(this.spinAxisTarget);
      }
      this.spinSpeedCurr = THREE.MathUtils.damp(this.spinSpeedCurr, this.spinSpeedTarget, 6.0, dt);

      // Secondary slower wobble on a distinct random axis (~0.6 rad/s)
      this.wobbleWanderTimer -= dt;
      if (this.wobbleWanderTimer <= 0) {
        for (let attempt = 0; attempt < 4; attempt++) {
          const theta = Math.random() * Math.PI * 2;
          const z = Math.random() * 2 - 1;
          const r = Math.sqrt(Math.max(0, 1 - z * z));
          _v1.set(Math.cos(theta) * r, z, Math.sin(theta) * r).normalize();
          if (Math.abs(_v1.dot(this.spinAxisTarget)) < 0.72) break;
        }
        if (_v1.dot(this.wobbleAxisCurr) < -0.92) {
          _v1.negate();
        }
        this.wobbleAxisTarget.copy(_v1);
        this.wobbleSpeedCurr = 0.52 + Math.random() * 0.16; // ~0.6 rad/s
        this.wobbleWanderTimer = 1.5 + Math.random() * 1.2;
      }

      const wobbleAlpha = 1 - Math.exp(-3.5 * dt);
      this.wobbleAxisCurr.lerp(this.wobbleAxisTarget, wobbleAlpha);
      if (this.wobbleAxisCurr.lengthSq() > 1e-6) {
        this.wobbleAxisCurr.normalize();
      } else {
        this.wobbleAxisCurr.copy(this.wobbleAxisTarget);
      }

      // Occasional sudden quick "jolt" (~every 4-6s, ~0.5s burst of extra speed)
      let joltExtraSpeed = 0;
      if (this.joltElapsed >= 0) {
        this.joltElapsed += dt;
        const ju = this.joltElapsed / this.joltDuration;
        if (ju >= 1) {
          this.joltElapsed = -1;
        } else {
          joltExtraSpeed = Math.pow(Math.sin(ju * Math.PI), 0.7) * this.joltStrength;
        }
      } else {
        this.joltCooldown -= dt;
        if (this.joltCooldown <= 0) {
          this.joltElapsed = 0;
          this.joltDuration = 0.45 + Math.random() * 0.15; // ~0.5s
          this.joltStrength = 1.9 + Math.random() * 1.1;
          this.joltCooldown = 4.0 + Math.random() * 2.0; // every 4-6s
        }
      }

      // Combine main spin (+ jolt) and secondary wobble axis into one frame-rate independent rotation
      _v2
        .copy(this.spinAxisCurr)
        .multiplyScalar(this.spinSpeedCurr + joltExtraSpeed)
        .addScaledVector(this.wobbleAxisCurr, this.wobbleSpeedCurr);
      const totalSpeed = _v2.length();
      if (totalSpeed > 1e-5) {
        _v2.divideScalar(totalSpeed);
        _invQuat.setFromAxisAngle(_v2, totalSpeed * dt);
        this.dieGroup.quaternion.premultiply(_invQuat).normalize();
      }
    }

    // 4. Hand animation & aiming / throwing / flying state machine
    const showHand = this.dartState === 'ready' || this.dartState === 'aiming' || this.dartState === 'throwing';
    const targetEnter = showHand ? 1 : 0;
    this.handEnterAmount = THREE.MathUtils.damp(this.handEnterAmount, targetEnter, 9.0, dt);
    this.handAnchor.visible = this.handEnterAmount > 0.01;

    if (this.handAnchor.visible) {
      const enterDrop = (1 - this.handEnterAmount) * -0.65;
      const swayX = Math.sin(this.elapsedClock * 1.45) * 0.012 * (1 - this.aimPull * 0.7);
      const swayY = Math.sin(this.elapsedClock * 2.1 + 0.5) * 0.009 * (1 - this.aimPull * 0.7);
      const swayRoll = Math.sin(this.elapsedClock * 1.1) * 0.025 * (1 - this.aimPull * 0.7);

      let throwFwdZ = 0;
      let throwPitch = 0;
      if (this.dartState === 'throwing') {
        this.throwAnimElapsed += dt;
        const tu = Math.min(1, this.throwAnimElapsed / this.throwAnimDuration);
        const lunge = Math.sin(Math.min(1, tu * 1.4) * Math.PI * 0.5);
        throwFwdZ = -0.44 * lunge;
        throwPitch = -0.22 * lunge;

        if (!this.throwReleased && tu >= 0.38) {
          this.throwReleased = true;
          this.launchDartProjectile(this.aimPull, this.throwPendingYaw, this.throwPendingPower);
          this.dartState = 'flying';
        }
      }

      const pullBackZ = this.aimPull * 0.34;
      const pullDropY = -this.aimPull * 0.08;
      const pullPitch = this.aimPull * 0.09;
      const aimShiftX = Math.sin(this.aimYaw) * 0.14;

      this.handAnchor.position.set(
        0.04 + swayX + aimShiftX,
        -0.52 + enterDrop + swayY + pullDropY,
        -2.18 + pullBackZ + throwFwdZ,
      );
      this.handAnchor.rotation.set(
        0.09 + pullPitch + throwPitch,
        0.02 - this.aimYaw,
        swayRoll,
      );

      if (this.dartState === 'aiming') {
        this.updateAimArcPrediction();
      } else {
        this.aimArc.setVisible(false);
      }
    } else {
      this.aimArc.setVisible(false);
    }

    // 5. Flying dart projectile physics & continuous raycasting
    if (this.dartState === 'flying' && this.flyingDart && this.dieMesh) {
      this.dartFlightTime += dt;

      // Previous tip position in world space
      const prevDir = this.dartVel.clone().normalize();
      const prevTipWorld = this.dartPos.clone().addScaledVector(prevDir, -DART_TIP_Z);

      // Integrate gravity + air drag
      this.dartVel.y -= DART_GRAVITY * dt;
      this.dartVel.multiplyScalar(Math.exp(-DART_AIR_DRAG * dt));
      this.dartPos.addScaledVector(this.dartVel, dt);

      const nextDir = this.dartVel.clone().normalize();
      const nextTipWorld = this.dartPos.clone().addScaledVector(nextDir, -DART_TIP_Z);

      // Orient dart along velocity with damped initial wobble (~0.35s) and gentle axial spin
      this.dartRollAngle += 7.5 * dt;
      const wAmp = Math.exp(-this.dartFlightTime * 9.5) * 0.13;
      const wPitch = wAmp * Math.sin(this.dartFlightTime * 34);
      const wYaw = wAmp * 0.7 * Math.cos(this.dartFlightTime * 27 + 0.6);

      const qBase = new THREE.Quaternion().setFromUnitVectors(FORWARD_Z, nextDir);
      const qWobble = new THREE.Quaternion().setFromEuler(new THREE.Euler(wPitch, wYaw, 0));
      const qRoll = new THREE.Quaternion().setFromAxisAngle(FORWARD_Z, this.dartRollAngle);

      this.flyingDart.group.position.copy(this.dartPos);
      this.flyingDart.group.quaternion.copy(qBase).multiply(qWobble).multiply(qRoll);

      // Continuous raycast along tip segment [prevTipWorld -> nextTipWorld]
      const segVec = _v1.subVectors(nextTipWorld, prevTipWorld);
      const segLen = segVec.length();
      let didHit = false;

      if (segLen > 1e-5) {
        this.raycaster.set(prevTipWorld, segVec.divideScalar(segLen));
        this.raycaster.near = 0;
        this.raycaster.far = segLen + 0.06;
        const hits = this.raycaster.intersectObject(this.dieMesh, false);
        if (hits.length > 0) {
          didHit = true;
          this.handleDartHit(hits[0].point, nextDir);
        }
      }

      // Safety catch in case the spinning ball rotated onto the dart tip between rays
      if (!didHit) {
        const localTip = this.dieGroup.worldToLocal(nextTipWorld.clone());
        const tipDist = localTip.length();
        const dirNorm = localTip.clone().normalize();
        const surfaceR = DIE_RADIUS * lumpyRadiusScale(dirNorm);
        if (tipDist <= surfaceR) {
          const snappedWorld = this.dieGroup.localToWorld(dirNorm.multiplyScalar(surfaceR));
          didHit = true;
          this.handleDartHit(snappedWorld, nextDir);
        }
      }

      // Miss check: flew past or hit floor
      if (!didHit) {
        if (this.dartPos.y <= 0.06) {
          this.dartPos.y = 0.06;
          this.flyingDart.group.position.y = 0.06;
          if (!this.missFloorPlayed) {
            this.missFloorPlayed = true;
            soundEffects.playDartMissFloor(this.muted);
          }
          this.dartState = 'missed';
          this.missCooldown = 0.38;
        } else if (this.dartPos.z < -7.5 || this.dartFlightTime > 2.3) {
          this.dartState = 'missed';
          this.missCooldown = 0.22;
        }
      }
    } else if (this.dartState === 'missed') {
      this.missCooldown -= dt;
      if (this.missCooldown <= 0) {
        this.disposeFlyingDart();
        this.heldDart.group.visible = true;
        this.aimPull = 0;
        this.aimYaw = 0;
        this.missFloorPlayed = false;
        this.dartState = 'ready';
        this.callbacks.onDartActivityChange?.(false);
      }
    }

    return true;
  }

  private stepSimulation(dt: number): boolean {
    if (!this.dieGroup) return false;
    this.elapsedClock += dt;

    let phaseNeedsLoop = false;

    if (this.phase === 'rolling') {
      this.world.step(1 / 60, dt, 4);
      this.applySoftBoundaryWalls(dt);

      const onTable = this.dieBody.position.y <= DIE_RADIUS + 0.06;
      const linSpeed = Math.hypot(this.dieBody.velocity.x, this.dieBody.velocity.z);
      const angSpeed = this.dieBody.angularVelocity.length();

      if (onTable) {
        const rollingDrag = Math.exp(-0.34 * dt);
        this.dieBody.velocity.x *= rollingDrag;
        this.dieBody.velocity.z *= rollingDrag;
        this.dieBody.angularVelocity.scale(rollingDrag, this.dieBody.angularVelocity);

        if (linSpeed < 0.4 && angSpeed < 0.45) {
          const finalSettleDrag = Math.exp(-1.25 * dt);
          this.dieBody.velocity.x *= finalSettleDrag;
          this.dieBody.velocity.z *= finalSettleDrag;
          this.dieBody.angularVelocity.scale(finalSettleDrag, this.dieBody.angularVelocity);
        }
      }

      this.dieGroup.position.set(
        this.dieBody.position.x,
        this.dieBody.position.y,
        this.dieBody.position.z,
      );
      this.dieGroup.quaternion.set(
        this.dieBody.quaternion.x,
        this.dieBody.quaternion.y,
        this.dieBody.quaternion.z,
        this.dieBody.quaternion.w,
      );

      this.updateLightsForDie(this.dieGroup.position.x, this.dieGroup.position.z);
      this.updateContactShadow();

      const curLinSpeed = Math.hypot(
        this.dieBody.velocity.x,
        this.dieBody.velocity.y,
        this.dieBody.velocity.z,
      );
      const curAngSpeed = this.dieBody.angularVelocity.length();

      // Begin preloading & decoding the original TMDB poster as the ball slows down
      if (onTable && curLinSpeed < 0.28 && curAngSpeed < 0.32) {
        const candidateIdx = this.computeWinningMovieFromIdMap();
        if (candidateIdx !== this.preloadedWinnerIndex) {
          this.preloadedWinnerIndex = candidateIdx;
          this.callbacks.onPreloadWinner(candidateIdx);
        }
      }

      if (onTable && curLinSpeed < 0.045 && curAngSpeed < 0.055) {
        this.stoppedDuration += dt;
      } else {
        this.stoppedDuration = 0;
      }

      if (this.stoppedDuration >= 0.5) {
        // Freeze ball position & rotation completely until the next roll
        this.dieBody.velocity.setZero();
        this.dieBody.angularVelocity.setZero();
        this.dieBody.sleep();

        soundEffects.playSettleClick(this.muted);

        // Winner = poster at the very top of the ball (facing straight up)
        this.winnerMovieIndex = this.computeWinningMovieFromIdMap();
        if (this.winnerMovieIndex !== this.preloadedWinnerIndex) {
          this.preloadedWinnerIndex = this.winnerMovieIndex;
          this.callbacks.onPreloadWinner(this.winnerMovieIndex);
        }
        this.mountWinningPosterPatch(this.winnerMovieIndex);
        this.computePushInCurve(this.winnerMovieIndex);

        this.pauseElapsed = 0;
        this.phase = 'revealPause';
      }
      phaseNeedsLoop = true;
    } else if (this.phase === 'revealPause') {
      // 1. Hold still for a 0.8s beat before camera moves
      this.pauseElapsed += dt;
      if (this.pauseElapsed >= this.pauseDuration) {
        this.pushElapsed = 0;
        this.phase = 'pushIn';
        this.callbacks.onZoomStarted();
      }
      phaseNeedsLoop = true;
    } else if (this.phase === 'pushIn') {
      // 2. Camera glides slowly up and toward top poster (2.5s power2.inOut)
      this.pushElapsed += dt;
      const u = Math.min(1, this.pushElapsed / this.pushDuration);
      const power2InOut = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;

      this.evalCubicBezier(
        power2InOut,
        this.pushBezierP0,
        this.pushBezierP1,
        this.pushBezierP2,
        this.pushBezierP3,
        this.camera.position,
      );

      this.controls.target.lerpVectors(
        this.pushStartCamTarget,
        this.pushEndCamTarget,
        smoothstep(0.0, 0.82, u),
      );

      _v1
        .lerpVectors(this.pushStartCamUp, this.pushEndCamUp, smoothstep(0.08, 0.94, u))
        .normalize();
      this.camera.up.copy(_v1);
      this.camera.lookAt(this.controls.target);

      if (u >= 1) {
        this.camera.position.copy(this.pushBezierP3);
        this.controls.target.copy(this.pushEndCamTarget);
        this.camera.up.copy(this.pushEndCamUp);
        this.camera.lookAt(this.controls.target);

        if (this.winnerScrapMesh) {
          this.winnerScrapMesh.visible = true;
          this.winnerScrapMesh.position.copy(this.cardStartPos);
          this.winnerScrapMesh.quaternion.copy(this.cardStartQuat);
          this.winnerScrapMesh.scale.setScalar(1.0);
        }
        if (this.winnerScrapMat) {
          this.winnerScrapMat.opacity = 1.0;
        }
        if (this.winnerBlankMat) {
          this.winnerBlankMat.opacity = 1.0;
        }
        if (this.winnerShadowMat) {
          this.winnerShadowMat.opacity = 0.0;
        }

        this.liftElapsed = 0;
        this.swapTriggered = false;
        this.phase = 'liftUp';
        this.callbacks.onPosterLiftStarted();
      }
      phaseNeedsLoop = true;
    } else if (this.phase === 'liftUp') {
      // 3. Torn scrap lifts flat & upright facing the camera (2.0s, power2.out)
      this.liftElapsed += dt;
      const u = Math.min(1, this.liftElapsed / this.liftDuration);
      const liftEase = 1 - Math.pow(1 - u, 2); // power2.out

      if (this.winnerScrapMesh) {
        this.winnerScrapMesh.position.lerpVectors(
          this.cardStartPos,
          this.cardLandPos,
          liftEase,
        );
        this.winnerScrapMesh.quaternion.slerpQuaternions(
          this.cardStartQuat,
          this.cardLandQuat,
          smoothstep(0.0, 0.55, u),
        );
        this.winnerScrapMesh.scale.setScalar(
          THREE.MathUtils.lerp(1.0, this.cardLandScale * 1.03, liftEase),
        );
      }

      if (this.winnerShadowMat) {
        const shIn = smoothstep(0.0, 0.25, u);
        const shFade = 1 - smoothstep(0.25, 0.72, u);
        this.winnerShadowMat.opacity = 0.4 * shIn * shFade;
      }

      // Smoothly retract/hide stuck dart right as scrap begins peeling away so it doesn't poke through the enlarging poster
      if (this.stuckDartPivot) {
        if (u < 0.2) {
          this.stuckDartPivot.scale.setScalar(1 - smoothstep(0.0, 0.18, u));
        } else {
          this.stuckDartPivot.visible = false;
        }
      }

      if (u >= 1) {
        if (this.winnerScrapMesh) {
          this.winnerScrapMesh.position.copy(this.cardLandPos);
          this.winnerScrapMesh.quaternion.copy(this.cardLandQuat);
          this.winnerScrapMesh.scale.setScalar(this.cardLandScale * 1.03);
        }
        if (this.winnerShadowMat) this.winnerShadowMat.opacity = 0;

        this.swapElapsed = 0;
        this.swapTriggered = true;
        this.phase = 'swapCrossfade';
        this.callbacks.onPosterSwapStarted(
          this.winnerMovieIndex,
          this.computeLandingScreenLayout(),
          false,
        );
      }
      phaseNeedsLoop = true;
    } else if (this.phase === 'swapCrossfade') {
      // 4. Soft crossfade into the clean high-res original poster (0.4s)
      this.swapElapsed += dt;
      const u = Math.min(1, this.swapElapsed / this.swapDuration);

      const scrapOp = 1 - smoothstep(0.0, 0.92, u);
      if (this.winnerScrapMat) this.winnerScrapMat.opacity = scrapOp;

      // Subtle soft white glow breathing softly behind the crossfade
      if (this.winnerFlashMesh && this.winnerFlashMat) {
        const glow = Math.sin(u * Math.PI) * 0.16;
        if (glow > 0.005) {
          this.winnerFlashMesh.visible = true;
          this.winnerFlashMat.opacity = glow;
          this.winnerFlashMesh.scale.setScalar(THREE.MathUtils.lerp(0.96, 1.12, u));
        } else {
          this.winnerFlashMesh.visible = false;
          this.winnerFlashMat.opacity = 0;
        }
      }

      if (u >= 1) {
        if (this.winnerScrapMesh) {
          this.winnerScrapMesh.visible = false;
          this.winnerScrapMesh.scale.setScalar(this.cardLandScale);
        }
        if (this.winnerScrapMat) this.winnerScrapMat.opacity = 0;
        if (this.winnerFlashMesh) this.winnerFlashMesh.visible = false;
        if (this.winnerFlashMat) this.winnerFlashMat.opacity = 0;

        this.settleElapsed = 0;
        this.phase = 'settle';
        this.callbacks.onPosterSettleStarted();
      }
      phaseNeedsLoop = true;
    } else if (this.phase === 'settle') {
      // 5. Tiny settle (scale 1.03 -> 1.0, 0.5s), then neon pink dialog fades in
      this.settleElapsed += dt;
      const u = Math.min(1, this.settleElapsed / this.settleDuration);

      if (u >= 1) {
        this.phase = 'revealed';
        this.callbacks.onRevealReady(
          this.winnerMovieIndex,
          this.computeLandingScreenLayout(),
          false,
        );
        phaseNeedsLoop = false;
      } else {
        phaseNeedsLoop = true;
      }
    } else if (this.phase === 'revealed') {
      phaseNeedsLoop = false;
    } else if (this.phase === 'returning') {
      this.returnElapsed += dt;
      const u = Math.min(1, this.returnElapsed / this.returnDuration);

      if (this.returnHadCleanImg) {
        // Crossfade clean poster back to torn scrap
        const scrapOp = smoothstep(0.0, 0.24, u);
        if (this.winnerScrapMat) this.winnerScrapMat.opacity = scrapOp;
      }

      // Shrink scrap cleanly back onto its spot on the ball (no spin)
      const flyStart = this.returnHadCleanImg ? 0.16 : 0.02;
      const flyEnd = this.returnHadCleanImg ? 0.74 : 0.66;
      if (u <= flyEnd) {
        const cardU = smoothstep(flyStart, flyEnd, u);
        const flyEase =
          cardU < 0.5 ? 2 * cardU * cardU : 1 - Math.pow(-2 * cardU + 2, 2) / 2;

        if (this.winnerScrapMesh) {
          this.winnerScrapMesh.visible = true;
          this.winnerScrapMesh.position.lerpVectors(
            this.returnCardStartPos,
            this.cardStartPos,
            flyEase,
          );
          this.winnerScrapMesh.scale.setScalar(
            THREE.MathUtils.lerp(this.returnCardStartScale, 1.0, flyEase),
          );
          this.winnerScrapMesh.quaternion.slerpQuaternions(
            this.returnCardStartQuat,
            this.cardStartQuat,
            flyEase,
          );
        }
      } else {
        if (this.winnerScrapMesh) this.winnerScrapMesh.visible = false;
      }

      const blankFadeStart = this.returnHadCleanImg ? 0.68 : 0.62;
      if (this.winnerBlankMat && u > blankFadeStart) {
        this.winnerBlankMat.opacity = Math.max(
          0,
          1 - smoothstep(blankFadeStart, blankFadeStart + 0.14, u),
        );
      }

      // Smoothly fly camera back to normal view (1.5s)
      const camU = smoothstep(this.returnHadCleanImg ? 0.2 : 0.15, 1.0, u);
      const camEase =
        camU < 0.5 ? 4 * camU * camU * camU : 1 - Math.pow(-2 * camU + 2, 3) / 2;

      this.evalCubicBezier(
        camEase,
        this.returnBezierP0,
        this.returnBezierP1,
        this.returnBezierP2,
        this.returnBezierP3,
        this.camera.position,
      );

      this.controls.target.lerpVectors(
        this.returnStartCamTarget,
        this.returnEndCamTarget,
        camEase,
      );

      _v1
        .lerpVectors(this.returnStartCamUp, this.returnEndCamUp, smoothstep(0.1, 0.9, camU))
        .normalize();
      this.camera.up.copy(_v1);
      this.camera.lookAt(this.controls.target);

      if (u >= 1) {
        this.camera.position.copy(this.returnBezierP3);
        this.controls.target.copy(this.returnEndCamTarget);
        this.camera.up.copy(UP_VECTOR);
        this.camera.lookAt(this.controls.target);
        this.disposeWinningPatch();
        this.disposeStuckDart();
        this.dentStrengthUniform.value = 0;
        this.heldDart.group.visible = true;
        this.aimPull = 0;
        this.aimYaw = 0;
        this.dartState = 'ready';

        if (this.mode === 'darts') {
          this.controls.enabled = false;
          this.handAnchor.visible = true;
          this.phase = 'idle';
          this.callbacks.onDartActivityChange?.(false);
          this.callbacks.onReturnComplete();
          phaseNeedsLoop = true;
        } else {
          this.dieBody.wakeUp();
          this.controls.enabled = true;
          this.controls.update();
          this.phase = 'idle';
          this.callbacks.onReturnComplete();
          phaseNeedsLoop = false;
        }
      } else {
        phaseNeedsLoop = true;
      }
    } else if (this.phase === 'idle') {
      if (this.mode === 'darts') {
        phaseNeedsLoop = this.stepDartsIdleAndFlight(dt);
      } else {
        // Hide hand smoothly when returning to Dice mode
        if (this.handEnterAmount > 0.005) {
          this.handEnterAmount = THREE.MathUtils.damp(this.handEnterAmount, 0, 10.0, dt);
          const enterDrop = (1 - this.handEnterAmount) * -0.65;
          this.handAnchor.position.y = -0.52 + enterDrop;
          this.handAnchor.visible = this.handEnterAmount > 0.01;
          phaseNeedsLoop = true;
        } else {
          this.handAnchor.visible = false;
        }

        // Smooth transition back to floor & OrbitControls when switching from Darts to Dice mode
        if (this.modeTransitioning || this.diceReturnSettling) {
          const desiredCamX = this.dieGroup.position.x + this.camOffset.x;
          const desiredCamY = this.camOffset.y;
          const desiredCamZ = this.dieGroup.position.z + this.camOffset.z;

          if (this.diceReturnSettling) {
            this.world.step(1 / 60, dt, 4);
            this.dieGroup.position.set(
              this.dieBody.position.x,
              this.dieBody.position.y,
              this.dieBody.position.z,
            );
            this.dieGroup.quaternion.set(
              this.dieBody.quaternion.x,
              this.dieBody.quaternion.y,
              this.dieBody.quaternion.z,
              this.dieBody.quaternion.w,
            );
            this.updateLightsForDie(this.dieGroup.position.x, this.dieGroup.position.z);
            this.updateContactShadow();
          }

          this.camera.position.x = THREE.MathUtils.damp(this.camera.position.x, desiredCamX, 6.0, dt);
          this.camera.position.y = THREE.MathUtils.damp(this.camera.position.y, desiredCamY, 6.0, dt);
          this.camera.position.z = THREE.MathUtils.damp(this.camera.position.z, desiredCamZ, 6.0, dt);
          this.controls.target.x = THREE.MathUtils.damp(this.controls.target.x, this.dieGroup.position.x, 6.0, dt);
          this.controls.target.y = THREE.MathUtils.damp(this.controls.target.y, this.camTargetY, 6.0, dt);
          this.controls.target.z = THREE.MathUtils.damp(this.controls.target.z, this.dieGroup.position.z, 6.0, dt);
          this.camera.lookAt(this.controls.target);

          const onFloor =
            this.dieBody.position.y <= DIE_RADIUS + 0.025 &&
            Math.abs(this.dieBody.velocity.y) < 0.08;
          const camSettled =
            Math.hypot(
              this.camera.position.x - desiredCamX,
              this.camera.position.y - desiredCamY,
              this.camera.position.z - desiredCamZ,
            ) < 0.03;

          if (onFloor && camSettled && this.handEnterAmount <= 0.01) {
            this.dieBody.position.y = DIE_RADIUS;
            this.dieBody.velocity.setZero();
            this.dieBody.angularVelocity.setZero();
            this.dieGroup.position.y = DIE_RADIUS;
            this.modeTransitioning = false;
            this.diceReturnSettling = false;
            this.controls.enabled = true;
            this.controls.update();
          } else {
            phaseNeedsLoop = true;
          }
        } else {
          this.controls.update();
        }
      }
    }

    return phaseNeedsLoop;
  }

  private updateContactShadow(): void {
    if (!this.dieGroup) return;
    const heightAboveTable = Math.max(0, this.dieGroup.position.y - DIE_RADIUS);
    this.contactShadowMesh.position.x = this.dieGroup.position.x;
    this.contactShadowMesh.position.z = this.dieGroup.position.z;
    const scale = 1 + heightAboveTable * 0.22;
    this.contactShadowMesh.scale.set(scale, 1, scale);
    const mat = this.contactShadowMesh.material as THREE.MeshBasicMaterial;
    mat.opacity = Math.max(0.25, 0.85 - heightAboveTable * 0.18);
  }

  private updatePointerNdc(clientX: number, clientY: number): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  }

  private raycastDie(clientX: number, clientY: number): number | null {
    if (!this.dieMesh || !this.dieGroup || !this.bakedCollage) return null;
    this.updatePointerNdc(clientX, clientY);
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const hits = this.raycaster.intersectObject(this.dieMesh, false);
    if (hits.length === 0) return null;
    _v1.copy(hits[0].point);
    this.dieGroup.worldToLocal(_v1).normalize();
    return this.bakedCollage.sampleIdAtDirection(_v1);
  }

  private isPointerOnDie(clientX: number, clientY: number): boolean {
    if (!this.dieGroup) return false;
    this.updatePointerNdc(clientX, clientY);
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    if (this.dieMesh) {
      const hits = this.raycaster.intersectObject(this.dieMesh, false);
      if (hits.length > 0) return true;
    }
    const distToRay = this.raycaster.ray.distanceToPoint(this.dieGroup.position);
    return distToRay <= DIE_RADIUS * 1.15;
  }

  private onPointerDown = (e: PointerEvent) => {
    if (!this.dieGroup) return;

    if (
      this.phase === 'revealPause' ||
      this.phase === 'pushIn' ||
      this.phase === 'liftUp' ||
      this.phase === 'swapCrossfade' ||
      this.phase === 'settle'
    ) {
      this.skipRevealToFinal();
      return;
    }

    if (this.phase !== 'idle') return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;

    if (this.mode === 'darts') {
      if (this.dartState !== 'ready') return;
      soundEffects.unlock();
      this.aimingPointerId = e.pointerId;
      this.aimStartX = e.clientX;
      this.aimStartY = e.clientY;
      this.aimPull = 0;
      this.aimYaw = 0;
      this.aimSamples = [{ x: e.clientX, y: e.clientY, t: performance.now() }];
      this.dartState = 'aiming';
      this.renderer.domElement.style.cursor = 'grabbing';
      try {
        this.renderer.domElement.setPointerCapture(e.pointerId);
      } catch {
        // Ignore
      }
      return;
    }

    if (this.modeTransitioning) return;

    if (this.isPointerOnDie(e.clientX, e.clientY)) {
      this.draggingDie = true;
      this.dragPointerId = e.pointerId;
      this.controls.enabled = false;
      this.dragSamples = [{ x: e.clientX, y: e.clientY, t: performance.now() }];
      this.renderer.domElement.style.cursor = 'grabbing';
      this.callbacks.onHoverMovie(null, e.clientX, e.clientY);
      try {
        this.renderer.domElement.setPointerCapture(e.pointerId);
      } catch {
        // Ignore
      }
    }
  };

  private onPointerMove = (e: PointerEvent) => {
    if (this.mode === 'darts') {
      if (this.dartState === 'aiming' && e.pointerId === this.aimingPointerId) {
        const now = performance.now();
        this.aimSamples.push({ x: e.clientX, y: e.clientY, t: now });
        if (this.aimSamples.length > 8) this.aimSamples.shift();

        const maxPullPx = Math.min(220, Math.max(120, window.innerHeight * 0.28));
        const maxYawPx = Math.min(240, Math.max(110, window.innerWidth * 0.34));
        const dyDown = Math.max(0, e.clientY - this.aimStartY);
        const dx = e.clientX - this.aimStartX;

        this.aimPull = Math.min(1, dyDown / maxPullPx);
        this.aimYaw = THREE.MathUtils.clamp((dx / maxYawPx) * 0.38, -0.38, 0.38);
      } else if (this.phase === 'idle' && this.dartState === 'ready' && e.pointerType !== 'touch') {
        this.renderer.domElement.style.cursor = 'grab';
      }
      return;
    }

    if (this.draggingDie && e.pointerId === this.dragPointerId) {
      const now = performance.now();
      this.dragSamples.push({ x: e.clientX, y: e.clientY, t: now });
      if (this.dragSamples.length > 8) this.dragSamples.shift();
      return;
    }

    if (this.phase !== 'idle' || e.pointerType === 'touch') return;

    const now = performance.now();
    if (now - this.lastHoverCheck < 45) return;
    this.lastHoverCheck = now;

    const movieIdx = this.raycastDie(e.clientX, e.clientY);
    this.renderer.domElement.style.cursor = movieIdx !== null ? 'grab' : 'default';
    this.callbacks.onHoverMovie(movieIdx, e.clientX, e.clientY);
  };

  private onPointerUp = (e: PointerEvent) => {
    if (this.mode === 'darts') {
      if (this.dartState !== 'aiming' || e.pointerId !== this.aimingPointerId) return;
      this.aimingPointerId = -1;
      this.renderer.domElement.style.cursor = 'grab';
      try {
        this.renderer.domElement.releasePointerCapture(e.pointerId);
      } catch {
        // Ignore
      }

      if (this.aimPull < 0.08) {
        this.aimPull = 0;
        this.aimYaw = 0;
        this.aimArc.setVisible(false);
        this.dartState = 'ready';
        return;
      }

      // Measure release flick speed (fast upward or pull flick right on release adds power)
      const now = performance.now();
      const recent = this.aimSamples.filter((s) => now - s.t <= 115);
      const first = recent.length >= 2 ? recent[0] : this.aimSamples[this.aimSamples.length - 2];
      const last = this.aimSamples[this.aimSamples.length - 1];
      let flickBonus = 0;
      if (first && last) {
        const dtMs = Math.max(16, last.t - first.t);
        const dy = last.y - first.y;
        const speedPxPerMs = Math.abs(dy) / dtMs;
        // Upward release flick contributes strongly; rapid pull release contributes moderately
        const dirFactor = dy < 0 ? 1.0 : 0.45;
        flickBonus = Math.min(0.45, Math.max(0, (speedPxPerMs - 0.18) * 0.34 * dirFactor));
      }

      this.throwPendingPower = flickBonus;
      this.throwPendingYaw = this.aimYaw;
      this.throwAnimElapsed = 0;
      this.throwReleased = false;
      this.missFloorPlayed = false;
      this.aimArc.setVisible(false);
      this.dartState = 'throwing';
      this.callbacks.onDartActivityChange?.(true);
      return;
    }

    if (!this.draggingDie || e.pointerId !== this.dragPointerId) return;
    this.draggingDie = false;
    this.dragPointerId = -1;
    this.renderer.domElement.style.cursor = 'default';
    try {
      this.renderer.domElement.releasePointerCapture(e.pointerId);
    } catch {
      // Ignore
    }

    if (this.phase === 'rolling') return;

    const now = performance.now();
    const recent = this.dragSamples.filter((s) => now - s.t <= 150);
    const first = recent.length >= 2 ? recent[0] : this.dragSamples[0];
    const last = this.dragSamples[this.dragSamples.length - 1];

    if (!first || !last) {
      if (this.phase === 'idle') this.controls.enabled = true;
      return;
    }

    const dx = last.x - first.x;
    const dy = last.y - first.y;
    const dtMs = Math.max(16, last.t - first.t);
    const dist = Math.hypot(dx, dy);

    if (dist > 14) {
      const speedPxPerMs = dist / dtMs;
      const strength = Math.min(1.6, Math.max(0.55, speedPxPerMs * 0.78));

      this.camera.getWorldDirection(_camForward);
      _camForward.y = 0;
      if (_camForward.lengthSq() < 1e-4) _camForward.set(0, 0, -1);
      _camForward.normalize();
      _camRight.crossVectors(_camForward, UP_VECTOR).normalize();

      const normDx = dx / dist;
      const normDy = dy / dist;

      const dirX = _camRight.x * normDx - _camForward.x * normDy;
      const dirZ = _camRight.z * normDx - _camForward.z * normDy;
      const speedWorld = 3.6 + strength * 4.4;

      this.callbacks.onFlingRollRequest({
        vx: dirX * speedWorld,
        vz: dirZ * speedWorld,
        strength,
      });
    } else if (this.phase === 'idle') {
      this.controls.enabled = true;
    }
  };

  private onPointerLeave = () => {
    this.callbacks.onHoverMovie(null, 0, 0);
  };

  private onResize = () => {
    if (this.disposed) return;
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    const aspect = width / height;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.updateResponsiveCamOffset(aspect);

    if (this.phase === 'idle' && this.dieGroup) {
      if (this.mode === 'darts') {
        this.getDartsCameraPose(this.camera.position, this.controls.target);
        this.camera.lookAt(this.controls.target);
      } else {
        this.camera.position.set(
          this.dieGroup.position.x + this.camOffset.x,
          this.camOffset.y,
          this.dieGroup.position.z + this.camOffset.z,
        );
        this.controls.target.set(
          this.dieGroup.position.x,
          this.camTargetY,
          this.dieGroup.position.z,
        );
        this.controls.update();
      }
    } else if (this.phase === 'revealed' && this.dieGroup) {
      this.updateCardLandingPose(width, height);
      this.camera.position.copy(this.pushBezierP3);
      this.camera.up.copy(this.pushEndCamUp);
      this.controls.target.copy(this.pushEndCamTarget);
      this.camera.lookAt(this.controls.target);

      if (this.winnerScrapMesh) {
        this.winnerScrapMesh.position.copy(this.cardLandPos);
        this.winnerScrapMesh.quaternion.copy(this.cardLandQuat);
        this.winnerScrapMesh.scale.setScalar(this.cardLandScale);
      }

      this.callbacks.onRevealLayoutChange(this.computeLandingScreenLayout());
    }

    const pixelRatio = this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height);
    if (this.composer && !this.isSoftwareGl) {
      this.composer.setPixelRatio(pixelRatio);
      this.composer.setSize(width, height);
    }

    this.scheduleOnDemandRender();
  };

  private onContextLost = (e: Event) => {
    e.preventDefault();
    if (this.frameId) {
      cancelAnimationFrame(this.frameId);
      this.frameId = 0;
    }
    this.callbacks.onContextLostChange(true);
  };

  private onContextRestored = () => {
    this.callbacks.onContextLostChange(false);
    this.scheduleOnDemandRender();
  };

  private bindEvents(): void {
    const dom = this.renderer.domElement;
    dom.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    dom.addEventListener('pointerleave', this.onPointerLeave);
    dom.addEventListener('webglcontextlost', this.onContextLost);
    dom.addEventListener('webglcontextrestored', this.onContextRestored);
    window.addEventListener('resize', this.onResize);
  }

  private unbindEvents(): void {
    const dom = this.renderer.domElement;
    dom.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    dom.removeEventListener('pointerleave', this.onPointerLeave);
    dom.removeEventListener('webglcontextlost', this.onContextLost);
    dom.removeEventListener('webglcontextrestored', this.onContextRestored);
    window.removeEventListener('resize', this.onResize);
  }

  private disposeDie(): void {
    this.disposeWinningPatch();
    this.disposeStuckDart();
    this.disposeFlyingDart();
    if (this.dieGroup) {
      this.scene.remove(this.dieGroup);
      this.dieGroup = null;
    }
    if (this.dieMesh) {
      this.dieMesh.geometry.dispose();
      this.dieMesh = null;
    }
    if (this.dieMaterial) {
      this.dieMaterial.dispose();
      this.dieMaterial = null;
    }
    if (this.bakedCollage) {
      this.bakedCollage.dispose();
      this.bakedCollage = null;
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.bakeAbortController?.abort();
    if (this.frameId) {
      cancelAnimationFrame(this.frameId);
      this.frameId = 0;
    }
    this.unbindEvents();
    this.controls.dispose();
    this.disposeDie();

    this.heldDart.dispose();
    this.handRig.dispose();
    this.aimArc.dispose();

    this.paperNormalTex.dispose();
    this.paperRoughnessTex.dispose();
    this.lightBurstTex.dispose();

    this.floorMesh.geometry.dispose();
    (this.floorMesh.material as THREE.Material).dispose();

    this.contactShadowMesh.geometry.dispose();
    (this.contactShadowMesh.material as THREE.MeshBasicMaterial).map?.dispose();
    (this.contactShadowMesh.material as THREE.Material).dispose();

    if (this.ssaoPass) {
      this.ssaoPass.dispose();
      this.ssaoPass = null;
    }
    if (this.outputPass) {
      this.outputPass.dispose();
      this.outputPass = null;
    }
    if (this.composer) {
      this.composer.dispose();
      this.composer = null;
    }

    this.renderer.dispose();
    if (this.renderer.domElement.parentNode === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
