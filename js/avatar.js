// avatar.js — A lightweight procedural Three.js avatar that "talks".
// The mouth opening is driven by a shared `mouthTarget` value (0..1) that the
// TTS layer pulses on word boundaries, giving a believable lip-sync without
// needing a rigged glTF model or external assets.

import * as THREE from 'three';

export class Avatar {
  constructor(canvas) {
    this.canvas = canvas;
    this.mouthTarget = 0;   // desired openness, set externally while speaking
    this.mouth = 0;         // smoothed openness actually rendered
    this.speaking = false;
    this.blink = 0;
    this.nextBlink = 2 + Math.random() * 3;
    this.clock = new THREE.Clock();
    this._init();
  }

  _init() {
    const { canvas } = this;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    this.camera.position.set(0, 0.1, 5.2);

    // Lights
    this.scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x202840, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(2, 3, 4);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x5b8cff, 0.6);
    rim.position.set(-3, 1, -2);
    this.scene.add(rim);

    // Root group lets us add a gentle idle sway / head turn
    this.root = new THREE.Group();
    this.scene.add(this.root);

    const skin = new THREE.MeshStandardMaterial({ color: 0xe6b58a, roughness: 0.7, metalness: 0.0 });
    const hairMat = new THREE.MeshStandardMaterial({ color: 0x2b2118, roughness: 0.9 });

    // Head
    this.head = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 48), skin);
    this.head.scale.set(0.92, 1.05, 0.9);
    this.root.add(this.head);

    // Hair cap
    const hair = new THREE.Mesh(new THREE.SphereGeometry(1.02, 40, 40, 0, Math.PI * 2, 0, Math.PI * 0.55), hairMat);
    hair.scale.set(0.95, 1.08, 0.95);
    hair.position.y = 0.08;
    this.root.add(hair);

    // Eyes
    const eyeWhite = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
    const iris = new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 0.4 });
    this.eyes = [];
    for (const sx of [-1, 1]) {
      const g = new THREE.Group();
      const white = new THREE.Mesh(new THREE.SphereGeometry(0.16, 24, 24), eyeWhite);
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.09, 20, 20), iris);
      pupil.position.z = 0.1;
      g.add(white, pupil);
      g.position.set(0.33 * sx, 0.18, 0.82);
      this.root.add(g);
      this.eyes.push(g);

      // Eyebrow
      const brow = new THREE.Mesh(
        new THREE.BoxGeometry(0.28, 0.05, 0.08),
        hairMat
      );
      brow.position.set(0.33 * sx, 0.42, 0.86);
      brow.rotation.z = -0.08 * sx;
      this.root.add(brow);
    }

    // Eyelids (scale down to blink)
    this.lids = [];
    for (const sx of [-1, 1]) {
      const lid = new THREE.Mesh(new THREE.SphereGeometry(0.17, 24, 24, 0, Math.PI * 2, 0, Math.PI / 2), skin);
      lid.position.set(0.33 * sx, 0.18, 0.82);
      lid.scale.y = 0.01;
      this.root.add(lid);
      this.lids.push(lid);
    }

    // Nose
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.3, 16), skin);
    nose.rotation.x = Math.PI * 0.5;
    nose.position.set(0, -0.02, 0.95);
    this.root.add(nose);

    // Mouth: an upper and lower lip that separate to "open"
    const lipMat = new THREE.MeshStandardMaterial({ color: 0x8a3b3b, roughness: 0.6 });
    const innerMat = new THREE.MeshStandardMaterial({ color: 0x2a1015, roughness: 0.8 });

    this.mouthInner = new THREE.Mesh(new THREE.SphereGeometry(0.26, 24, 24), innerMat);
    this.mouthInner.scale.set(1, 0.5, 0.4);
    this.mouthInner.position.set(0, -0.45, 0.86);
    this.root.add(this.mouthInner);

    this.lipTop = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.42, 6, 12), lipMat);
    this.lipTop.rotation.z = Math.PI / 2;
    this.lipTop.position.set(0, -0.36, 0.92);
    this.root.add(this.lipTop);

    this.lipBottom = this.lipTop.clone();
    this.lipBottom.position.set(0, -0.54, 0.92);
    this.root.add(this.lipBottom);

    window.addEventListener('resize', () => this._resize());
    this._resize();
    this._animate();
  }

  _resize() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setSpeaking(on) {
    this.speaking = on;
    if (!on) this.mouthTarget = 0;
  }

  // Called by TTS on each word boundary to pulse the jaw.
  pulse(amount = 1) {
    this.mouthTarget = Math.min(1, 0.45 + Math.random() * 0.55) * amount;
  }

  _animate = () => {
    requestAnimationFrame(this._animate);
    const dt = this.clock.getDelta();
    const t = this.clock.elapsedTime;

    // Idle: gentle breathing sway + subtle head turn
    this.root.rotation.y = Math.sin(t * 0.5) * 0.12;
    this.root.rotation.x = Math.sin(t * 0.7) * 0.04;
    this.root.position.y = Math.sin(t * 1.4) * 0.02;

    // While speaking, add a fast jitter so the mouth keeps moving between
    // word-boundary pulses; decay toward closed otherwise.
    if (this.speaking) {
      const jitter = (Math.sin(t * 28) * 0.5 + 0.5) * 0.4 + 0.1;
      this.mouthTarget = Math.max(this.mouthTarget * 0.86, jitter);
    } else {
      this.mouthTarget *= 0.8;
    }
    this.mouth += (this.mouthTarget - this.mouth) * Math.min(1, dt * 18);

    const open = this.mouth * 0.32;
    this.lipBottom.position.y = -0.42 - open;
    this.lipTop.position.y = -0.34 + open * 0.15;
    this.mouthInner.scale.y = 0.18 + this.mouth * 0.7;
    this.mouthInner.position.y = -0.45 - open * 0.4;

    // Blinking
    this.nextBlink -= dt;
    if (this.nextBlink <= 0) { this.blink = 1; this.nextBlink = 2.5 + Math.random() * 3.5; }
    this.blink = Math.max(0, this.blink - dt * 8);
    const lidScale = 0.01 + this.blink * 1.0;
    this.lids.forEach((l) => (l.scale.y = lidScale));

    this.renderer.render(this.scene, this.camera);
  };
}
